/**
 * SSE 协议层(w2b,`src/obs/live.ts` 那份实测结论的类型化重写)。
 *
 * 纯模块:没有 DOM、没有 `EventSource`、没有 React、时间一律由调用方喂 `nowMs`。
 * 三条理由,按分量排:
 *
 * 1. **判据必须可测**。本仓的测试跑在 Workers 运行时里(无 jsdom),而「401 与断连是两个
 *    文案」「坏帧绝不能停更整页」「停滞必须用 `Date.now()` 差值」这三条恰恰是最容易在重构中
 *    被悄悄改坏、又只有浏览器现场才会暴露的东西。判定留在纯函数里,测试就钉得住。
 *    真正的 `new EventSource` 只出现在 use-event-stream.ts 那一层薄适配器里(标「需浏览器实测」)。
 * 2. **抗 hidden-tab 节流**。浏览器会把后台标签页的 `setInterval` 压到每分钟一次甚至冻结。
 *    如果停滞时长是「每次 tick +1 秒」累加出来的,回到前台时那个数字会**慢于真实经过时间** ——
 *    表现恰好是最坏的那种:一条悬挂的任务在后台时不报警,切回来还在那儿慢慢数。
 *    改成 `nowMs - lastEventMs` 之后,tick 只决定「多久重画一次」,不参与「过了多久」的计算。
 * 3. **事件流不进 Query 缓存**(docs/product.md §4)。这条流是**增量流**不是快照:一帧只代表
 *    一个新事件,把它塞进 Query 的「按 key 存一份最新快照」模型,就得在前端自己拼出全量列表,
 *    而那份列表与续传点(Last-Event-ID)从此是两套真相。断线重连由 EventSource 按标准自己管
 *    (帧 id 与 `GET /events` 的 `?after=` 同口径,见 `src/obs/stream.ts` 不变量 1),
 *    Query 在这里没有任何可缓存的东西。
 *
 * 与 live.ts 的关系:这份是**副本**,而理由与数字只有一份出处 —— 阈值的推导在
 * `src/supervisor/detect.ts`(算式与实测样本只在那里出现一次),分支表的实测记录在
 * `src/obs/live.ts`。副本会漂,所以 test/web-stream-protocol.test.ts 的 A 组从 worker 侧
 * import 那几份权威逐项比对:「改了后端忘了前端」在这里红,而不是在 prod 上被人看出来。
 * 文案有一处**刻意**不同并已核对:live.ts 写「EventSource 无法携带 Authorization 头,
 * 当前只能靠 API 客户端」,那是 w1b 之前的话;w1b 起浏览器带同源会话 cookie,所以这里的 401
 * 分支说的是「会话失效 → 重新登录」这个新动作。
 */

import { streamEndSchema, streamEventSchema } from "./schema";
import { isBehavioralKind, type Tone } from "./view";

/** `event:` 字段的两个取值(src/obs/stream.ts 的 OBS_SSE_EVENT / OBS_SSE_END_EVENT)。 */
export const SSE_AGENT_EVENT = "agent";
export const SSE_END_EVENT = "end";

/**
 * 停滞阈值(秒)。**这里是引用点,不是定义点** —— 唯一定义在
 * `src/supervisor/detect.ts`(推导算式与实测样本只在那里出现一次,见 §9.8)。
 * 数值由 test/web-stream-protocol.test.ts 与 worker 侧常量逐字比对钉住:
 * 改那边不改这边,测试红。
 *
 * - warn(黄)= `agent_silent`:模型静默但心跳在跳 ⇒ runner 活着,**永不判红**。
 * - err(红)= `no_heartbeat`:连每轮无条件写的那条心跳都没了 ⇒ runner 停了。
 */
export const STALL_WARN_SECONDS = 900;
export const STALL_DANGER_SECONDS = 180;

/**
 * 任务详情页自己的停滞阈值(秒) —— 与上面那对是**两套判据**,不是同一件事的两次引用。
 *
 * 权威 = docs/product.md §5(「停滞三色:>90s 黄、>300s 红,`Date.now()` 与最后事件时间
 * 差值」)。判据是「**无新事件**」:心跳也算事件,所以这里只有一条时间源(lastAnyMs),
 * 不分 runner/模型;而监督器那对拆两条时间源、红只归心跳停。页面把"这条流还活着吗、
 * 内容还在来吗"压成一个数,监督器把"runner 停了"与"模型沉默"分开 —— 两个问题,两个答案。
 *
 * worker 侧没有可逐值比对的对应常量,所以这四个值逐字钉在 test/web-task-detail.test.ts
 * (含边界与 181s 双判据对照),改这里不改测试,红。
 */
export const TASK_STALL_WARN_SECONDS = 90;
export const TASK_STALL_DANGER_SECONDS = 300;

/** `EventSource.readyState` 的三个取值(WHATWG 冻结的常数,不是实现细节)。 */
export const ES_READY_STATE_CONNECTING = 0;
export const ES_READY_STATE_OPEN = 1;
export const ES_READY_STATE_CLOSED = 2;

/** 连接提示的一种形状:它决定文案、色调,以及「这次该不该算作一次重连」。 */
export interface StreamConnRule {
  /** 匹配的 readyState;`null` = 末尾兜底分支(取值不在预期内)。 */
  readonly readyState: number | null;
  readonly text: (counterValue: string) => string;
  /** 这条分支是否意味着浏览器**真的**还会自己重连。只有 true 时 `reconnects` 才 +1。 */
  readonly reconnecting: boolean;
  /** 中间插哪个计数器:`null` = 这条分支不承诺任何次数,因此不显示数字。 */
  readonly counter: "reconnects" | "readyState" | null;
  /** 是否该给用户「重新登录」这个动作(401 之后唯一有用的动作)。 */
  readonly reauth: boolean;
}

/**
 * 分支表。顺序即语义:线性扫描 + 末尾兜底,`readyState: null` 只能出现在最后。
 *
 * 为什么 CLOSED 与 CONNECTING 必须两个文案(2026-09-03 浏览器实测,同一窗口并排探两条流):
 * - HTTP 401 → `onerror` 只触发 1 次、`readyState` 停在 2(CLOSED)、浏览器**永不重连**;
 * - 网络失败(拒连)→ `onerror` 每 ~3000ms 一次、`readyState` 停在 0(CONNECTING)、真的重连。
 * 两个形状在旧页面上长得一模一样(都停在「正在自动重连(第 1 次)」),而 401 那条永远不会再动 ——
 * 沿用同一句文案等于向操作员承诺一件已证明不会发生的事,他会白等。
 *
 * 判据是 `readyState` 而不是「error 事件出现了几次」:401 与断连的**第一次**都恰好是 1 次,
 * 拿次数当判据必然把 401 误判成「正在重连」。
 */
export const STREAM_CONN_RULES: readonly StreamConnRule[] = [
  {
    readyState: ES_READY_STATE_CLOSED,
    text: () =>
      "连接已关闭,浏览器不会自动重连 —— 最常见原因是会话失效(401):这条流只认同源会话 cookie。",
    reconnecting: false,
    counter: null,
    reauth: true,
  },
  {
    readyState: ES_READY_STATE_CONNECTING,
    text: (value) => `连接中断,浏览器正在自动重连(第 ${value} 次)`,
    reconnecting: true,
    counter: "reconnects",
    reauth: false,
  },
  {
    readyState: null,
    text: (value) =>
      `连接异常且状态未知(readyState=${value}):不承诺自动重连,也不承诺已关闭。`,
    reconnecting: false,
    counter: "readyState",
    reauth: false,
  },
];

if (STREAM_CONN_RULES.some((rule, i) => rule.readyState === null && i !== STREAM_CONN_RULES.length - 1)) {
  // 大声失败:兜底分支不在末尾会先命中并吃掉所有具体分支 —— 那是静默的文案错配。
  throw new Error("stream_conn_rules_fallback_not_last");
}

/** 健康连接的一句话(没有 error 发生过时的缺省)。 */
export const STREAM_CONNECTED_TEXT = "已连接,增量事件持续到达";
export const STREAM_ENDED_TEXT = "流已结束";

export interface StreamConnView {
  readonly text: string;
  readonly tone: Tone;
  readonly reconnecting: boolean;
  readonly reauth: boolean;
}

function matchConnRule(readyState: number): StreamConnRule {
  for (const rule of STREAM_CONN_RULES) {
    if (rule.readyState === readyState) return rule;
  }
  return STREAM_CONN_RULES[STREAM_CONN_RULES.length - 1]!;
}

/** 一次 `onerror` 该显示什么、该不该算作一次重连。纯函数,browserless 可测。 */
export function streamConnectionView(readyState: number, reconnects: number): StreamConnView {
  const rule = matchConnRule(readyState);
  const counterValue =
    rule.counter === "reconnects"
      ? String(reconnects)
      : rule.counter === "readyState"
        ? String(readyState)
        : "";
  return {
    text: rule.text(counterValue),
    tone: rule.readyState === ES_READY_STATE_CLOSED ? "err" : "warn",
    reconnecting: rule.reconnecting,
    reauth: rule.reauth,
  };
}

/**
 * 一帧的三种结论。`bad` 不是异常处理的花瓶 —— 它是这条流的**正常**分支之一:
 * 流上除了事件帧还有终止帧与注释帧,而信封演进(`AgentEventV1.v`)时老页面必须先能
 * 读懂「我读不懂」并继续盯停滞。live.ts 用 `bad += 1; return` 表达了同一条纪律。
 */
/** 一条可读的事件帧(信封里 UI 真要用的四个字段;其余原样留在 payload 里)。 */
export interface StreamEventView {
  readonly seq: number;
  readonly ts: string;
  readonly kind: string;
  readonly payload: unknown;
}

export type StreamFrame =
  | { readonly kind: "event"; readonly event: StreamEventView }
  | { readonly kind: "bad"; readonly reason: string }
  | { readonly kind: "end"; readonly events: number | null; readonly unreadable: string[] };

/**
 * 解析一帧。绝不抛:任何输入都归成三种结论之一。
 *
 * 未带 `event:` 的匿名 data 帧按 agent 收(live.ts 的 `es.onmessage` 同一处置):
 * 静默丢掉一类帧比把它标成坏帧更糟 —— 计数行会替它撒谎说「一切正常」。
 */
export function parseStreamFrame(frameEvent: string, data: string): StreamFrame {
  if (frameEvent === SSE_END_EVENT) {
    const parsed = streamEndSchema.safeParse(json(data));
    return {
      kind: "end",
      events: parsed.success ? parsed.data.events : null,
      unreadable: parsed.success ? parsed.data.unreadable_attempts : [],
    };
  }
  const parsed = streamEventSchema.safeParse(json(data));
  if (!parsed.success) return { kind: "bad", reason: parsed.error.issues[0]?.message ?? "形状不符" };
  const { seq, ts, kind, payload } = parsed.data;
  return { kind: "event", event: { seq, ts, kind, payload } };
}

function json(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 停滞的两条时间源。
 *
 * 为什么必须两条(c10b 起重标定的核心):「没有新转录」既可能是 agent 挂了,也可能是它在干
 * 一件不产字的长活(实测一个健康 writer 静默 576s)—— 只有心跳这条独立时间源能把两者分开。
 * `lastAnyMs` 含心跳(证明 runner 还在跳),`lastBehavioralMs` 不含(证明模型还在动)。
 * 把心跳也算进行为时间源,静默计时永远归零,agent_silent 形同虚设。
 *
 * 起点用 `startMs`(开页时刻)而不是 null:「一直没有事件」与「事件停了」是同一个故障的两种
 * 形状,缺一条事件也不能把计时器灰在那儿不动 —— 那正好把最需要看的时间藏起来。
 */
export interface StallClock {
  readonly startMs: number;
  readonly lastAnyMs: number;
  readonly lastBehavioralMs: number;
}

export function createStallClock(nowMs: number): StallClock {
  return { startMs: nowMs, lastAnyMs: nowMs, lastBehavioralMs: nowMs };
}

/** 一帧到达后推进时钟(不可变:时钟是渲染输入,就地改会让「哪一帧改的」查不出来)。 */
export function advanceStallClock(clock: StallClock, frame: StreamFrame, nowMs: number): StallClock {
  if (frame.kind !== "event") return clock;
  const anyNext = { ...clock, lastAnyMs: nowMs };
  return isBehavioralKind(frame.event.kind)
    ? { ...anyNext, lastBehavioralMs: nowMs }
    : anyNext;
}

export interface StallView {
  readonly text: string;
  readonly tone: Tone;
  /** 停滞秒数(红>黄>正常三档都用它,组件不再自己算)。 */
  readonly seconds: number;
}

/**
 * 停滞时长 → 三色文案。`ended` 后不再计时:流收尾后那个数字每涨一秒都是谎。
 *
 * 红只说「runner 停了」,黄只说「模型沉默但 runner 活着」—— 两条判据说两件不同的事,
 * 这也是把它们并排显示的价值:黄线不该被读成故障。
 */
export function stallView(clock: StallClock, nowMs: number, ended: boolean): StallView {
  if (ended) return { text: STREAM_ENDED_TEXT, tone: "", seconds: 0 };
  const beatSecs = Math.floor((nowMs - clock.lastAnyMs) / 1000);
  const quietSecs = Math.floor((nowMs - clock.lastBehavioralMs) / 1000);
  if (beatSecs > STALL_DANGER_SECONDS) {
    return { text: `心跳停止 ${beatSecs}s(runner 停了)`, tone: "err", seconds: beatSecs };
  }
  if (quietSecs > STALL_WARN_SECONDS) {
    return { text: `模型静默 ${quietSecs}s(runner 活着)`, tone: "warn", seconds: quietSecs };
  }
  return { text: `最后事件 ${beatSecs}s 前`, tone: "ok", seconds: beatSecs };
}

/**
 * 任务详情页的停滞三色(product.md §5 口径):只看「无新事件」,心跳也把计时归零。
 *
 * 与 stallView 的分工见 TASK_STALL_* 常量注释。整秒粒度(Math.floor)与 stallView
 * 同口径:90s 整算正常,91s 才黄 —— 边界测试用的就是 90_000/91_000 这两刀。
 * 红黄档点名「无新事件」、正常档说「最后事件」:同一个数,两句话,别让操作员
 * 把 91s 的黄当成 runner 出了事。
 */
export function taskStallView(clock: StallClock, nowMs: number, ended: boolean): StallView {
  if (ended) return { text: STREAM_ENDED_TEXT, tone: "", seconds: 0 };
  const secs = Math.floor((nowMs - clock.lastAnyMs) / 1000);
  if (secs > TASK_STALL_DANGER_SECONDS) {
    return { text: `无新事件 ${secs}s(超过 ${TASK_STALL_DANGER_SECONDS}s)`, tone: "err", seconds: secs };
  }
  if (secs > TASK_STALL_WARN_SECONDS) {
    return { text: `无新事件 ${secs}s(超过 ${TASK_STALL_WARN_SECONDS}s)`, tone: "warn", seconds: secs };
  }
  return { text: `最后事件 ${secs}s 前`, tone: "ok", seconds: secs };
}

export interface StreamCounts {
  readonly seen: number;
  readonly bad: number;
  readonly reconnects: number;
}

/**
 * 计数行。三段只在非零时出现(「坏帧 0 条」是噪音),但「事件 0 条」恒显示 ——
 * 它是「连接活着而确实没内容」的唯一证据。
 */
export function streamCountsText(counts: StreamCounts): string {
  const parts = [`事件 ${counts.seen} 条`];
  if (counts.bad > 0) parts.push(`坏帧 ${counts.bad} 条(已跳过)`);
  if (counts.reconnects > 0) parts.push(`重连 ${counts.reconnects} 次`);
  return parts.join(" · ");
}
