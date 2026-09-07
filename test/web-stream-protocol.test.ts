import { describe, expect, it } from "vitest";

import {
  AGENT_SILENT_YELLOW_MS,
  NO_HEARTBEAT_RED_MS,
} from "../src/supervisor/detect";
import { OBS_EVENT_KINDS, OBS_HEARTBEAT_KIND } from "../src/obs/events";
import { OBS_SSE_END_EVENT, OBS_SSE_EVENT } from "../src/obs/stream";
import { EVENT_KINDS, HEARTBEAT_KIND } from "../web/src/lib/kinds";
import {
  ES_READY_STATE_CLOSED,
  ES_READY_STATE_CONNECTING,
  ES_READY_STATE_OPEN,
  STALL_DANGER_SECONDS,
  STALL_WARN_SECONDS,
  SSE_AGENT_EVENT,
  SSE_END_EVENT,
  advanceStallClock,
  createStallClock,
  parseStreamFrame,
  stallView,
  streamConnectionView,
  streamCountsText,
  streamErrorView,
  STREAM_CONN_RULES,
} from "../web/src/lib/stream-protocol";
import { TEXT_SUMMARY_MAX_CHARS, kindBadgeClass, stateBadgeClass, summarize } from "../web/src/lib/view";
import { TASK_TRANSITIONS } from "../src/control/statemachine";

/**
 * SSE 协议层与「后端权威 ↔ 前端副本」的一致性(w2b 交付 ④的可测部分)。
 *
 * 两类断言,目的不同,别混着看:
 *
 * A. **与后端逐字比对**(`detect.ts` 的两个阈值、`OBS_EVENT_KINDS`、`live.ts` 的分支表、
 *    `stream.ts` 的 event 名)。这些数字与名单在前端有一份副本,而副本会漂。漂移的表现不是
 *    报错,是「同一个悬挂任务在 /live 页红、在 SPA 页绿」或「新 kind 静默没有徽章」——
 *    观测面互相矛盾时,操作员会不再相信任何一面(§7 设计语言的原话)。
 *    A 类断言是**这个文件存在的唯一前提**:没有它,前端的副本就是无凭据的抄写。
 *
 * B. **行为本身**:两条时间源、坏帧不更页、end 帧停表、401 与断连两个文案、
 *    `Date.now()` 差值抗节流。这些是从 c9b/c10b 的实测里留下来的判据(§5 的「逐条迁移」清单),
 *    每一条都对应一次真实的误报或漏报。
 *
 * 浏览器里 `EventSource` 真按这张表派发事件——单测钉不住,已在 use-event-stream.ts 标注
 * 「需浏览器实测」,由部署后操作员冒烟复查。
 */

const NOW = Date.parse("2026-09-06T10:00:00.000Z");

function agentFrame(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 1,
    task_id: "t-1",
    attempt_id: "a-1",
    generation: 1,
    seq: 3,
    ts: "2026-09-06T10:00:00Z",
    kind: "assistant",
    payload: { text: "hello" },
    ...overrides,
  });
}

describe("A 组:前端副本与后端权威逐字一致", () => {
  it("停滞两档阈值与 supervisor 判据同值(毫秒 → 秒,不另立数字)", () => {
    expect(STALL_DANGER_SECONDS).toBe(NO_HEARTBEAT_RED_MS / 1000);
    expect(STALL_WARN_SECONDS).toBe(AGENT_SILENT_YELLOW_MS / 1000);
    // 常识防线:红必须比黄先到(反了就是「模型静默判红」,而那条永不该红)。
    expect(STALL_DANGER_SECONDS).toBeLessThan(STALL_WARN_SECONDS);
  });

  it("kind 名单与 OBS_EVENT_KINDS 同序同值", () => {
    expect([...EVENT_KINDS]).toEqual([...OBS_EVENT_KINDS]);
  });

  it("心跳 kind 名与摄取侧常量同值(两条时间源全靠这个名字分开)", () => {
    expect(HEARTBEAT_KIND).toBe(OBS_HEARTBEAT_KIND);
  });

  it("SSE 的 event 名与 stream.ts 的导出一致(名字漂了就是前端静默收不到任何帧)", () => {
    expect(SSE_AGENT_EVENT).toBe(OBS_SSE_EVENT);
    expect(SSE_END_EVENT).toBe(OBS_SSE_END_EVENT);
  });

  it("显示截断长度就是 200(原与退役的 live 页互钉,w4b 后锚在这里)", () => {
    expect(TEXT_SUMMARY_MAX_CHARS).toBe(200);
  });

  it("连接分支表覆盖实测的三种落点,兜底必须排表末(顺序错就是静默的文案错配)", () => {
    // live 页退役(w4b)后这张表没有第二份副本可比对;取值的正确性由 c9c 浏览器实测
    // 背书(401 → CLOSED 且不重连,断连 → CONNECTING 每 3s 重连),这里钉结构:
    // CLOSED/CONNECTING 两条实测分支在前,null 兜底收尾且全表只有一条。
    expect(STREAM_CONN_RULES.map((r) => r.readyState)).toEqual([
      ES_READY_STATE_CLOSED,
      ES_READY_STATE_CONNECTING,
      null,
    ]);
    expect(STREAM_CONN_RULES.filter((r) => r.readyState === null)).toHaveLength(1);
    const closed = streamConnectionView(ES_READY_STATE_CLOSED, 0);
    expect(closed.text).toContain("不会自动重连");
    expect(closed.reconnecting).toBe(false);
  });

  it("状态机的每个取值都有色调归属(新状态不会静默变中性)", () => {
    const states = Object.keys(TASK_TRANSITIONS);
    expect(states.length).toBeGreaterThan(5);
    const neutral: string[] = [];
    for (const state of states) {
      // stateBadgeClass 对未知值给中性徽章 —— 这里就是要抓「未知」。
      if (stateBadgeClass(state) === "ca-badge") neutral.push(state);
    }
    expect(neutral).toEqual([]);
  });

  it("每个 kind 都有 class 归属,且 class 名在 base.css 里真的存在", () => {
    const styleSources = __WEB_STYLE_SOURCES__;
    const baseCss = styleSources["web/src/styles/base.css"] ?? "";
    const defined = new Set(
      [...baseCss.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1] as string),
    );
    expect(defined.size).toBeGreaterThan(10);
    const missing: string[] = [];
    for (const kind of EVENT_KINDS) {
      const cls = kindBadgeClass(kind);
      if (cls === "" || !defined.has(cls)) missing.push(kind);
    }
    // 四态三件套同理:toneClass 拼出来的类名必须逐条存在。
    for (const tone of ["ok", "run", "warn", "err"] as const) {
      for (const cls of `ca-badge ca-state--${tone}`.split(" ")) {
        if (!defined.has(cls)) missing.push(cls);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe("B 组:两条时间源的停滞计时", () => {
  it("心跳只推进「runner 活着」那条,不推进「模型在动」那条", () => {
    const clock = createStallClock(NOW);
    const heartbeat = advanceStallClock(
      clock,
      { kind: "event", event: { seq: 1, ts: "", kind: HEARTBEAT_KIND, payload: {} } },
      NOW + 60_000,
    );
    expect(heartbeat.lastAnyMs).toBe(NOW + 60_000);
    expect(heartbeat.lastBehavioralMs).toBe(NOW);
    const input = advanceStallClock(
      heartbeat,
      { kind: "event", event: { seq: 2, ts: "", kind: "tool_use", payload: {} } },
      NOW + 90_000,
    );
    expect(input.lastBehavioralMs).toBe(NOW + 90_000);
  });

  it("推进是新对象:时钟是渲染输入,就地改会让「哪一帧改的」查不出来", () => {
    const clock = createStallClock(NOW);
    const next = advanceStallClock(
      clock,
      { kind: "event", event: { seq: 1, ts: "", kind: "assistant", payload: {} } },
      NOW + 1000,
    );
    expect(next).not.toBe(clock);
    expect(clock.lastAnyMs).toBe(NOW);
  });

  it("坏帧与 end 帧都不推进任何时间源(读不懂的帧不构成「动过」的证据)", () => {
    const clock = createStallClock(NOW);
    const later = NOW + 400_000;
    expect(advanceStallClock(clock, { kind: "bad", reason: "x" }, later)).toBe(clock);
    expect(advanceStallClock(clock, { kind: "end", events: 3, unreadable: [] }, later)).toBe(clock);
  });

  it("红:心跳缺席超过红线 ⇒ runner 停了", () => {
    const clock = createStallClock(NOW);
    const view = stallView(clock, NOW + (STALL_DANGER_SECONDS + 1) * 1000, false);
    expect(view.tone).toBe("err");
    expect(view.text).toContain("心跳停止");
    expect(view.text).toContain("runner 停了");
  });

  it("黄:心跳在跳而转录静默超过黄线 ⇒ 只黄,永不红", () => {
    let clock = createStallClock(NOW);
    // 每 30s 一条心跳,持续超过黄线:beat 时间源始终新鲜,所以绝不判红。
    for (let t = 30_000; t <= STALL_WARN_SECONDS * 1000 + 30_000; t += 30_000) {
      clock = advanceStallClock(
        clock,
        { kind: "event", event: { seq: 1, ts: "", kind: HEARTBEAT_KIND, payload: {} } },
        NOW + t,
      );
    }
    const view = stallView(clock, NOW + (STALL_WARN_SECONDS + 5) * 1000, false);
    expect(view.tone).toBe("warn");
    expect(view.text).toContain("模型静默");
    expect(view.text).toContain("runner 活着");
  });

  it("刚开页且无事件:显示等待秒数而不是灰在那里不动", () => {
    const clock = createStallClock(NOW);
    const view = stallView(clock, NOW + 5000, false);
    expect(view.tone).toBe("ok");
    expect(view.seconds).toBe(5);
  });

  /**
   * c9b 实测的那一条:后台标签页的 setInterval 会被压到每分钟一次甚至冻结。
   * 计时若是「每次 tick +1 秒」,切回来时数字会慢于真实经过时间 —— 表现恰好最坏:
   * 悬挂的任务在后台不报警,回到前台还在那儿慢慢数。差值算法下,tick 只决定重画频率。
   */
  it("抗 hidden-tab 节流:一次跨 10 分钟的 tick 立刻得出正确时长,不累加", () => {
    const clock = createStallClock(NOW);
    const afterLongFreeze = stallView(clock, NOW + 600_000, false);
    expect(afterLongFreeze.seconds).toBe(600);
    expect(afterLongFreeze.tone).toBe("err");
  });

  it("end 帧之后停表:再久也不涨(涨一秒都是谎)", () => {
    const clock = createStallClock(NOW);
    const view = stallView(clock, NOW + 86_400_000, true);
    expect(view.seconds).toBe(0);
    expect(view.tone).toBe("");
    expect(view.text).toContain("流已结束");
  });
});

describe("B 组:readyState 双文案", () => {
  it("CLOSED(401 的形状):不重连 + 给出重新登录这个动作", () => {
    const view = streamConnectionView(ES_READY_STATE_CLOSED, 0);
    expect(view.reconnecting).toBe(false);
    expect(view.reauth).toBe(true);
    expect(view.tone).toBe("err");
  });

  it("CONNECTING(网络断的形状):真会重连,且带次数", () => {
    const view = streamConnectionView(ES_READY_STATE_CONNECTING, 4);
    expect(view.reconnecting).toBe(true);
    expect(view.text).toContain("4");
    expect(view.reauth).toBe(false);
    expect(view.tone).toBe("warn");
  });

  it("两个分支的文案必须不同字(相同就等于对 401 承诺一件不会发生的事)", () => {
    expect(streamConnectionView(ES_READY_STATE_CLOSED, 1).text).not.toBe(
      streamConnectionView(ES_READY_STATE_CONNECTING, 1).text,
    );
  });

  it("兜底分支在末尾且回声 readyState 原值(未知状态不许说「会重连」)", () => {
    const last = STREAM_CONN_RULES[STREAM_CONN_RULES.length - 1]!;
    expect(last.readyState).toBeNull();
    const view = streamConnectionView(7, 0);
    expect(view.text).toContain("7");
    expect(view.reconnecting).toBe(false);
  });
});

describe("B 组:end 帧之后的 error 不是事故", () => {
  // 2026-09-07 prod 实测(w4a 终态任务页):end 后服务端关流,浏览器照例报错重连,
  // 旧闭包快照判据把每次都计成「重连」—— 9.6s 计 6 次、6s 后 15→16,常驻循环。
  it("ended=true → null,三种 readyState 一律不计数不上屏(CLOSED 也不是例外)", () => {
    for (const rs of [ES_READY_STATE_CONNECTING, ES_READY_STATE_OPEN, ES_READY_STATE_CLOSED]) {
      expect(streamErrorView(true, rs, 7), `readyState=${rs}`).toBeNull();
    }
  });

  it("ended=false → 与 streamConnectionView 逐字段一致(纯透传,分流判据仍只有 readyState 一张表)", () => {
    for (const rs of [ES_READY_STATE_CONNECTING, ES_READY_STATE_OPEN, ES_READY_STATE_CLOSED, 7]) {
      expect(streamErrorView(false, rs, 7), `readyState=${rs}`).toEqual(streamConnectionView(rs, 7));
    }
  });
});

describe("B 组:坏帧绝不停更整页", () => {
  it("合法 agent 帧 → event,带 seq/kind/payload", () => {
    const frame = parseStreamFrame(SSE_AGENT_EVENT, agentFrame());
    expect(frame.kind).toBe("event");
  });

  it("非法 JSON、缺 kind、kind 非字符串 → bad,且 bad 里说得出原因", () => {
    for (const raw of ["", "{", "null", "[]", JSON.stringify({ seq: 1 }), agentFrame({ kind: 42 })]) {
      const frame = parseStreamFrame(SSE_AGENT_EVENT, raw);
      expect(frame.kind, raw).toBe("bad");
    }
    const bad = parseStreamFrame(SSE_AGENT_EVENT, "not json at all");
    expect(bad.kind === "bad" && typeof bad.reason).toBe("string");
  });

  it("解析函数对任何输入都不抛(抛出去就是一条帧停更整页)", () => {
    const hostile = [
      "\u2028\u2029",
      '{"kind":"assistant"',
      "undefined",
      '"a string"',
      "123",
      '{"v":1,"task_id":"t","attempt_id":"a","generation":1,"seq":1,"ts":"x","kind":"assistant","payload":"不是对象"}',
    ];
    for (const raw of hostile) {
      expect(() => parseStreamFrame(SSE_AGENT_EVENT, raw), raw).not.toThrow();
      expect(() => parseStreamFrame(SSE_END_EVENT, raw), raw).not.toThrow();
      expect(() => parseStreamFrame("message", raw), raw).not.toThrow();
    }
  });

  it("匿名 data 帧按事件收(不静默丢一类帧)", () => {
    expect(parseStreamFrame("message", agentFrame()).kind).toBe("event");
  });

  it("end 帧读不懂也仍然停表(events=null),但不会因为坏帧而不结束", () => {
    const good = parseStreamFrame(SSE_END_EVENT, JSON.stringify({ v: 1, task_id: "t", events: 451, unreadable_attempts: ["a"] }));
    expect(good).toEqual({ kind: "end", events: 451, unreadable: ["a"] });
    const broken = parseStreamFrame(SSE_END_EVENT, "{}");
    expect(broken.kind).toBe("end");
    expect(broken.kind === "end" && broken.events).toBeNull();
  });
});

describe("B 组:计数行", () => {
  it("「事件 N 条」恒显示,坏帧与重连只在非零时出现", () => {
    expect(streamCountsText({ seen: 0, bad: 0, reconnects: 0 })).toBe("事件 0 条");
    expect(streamCountsText({ seen: 12, bad: 3, reconnects: 1 })).toBe(
      "事件 12 条 · 坏帧 3 条(已跳过) · 重连 1 次",
    );
  });

  it("坏帧计数与事件计数互不影响(跳过一条不等于停更一页)", () => {
    let clock = createStallClock(NOW);
    let seen = 0;
    let bad = 0;
    for (const raw of ["{", agentFrame(), "nope", agentFrame()]) {
      const frame = parseStreamFrame(SSE_AGENT_EVENT, raw);
      if (frame.kind === "bad") {
        bad += 1;
        continue;
      }
      seen += 1;
      clock = advanceStallClock(clock, frame, NOW + seen * 1000);
    }
    expect({ seen, bad }).toEqual({ seen: 2, bad: 2 });
    expect(clock.lastBehavioralMs).toBe(NOW + 2000);
  });
});

describe("显示截断", () => {
  it("折叠空白并在上限处截断,同时报出原始长度", () => {
    const short = summarize("  hello \n world  ");
    expect(short.shown).toBe("hello world");
    expect(short.note).toBe("");
    const long = summarize("x".repeat(TEXT_SUMMARY_MAX_CHARS + 37));
    expect(long.shown.length).toBe(TEXT_SUMMARY_MAX_CHARS);
    expect(long.note).toContain(String(TEXT_SUMMARY_MAX_CHARS + 37));
  });
});
