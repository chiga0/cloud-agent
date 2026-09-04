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
 *
 * `payload.tool_targets` 是白名单里**新增的一个键**,不是绕开白名单:它是「按键白名单 +
 * 打码 + 截断到 128 字符」之后的形状摘要(见 TOOL_TARGET_KEYS),不是 `input` 本身 ——
 * 「input 整体不进 journal」的理由(自由文本 = 凭据外流面)一个字都没变。加它的动机在
 * §9.8:判据要区分「读 A 文件」与「读 B 文件」,而 detect 只能看见这里写下的字节。
 */

import { LONGRUN_STATUSES, type ProcessSnapshot } from "../exec/longrun";
import type { Env } from "../types";

/** 信封版本。加字段递增此值前必须先想清楚读端点如何兼容旧段文件。
 *
 * **c10b 新增心跳 kind 时刻意不递增**,理由与 c10a(只加可选 payload 键不递增)不同类,
 * 所以要写清:心跳加的是**kind 取值**而不是信封字段。`v` 管的是「这行 JSON 的信封与
 * payload 通道长什么样」—— 加/改一个键的意义在于「所有读端点都要按新形状重解析」。
 * 而 kind 从设计上就是**开放集合**:读端点对不认识的 kind 必须照常返回(否则悬挂前
 * 最后写出的半结构化输出正好会被丢掉,见 toAgentEventV1),`raw` 的存在就是这条的
 * 极端形式。递增 v 的代价才是真问题:段文件的 `v` 一旦分裂,所有按 v 分支的读路径
 * (readObsAttemptEvents 的 decodeJsonl、GET /events、Live 页)都要么拒绝新段、要么
 * 各写两份解码 —— 用一次版本分裂换「多一个 kind」这条本就被容忍的变化,不划算。
 * 兼容面:老读端点看到 kind="heartbeat" 会当成一个不认识的可读 kind 原样透出,
 * 判据侧(c10b 的 detect)显式按 kind 排除心跳,不依赖 v。
 */
export const OBS_EVENT_V = 1;

/** 自由文本字段截断上限(字符)。2048:够看出 agent 在做什么,不够搬走一个文件。 */
export const OBS_TEXT_MAX_CHARS = 2048;

/** 凭据命中后的替换串。刻意不含 hex/base64 字符,不与真实 key 的任何前缀混淆。 */
export const OBS_SECRET_MASK = "***REDACTED***";

/** 短于这个长度的「凭据」不打码:一把 3 字符的 key 会把整段正文打成筛子。 */
const MIN_MASKABLE_SECRET_CHARS = 8;

/**
 * runner 心跳的 kind 名。操作员文档 §9.5 的字段表用的就是这个名字,两边只有一份。
 *
 * **为什么心跳必须由 runner 自己发,而不是拿转录静默当心跳**:transcript 的有无说的是
 * 「模型这 30 秒有没有吐字」,而判据要问的是「外圈的摄取通道还通不通」。两者在生产里
 * 会分叉:一个健康 writer 实测出现过 576 秒零新转录条目(c10 取证),那期间 poll 相
 * 一直在跑、沙箱一直活着 —— 拿静默当心跳会把这段判成「runner 停了」。反过来,poll 循环
 * 自己卡死(SDK 挂起、isolate 驱逐)时转录也可能是静的,但那**才是** runner 停了。
 * 只有一条由 runner 每轮无条件写下的时间源,才能把这两种形状分开:心跳断 = 高置信
 * 「观测通道自己停了」(red);心跳在而转录静 = 低置信「模型没说话」(只 yellow)。
 */
export const OBS_HEARTBEAT_KIND = "heartbeat";

/**
 * 心跳 payload 的 `status` 合法取值 —— 直接引用 longrun.ts 的状态清单,不在此重列。
 */
const HEARTBEAT_STATUS_VALUES: readonly string[] = LONGRUN_STATUSES;

/** 心跳 payload 里除 status 外的全部键:一律数值,缺省(null)即不写。 */
const HEARTBEAT_NUMBER_FIELDS = ["exit_code", "started_at_ms", "round_ms", "gap_ms"] as const;

/**
 * 事件 kind 的唯一权威清单。前八个取值直接来自 transcript 行类型,`raw` 是「认不出的也留下」。
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
  // 心跳不是 transcript 行:obsKindOfLine 永远不会返回它,它由摄取侧每轮显式产一条
  // (见 toHeartbeatEvent)。它仍然进这一份清单,因为这份清单是 kind 的**唯一权威**
  // —— 读端点、Live UI 徽章、判据过滤全部派生自它。另立一份「runner 侧 kind」清单
  // 迟早与这份漂移,而漂移的表现是「新 kind 在某个读面上静默消失」。
  OBS_HEARTBEAT_KIND,
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
 * 心跳 payload:只允许**枚举与数值**,没有任何自由文本通道。
 *
 * 为什么钉得比 transcript 通道还死(那条至少还有 payload.text):心跳每轮一条、由
 * runner 无条件写、且是判据的时间源 —— 一旦它能带文本,就成为一条**永不关闭的外流面**:
 * 每 30 秒一次、无人审阅、内容来自沙箱内部。所以这里连 `textField` 都不调用:
 * status 认不出即整键丢掉(宁缺一个观测维度),数值只认 `typeof === "number"`。
 *
 * `round_ms` / `gap_ms` 是这条事件存在的全部意义:把**摄取节奏本身**写进数据。
 * 在此之前阈值只能靠猜(90/300 的前提「摄取节拍每 30s 一次」就是猜的,实测被证伪);
 * 有了 gap,下一次改阈值可以先从 journal 里量出来,而不是再猜一遍。
 */
function heartbeatPayload(evt: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  const status = str(evt.status);
  if (status !== null && HEARTBEAT_STATUS_VALUES.includes(status)) payload.status = status;
  for (const field of HEARTBEAT_NUMBER_FIELDS) {
    const value = evt[field];
    if (typeof value === "number" && Number.isFinite(value)) payload[field] = value;
  }
  return payload;
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

/** tool_use 块里的工具名:枚举信息,保留;input 参数整体仍然丢弃(见 toolTargetOfBlock)。 */
const TOOL_NAME_MAX_CHARS = 128;
const TOOL_NAMES_MAX = 16;

/**
 * 入参目标的长度上限(字符)。刻意比 payload.text 小一个量级:128 字符足够写下一个
 * 文件路径或一句 `npm test`,不够搬走一段正文 —— 这个字段是判据的形状摘要,不是正文出口。
 */
const TOOL_TARGET_MAX_CHARS = 128;

/**
 * 允许读取的**参数键**白名单(只有这些键的**值**会被读,其余一律不看)。
 *
 * 键名比对前先做一次「小写 + 去分隔符」归一,于是 `file_path` / `filePath` /
 * `FilePath` / `file-path` 落到同一个键 —— 不同工具把同一个东西叫不同名字(上游命名
 * 没有统一口径),按字面比对会让判据在换工具时**静默**失灵:字段还在写,下标还对得上,
 * 只是永远取不到值。归一只作用于键名;取值一律按列出的键,认不出的键(如 `notebook_path`
 * / `cmd` / `query`)不取。
 *
 * 白名单不用启发式(「看着像路径就取」)是刻意的:漏一个键的代价只是少一个观测维度,
 * 多取一个键的代价是凭据外流 —— 这个不对称决定了只能显式列键。数组顺序即优先级,
 * 一个 input 里同时出现多个可取键时按此顺序取第一个。
 */
const TOOL_TARGET_KEYS = [
  { key: "file_path", shape: "raw" },
  { key: "path", shape: "raw" },
  { key: "pattern", shape: "raw" },
  { key: "directory", shape: "raw" },
  { key: "command", shape: "command" },
] as const;

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

/** 参数键归一:小写 + 去分隔符,让 `filePath` 与 `file_path` 落到同一个键。 */
function normalizeArgKey(key: string): string {
  return key.toLowerCase().replace(/[_\-\s]/g, "");
}

/** 预归一后的白名单:表里写的是可读原名,比对一律用归一名(`file_path` → `filepath`)。 */
const TOOL_TARGET_ORDER = TOOL_TARGET_KEYS.map((t) => ({
  canon: normalizeArgKey(t.key),
  shape: t.shape,
}));

/**
 * 命令 → 「首词 + 首个不以 `-` 开头的实参」。
 *
 * 只取这两个 token 是为了把泄露面钉在常数级:一条真实命令可能是
 * `bash -c 'curl -H "Authorization: Bearer …" …'`,整串进 journal 就等于把命令行
 * 里的一切外送。代价是判据看不见 flag —— 而「同一句命令换了个 flag 反复跑」正是
 * 空转的典型样子,不该被当成两个不同动作(见 §9.8 与 normalizeTarget)。
 */
function commandShape(command: string): string {
  const tokens = command.trim().split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return "";
  const head = tokens[0].slice(0, TOOL_TARGET_MAX_CHARS);
  const arg = tokens.slice(1).find((t) => !t.startsWith("-"));
  return arg === undefined ? head : `${head} ${arg.slice(0, TOOL_TARGET_MAX_CHARS)}`;
}

/** 一个 tool_use 块的入参目标;白名单里一个键都没命中时返回 null(而不是空串)。 */
function toolTargetOfBlock(block: Record<string, unknown>): string | null {
  const input = asRecord(block.input);
  if (input === null) return null;
  // 先把命中白名单的键收进一张归一名 → 原值的表(input 可能有几十个键,其中绝大多数
  // 一个都不看),再按 TOOL_TARGET_KEYS 的顺序取第一个能成形的。同名重复键取先出现的那个。
  const hits = new Map<string, string>();
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== "string") continue;
    const canon = normalizeArgKey(key);
    if (!TOOL_TARGET_ORDER.some((t) => t.canon === canon)) continue;
    if (!hits.has(canon)) hits.set(canon, value);
  }
  for (const { canon, shape } of TOOL_TARGET_ORDER) {
    const raw = hits.get(canon);
    if (raw === undefined) continue;
    const cut = shape === "command" ? commandShape(raw) : raw.trim();
    if (cut.length === 0) continue;
    return cut;
  }
  return null;
}

/**
 * 一次遍历同时产 `tool_names` 与 `tool_targets`:两个数组**共享同一次 push**,所以
 * 「同长度同顺序」不是约定而是结构上不可能违反(分成两个函数各扫一遍 blocks,就会在
 * 某次给其中一个加上过滤条件 → 下标静默错位,而错位比缺失更难查)。
 */
function toolNamesAndTargets(
  blocks: Array<Record<string, unknown>>,
  secrets: readonly string[],
): { names: string[]; targets: string[] } {
  const names: string[] = [];
  const targets: string[] = [];
  for (const block of blocks) {
    if (str(block.type) !== "tool_use") continue;
    const name = str(block.name);
    if (name === null) continue;
    const trimmed = maskSecrets(name, secrets).slice(0, TOOL_NAME_MAX_CHARS);
    // 无名块与重名块不产 slot(tool_names 本来就是去重 + 限 16 的):同一行里两次同名
    // 调用是罕见形状,而为它把两个数组拆成不等长,代价是让每个读端点先做一次交叉检查。
    if (names.length >= TOOL_NAMES_MAX || names.includes(trimmed)) continue;
    const target = toolTargetOfBlock(block);
    names.push(trimmed);
    // 先打码**再**限长(与 textField 同一顺序理由):切点落在凭据中间时,先截断会把
    // 半把 key 留在串里。取不到形状写 "" 而不是跳过 —— 下标对齐比数组稀疏好检查。
    targets.push(
      target === null ? "" : maskSecrets(target, secrets).slice(0, TOOL_TARGET_MAX_CHARS),
    );
  }
  return { names, targets };
}

/**
 * 行 → 白名单 payload。返回的键集合由本函数决定,与输入行里有什么无关:
 * 未列白的字段(message 的 id、input 里白名单之外的键如 `content`/`query`、任意新增的
 * 大字段)一律不进 journal。唯一从 input 里取东西的通道是 tool_targets 的按键白名单。
 */
function sanitizePayload(
  evt: Record<string, unknown>,
  kind: ObsEventKind,
  secrets: readonly string[],
): Record<string, unknown> {
  // 心跳走独立的、更窄的通道:它不来自 transcript,没有任何文本可脱敏。
  if (kind === OBS_HEARTBEAT_KIND) return heartbeatPayload(evt);

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
    const { names, targets } = toolNamesAndTargets(blocks, secrets);
    if (names.length > 0) payload.tool_names = names;
    // 只在**至少有一个 slot 取到了形状**时写这个键。全空时写 `[]`/`[""]` 会抹平两种
    // 截然不同的情况:「这条段早于 tool_targets 上线」与「新段里的工具全都没有可取形状」。
    // §9.8 要按 tool_targets 是否存在分段统计 shadow 样本,靠的就是这个区别。
    if (targets.some((t) => t.length > 0)) payload.tool_targets = targets;
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
 * 一条 runner 心跳 → AgentEventV1。与 toAgentEventV1 同规约:信封字段由调用方给,
 * payload 一律经 sanitizePayload(所以心跳不可能绕过白名单)。
 *
 * 输入是 longrun 的 ProcessSnapshot(camelCase),这里翻成 journal 的 snake_case:
 * 观测面的键名必须与「谁在写它」解耦 —— 否则 SDK 改一次字段名,历史段的读法就变了。
 */
export function toHeartbeatEvent(args: {
  taskId: string;
  attemptId: string;
  generation: number;
  seq: number;
  ts: string;
  snapshot: ProcessSnapshot;
  /** 本轮 ingest 在落盘前测得的耗时(ms) */
  round_ms: number;
  /** 与上一条心跳的间隔(ms);本 attempt 的第一条心跳为 null */
  gap_ms: number | null;
}): AgentEventV1 {
  const { snapshot } = args;
  const payload = sanitizePayload(
    {
      status: snapshot.status,
      exit_code: snapshot.exitCode,
      started_at_ms: snapshot.startedAtMs,
      round_ms: args.round_ms,
      gap_ms: args.gap_ms,
    },
    OBS_HEARTBEAT_KIND,
    [],
  );
  return {
    v: OBS_EVENT_V,
    task_id: args.taskId,
    attempt_id: args.attemptId,
    generation: args.generation,
    seq: args.seq,
    ts: args.ts,
    kind: OBS_HEARTBEAT_KIND,
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
