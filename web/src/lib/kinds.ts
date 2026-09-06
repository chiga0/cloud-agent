/**
 * 事件 kind 的前端名单(w2b)。
 *
 * 权威永远是 `src/obs/events.ts` 的 `OBS_EVENT_KINDS`(那份清单是 kind 的唯一权威:读端点、
 * Live UI 徽章、Supervisor 判据全部派生自它)。这里为什么不直接 import 它:那份源码在
 * `src/`(worker 侧),把它拉进前端 bundle 就会连带拖进 `exec/longrun.ts` 与整条摄取链 ——
 * 只为读九个字符串。代价与红利都要说清:
 * - **代价**:这是第二份名单,会漂。
 * - **防漂机制**:test/web-view.test.ts 从 worker 侧 import 那份权威清单,逐值比对(缺值、多值、
 *   顺序都红)。这条钉子是本文件存在的唯一前提;没有它,这份名单就是活文档里的谎言。
 * - 漂移的表现不是报错而是**静默**:新 kind 在徽章上落中性色,读的人以为「它不紧要」。
 */

/** 与 OBS_EVENT_KINDS 同序同值(由 test/web-view.test.ts 钉)。 */
export const EVENT_KINDS = [
  "system",
  "assistant",
  "user",
  "tool_use",
  "tool_result",
  "result",
  "error",
  "raw",
  "heartbeat",
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

/**
 * 心跳 kind。它不是 transcript 行,而是摄取侧每轮无条件写的一条(存在的唯一意义就是给
 * 「runner 还活着」提供独立时间源)—— 停滞判据的两条时间源全靠这个名字分开,
 * 所以它是判据常量,不是展示常量。见 lib/stream-protocol.ts。
 */
export const HEARTBEAT_KIND: EventKind = "heartbeat";
