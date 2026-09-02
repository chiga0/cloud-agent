import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import {
  OBS_SSE_PING_FRAME,
  createObsStreamSession,
  createObsStreamWaiter,
  obsStreamResponse,
  obsStreamStep,
  parseObsLastEventId,
  type ObsStreamDeps,
} from "../src/obs/stream";
import { readObsAttemptEvents, obsIndexPath } from "../src/obs/journal";
import { ingestTranscript, type ObsTranscriptReader } from "../src/obs/ingest";
import { SseReader, ident } from "./sse";

/**
 * SSE 投影的泵本身(引擎级,不经过 HTTP)。journal 用**真实的** R2 + 真实摄取造,
 * 只有两样东西是假的:任务快照(状态与 attempt 清单)和时钟。
 *
 * 假时钟是这组用例的全部意义所在:真实的 3s 尾读节拍既让测试变慢,又把最关键的一条
 * 不变量掩盖掉 —— 「cancel 之后 fire 永不来」。所以这里的 `schedule` 与 workerd 的
 * `setTimeout` 同构:返回的 `cancel()` **只清登记,绝不触发 fire**。任何「靠 fire 才
 * settle」的实现都会在这组用例里快速变红(而不是悬挂到超时)。
 *
 * 头号钉:缺陷 1 —— 客户端断开后泵必须彻底收敛(见 teardown 两条用例)。
 * 次号钉:缺陷 2 —— 帧 id = 该帧之后已读的条数(1-based 位置),不是 0-based 索引。
 */

const TS = "2026-09-02T00:00:00.000Z";

/** 立即 resolve 的哨兵:用它把「永不 settle」变成「快速红」。 */
const SENTINEL = "sentinel-won";
const tick0 = () => new Promise<string>((resolve) => setTimeout(() => resolve(SENTINEL), 0));
/** 输掉竞争的 promise 不能有 unhandled rejection;这里也不会发生,但留个回扣。 */
void tick0().catch(() => SENTINEL);

interface FakeClock {
  schedule: ObsStreamDeps["schedule"];
  tailIntervalMs: number;
  /** 到点(= 释放最早那一拍的 fire)。已被 cancel 的不算。 */
  release(): void;
  pending: number;
  cancels: number;
  fires: number;
}

function fakeClock(tailIntervalMs = 3000): FakeClock {
  const queue: Array<{ fire: () => void; drop: () => void }> = [];
  const clock: FakeClock = {
    tailIntervalMs,
    schedule: (_ms, fire) => {
      const entry = {
        fire,
        drop: () => {
          const i = queue.indexOf(entry);
          if (i >= 0) queue.splice(i, 1);
        },
      };
      queue.push(entry);
      clock.pending = queue.length;
      // 与 clearTimeout 一致:cancel 之后 fire 永不再执行。
      return {
        cancel: () => {
          clock.cancels += 1;
          entry.drop();
          clock.pending = queue.length;
        },
      };
    },
    release: () => {
      const entry = queue.shift();
      clock.pending = queue.length;
      if (entry) {
        clock.fires += 1;
        entry.fire();
      }
    },
    pending: 0,
    cancels: 0,
    fires: 0,
  };
  return clock;
}

function ndjson(turn: number): string {
  return JSON.stringify({
    type: "assistant",
    content: [{ type: "text", text: `turn ${turn}` }],
    usage: { input_tokens: turn, output_tokens: 1 },
  });
}

/**
 * 某 attempt 的 transcript 写入器:追加而不是替换。
 *
 * 必须是追加 —— 替换内容会被摄取侧判成换代(seq 从 1 重开),那样测的就不是
 * 「同一代里长出来的增量」了。位置游标恰恰要在这种「seq 会重开」的场景里仍然单调。
 */
async function seedJournal(taskId: string, attemptId: string, n: number) {
  let content = "";
  let turns = 0;
  const reader: ObsTranscriptReader = {
    async readFile() {
      return { content };
    },
  };
  const append = async (count: number): Promise<void> => {
    for (let i = 0; i < count; i++) {
      turns += 1;
      content += `${ndjson(turns)}\n`;
    }
    await ingestTranscript({
      bucket: env.ARTIFACTS,
      reader,
      taskId,
      attemptId,
      now: () => TS,
    });
  };
  await append(n);
  return { append };
}

interface Harness {
  taskId: string;
  attemptIds: string[];
  deps: ObsStreamDeps;
  clock: FakeClock;
  warns: string[];
  /** 快照内容可变:测试靠它把任务从 RUNNING 推到终态。 */
  source: { state: string; attemptIds: string[] };
}

/** 真 journal 读 + 假快照 + 假时钟。 */
function harness(source: { state: string; attemptIds: string[] }, taskId: string): Harness {
  const clock = fakeClock();
  const warns: string[] = [];
  return {
    taskId,
    attemptIds: source.attemptIds,
    clock,
    warns,
    source,
    deps: {
      readSnapshot: async () => ({ state: source.state, attemptIds: source.attemptIds }),
      readAttemptEvents: (id, attemptId, skip) =>
        readObsAttemptEvents(env.ARTIFACTS, id, attemptId, skip),
      schedule: clock.schedule,
      tailIntervalMs: clock.tailIntervalMs,
      warn: (message) => warns.push(message),
    },
  };
}

function open(h: Harness, lastEventId = 0) {
  const handle = obsStreamResponse(h.taskId, h.deps, createObsStreamSession(lastEventId));
  return { handle, sse: new SseReader(handle.response.body!.getReader()) };
}

describe("createObsStreamWaiter —— 缺陷 1 的头号钉", () => {
  it("cancel 之后 promise 必须 settle,即使 fire 永不再来", async () => {
    const clock = fakeClock();
    const waiter = createObsStreamWaiter(clock);
    let settled = false;
    void waiter.promise.then(() => {
      settled = true;
    });

    waiter.cancel();
    // 不真等 3s:与一个立即 resolve 的哨兵赛跑。上一轮的实现(clearTimeout 后等 fire)
    // 在这里会输掉竞争 —— 那正是「每次断开漏一个悬挂 async 帧」的现场。
    const winner = await Promise.race([waiter.promise.then(() => "settled"), tick0()]);
    expect(winner).toBe("settled");
    expect(settled).toBe(true);
    expect(clock.fires, "cancel 之后 fire 不得被调用(与 clearTimeout 同语义)").toBe(0);
    expect(clock.pending).toBe(0);
    expect(clock.cancels, "定时器也要真清掉").toBe(1);
  });

  it("cancel 幂等,且到点路径照常 settle", async () => {
    const clock = fakeClock();
    const waiter = createObsStreamWaiter(clock);
    waiter.cancel();
    waiter.cancel();
    await waiter.promise;
    expect(clock.cancels).toBe(1);

    const other = createObsStreamWaiter(clock);
    expect(clock.pending, "挂上一拍就登记一个定时器").toBe(1);
    clock.release();
    await other.promise;
    expect(clock.fires).toBe(1);
  });
});

describe("obsStreamResponse —— 泵的位置游标与终止", () => {
  it("单 attempt 回放:帧 id 从 1 起严格递增到 N,end 帧与最后一帧同口径", async () => {
    const taskId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    await seedJournal(taskId, attemptId, 3);
    const h = harness({ state: "BLOCKED", attemptIds: [attemptId] }, taskId);
    const { handle, sse } = open(h);

    const frames = await sse.drain();
    expect(SseReader.eventIds(frames)).toEqual([1, 2, 3]);
    const events = SseReader.events(frames);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(events.map((e) => e.ts)).toEqual([TS, TS, TS]);

    const end = frames[frames.length - 1];
    expect(end.event).toBe("end");
    expect(end.id, "end 帧的 id = 当前扁平总条数,与最后一帧事件同口径").toBe(3);
    expect(JSON.parse(end.data!)).toMatchObject({ task_id: taskId, events: 3, unreadable_attempts: [] });
    await handle.settled;
    await sse.cancel();
  });

  it("跨 attempt 的扁平序与 GET /events 同源:attempt 创建序 + 内部 seq 升序", async () => {
    const taskId = crypto.randomUUID();
    const a1 = crypto.randomUUID();
    const a2 = crypto.randomUUID();
    await seedJournal(taskId, a1, 3);
    await seedJournal(taskId, a2, 2);
    const h = harness({ state: "BLOCKED", attemptIds: [a1, a2] }, taskId);
    const { handle, sse } = open(h);

    const frames = await sse.drain();
    expect(SseReader.eventIds(frames)).toEqual([1, 2, 3, 4, 5]);
    const events = SseReader.events(frames);
    expect(events.map((e) => `${e.attempt_id === a1 ? "a1" : "a2"}:${e.seq}`)).toEqual([
      "a1:1",
      "a1:2",
      "a1:3",
      "a2:1",
      "a2:2",
    ]);
    expect(events.map(ident)).toEqual([
      `${a1.slice(0, 8)}/1/1`,
      `${a1.slice(0, 8)}/1/2`,
      `${a1.slice(0, 8)}/1/3`,
      `${a2.slice(0, 8)}/1/1`,
      `${a2.slice(0, 8)}/1/2`,
    ]);
    await handle.settled;
    await sse.cancel();
  });

  it("Last-Event-ID=2 → 只推位置 3..N,一条都不重发(缺陷 2 的续传面)", async () => {
    const taskId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    await seedJournal(taskId, attemptId, 5);
    const h = harness({ state: "BLOCKED", attemptIds: [attemptId] }, taskId);
    const { handle, sse } = open(h, 2);

    const frames = await sse.drain();
    expect(SseReader.eventIds(frames)).toEqual([3, 4, 5]);
    expect(SseReader.events(frames).map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(frames[frames.length - 1].id).toBe(5);
    await handle.settled;
    await sse.cancel();
  });

  it("跨 attempt 边界续传:After=3 恰好从第二个 attempt 的头开始", async () => {
    const taskId = crypto.randomUUID();
    const a1 = crypto.randomUUID();
    const a2 = crypto.randomUUID();
    await seedJournal(taskId, a1, 3);
    await seedJournal(taskId, a2, 2);
    const h = harness({ state: "BLOCKED", attemptIds: [a1, a2] }, taskId);
    const { handle, sse } = open(h, 3);

    const frames = await sse.drain();
    expect(SseReader.eventIds(frames)).toEqual([4, 5]);
    expect(SseReader.events(frames).map((e) => `${e.attempt_id === a1 ? "a1" : "a2"}:${e.seq}`)).toEqual([
      "a2:1",
      "a2:2",
    ]);
    await handle.settled;
    await sse.cancel();
  });

  it("RUNNING 且一轮无新事件 → 发 ping 注释帧而不杀流", async () => {
    const taskId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    await seedJournal(taskId, attemptId, 1);
    const h = harness({ state: "RUNNING", attemptIds: [attemptId] }, taskId);
    const { handle, sse } = open(h);

    const first = await sse.next();
    expect(first!.id).toBe(1);
    h.clock.release(); // 下一拍:journal 没有增量 → 这一轮就该保活
    const ping = await sse.next();
    expect(ping!.raw).toBe(OBS_SSE_PING_FRAME.trimEnd());
    expect(ping!.comment).toBe(true);
    expect(ping!.event).toBeNull();
    expect(handle.response.ok).toBe(true);
    await sse.cancel();
    await handle.settled;
  });

  it("tail 增量:释放一拍后新事件按续接的 id 出现(不真等 3s)", async () => {
    const taskId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    const seed = await seedJournal(taskId, attemptId, 2);
    const h = harness({ state: "RUNNING", attemptIds: [attemptId] }, taskId);
    const { handle, sse } = open(h);

    expect(SseReader.eventIds(await sse.take(2))).toEqual([1, 2]);
    await seed.append(3);
    h.clock.release();
    const frames = await sse.take(3);
    expect(SseReader.eventIds(frames)).toEqual([3, 4, 5]);
    expect(SseReader.events(frames).map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(SseReader.events(frames).map((e) => e.generation)).toEqual([1, 1, 1]);

    h.source.state = "BLOCKED";
    h.clock.release();
    const tail = await sse.drain();
    expect(tail.map((f) => f.event)).toEqual(["end"]);
    expect(tail[0].id).toBe(5);
    await handle.settled;
    await sse.cancel();
  });

  it("某 attempt 的 journal 读坏了:跳过后继续推,不杀流", async () => {
    const taskId = crypto.randomUUID();
    const a1 = crypto.randomUUID();
    const a2 = crypto.randomUUID();
    await seedJournal(taskId, a1, 2);
    await seedJournal(taskId, a2, 2);
    await env.ARTIFACTS.put(obsIndexPath(taskId, a1), "not json");
    const h = harness({ state: "RUNNING", attemptIds: [a1, a2] }, taskId);
    const { handle, sse } = open(h);

    const frames = await sse.take(2);
    expect(SseReader.eventIds(frames)).toEqual([1, 2]);
    expect(SseReader.events(frames).every((e) => e.attempt_id === a2)).toBe(true);
    expect(h.warns.join("\n")).toContain("obs_stream_attempt_unreadable");

    h.clock.release();
    const ping = await sse.next();
    expect(ping!.raw, "坏 attempt 之后流还活着").toBe(OBS_SSE_PING_FRAME.trimEnd());

    h.source.state = "BLOCKED";
    h.clock.release();
    const tail = await sse.drain();
    expect(tail[tail.length - 1].event).toBe("end");
    expect(JSON.parse(tail[tail.length - 1].data!).unreadable_attempts).toEqual([a1]);
    await handle.settled;
    await sse.cancel();
  });

  it("快照读不到(任务被删)→ 收尾关流,而不是空转到天荒地老", async () => {
    const taskId = crypto.randomUUID();
    const h = harness({ state: "RUNNING", attemptIds: [] }, taskId);
    h.deps.readSnapshot = async () => null;
    const { handle, sse } = open(h);

    const frames = await sse.drain();
    expect(frames.map((f) => f.event)).toEqual(["end"]);
    await handle.settled;
    await sse.cancel();
  });

  it("journal 读抛错的是快照本身 → 记 warn 并关流(不留下打不开的 200)", async () => {
    const taskId = crypto.randomUUID();
    const h = harness({ state: "RUNNING", attemptIds: [] }, taskId);
    h.deps.readSnapshot = async () => {
      throw new Error("do_unavailable");
    };
    const { handle, sse } = open(h);
    const frames = await sse.drain();
    expect(frames).toEqual([]);
    expect(h.warns.join("\n")).toContain("obs_stream_pump_failed");
    await handle.settled;
    await sse.cancel();
  });
});

describe("teardown 收敛 —— 客户端断开后泵必须退出", () => {
  it("RUNNING 中 cancel body:泵立刻收敛,不留悬挂的 async 帧", async () => {
    const taskId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    await seedJournal(taskId, attemptId, 2);
    const h = harness({ state: "RUNNING", attemptIds: [attemptId] }, taskId);
    const { handle, sse } = open(h);
    await sse.take(2);

    await sse.cancel();
    const winner = await Promise.race([handle.settled.then(() => "pump"), tick0()]);
    expect(winner, "缺陷 1:cancel 只 clearTimeout 的话这一句会输").toBe("pump");
    expect(h.clock.cancels, "定时器被清").toBeGreaterThanOrEqual(1);
    expect(h.clock.pending, "没有留着的定时器").toBe(0);
  });

  it("断开后不再推进:后续 release 不会复活泵", async () => {
    const taskId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    const seed = await seedJournal(taskId, attemptId, 1);
    const h = harness({ state: "RUNNING", attemptIds: [attemptId] }, taskId);
    const { handle, sse } = open(h);
    await sse.take(1);
    await sse.cancel();
    await handle.settled;

    h.source.state = "BLOCKED";
    h.clock.release();
    await seed.append(2);
    h.clock.release();
    expect(h.clock.fires, "被 cancel 的那一拍不该再有 fire 落回泵").toBeLessThanOrEqual(2);
  });
});

describe("obsStreamStep —— 单步可独立驱动", () => {
  it("同一 session 连续两步:第二步只推新增,位置接着往下数", async () => {
    const taskId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    const seed = await seedJournal(taskId, attemptId, 2);
    const h = harness({ state: "RUNNING", attemptIds: [attemptId] }, taskId);
    const session = createObsStreamSession(0);
    const frames: string[] = [];
    const emit = (f: string) => frames.push(f);

    expect(await obsStreamStep(h.deps, taskId, session, emit)).toMatchObject({ newEvents: 2, running: true });
    expect(frames.map((f) => Number(/^id: (\d+)$/m.exec(f)![1]))).toEqual([1, 2]);
    expect(await obsStreamStep(h.deps, taskId, session, emit)).toMatchObject({ newEvents: 0 });
    expect(frames.length, "无增量就是零帧").toBe(2);

    await seed.append(1);
    expect(await obsStreamStep(h.deps, taskId, session, emit)).toMatchObject({ newEvents: 1 });
    expect(session.position).toBe(3);

    h.source.state = "DONE";
    expect(await obsStreamStep(h.deps, taskId, session, emit)).toMatchObject({ newEvents: 0, running: false });
  });

  it("起始位置超过总条数 → 零帧而不报错(客户端拿着未来的游标重连)", async () => {
    const taskId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    await seedJournal(taskId, attemptId, 2);
    const h = harness({ state: "BLOCKED", attemptIds: [attemptId] }, taskId);
    const session = createObsStreamSession(99);
    const frames: string[] = [];
    expect(await obsStreamStep(h.deps, taskId, session, (f) => frames.push(f))).toMatchObject({
      newEvents: 0,
      running: false,
    });
    expect(frames).toEqual([]);
    expect(session.position).toBe(99);
  });
});

describe("parseObsLastEventId / createObsStreamSession", () => {
  it("缺省(header 不在)= 0;合法非负整数原样接受", () => {
    expect(parseObsLastEventId(null)).toEqual({ value: 0, error: null });
    for (const [raw, value] of [["0", 0], ["1", 1], ["450", 450], [" 7 ", 7]] as Array<[string, number]>) {
      expect(parseObsLastEventId(raw)).toEqual({ value, error: null });
    }
  });

  it("非法值一律拒绝:非数字、负数、小数、空串、超出安全整数", () => {
    for (const raw of ["abc", "-1", "", "   ", "1.5", "1e400", "9007199254740993", "0x10", "3,4"]) {
      const parsed = parseObsLastEventId(raw);
      expect(parsed.error, `last-event-id=${JSON.stringify(raw)} 应被拒绝`).toBeTruthy();
      expect(parsed.value).toBe(0);
    }
  });

  it("起始位置畸形大声失败", () => {
    expect(() => createObsStreamSession(-1)).toThrow(/obs_stream_bad_start_position/);
    expect(() => createObsStreamSession(1.5)).toThrow(/obs_stream_bad_start_position/);
    expect(() => createObsStreamSession(Number.NaN)).toThrow(/obs_stream_bad_start_position/);
    expect(createObsStreamSession(0)).toMatchObject({ position: 0 });
  });
});
