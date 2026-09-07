/**
 * 业务值 → 设计 token class 的映射(w2b 数据层的另一半)。
 *
 * base.css 只交「色彩/尺寸的形状」(`.ca-state--warn` 是一套 warn 三件套,不含业务含义),
 * 而**什么算 warn** 是产品判据 —— 它的权威在后端(状态机的取值集、supervisor 的阈值)。
 * 所以这层映射必须存在可测的纯函数里,而不是散在组件的 `className` 三元表达式中:
 * 散着写的代价是「同一个 DONE 在列表页绿、在详情页蓝」,而观测面互相矛盾时人会不再相信任何一面
 * (docs/product.md §7 设计语言的原话)。
 *
 * 取值清单本身**不**在这一份里重列权威:`src/control/statemachine.ts`(状态集)与
 * `lib/kinds.ts`(kind 集,它自己由测试钉回 worker 权威)。下面的 `TASK_STATE_VALUES` 是
 * 前端为「配色 + 过滤器取值」抄的一份副本(带防漂钉子),不是第二份权威。
 * 漏一个值的表现是「新状态静默变中性」,那是比红屏更难发现的故障。
 */

import { EVENT_KINDS, HEARTBEAT_KIND, type EventKind } from "./kinds";

/**
 * 五档色调:`ok`/`run`/`warn`/`err` 四态 + `""`(中性 = 只有描边,不表态)。
 * 值即 base.css 里 `.ca-state--<tone>` 的后缀;`""` 走 `.ca-badge` 本身。
 */
export const TONES = ["", "ok", "run", "warn", "err"] as const;
export type Tone = (typeof TONES)[number];

/**
 * 任务状态取值集(**前端唯一的枚举点**)。
 *
 * 权威是 `src/control/statemachine.ts` 的 `TASK_TRANSITIONS` 键。这里不 import 它:那份源码在
 * `src/`(worker 侧),拉进前端 bundle 就会连带拖进整条状态机与它的依赖,只为读七个字符串
 * (与 `lib/kinds.ts` 对 `OBS_EVENT_KINDS` 的处理同一条理由、同一套防漂机制:
 * test/web-tasks-page.test.ts 拿 worker 权威逐值比对,缺值/多值都红)。
 *
 * 顺序 = 状态机的推进顺序:过滤器下拉照它排,读的人是从「还没开始」一路看到「已经停下」。
 *
 * w3 起这份键域同时管两处:下面的色调表、`/` 任务列表的 state 过滤取值(`lib/schema.ts` 的
 * zod 枚举)。共用一份是刻意的 —— 「能过滤的状态」与「有配色的状态」必须是同一件事,
 * 否则就会出现一个筛出来整列没配色的状态。
 */
export const TASK_STATE_VALUES = [
  "PENDING",
  "RUNNING",
  "VERIFYING",
  "AWAITING_APPROVAL",
  "DONE",
  "REJECTED",
  "BLOCKED",
] as const;

export type TaskStateValue = (typeof TASK_STATE_VALUES)[number];

/**
 * 状态色调的唯一来源:这张表之外没有任何地方决定颜色。
 * 键域是 `TaskStateValue` 而不是 `string`:补一个状态而这里少一条会**编译期**红,
 * 不用等到线上发现「某个新状态静默没有配色」(那正是本文件顶部说的那类最难发现的故障)。
 */
const STATE_TONE_BY_STATE: Readonly<Record<TaskStateValue, Tone>> = {
  PENDING: "run",
  RUNNING: "run",
  VERIFYING: "run",
  AWAITING_APPROVAL: "warn",
  DONE: "ok",
  REJECTED: "err",
  BLOCKED: "err",
};

/**
 * 任务状态 → 色调。判据一句话:成功终态 = ok;**等待人工 = warn**(它不是故障,是「需要有
 * 人动手」,与 err 必须分色);仍在推进的中间态 = run;需要人看而已经不动了的终态 = err。
 *
 * `AWAITING_APPROVAL` 用 warn 而不是 run:Approvals 角标与详情页徽章共用这一条判据。
 * 若它算 run,「审批积压」在视觉上就和「正在跑」混为一谈 —— 而积压正是那一页存在的理由(w5)。
 */
export function stateTone(state: string): Tone {
  // 先按 `Record<string, Tone>` 读再判空:状态值是后端给的字符串(未知状态必须照样渲染,
  // 只是落中性色),而色调表按 TaskStateValue 收紧了键域,直接用 string 索引在严格模式下不成立。
  const tone = (STATE_TONE_BY_STATE as Readonly<Record<string, Tone | undefined>>)[state];
  return tone ?? "";
}

export function stateBadgeClass(state: string): string {
  return toneClass(stateTone(state));
}

/**
 * 色调 → 徽章 class。四态全部写成**完整字面量**而不是 `ca-state--${tone}` 的拼接:
 * 拼接出来的类名在源码里不存在,test/web-theme-tokens.test.ts 那种「扫 class 全集」的钉子
 * 就扫不到它 —— 而这类漂移的表现是「某个状态静默没有配色」,恰是暗色下也看不出来的那种。
 * `Record<Exclude<Tone, "">, string>` 让「加一档色调而这里少一条」在 typecheck 阶段就红。
 */
const TONE_CLASS_BY_TONE: Readonly<Record<Exclude<Tone, "">, string>> = {
  ok: "ca-badge ca-state--ok",
  run: "ca-badge ca-state--run",
  warn: "ca-badge ca-state--warn",
  err: "ca-badge ca-state--err",
};

/** 状态、停滞、连接三类徽章共用这一个出口,不留第二个配色点。 */
export function toneClass(tone: Tone): string {
  return tone === "" ? "ca-badge" : TONE_CLASS_BY_TONE[tone];
}

/**
 * kind → class。`Record<EventKind, string>` 让「名单加一个 kind 而这里少一条」在 typecheck
 * 阶段就红 —— 编译期吃掉一半漂移,剩下的一半由 kinds.ts 那根钉子管。
 * `tool_result` 的后缀是连字符,与 base.css 里那一条逐字一致。
 */
const KIND_CLASS_BY_KIND: Readonly<Record<EventKind, string>> = {
  system: "ca-kind--system",
  assistant: "ca-kind--assistant",
  user: "ca-kind--user",
  tool_use: "ca-kind--tool-use",
  tool_result: "ca-kind--tool-result",
  result: "ca-kind--result",
  error: "ca-kind--error",
  raw: "ca-kind--raw",
  heartbeat: "ca-kind--heartbeat",
};

/** 未知 kind 落中性:class 名只能来自这张表 —— 让后端的字符串决定 class 名,等于把「一个未知 kind」升级成「注入一个任意 class」(与 live.ts 的 kindClass() 同一条理由)。 */
export function kindBadgeClass(kind: string): string {
  if (!(EVENT_KINDS as readonly string[]).includes(kind)) return "";
  return KIND_CLASS_BY_KIND[kind as EventKind];
}

/** 心跳是否算「行为」:停滞的两条时间源全靠这一条分开(见 lib/stream-protocol.ts)。 */
export function isBehavioralKind(kind: string): boolean {
  return kind !== HEARTBEAT_KIND;
}

/**
 * 摘要显示上限(字符)。同一条理由:journal 里 payload.text 最长 2048,一屏时间线放不下也
 * 不需要放下 —— 这里只做**显示**截断并标注原始长度,数据一个字节不动(全文有
 * GET /api/tasks/:id/events)。数值由 test/web-stream-protocol.test.ts 钉住为 200。
 */
export const TEXT_SUMMARY_MAX_CHARS = 200;

/**
 * 折叠空白 + 截断。`note` 单独返回给调用方渲染成 muted 的一段:拼进 `shown` 就会被当成
 * 文本内容的一部分复制走(用户粘贴出来的东西里夹着 UI 提示,是最讨厌的一类脏)。
 */
export function summarize(text: string): { shown: string; note: string } {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= TEXT_SUMMARY_MAX_CHARS) return { shown: flat, note: "" };
  return {
    shown: flat.slice(0, TEXT_SUMMARY_MAX_CHARS),
    note: `… 已截断(全文 ${flat.length} 字符,看 /api/tasks/:id/events)`,
  };
}

/** payload 的异构字段:任何一层形状不对就退回空值,不抛。未知 kind 的帧也必须能渲染掉。 */
export function textOf(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) return "";
  const text = (payload as { text?: unknown }).text;
  return typeof text === "string" ? text : "";
}

export function totalTokensOf(payload: unknown): number | null {
  if (typeof payload !== "object" || payload === null) return null;
  const usage = (payload as { usage?: unknown }).usage;
  if (typeof usage !== "object" || usage === null) return null;
  const total = (usage as { total_tokens?: unknown }).total_tokens;
  return typeof total === "number" && Number.isFinite(total) ? total : null;
}

/**
 * 时长展示(秒 → `1h02m` / `3m12s` / `45s`)。
 *
 * 台账与预算读的都是时长,而裸秒数(`3784s`)要心算、ISO duration 没人读得下去。
 * 非有限值(NaN/Infinity)与负数一律当 0:这函数会被喂 `Date.now()` 差值与后端数值,
 * 而看板上出现一次 "NaNs" 之后,那一整列数字就没人再信了。
 */
export function durationLabel(seconds: number): string {
  if (!Number.isFinite(seconds)) return "0s";
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m${String(secs).padStart(2, "0")}s`;
  return `${secs}s`;
}
