import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createExecutionContext, env } from "cloudflare:test";

import worker from "../src/index";
import { BUDGET_CLAMP_EVENT_KIND } from "../src/control/budget";
import { TaskSession } from "../src/control/session";
import { OBS_EVENT_KINDS } from "../src/obs/events";
import { ingestTranscript, type ObsTranscriptReader } from "../src/obs/ingest";
import { applyMigrations } from "./d1";

import { ApiError } from "../web/src/lib/api";
import {
  TASK_EVENTS_PAGE_LIMIT,
  taskEventsUrl,
  taskSnapshotUrl,
  taskStreamUrl,
  fetchTaskEvents,
  fetchTaskSnapshot,
} from "../web/src/lib/queries";
import { taskEventsPageSchema, taskSnapshotSchema, type TaskSnapshot } from "../web/src/lib/schema";
import { EVENT_KINDS } from "../web/src/lib/kinds";
import {
  STALL_DANGER_SECONDS,
  STALL_WARN_SECONDS,
  STREAM_ENDED_TEXT,
  TASK_STALL_DANGER_SECONDS,
  TASK_STALL_WARN_SECONDS,
  stallView,
  taskStallView,
  type StallClock,
} from "../web/src/lib/stream-protocol";
import {
  applyPullPage,
  attemptDurationSeconds,
  attemptRowView,
  baselineFacts,
  BUDGET_CLAMP_KIND,
  budgetFacts,
  clampFacts,
  connectionBadge,
  detailFailureText,
  endFrameLine,
  eventKey,
  INITIAL_PULL,
  isTaskNotFound,
  kindBadgeClassName,
  mergeTimeline,
  pullHasMore,
  pullNote,
  pullStartAfter,
  pullWithFailure,
  runEventsPull,
  snapshotReadNote,
  stateDisplay,
  streamEnabledFor,
  streamFramesOf,
  timelineEmptyText,
  timelineRowView,
  truncateHash,
  pullFailureText,
  type PullState,
  type PullTriggerInput,
  type TaskEventsReader,
} from "../web/src/lib/task-detail";
import { STREAM_EVENT_BUFFER_LIMIT } from "../web/src/lib/use-event-stream";
import { TEXT_SUMMARY_MAX_CHARS, type Tone } from "../web/src/lib/view";

/**
 * `/tasks/$taskId` 上半(w4a)的判定层 + 与真端点的对表。
 *
 * 打法与 test/web-tasks-page.test.ts 同构,因为这一页的可测部分同样是纯函数
 * (Workers 运行时里没有 DOM、没有 `EventSource`;`.tsx` 那一半由
 * test/web-frontend-contract.test.ts 的源码钉子 + 部署后浏览器冒烟覆盖)。
 *
 * 三组断言各管一类故障:
 *
 * 1. **与 worker 权威逐字比对**(`budget.clamped` 的 kind 名、补齐一页的 limit 落在服务端
 *    接受的范围里)。前端抄的那份副本会漂,而漂了的表现是「夹钳留痕静默不显示」这种
 *    没人会去查的形状。
 * 2. **判据本身真跑**:补齐该不该跑、从哪续、翻没翻尽、坏形状不许报废整页、合并不重复计条、
 *    四种失败四种说法、读不到的字段说「—」而不是 0。派单里那句「逐条迁移 c9b/c9c 实测经验」
 *    的可测部分全在这一组。
 * 3. **与真端点对表**:前两组都是「我们自己怎么说」,这一组直接起 worker,把这一页真的
 *    发得出去的几个 URL 打一遍 —— `taskSnapshotSchema` 是 `handleGetTask` 的**合法转写**
 *    而不是编出来的契约、attempts 真的只有那六列(所以「预算上限读不到」那句话是真话)、
 *    `after` 真的是扁平位置而不是 `seq`、`pullHasMore` 与服务端自己算的 `next_cursor` 同值。
 */

const TOKEN = env.WORKER_API_TOKEN;
const ns = () => env.TASK_SESSION as DurableObjectNamespace<TaskSession>;

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── 1. 与 worker 权威对表 ────────────────────────────────────────────────────

describe("前端副本与 worker 权威同源", () => {
  it("budget.clamped 的 kind 名与 src/control/budget.ts 逐字相同(漂了就是夹钳留痕静默不显示)", () => {
    expect(BUDGET_CLAMP_KIND).toBe(BUDGET_CLAMP_EVENT_KIND);
  });

  it("补齐一页的 limit 在服务端接受的范围内(它缺省 500、上限 2000,超了直接 400)", async () => {
    expect(TASK_EVENTS_PAGE_LIMIT).toBeGreaterThan(0);
    expect(TASK_EVENTS_PAGE_LIMIT).toBeLessThanOrEqual(2000);
    // 真打一遍才算「在范围内」这条不是读注释读出来的结论(下面那组对表同一个 worker)。
    const { taskId } = await seedTask([1]);
    stubFetchToWorker();
    await expect(fetchTaskEvents(taskId, 0)).resolves.toMatchObject({ count: 1 });
  });

  it("w4a 的接线确实引用了前端停滞常量(下面那组专钉 90/300 新口径)", () => {
    // 这两个常量与 src/supervisor/detect.ts 的逐值比对由 test/web-stream-protocol.test.ts 管。
    expect(STALL_WARN_SECONDS).toBeGreaterThan(STALL_DANGER_SECONDS);
  });
});

// ── 1b. 任务详情页的停滞三色:与监督器是两套判据 ─────────────────────────────

describe("taskStallView:任务详情页的停滞三色(权威 = product.md §5:>90s 黄 >300s 红)", () => {
  const T0 = 1_800_000_000_000;
  /** 造一个「anyAgoMs 前有过最后一条事件(心跳也算)」的时钟;behavioralAgoMs 缺省同刻。 */
  const clockAt = (anyAgoMs: number, behavioralAgoMs = anyAgoMs): StallClock => ({
    startMs: T0,
    lastAnyMs: T0 - anyAgoMs,
    lastBehavioralMs: T0 - behavioralAgoMs,
  });

  it("两个阈值逐值 = 90/300(权威是 product.md §5,不是监督器那对 900/180)", () => {
    expect(TASK_STALL_WARN_SECONDS).toBe(90);
    expect(TASK_STALL_DANGER_SECONDS).toBe(300);
    expect(TASK_STALL_WARN_SECONDS).toBeLessThan(TASK_STALL_DANGER_SECONDS);
  });

  it("边界(整秒粒度,与 stallView 同一口径):90s 正常、91s 黄、300s 黄、301s 红", () => {
    expect(taskStallView(clockAt(90_000), T0, false).tone).toBe("ok");
    expect(taskStallView(clockAt(91_000), T0, false).tone).toBe("warn");
    expect(taskStallView(clockAt(300_000), T0, false).tone).toBe("warn");
    expect(taskStallView(clockAt(301_000), T0, false).tone).toBe("err");
  });

  it("时间源是「最后一条事件」(lastAnyMs),不是行为时间源:91s 前有过心跳也算 91s", () => {
    const view = taskStallView(clockAt(91_000, 200_000), T0, false);
    expect(view.seconds).toBe(91);
    expect(view.tone).toBe("warn");
    expect(view.text).toContain("91");
  });

  it("与监督器那套是两个判据:181s 静默在监督器口径里已是红(>180 心跳停),本页口径是黄", () => {
    expect(STALL_DANGER_SECONDS).toBe(180);
    const clock = clockAt(181_000);
    expect(stallView(clock, T0, false).tone).toBe("err");
    expect(taskStallView(clock, T0, false).tone).toBe("warn");
  });

  it("红黄文案说「无新事件」,正常档说「最后事件」;阈值数字出自常量而不是第二份字面量", () => {
    expect(taskStallView(clockAt(91_000), T0, false).text).toContain(`超过 ${TASK_STALL_WARN_SECONDS}s`);
    expect(taskStallView(clockAt(301_000), T0, false).text).toContain(`超过 ${TASK_STALL_DANGER_SECONDS}s`);
    expect(taskStallView(clockAt(5_000), T0, false).text).toContain("最后事件 5s 前");
  });

  it("ended 停表:流收尾后不再计时(与 stallView 同一条纪律)", () => {
    const view = taskStallView(clockAt(301_000), T0, true);
    expect(view.tone).toBe("");
    expect(view.seconds).toBe(0);
    expect(view.text).toBe(STREAM_ENDED_TEXT);
  });
});

// ── 2. 补齐:触发、翻页、坏形状、失败 ────────────────────────────────────────

/** 造一页 `GET /events` 的答复(形状照 handleGetTaskEvents)。 */
function page(events: unknown[], total: number, extra: Record<string, unknown> = {}) {
  return {
    task_id: "t",
    state: "RUNNING",
    events,
    count: events.length,
    total,
    unreadable_attempts: [],
    ...extra,
  };
}

function journalEvent(seq: number, text = `e${seq}`): Record<string, unknown> {
  return {
    v: 1,
    task_id: "t",
    attempt_id: "a-1",
    generation: 1,
    seq,
    ts: `2026-09-06T10:00:${String(seq % 60).padStart(2, "0")}Z`,
    kind: "assistant",
    payload: { text },
  };
}

describe("pullHasMore:续读位点的算法与服务端同口径", () => {
  it("after + count < total 才算还有更多", () => {
    expect(pullHasMore(0, page([journalEvent(1)], 10) as never)).toBe(true);
    expect(pullHasMore(0, page([journalEvent(1)], 1) as never)).toBe(false);
    expect(pullHasMore(9, page([journalEvent(10)], 10) as never)).toBe(false);
    // 空页而 total 更大 = 还没读完(位置游标在更早的 attempt 里,不能因为这一页空就停)。
    expect(pullHasMore(3, page([], 10) as never)).toBe(true);
  });

  it("空页且已经读到 total:停(否则是一个永远不会结束的循环)", () => {
    expect(pullHasMore(10, page([], 10) as never)).toBe(false);
  });
});

describe("applyPullPage:一条坏形状不许报废整页", () => {
  it("读不懂的条目计数并跳过,其余照收,位置 = after + 下标 + 1", () => {
    const next = applyPullPage(
      INITIAL_PULL,
      page([journalEvent(1), { nope: true }, journalEvent(3)], 3) as never,
      0,
    );
    expect(next.items.map((item) => item.position)).toEqual([1, 3]);
    expect(next.bad).toBe(1);
    expect(next.pulled).toBe(3);
    expect(next.requests).toBe(1);
    expect(next.exhausted).toBe(true);
    expect(next.failure).toBeNull();
  });

  it("位置口径按 count 走(读不懂的条目同样占一个位置,否则续读点会倒退)", () => {
    const next = applyPullPage(INITIAL_PULL, page([{ bad: 1 }], 5) as never, 0);
    expect(next.pulled).toBe(1);
    expect(next.items).toEqual([]);
    const after = applyPullPage(next, page([journalEvent(2)], 5) as never, 1);
    expect(after.items.map((item) => item.position)).toEqual([2]);
  });

  it("失败之后再来一页:failure 清空,已读到的条目保留,计数继续累加", () => {
    const failed = pullWithFailure(INITIAL_PULL, new ApiError({ kind: "network" }, "/x"));
    expect(failed.failure).toContain("没有送达");
    const next = applyPullPage(failed, page([journalEvent(1)], 1) as never, 0);
    expect(next.failure).toBeNull();
    expect(next.bad).toBe(0);
    expect(next.items.length).toBe(1);
  });

  it("超过内存上限时保留最新的一段(观测页上无上限的数组是真实的内存故障)", () => {
    const events = Array.from({ length: STREAM_EVENT_BUFFER_LIMIT + 5 }, (_, i) =>
      journalEvent(i + 1),
    );
    const next = applyPullPage(INITIAL_PULL, page(events, events.length) as never, 0);
    expect(next.items.length).toBe(STREAM_EVENT_BUFFER_LIMIT);
    expect(next.items[0]?.position).toBe(6);
    expect(next.pulled).toBe(events.length);
  });

  it("失败状态保留已读到的条目:清空时间线等于把「读不到」伪装成「没有」", () => {
    const read = applyPullPage(INITIAL_PULL, page([journalEvent(1)], 9) as never, 0);
    const failed = pullWithFailure(read, new ApiError({ kind: "shape", status: 200, detail: "x" }, "/y"));
    expect(failed.items.length).toBe(1);
    expect(failed.failure).toContain("仍然保留");
    expect(failed.exhausted).toBe(true);
  });
});

describe("pullStartAfter:补齐是流的备份,不是第二个数据源", () => {
  const healthy: PullState = INITIAL_PULL;

  /** 一屏触发输入:每个用例只改自己那一位,免得新增字段时漏改一处而「全都绿因为没比」。 */
  function input(overrides: Partial<Parameters<typeof pullStartAfter>[0]>): PullTriggerInput {
    return {
      streaming: true,
      connected: true,
      badFrames: 0,
      streamFrames: 0,
      ended: false,
      endEvents: null,
      pull: healthy,
      manual: false,
      ...overrides,
    };
  }

  it("没开流就不补齐(任务不存在时连流都不开,见 streamEnabledFor)", () => {
    expect(pullStartAfter(input({ streaming: false, connected: false }))).toBeNull();
  });

  it("流健康、无坏帧、未结束 → 不补齐(那一页的实时性归流,两把刷子同时刷只会互相重复)", () => {
    expect(pullStartAfter(input({ streamFrames: 120 }))).toBeNull();
  });

  it("连接有未恢复的 error → 从已覆盖位置续读", () => {
    expect(
      pullStartAfter(input({ connected: false, pull: { ...healthy, pulled: 42 } })),
    ).toBe(42);
  });

  it("坏帧留下位置空洞 → 补齐去填(坏帧不因此成为漏读)", () => {
    expect(pullStartAfter(input({ badFrames: 1 }))).toBe(0);
  });

  it("end 帧报的总数比两个通道的覆盖率都高 → 必须补(「看起来完整而其实少了 N 条」那一类)", () => {
    expect(
      pullStartAfter(
        input({
          ended: true,
          endEvents: 451,
          streamFrames: 400,
          pull: { ...healthy, pulled: 400, exhausted: true },
        }),
      ),
    ).toBe(400);
  });

  it("end 帧的总数已被流覆盖 → 不为「再证明一次没漏」而重读整份 journal", () => {
    // 这是每次打开一个已结束任务时的常规形状:流首拍回放全部,然后 end 报同一个总数。
    expect(
      pullStartAfter(input({ ended: true, endEvents: 451, streamFrames: 451 })),
    ).toBeNull();
    // 反过来,只有补齐腿覆盖到了也不算漏读没有:两个数取 max 才是覆盖率。
    expect(
      pullStartAfter(
        input({ ended: true, endEvents: 10, streamFrames: 3, pull: { ...healthy, pulled: 10, exhausted: true } }),
      ),
    ).toBeNull();
  });

  it("end 帧读不懂(没有数字)→ 不凭猜测补,已翻尽时保持现状", () => {
    expect(
      pullStartAfter(
        input({ ended: true, endEvents: null, pull: { ...healthy, pulled: 400, exhausted: true } }),
      ),
    ).toBeNull();
  });

  it("已翻尽而流仍断着 → 不自动空转(第三个节拍 §4 没给;手动出口在按钮上)", () => {
    expect(
      pullStartAfter(
        input({
          connected: false,
          pull: { ...healthy, pulled: 10, total: 10, exhausted: true },
        }),
      ),
    ).toBeNull();
  });

  it("手动补齐:健康、已翻尽也照样续读一段", () => {
    expect(
      pullStartAfter(input({ manual: true, pull: { ...healthy, pulled: 128, exhausted: true } })),
    ).toBe(128);
    expect(pullStartAfter(input({ manual: true }))).toBe(0);
  });

  it("流没开着时手动也不动(不给一个服务端已回答「没有这个任务」的 id 发请求)", () => {
    expect(
      pullStartAfter(
        input({ streaming: false, connected: false, badFrames: 3, ended: true, endEvents: 99, manual: true }),
      ),
    ).toBeNull();
  });
});

describe("runEventsPull:一页一页翻到服务端说没有更多", () => {
  /** 记下每次请求的 after,并可控地答复。 */
  function scripted(pages: Array<ReturnType<typeof page>>): {
    reader: TaskEventsReader;
    calls: number[];
  } {
    const calls: number[] = [];
    return {
      calls,
      reader: async (_taskId: string, after: number) => {
        calls.push(after);
        const next = pages[calls.length - 1];
        if (next === undefined) throw new Error(`scripted pages exhausted at ${String(after)}`);
        return next as never;
      },
    };
  }

  it("三页翻尽:after 依次 0 / 500 / 1000,位置连续无洞无重叠", async () => {
    const { reader, calls } = scripted([
      page(Array.from({ length: 2 }, (_, i) => journalEvent(i + 1)), 5),
      page(Array.from({ length: 2 }, (_, i) => journalEvent(i + 3)), 5),
      page([journalEvent(5)], 5),
    ]);
    const seen: PullState[] = [];
    const final = await runEventsPull("t", 0, INITIAL_PULL, (s) => seen.push(s), reader);
    expect(calls).toEqual([0, 2, 4]);
    expect(final.exhausted).toBe(true);
    expect(final.pulled).toBe(5);
    expect(final.items.map((item) => item.position)).toEqual([1, 2, 3, 4, 5]);
    // 每翻一页都提交一次:页面上那条时间线是逐段长出来的,不是最后一次性替换。
    expect(seen.length).toBe(3);
  });

  it("中途失败即停,已读到的部分留在状态里", async () => {
    const reader: TaskEventsReader = async (_taskId, after) => {
      if (after === 0) return page([journalEvent(1)], 9) as never;
      throw new ApiError({ kind: "unauthorized", status: 401 }, "/x");
    };
    const final = await runEventsPull("t", 0, INITIAL_PULL, () => {}, reader);
    expect(final.items.length).toBe(1);
    expect(final.failure).toContain("会话失效");
    expect(final.exhausted).toBe(true);
  });

  it("续读的 after 不合法就不发请求(空值会被服务端当 0 = 从头重放一遍已看过的流)", async () => {
    let calls = 0;
    const reader: TaskEventsReader = async () => {
      calls += 1;
      return page([], 0) as never;
    };
    const final = await runEventsPull("t", Number.NaN, INITIAL_PULL, () => {}, reader);
    expect(calls).toBe(0);
    expect(final.failure ?? "").not.toBe("");
  });
});

// ── 3. 两个通道合并 ──────────────────────────────────────────────────────────

describe("mergeTimeline:补齐段在前、流的增量段在后,同内容不重复计条", () => {
  const pulledEvents = [1, 2].map((seq) => ({
    position: seq,
    seq,
    ts: `2026-09-06T10:00:0${seq}Z`,
    kind: "assistant",
    payload: { text: `e${seq}` },
  }));

  it("流通道重复了补齐已给的事件 → 只留一行", () => {
    const merged = mergeTimeline(pulledEvents, [
      { seq: 1, ts: "2026-09-06T10:00:01Z", kind: "assistant", payload: { text: "e1" } },
      { seq: 3, ts: "2026-09-06T10:00:09Z", kind: "assistant", payload: { text: "e3" } },
    ]);
    expect(merged.map((entry) => entry.source)).toEqual(["pull", "pull", "stream"]);
    expect(merged.map((entry) => entry.seq)).toEqual([1, 2, 3]);
  });

  it("补齐段保持自己的位置,流段位置为 null(它在有坏帧时不可信,见文件头)", () => {
    const merged = mergeTimeline(pulledEvents, []);
    expect(merged.every((entry) => entry.position !== null)).toBe(true);
    const tail = mergeTimeline([], [{ seq: 7, ts: "x", kind: "raw", payload: {} }]);
    expect(tail[0]?.position).toBeNull();
    expect(tail[0]?.key).toBe("s0");
  });

  it("合并结果也受内存上限约束(保留最新的一段)", () => {
    const streamed = Array.from({ length: STREAM_EVENT_BUFFER_LIMIT + 20 }, (_, i) => ({
      seq: i + 1,
      ts: `t${i}`,
      kind: "assistant",
      payload: { text: `s${i}` },
    }));
    const merged = mergeTimeline([], streamed);
    expect(merged.length).toBe(STREAM_EVENT_BUFFER_LIMIT);
    expect(merged[merged.length - 1]?.payload).toEqual({ text: `s${streamed.length - 1}` });
  });

  it("内容键含 kind/ts/seq/payload 四项:换一项就不算重复", () => {
    const base = { seq: 1, ts: "t", kind: "assistant", payload: { text: "a" } };
    expect(eventKey(base)).toBe(eventKey({ ...base }));
    for (const variant of [
      { ...base, seq: 2 },
      { ...base, ts: "t2" },
      { ...base, kind: "user" },
      { ...base, payload: { text: "b" } },
    ]) {
      expect(eventKey(variant)).not.toBe(eventKey(base));
    }
  });
});

describe("timelineRowView:逐条迁移 c9b 那份渲染表", () => {
  it("长文本截到 200 字符并把原文长度交给 note(全文有 /events)", () => {
    const long = "x".repeat(TEXT_SUMMARY_MAX_CHARS + 37);
    const row = timelineRowView({
      key: "k",
      position: 1,
      seq: 1,
      ts: "t",
      kind: "assistant",
      payload: { text: long },
      source: "pull",
    });
    expect(row.text.length).toBe(TEXT_SUMMARY_MAX_CHARS);
    expect(row.note).toContain(String(long.length));
    expect(row.text).not.toContain("全文");
  });

  it("tool_use 报工具名、raw 报 raw_type、有 usage 报 tokens", () => {
    const row = (kind: string, payload: unknown) =>
      timelineRowView({ key: "k", position: null, seq: 1, ts: "t", kind, payload, source: "stream" });
    expect(row("tool_use", { tool_names: ["Bash", "Edit"] }).extra).toBe("tools: Bash, Edit");
    expect(row("raw", { raw_type: "system" }).extra).toBe("raw_type: system");
    expect(row("result", { usage: { total_tokens: 42 } }).extra).toBe("tokens: 42");
    expect(row("assistant", {}).extra).toBe("");
  });

  it("陌生 payload 形状不抛:未知 kind 落中性徽章", () => {
    for (const payload of [null, 42, "str", [], { text: 1 }, { tool_names: "不是数组" }]) {
      expect(() => timelineRowView({ key: "k", position: null, seq: 1, ts: "t", kind: "whatever", payload, source: "stream" })).not.toThrow();
    }
    expect(kindBadgeClassName("whatever")).toBe("ca-badge");
  });

  it("kind 徽章覆盖 OBS_EVENT_KINDS 全值,且都带 ca-badge 底座", () => {
    expect([...EVENT_KINDS]).toEqual([...OBS_EVENT_KINDS]);
    for (const kind of OBS_EVENT_KINDS) {
      const cls = kindBadgeClassName(kind);
      expect(cls, kind).toContain("ca-badge");
      expect(cls, kind).not.toBe("ca-badge");
    }
  });

  it("位置标签:补齐段给位置,流段说「增量」", () => {
    expect(timelineRowView({ key: "k", position: 7, seq: 1, ts: "t", kind: "user", payload: {}, source: "pull" }).positionLabel).toBe("7");
    expect(timelineRowView({ key: "k", position: null, seq: 1, ts: "t", kind: "user", payload: {}, source: "stream" }).positionLabel).toBe("增量");
  });
});

// ── 4. 头部:失败面、空态、基线、预算、attempts ──────────────────────────────

describe("失败面:404 与三种读取失败各有说法,且没有一种被说成「没有内容」", () => {
  const notFound = new ApiError({ kind: "http", status: 404, errorType: "not_found" }, "/api/tasks/x");

  it("404 单独一支:说「没有这个任务」并否定「任务存在但没内容」", () => {
    expect(isTaskNotFound(notFound)).toBe(true);
    const text = detailFailureText(notFound);
    expect(text).toContain("404");
    expect(text).toContain("不是");
    expect(text).toContain("TaskSession");
  });

  it("404 但 error.type 不是 not_found:不算「任务不存在」(那是另一种故障)", () => {
    const other = new ApiError({ kind: "http", status: 404, errorType: "artifact_missing" }, "/x");
    expect(isTaskNotFound(other)).toBe(false);
    expect(detailFailureText(other)).toContain("artifact_missing");
  });

  it("四种失败 + 意外异常各一句,互不重复", () => {
    const errors: unknown[] = [
      new ApiError({ kind: "unauthorized", status: 401 }, "/x"),
      new ApiError({ kind: "http", status: 500, errorType: null }, "/x"),
      new ApiError({ kind: "network" }, "/x"),
      new ApiError({ kind: "shape", status: 200, detail: "text/html" }, "/x"),
      new Error("bug"),
      notFound,
    ];
    const texts = errors.map(detailFailureText);
    expect(new Set(texts).size).toBe(texts.length);
    expect(texts[1]).toContain("500");
    expect(texts[2]).toContain("不是「任务不存在」");
    expect(texts[3]).toContain("run_worker_first");
    expect(texts[4]).toContain("页面这边");
    // §7 头号风险:200 + HTML 不能被说成「服务端拒绝」
    expect(texts[3]).not.toContain("服务端答复");
  });

  it("http 无 errorType 时不括一个 null 出来", () => {
    expect(detailFailureText(new ApiError({ kind: "http", status: 503, errorType: null }, "/x"))).not.toContain("null");
  });

  it("补齐的失败文案必带「已读到的仍然保留」(停更与清空是两种不同的谎)", () => {
    for (const err of [
      new ApiError({ kind: "network" }, "/x"),
      new ApiError({ kind: "shape", status: 200, detail: "y" }, "/x"),
      new ApiError({ kind: "unauthorized", status: 401 }, "/x"),
      new ApiError({ kind: "http", status: 400, errorType: "invalid_after" }, "/x"),
      new Error("bug"),
    ]) {
      expect(pullFailureText(err), String(err)).toMatch(/保留|仍然/);
    }
    expect(pullFailureText(new ApiError({ kind: "http", status: 400, errorType: "invalid_after" }, "/x"))).toContain(
      "invalid_after",
    );
  });

  it("空态与失败态分开,而空态本身说清「不是没读到」", () => {
    const empty = timelineEmptyText(INITIAL_PULL, 0, false);
    expect(empty).toContain("不是没读到");
    expect(timelineEmptyText(INITIAL_PULL, 0, true)).not.toBe(empty);
    expect(timelineEmptyText({ ...INITIAL_PULL, failure: "x" }, 0, false)).not.toBe(empty);
    // 收到了帧却一条都读不出来:指向计数行,而不是说「还没有事件」
    expect(timelineEmptyText(INITIAL_PULL, 5, false)).toContain("坏帧");
  });
});

describe("开流的时机与三类徽章", () => {
  it("快照答了 404 就不开流(否则 CLOSED 的文案会把「id 不存在」说成「会话失效」)", () => {
    expect(streamEnabledFor(false, false)).toBe(false);
    expect(streamEnabledFor(true, true)).toBe(false);
    expect(streamEnabledFor(true, false)).toBe(true);
  });

  it("连接徽章:收尾 > error > 正常;收尾那句不带色;reauth 原样带出(401 的出口只有这一个)", () => {
    const closed = { text: "连接已关闭,浏览器不会自动重连", tone: "err" as Tone, reauth: true };
    const reconnecting = { text: "连接中断,浏览器正在自动重连(第 1 次)", tone: "warn" as Tone, reauth: false };
    expect(connectionBadge(closed, false, "已连接", STREAM_ENDED_TEXT)).toEqual({
      text: "连接已关闭,浏览器不会自动重连",
      tone: "err",
      reauth: true,
    });
    // 收尾优先:已结束的流不再承诺「正在重连」,也不再给重新登录的出口
    expect(connectionBadge(closed, true, "已连接", STREAM_ENDED_TEXT).text).toBe(STREAM_ENDED_TEXT);
    expect(connectionBadge(closed, true, "已连接", STREAM_ENDED_TEXT).reauth).toBe(false);
    expect(connectionBadge(reconnecting, false, "已连接", STREAM_ENDED_TEXT).tone).toBe("warn");
    expect(connectionBadge(null, false, "已连接", STREAM_ENDED_TEXT).tone).toBe("ok");
    expect(connectionBadge(null, false, "已连接", STREAM_ENDED_TEXT).reauth).toBe(false);
  });

  it("end 帧那句带总条数,读不懂数字时不硬凑", () => {
    expect(endFrameLine(STREAM_ENDED_TEXT, 451)).toContain("451");
    expect(endFrameLine(STREAM_ENDED_TEXT, null)).not.toMatch(/\d/);
    expect(endFrameLine(STREAM_ENDED_TEXT, 3)).toContain("state 徽章");
  });

  it("快照没读到答复之前不编一个 state,收尾时也不猜精确终态", () => {
    expect(stateDisplay(null, false)).toEqual({ state: "未知(快照未读到)", known: false });
    expect(stateDisplay(null, true).state).toContain("非 RUNNING");
    expect(stateDisplay("BLOCKED", true)).toEqual({ state: "BLOCKED", known: true });
  });

  it("streamFramesOf:坏帧也占一个位置", () => {
    expect(streamFramesOf({ seen: 40, bad: 3 })).toBe(43);
  });

  it("快照时间戳只在真有答复时才给", () => {
    expect(snapshotReadNote(null, null)).toContain("还没有读到答复");
    expect(snapshotReadNote(0, null)).toContain("还没有读到答复");
    expect(snapshotReadNote(Date.parse("2026-09-06T10:00:00.000Z"), "RUNNING")).toContain(
      "2026-09-06T10:00:00.000Z",
    );
  });

  it("补齐那句话把覆盖率、翻尽、读不到的 attempt 一起说完", () => {
    const text = pullNote(
      {
        ...INITIAL_PULL,
        pulled: 3,
        items: [{ position: 1, seq: 1, ts: "t", kind: "assistant", payload: {} }],
        total: 3,
        requests: 2,
        unreadable: ["a-9"],
        exhausted: true,
      },
      true,
    );
    expect(text).toContain("补齐 1 条");
    expect(text).toContain("请求 2 次");
    expect(text).toContain("总条数 3");
    expect(text).toContain("a-9");
    expect(text).toContain("不完整的视图");
    expect(pullNote(INITIAL_PULL, true)).toContain("SSE 是这一页的当前数据源");
    expect(pullNote(INITIAL_PULL, false)).toBe("未使用拉取补齐。");
  });
});

describe("基线、digest、预算、attempts 的诚实口径", () => {
  const task = {
    id: "t",
    state: "BLOCKED",
    version: 4,
    created_at: "2026-09-06T09:00:00.000Z",
    updated_at: "2026-09-06T10:00:00.000Z",
    spec_digest: "0".repeat(64),
    base: { sha: "a".repeat(40), source: "pinned" },
    last_candidate_digest: "b".repeat(64),
    current_evidence: {
      writer_attempt_id: "w-1",
      writer_manifest_key: "k",
      writer_manifest_digest: "c".repeat(64),
    },
  };

  function snapshotWith(overrides: Record<string, unknown>): TaskSnapshot {
    return { task: { ...task, ...overrides }, attempts: [], events: [] } as unknown as TaskSnapshot;
  }

  it("digest 截断到 12 位,完整值留在 note(截断是排版,不是删信息)", () => {
    expect(truncateHash("0".repeat(64))).toEqual({ shown: `${"0".repeat(12)}…`, full: "0".repeat(64) });
    expect(truncateHash("short")).toEqual({ shown: "short", full: "short" });
    const rows = baselineFacts(snapshotWith({}).task);
    const baseRow = rows.find((row) => row.label === "base sha");
    expect(baseRow?.value).toBe(`${"a".repeat(12)}…`);
    expect(baseRow?.note).toContain(`source=pinned`);
    expect(baseRow?.note).toContain("a".repeat(40));
  });

  it("base 缺键 / null 都说「未固定」,不当成空串也不当成 0", () => {
    for (const value of [undefined, null]) {
      const row = baselineFacts(snapshotWith({ base: value }).task).find((r) => r.label === "base sha");
      expect(row?.absent, String(value)).toBe(true);
      expect(row?.value).toBe("—");
      expect(row?.note).toContain("基线未固定");
    }
  });

  it("没有 verifier 证据时那一行说「还没有」而不是空白", () => {
    const rows = baselineFacts(snapshotWith({}).task);
    expect(rows.find((row) => row.label === "verifier manifest digest")?.absent).toBe(true);
    const withVerifier = baselineFacts(
      snapshotWith({
        current_evidence: { ...task.current_evidence, verifier_manifest_digest: "d".repeat(64) },
      }).task,
    );
    expect(withVerifier.find((row) => row.label === "verifier manifest digest")?.absent).toBe(false);
  });

  it("current_evidence 为 null 时不编 attempt id", () => {
    const rows = baselineFacts(snapshotWith({ current_evidence: null }).task);
    const row = rows.find((r) => r.label === "钉住的证据");
    expect(row?.absent).toBe(true);
    expect(rows.some((r) => r.label === "writer manifest digest")).toBe(false);
  });

  it("clampFacts:从链上字符串 payload 里取,取最后一条,读不懂的链不抛", () => {
    const clampRow = (seq: number, payload: unknown) => ({
      seq,
      kind: BUDGET_CLAMP_KIND,
      payload: typeof payload === "string" ? payload : JSON.stringify(payload),
      digest: "d",
      prev_digest: null,
      created_at: "2026-09-06T10:00:00.000Z",
    });
    const snapshot = {
      task,
      attempts: [],
      events: [
        { seq: 1, kind: "task.created", payload: "{}", digest: "d", prev_digest: null, created_at: "t" },
        clampRow(2, {
          attempt_id: "a-1",
          requested_seconds: 5400,
          writer_wall_minutes: 90,
          ceiling_minutes: 90,
          clamp_reason: "wall_clamped",
        }),
        clampRow(3, {
          attempt_id: "a-2",
          requested_seconds: 7200,
          writer_wall_minutes: 25,
          ceiling_minutes: 25,
          clamp_reason: "platform_ceiling",
        }),
      ],
    } as never;
    const facts = clampFacts(snapshot);
    expect(facts).toEqual({
      rows: 2,
      unreadable: 0,
      requestedSeconds: 7200,
      writerWallMinutes: 25,
      ceilingMinutes: 25,
      reason: "platform_ceiling",
    });
    // payload 不是合法 JSON:计数而不是当没有 —— 「有留痕而读不懂」与「没有留痕」两句话
    const unreadable = clampFacts({
      task,
      attempts: [],
      events: [clampRow(1, "not json"), clampRow(2, { requested_seconds: 600 })],
    } as never);
    expect(unreadable).toEqual({
      rows: 2,
      unreadable: 1,
      requestedSeconds: 600,
      writerWallMinutes: null,
      ceilingMinutes: null,
      reason: null,
    });
    // 一条都读不懂时也绝不是「没被夹过」:budgetFacts 那一行必须留在原地并说不完整
    const allBad = budgetFacts({
      task,
      attempts: [],
      events: [clampRow(1, "nope")],
    } as never);
    const badRow = allBad.rows.find((row) => row.label === "墙钟夹钳留痕");
    expect(badRow?.absent).toBe(true);
    expect(badRow?.note).toContain("全都解不出来");
    expect(clampFacts({ task, attempts: [], events: [] } as never)).toBeNull();
    expect(clampFacts(null)).toBeNull();
    // 链上一条都没有 → 才允许说「没被夹过」
    expect(
      budgetFacts({ task, attempts: [], events: [] } as never).rows.find(
        (row) => row.label === "墙钟夹钳留痕",
      )?.note,
    ).toContain("一条 budget.clamped 都没有");
  });

  it("budgetFacts:只有用量合计与夹钳留痕,并且明说上限不在这条端点上", () => {
    const snapshot = {
      task,
      attempts: [
        { id: "a1", role: "writer", state: "BLOCKED", tokens_used: 100, created_at: "t", finished_at: null },
        { id: "a2", role: "reviewer", state: "SUCCEEDED", tokens_used: 23, created_at: "t", finished_at: "t" },
      ],
      events: [],
    } as never;
    const facts = budgetFacts(snapshot);
    expect(facts.rows.find((row) => row.label === "attempts 用量合计")?.value).toBe("123");
    expect(facts.boundary).toContain("六列");
    expect(facts.boundary).toContain("max_wall_seconds");
    expect(facts.boundary).toContain("GET /api/admin/attempts");
    // 不猜一个看着像上限的数:文案里不许出现「预算 = 」这种断言
    expect(facts.boundary).not.toMatch(/预算\s*=/);
    expect(budgetFacts(null).rows.find((row) => row.label === "轮次数")?.value).toBe("0");
  });

  it("attempt 时长:没结束 / 时间不可解析 / 倒序都给 null 而不是 0", () => {
    expect(attemptDurationSeconds("2026-09-06T10:00:00.000Z", null)).toBeNull();
    expect(attemptDurationSeconds("昨天", "2026-09-06T10:01:00.000Z")).toBeNull();
    expect(attemptDurationSeconds("2026-09-06T10:02:00.000Z", "2026-09-06T10:01:00.000Z")).toBeNull();
    expect(attemptDurationSeconds("2026-09-06T10:00:00.000Z", "2026-09-06T10:02:30.000Z")).toBe(150);
    const row = attemptRowView({
      id: "0f4c1a2b-3d4e-5f60-7182-93a4b5c6d7e8",
      role: "writer",
      state: "RUNNING",
      tokens_used: 5,
      created_at: "2026-09-06T10:00:00.000Z",
      finished_at: null,
    });
    expect(row.shortId).toBe("0f4c1a2b");
    expect(row.finished).toBe("—");
    expect(row.duration).toContain("仍在进行");
    expect(row.tokens).toBe("5");
  });
});

// ── 5. 与真服务端对表:形状是转写出来的,不是猜的 ─────────────────────────────

interface SeedResult {
  taskId: string;
  attemptIds: string[];
}

/** 造一个 RUNNING 中的任务,并按 perAttempt 的条数为每条 attempt 摄取一轮 journal 事件。 */
async function seedTask(perAttempt: number[]): Promise<SeedResult> {
  const taskId = crypto.randomUUID();
  const stub = ns().get(ns().idFromName(taskId));
  await stub.createTask({ prompt: "w4a 对表任务", base_sha: "f".repeat(40) }, taskId);
  const attemptIds: string[] = [];
  for (let i = 0; i < perAttempt.length; i++) {
    const { attempt_id } = await stub.startAttempt({
      role: "writer",
      idempotency_key: `${taskId}:attempt:${i + 1}`,
      max_model_tokens: 1000,
      max_wall_seconds: 600,
    });
    attemptIds.push(attempt_id);
    const rows = Array.from({ length: perAttempt[i] }, (_, n) =>
      JSON.stringify({
        type: "assistant",
        content: [{ type: "text", text: `attempt${i} turn${n}` }],
        usage: { input_tokens: n, output_tokens: 1 },
      }),
    );
    const reader: ObsTranscriptReader = {
      async readFile() {
        return { content: rows.length > 0 ? `${rows.join("\n")}\n` : "" };
      },
    };
    await ingestTranscript({
      bucket: env.ARTIFACTS,
      reader,
      taskId,
      attemptId: attempt_id,
      now: () => `2026-09-01T00:0${i}:00.000Z`,
    });
  }
  return { taskId, attemptIds };
}

/**
 * 把全局 fetch 换成「打到真 worker」。
 *
 * 为什么不只用 worker.fetch:那样测的是测试自己的拼 URL 能力,而不是这一页真的发出去的那个
 * URL。换成打真 worker 之后,`apiRequest` 的介质检查、zod 校验、四种失败分类与这里的
 * 判据全都在同一条链上跑一遍。凭据仍走 Bearer(浏览器那条 cookie 路径由
 * test/session-auth.test.ts 管,不是这一页的判据)。
 */
function stubFetchToWorker(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init: RequestInit) => {
      const url = new URL(String(input), "https://example.com");
      const headers = new Headers(init.headers as HeadersInit | undefined);
      headers.set("authorization", `Bearer ${TOKEN}`);
      return worker.fetch(
        new Request(url, { method: init.method ?? "GET", headers }),
        env,
        createExecutionContext(),
      );
    }),
  );
}

beforeAll(applyMigrations);

describe("与真端点对表:GET /api/tasks/:id", () => {
  it("快照答复被 taskSnapshotSchema 接受,且 attempts 真的只有那六列(「上限读不到」是真话)", async () => {
    const { taskId, attemptIds } = await seedTask([1]);
    const res = await directFetch(taskSnapshotUrl(taskId));
    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = taskSnapshotSchema.safeParse(body);
    expect(parsed.success, JSON.stringify((parsed as { error?: unknown }).error)).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.task.id).toBe(taskId);
    expect(parsed.data.task.state).toBe("RUNNING");
    expect(parsed.data.attempts.map((row) => row.id)).toEqual(attemptIds);
    // 这一条是 budgetFacts.boundary 那句话的凭据:列集合恰好这六个,多一个都算我说错了。
    expect(Object.keys(parsed.data.attempts[0] ?? {}).sort()).toEqual([
      "created_at",
      "finished_at",
      "id",
      "role",
      "state",
      "tokens_used",
    ]);
    expect(JSON.stringify(body)).not.toContain("max_wall_seconds");
  });

  it("base_sha 与 spec_digest 在快照里可读(入口 pin 过的基线真的落到 task.base)", async () => {
    const { taskId } = await seedTask([1]);
    const snapshot = await fetchTaskSnapshotWithWorker(taskId);
    const rows = baselineFacts(snapshot.task);
    const baseRow = rows.find((row) => row.label === "base sha");
    expect(baseRow?.absent).toBe(false);
    expect(baseRow?.note).toContain("f".repeat(40));
    expect(rows.find((row) => row.label === "spec_digest")?.absent).toBe(false);
    // 还没产出候选、还没钉住证据:两行都得说「未记录」而不是空串。
    expect(rows.find((row) => row.label === "last_candidate_digest")?.value).toBe("—");
    expect(rows.find((row) => row.label === "钉住的证据")?.absent).toBe(true);
  });

  it("404 走 not_found:文案与「不开流」两件事都由同一个判据决定", async () => {
    const missing = crypto.randomUUID();
    stubFetchToWorker();
    const err = await fetchTaskSnapshot(missing).catch((caught: unknown) => caught);
    expect(isTaskNotFound(err)).toBe(true);
    expect(streamEnabledFor(true, isTaskNotFound(err))).toBe(false);
    expect(detailFailureText(err)).toContain("404");
  });

  it("畸形 id 与不存在的 id 吃同一句 404 not_found(路由正则不匹配就落到总 404)", async () => {
    // `/^\/api\/tasks\/([0-9a-f-]{36})(…)?$/` 不匹配 → src/index.ts 末尾那条统一 404。
    // 两件事由此钉住:① 前端不复核 id 形状也不会漏出「另一种错误」;② 这一页的 404 文案
    // 必须同时盖住「id 打错」与「没建过它」两种可能(它确实盖住了,见 detailFailureText)。
    stubFetchToWorker();
    const err = await fetchTaskSnapshot("not-a-uuid").catch((caught: unknown) => caught);
    expect(err).toBeInstanceOf(ApiError);
    expect(isTaskNotFound(err)).toBe(true);
    const text = detailFailureText(err);
    expect(text).toContain("404");
    expect(text).toContain("打错");
    expect(streamEnabledFor(true, true)).toBe(false);
  });
});

describe("与真端点对表:GET /api/tasks/:id/events", () => {
  it("一页读全部:形状合法,位置游标与服务端的 next_cursor 同口径", async () => {
    const { taskId } = await seedTask([3]);
    stubFetchToWorker();
    const pageOne = await fetchTaskEvents(taskId, 0);
    const parsed = taskEventsPageSchema.safeParse({ ...pageOne });
    expect(parsed.success).toBe(true);
    expect(pageOne.count).toBe(3);
    expect(pageOne.total).toBe(3);
    expect(pullHasMore(0, pageOne)).toBe(false);

    // 与真端点的原始答复对表:next_cursor 与 pullHasMore 必须说的是同一件事。
    const raw = (await (
      await directFetch(`${taskSnapshotUrl(taskId)}/events?after=0&limit=500`)
    ).json()) as { next_cursor: number | null };
    expect(raw.next_cursor).toBeNull();
  });

  it("跨 attempt 分页翻尽:一页两条地读,合起来既不重发也不漏读", async () => {
    const { taskId, attemptIds } = await seedTask([3, 2]);
    stubFetchToWorker();
    const final = await runEventsPull(taskId, 0, INITIAL_PULL, () => {}, (id, after) =>
      fetchTaskEvents(id, after),
    );
    // limit=500 装得下 5 条,所以这一轮一次就翻尽 —— 翻页路径由下一条(小 limit)钉。
    expect(final.items.map((item) => item.position)).toEqual([1, 2, 3, 4, 5]);
    expect(final.pulled).toBe(5);
    expect(final.exhausted).toBe(true);
    expect(final.bad).toBe(0);
    expect(final.unreadable).toEqual([]);
    // 顺序就是服务端口径:attempt 创建序,attempt 内按 generation/seq 升序。
    const identities = final.items.map((item) => `${item.seq}`);
    expect(identities).toEqual(["1", "2", "3", "1", "2"]);
    // 事件确实来自两条 attempt(合并成一条时间线的前提)。
    expect(attemptIds.length).toBe(2);
  });

  it("一页只装两条时也要翻尽(小 limit 手动钉翻页路径,与 pullHasMore 同一把尺)", async () => {
    const { taskId } = await seedTask([3, 2]);
    stubFetchToWorker();
    const seen: number[] = [];
    const reader: TaskEventsReader = async (id, after) => {
      seen.push(after);
      const res = await directFetch(`${taskSnapshotUrl(id)}/events?after=${after}&limit=2`);
      const body = (await res.json()) as Record<string, unknown>;
      return { ...body, unreadable_attempts: body.unreadable_attempts ?? [] } as never;
    };
    const final = await runEventsPull(taskId, 0, INITIAL_PULL, () => {}, reader);
    expect(seen).toEqual([0, 2, 4]);
    expect(final.items.map((item) => item.position)).toEqual([1, 2, 3, 4, 5]);
    expect(final.exhausted).toBe(true);
    // 每一次续读位点都等于服务端自己的 next_cursor:两条腿真的是同一个口径。
    expect(final.requests).toBe(3);
  });

  it("`after` 不是 seq:拿 per-attempt 的 seq 当续读点会静默漏读(派单点名的那条注释)", async () => {
    const { taskId } = await seedTask([3, 2]);
    stubFetchToWorker();
    const full = await fetchTaskEvents(taskId, 0);
    // 第二条 attempt 的 seq 从 1 重新开始,而扁平位置是 4、5。
    expect(full.events.map((raw) => (raw as { seq: number }).seq)).toEqual([1, 2, 3, 1, 2]);
    const wrong = await fetchTaskEvents(taskId, 2); // 若 after 是 seq,这一句该给出 attempt2 的两条
    expect(wrong.events.map((raw) => (raw as { seq: number }).seq)).toEqual([3, 1, 2]);
    expect(wrong.total).toBe(5);
    // 正确用法:扁平位置 2 之后就是第 3 条起。
    expect(full.count).toBe(5);
  });

  it("反向对照:空值 after 与超限 limit 都被服务端拒(所以那两个值不许被拼进 URL)", async () => {
    const { taskId } = await seedTask([1]);
    const emptyAfter = await directFetch(`${taskSnapshotUrl(taskId)}/events?after=&limit=500`);
    expect(emptyAfter.status).toBe(400);
    expect(((await emptyAfter.json()) as { error: { type: string } }).error.type).toBe("invalid_after");
    const overLimit = await directFetch(`${taskSnapshotUrl(taskId)}/events?after=0&limit=2001`);
    expect(overLimit.status).toBe(400);
    expect(((await overLimit.json()) as { error: { type: string } }).error.type).toBe("invalid_limit");
  });

  it("URL 由 taskEventsUrl 一处拼出:经 fetchTaskEvents 打出去就是 200", async () => {
    const { taskId } = await seedTask([2]);
    stubFetchToWorker();
    await expect(fetchTaskEvents(taskId, 1)).resolves.toMatchObject({ count: 1, total: 2 });
    expect(taskEventsUrl(taskId, 0)).toBe(`/api/tasks/${taskId}/events?after=0&limit=${TASK_EVENTS_PAGE_LIMIT}`);
  });
});

describe("与真端点对表:SSE 路径", () => {
  it("taskStreamUrl 打到真 worker 得到 200 + text/event-stream(路径漂了就是 HTML 或 404)", async () => {
    const { taskId } = await seedTask([1]);
    const res = await directFetch(taskStreamUrl(taskId));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
    await res.body?.cancel().catch(() => undefined);
  });

  it("不存在的任务:流与快照同口径给 404(在建流之前判掉,所以这里不是 HTML)", async () => {
    const res = await directFetch(taskStreamUrl(crypto.randomUUID()));
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
  });

  it("路径带 `/` 的 id 会被编码,不会跑到别的端点上去", () => {
    expect(taskStreamUrl("a/b")).toBe("/api/tasks/a%2Fb/events/stream");
    expect(taskSnapshotUrl("../x")).toBe("/api/tasks/..%2Fx");
  });
});

/** 带凭据地直打真 worker(不经前端那条 fetch 分类,用来读原始字段做对照)。 */
async function directFetch(path: string): Promise<Response> {
  return worker.fetch(
    new Request(`https://example.com${path}`, { headers: { authorization: `Bearer ${TOKEN}` } }),
    env,
    createExecutionContext(),
  );
}

/** 用真端点的答复走一遍本页的读法(apiGet + zod + 失败分类),拿快照本体。 */
async function fetchTaskSnapshotWithWorker(taskId: string) {
  stubFetchToWorker();
  return fetchTaskSnapshot(taskId);
}
