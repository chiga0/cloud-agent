/**
 * Observation 层事件协议(第一纵切)—— AgentEventV1 信封 + transcript 行映射 + ingress 脱敏。
 *
 * 定位:这一层**不是权威**。权威是 TaskSession DO 的事件 hash chain(§4 Event),
 * 这里一条链都不建:不签 prev_digest、不进 D1、不参与状态机。它回答的是另一个问题
 * ——「现在这一刻沙箱里的 agent 在干什么」,而 DO 链回答「已经确定的事实是什么」。
 * 之所以值得单独一层:C2-r6 那次 24 分钟模型悬挂在外圈眼里与正常运行无异,
 * 因为 RUNNING 期间没有任何事件级出口(/api/admin/events 读的是终态归档)。
 *
 * 脱敏刻意放在 **ingress**(而不是读端点):自由文本一旦以明文落进 R2,后面所有
 * 读取方、所有保留期都成了泄露面。黑名单在这里一律不用 —— 白名单漏一个字段只是
 * 少一个观测维度,黑名单漏一个字段就是凭据外流。
 */

import type { Env } from "../types";

/** 信封版本。加字段递增此值前必须先想清楚读端点如何兼容旧段文件。 */
export const OBS_EVENT_V = 1;

/** 自由文本字段截断上限(字符)。2048:够看出 agent 在做什么,不够搬走一个文件。 */
export const OBS_TEXT_MAX_CHARS = 2048;

/** 凭据命中后的替换串。刻意不含 hex/base64 字符,不与真实 key 的任何前缀混淆。 */
export const OBS_SECRET_MASK = "***REDACTED***";

/** 短于这个长度的「凭据」不打码:一把 3 字符的 key 会把整段正文打成筛子。 */
const MIN_MASKABLE_SECRET_CHARS = 8;

/**
 * 事件 kind 的唯一权威清单。取值直接来自 transcript 行类型,`raw` 是「认不出的也留下」。
 * 加一个 kind 只需要改这里 + KIND_OF 的映射,读端点不另立清单。
 */
export const OBS_EVENT_KINDS = [
  "system",
  "assistant",
  "user",
  "tool_use",
  "tool_result",
  "result",
  "error",
  "raw",
] as const;
export type ObsEventKind = (typeof OBS_EVENT_KINDS)[number];

/** 事件信封。payload 一律是白名单后的扁平对象(见 sanitizePayload)。 */
export interface AgentEventV1 {
  v: 1;
  task_id: string;
  attempt_id: string;
  /** attempt 内代数:durable 重放复用同一 attempt_id 时,换代表示「这是新一轮执行」 */
  generation: number;
  /** (attempt, generation) 内单调递增,从 1 起 */
  seq: number;
  /** 摄取时刻(不是模型侧时间):观测层的价值就在「外圈什么时候知道」 */
  ts: string;
  kind: ObsEventKind;
  payload: Record<string, unknown>;
}

/**
 * 顶层直取字段白名单:名字在表里且类型对得上才留。
 * 只放枚举型信息(类型、模型名、时长、token 数、退出码)—— 自由文本另走 TEXT 通道。
 */
const SCALAR_FIELDS: Record<string, "str" | "num" | "bool"> = {
  subtype: "str",
  uuid: "str",
  session_id: "str",
  model: "str",
  stop_reason: "str",
  is_error: "bool",
  num_turns: "num",
  duration_ms: "num",
  duration_api_ms: "num",
  total_cost_usd: "num",
  exit_code: "num",
};

/** usage 四元组:字段名与上游原样对齐(与 extract.ts 同口径,不重命名)。 */
const USAGE_FIELDS = [
  "input_tokens",
  "cache_read_input_tokens",
  "output_tokens",
  "total_tokens",
] as const;

/** tool_use 块里的工具名:枚举信息,保留;input 参数是自由文本,丢弃。 */
const TOOL_NAME_MAX_CHARS = 128;
const TOOL_NAMES_MAX = 16;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** 事件里的 content 块数组:qwen 把块挂在顶层 `content` 或 `message.content` 上。 */
function contentBlocks(evt: Record<string, unknown>): Array<Record<string, unknown>> {
  const top = Array.isArray(evt.content) ? evt.content : null;
  const nested = Array.isArray(asRecord(evt.message)?.content)
    ? (asRecord(evt.message)!.content as unknown[])
    : null;
  const blocks = top ?? nested ?? [];
  return blocks.map(asRecord).filter((b): b is Record<string, unknown> => b !== null);
}

/** 一个 content 块里的自由文本:text 块直接取,tool_result 的 content 可能是串或块数组。 */
function blockText(block: Record<string, unknown>): string {
  const direct = str(block.text);
  if (direct !== null) return direct;
  const inner = block.content;
  if (typeof inner === "string") return inner;
  if (Array.isArray(inner)) {
    return inner
      .map(asRecord)
      .filter((b): b is Record<string, unknown> => b !== null)
      .map((b) => str(b.text) ?? "")
      .join("");
  }
  return "";
}

/**
 * 行类型 → kind。判定顺序有意为之:一条 assistant 行里带 tool_use 块时,它的事件
 * 语义是「agent 发起了一个工具调用」,而不是「agent 说了段话」—— 外圈要看的正是
 * 前者(悬挂最典型的样子就是「最后一次 tool_use 之后再无事件」)。
 */
export function obsKindOfLine(evt: Record<string, unknown>): ObsEventKind {
  const type = str(evt.type) ?? "";
  const blocks = contentBlocks(evt);
  const errored = evt.is_error === true || /^error/.test(str(evt.subtype) ?? "");

  switch (type) {
    case "system":
      return errored ? "error" : "system";
    case "assistant":
      if (blocks.some((b) => str(b.type) === "tool_use")) return "tool_use";
      return errored ? "error" : "assistant";
    case "user":
      return blocks.some((b) => str(b.type) === "tool_result") ? "tool_result" : "user";
    case "tool_use":
      return "tool_use";
    case "tool_result":
      return "tool_result";
    case "result":
      return errored ? "error" : "result";
    case "error":
      return "error";
    default:
      return "raw";
  }
}

/** 凭据精确匹配打码。空串与过短值不参与(见 MIN_MASKABLE_SECRET_CHARS)。 */
export function maskSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length < MIN_MASKABLE_SECRET_CHARS) continue;
    if (!out.includes(secret)) continue;
    out = out.split(secret).join(OBS_SECRET_MASK);
  }
  return out;
}

/** 截断到 OBS_TEXT_MAX_CHARS。在打码**之后**调用:截断点落在凭据中间时,
 * 先打码能保证边界左侧已是替换串而不是半把 key。 */
function truncate(text: string): string {
  return text.length <= OBS_TEXT_MAX_CHARS ? text : text.slice(0, OBS_TEXT_MAX_CHARS);
}

/** 白名单字符串字段:先打码再截断,长度为零即舍弃(不留 `""` 噪声)。 */
function textField(value: string, secrets: readonly string[]): string | null {
  const masked = maskSecrets(value, secrets);
  if (masked.trim().length === 0) return null;
  return truncate(masked);
}

function usageOf(evt: Record<string, unknown>): Record<string, number> | null {
  const raw = (evt.usage ?? asRecord(evt.message)?.usage) as Record<string, unknown> | undefined;
  const usage = asRecord(raw);
  if (!usage) return null;
  const out: Record<string, number> = {};
  for (const field of USAGE_FIELDS) {
    if (typeof usage[field] === "number") out[field] = usage[field] as number;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function toolNames(
  blocks: Array<Record<string, unknown>>,
  secrets: readonly string[],
): string[] {
  const names: string[] = [];
  for (const block of blocks) {
    if (str(block.type) !== "tool_use") continue;
    const name = str(block.name);
    if (name === null) continue;
    const trimmed = maskSecrets(name, secrets).slice(0, TOOL_NAME_MAX_CHARS);
    if (names.length < TOOL_NAMES_MAX && !names.includes(trimmed)) names.push(trimmed);
  }
  return names;
}

/**
 * 行 → 白名单 payload。返回的键集合由本函数决定,与输入行里有什么无关:
 * 未列白的字段(tools 的 input、message 的 id、任意新增的大字段)一律不进 journal。
 */
function sanitizePayload(
  evt: Record<string, unknown>,
  kind: ObsEventKind,
  secrets: readonly string[],
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  for (const [field, want] of Object.entries(SCALAR_FIELDS)) {
    const value = evt[field] ?? asRecord(evt.message)?.[field];
    if (want === "str") {
      const s = str(value);
      if (s !== null) {
        const masked = textField(s, secrets);
        if (masked !== null) payload[field] = masked;
      }
    } else if (want === "num") {
      if (typeof value === "number" && Number.isFinite(value)) payload[field] = value;
    } else if (want === "bool") {
      if (typeof value === "boolean") payload[field] = value;
    }
  }

  const usage = usageOf(evt);
  if (usage) payload.usage = usage;

  const blocks = contentBlocks(evt);
  if (kind === "tool_use") {
    const names = toolNames(blocks, secrets);
    if (names.length > 0) payload.tool_names = names;
  }

  // 自由文本只有一处出口:payload.text(打码 + ≤2048)
  let text = "";
  if (kind === "result") text = str(evt.result) ?? "";
  else if (kind === "error") text = str(evt.error) ?? str(evt.message) ?? str(evt.result) ?? "";
  else if (kind === "tool_result" || kind === "user" || kind === "assistant") {
    text = blocks
      .filter((b) => str(b.type) !== "tool_use")
      .map(blockText)
      .join("\n");
  }
  if (kind === "raw") text = str(evt.text) ?? "";
  if (text) {
    const masked = textField(text, secrets);
    if (masked !== null) payload.text = masked;
  }
  // 认不出的行不丢:留原 type,外圈才看得出「出现了协议里没有的行类型」
  if (kind === "raw") {
    const rawType = str(evt.type);
    if (rawType !== null) payload.raw_type = truncate(maskSecrets(rawType, secrets));
  }

  return payload;
}

/**
 * 一条 transcript 行 → AgentEventV1。非 JSON 行也产事件(否则悬挂前最后写出的
 * 半结构化输出正好会被丢掉),kind=raw、行原文经打码截断后进 payload.text。
 */
export function toAgentEventV1(args: {
  taskId: string;
  attemptId: string;
  generation: number;
  seq: number;
  ts: string;
  line: string;
  secrets?: readonly string[];
}): AgentEventV1 {
  const secrets = args.secrets ?? [];
  const line = args.line.trim();
  let kind: ObsEventKind = "raw";
  let payload: Record<string, unknown> = {};

  const parsed: unknown = (() => {
    try {
      return JSON.parse(line);
    } catch {
      return undefined;
    }
  })();

  if (parsed === undefined) {
    const masked = textField(line, secrets);
    if (masked !== null) payload.text = masked;
    payload.unparseable = true;
  } else {
    const evt = asRecord(parsed);
    if (evt) {
      kind = obsKindOfLine(evt);
      payload = sanitizePayload(evt, kind, secrets);
    } else {
      // 合法 JSON 但不是对象(数字/数组/字符串行):原文截断留证
      const masked = textField(line, secrets);
      if (masked !== null) payload.text = masked;
      payload.raw_json_scalar = true;
    }
  }

  return {
    v: OBS_EVENT_V,
    task_id: args.taskId,
    attempt_id: args.attemptId,
    generation: args.generation,
    seq: args.seq,
    ts: args.ts,
    kind,
    payload,
  };
}

/**
 * 平台注入沙箱的已知凭据值。脱敏是「精确匹配已知值」,所以清单必须来自注入点本身,
 * 不能靠字段名猜 —— transcript 里出现的可能是 key 的值,而不是 `OPENAI_API_KEY` 这个名字。
 *
 * 逐值列举而非模式匹配:漏一个值就是泄露,多列一个值(WORKER_API_TOKEN 并不进沙箱,
 * 但 reviewer 的裁决文本里可能出现)只是多打一处码。
 */
export function obsSecretValues(env: Env | Partial<Env>): string[] {
  const candidates = [
    env.SANDBOX_MODEL_API_KEY,
    env.DASHSCOPE_API_KEY,
    env.WORKER_API_TOKEN,
  ];
  const seen = new Set<string>();
  for (const value of candidates) {
    if (typeof value === "string" && value.length >= MIN_MASKABLE_SECRET_CHARS) seen.add(value);
  }
  return [...seen];
}
