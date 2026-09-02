import type { ReviewSource, ReviewVerdict } from "../control/gates";

/**
 * 从 qwen-code stream-json transcript 提取 agent 的最终回答。
 *
 * qwen 的 stream-json 是 NDJSON,每行一个事件。最终答案通常出现在
 * 最后一条 type=result 事件的 result 字段里;若没有则退化为拼接
 * 所有 assistant content block 的文本。
 */
export function extractResultFromTranscript(transcript: string): string | null {
  const lines = transcript.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return null;

  let lastResult: string | null = null;
  const contentChunks: string[] = [];

  for (const line of lines) {
    try {
      const evt = JSON.parse(line) as Record<string, unknown>;
      if (evt.type === "result" && typeof evt.result === "string") {
        lastResult = evt.result;
      }
      if (
        evt.type === "assistant" &&
        Array.isArray((evt as { content?: unknown }).content)
      ) {
        for (const block of (evt as { content: Array<Record<string, unknown>> }).content) {
          if (block.type === "text" && typeof block.text === "string") {
            contentChunks.push(block.text);
          }
        }
      }
    } catch {
      // 非 JSON 行忽略
    }
  }

  if (lastResult && lastResult.trim().length > 0) return lastResult.trim();
  if (contentChunks.length > 0) return contentChunks.join("").trim();
  return null;
}

/**
 * qwen stream-json 事件里的 token 用量四元组。字段名与上游原样对齐
 * (input/output/cache_read),不做重命名 —— 台账要能回答「这个数字是从哪来的」,
 * 改一次名字就多一层需要人记的映射。
 * 缺字段留 `undefined`(不是 0):0 是「上游说没消耗」,undefined 是「上游没说」。
 */
export interface TranscriptUsage {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

const USAGE_FIELDS = [
  "input_tokens",
  "cache_read_input_tokens",
  "output_tokens",
  "total_tokens",
] as const;

/** 事件里的 usage:顶层 `evt.usage` 或挂在 message 上的 `evt.message.usage`。 */
function usageOfEvent(evt: Record<string, unknown>): TranscriptUsage | null {
  const message = evt.message;
  const nested =
    message && typeof message === "object"
      ? (message as Record<string, unknown>).usage
      : undefined;
  const raw = (evt.usage ?? nested) as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== "object") return null;

  const usage: TranscriptUsage = {};
  let known = false;
  for (const field of USAGE_FIELDS) {
    if (typeof raw[field] === "number") {
      usage[field] = raw[field] as number;
      known = true;
    }
  }
  // 只有 usage 壳子(或全是非数值字段)等于没有用量信息,不能当 0 记进台账
  return known ? usage : null;
}

/**
 * 一条 usage 的有效总量:上游没给 total 时由 input+output 推出。
 * 注意这是「量」的口径,不是「钱」的口径 —— 成本看 costWeightedFromUsage。
 */
function effectiveTotal(u: TranscriptUsage): number {
  return u.total_tokens ?? (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
}

/**
 * 从 qwen-code stream-json transcript 提取 token 用量四元组。
 *
 * 在所有携带 usage 的事件里取有效 total 最大的一条:type=result 的 usage 是整轮
 * 会话的累计值,而单次调用不可能超过上下文窗口,因此最大值必是累计值。
 * 无任何 usage 事件返回 null。
 */
export function extractUsageFromTranscript(transcript: string): TranscriptUsage | null {
  const lines = transcript.split("\n").filter((l) => l.trim().length > 0);
  let best: TranscriptUsage | null = null;
  let bestTotal = 0;

  for (const line of lines) {
    let evt: unknown;
    try {
      evt = JSON.parse(line);
    } catch {
      // non-JSON line, ignore
      continue;
    }
    if (!evt || typeof evt !== "object") continue;
    const usage = usageOfEvent(evt as Record<string, unknown>);
    if (!usage) continue;
    const total = effectiveTotal(usage);
    if (total > bestTotal) {
      best = usage;
      bestTotal = total;
    }
  }

  return best;
}

/**
 * 从 qwen-code stream-json transcript 提取 token 用量。
 * 取所有携带 usage 的事件里有效总量最大的一条(type=result 是整轮累计值),
 * 无 total_tokens 时由 input+output 推出;无法解析则返回 0。
 *
 * 保留 raw total 口径(台账的 tokens_used 即此值),既有复盘的语义不变;成本口径
 * 另见 costWeightedFromUsage —— total 把 cache 命中与 fresh input 同价计,失真严重。
 */
export function extractTokensFromTranscript(transcript: string): number {
  const usage = extractUsageFromTranscript(transcript);
  return usage === null ? 0 : effectiveTotal(usage);
}

/**
 * 成本加权用量:把「量」换算成可横向比较的相对成本,单位是 fresh input token 数。
 *
 * 隐式 prompt 缓存命中(r11 实测占 total 的 96.9%)按 cacheReadFactor 折扣计价,
 * fresh input 与 output 全额。三档口径:
 * - input 与 cache_read 都已知:精确拆分;
 * - 只有 input(cache_read 未知):保守按全 fresh 计,绝不猜「全是缓存命中」;
 * - 只有 total:退回 total,即与 raw total 同值 —— 诚实标注为「无从拆分」。
 */
export function costWeightedFromUsage(u: TranscriptUsage, cacheReadFactor: number): number {
  const output = u.output_tokens ?? 0;
  const input = u.input_tokens;
  const cacheRead = u.cache_read_input_tokens;
  if (input !== undefined && cacheRead !== undefined) {
    // cache_read 是 input 的子集:fresh = input - cache_read
    return input - cacheRead + output + Math.round(cacheRead * cacheReadFactor);
  }
  if (input !== undefined) return input + output;
  return u.total_tokens ?? (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
}

const REVIEW_SOURCES: ReviewSource[] = ["task_prompt", "writer_result", "verify_output", "patch"];

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  return items.length > 0 ? items : undefined;
}

/** 把任意形状的 LLM 输出收敛成 ReviewVerdict;decision 不合法即 none。 */
function toVerdict(parsed: Record<string, unknown>): ReviewVerdict {
  const decision = parsed.decision === "approve" || parsed.decision === "reject" ? parsed.decision : "none";
  const criteria = Array.isArray(parsed.failed_criteria)
    ? parsed.failed_criteria.filter((v): v is number => typeof v === "number" && Number.isInteger(v))
    : undefined;
  const evidence = Array.isArray(parsed.evidence)
    ? (parsed.evidence as Array<Record<string, unknown>>)
        .filter(
          (e): e is { source: ReviewSource; quote: string } =>
            typeof e?.source === "string" &&
            REVIEW_SOURCES.includes(e.source as ReviewSource) &&
            typeof e?.quote === "string",
        )
        .map((e) => ({ source: e.source, quote: e.quote }))
    : undefined;
  return {
    decision,
    reason: typeof parsed.reason === "string" ? parsed.reason : "",
    failed_criteria: criteria && criteria.length > 0 ? criteria : undefined,
    fix_instructions: asStringArray(parsed.fix_instructions),
    evidence: evidence && evidence.length > 0 ? evidence : undefined,
  };
}

/**
 * 解析 reviewer 的裁决。reviewer 走纯 LLM,输入就是单行 JSON 回答
 * (不是 NDJSON transcript,不能经 extractResultFromTranscript 处理)。
 * 依次尝试:整段 JSON → 文本里的 JSON 片段 → decision 正则兜底。
 *
 * 全部失败时返回 `none` 而非 reject:解析失败是基建问题,不该让任务返工,
 * 交由人工裁决(fail-closed)。
 */
export function parseReviewVerdict(text: string): ReviewVerdict {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object") return toVerdict(parsed as Record<string, unknown>);
  } catch {
    // fall through to fragment search
  }
  const fragment = /\{[\s\S]*\}/.exec(text);
  if (fragment) {
    try {
      const parsed = JSON.parse(fragment[0]) as unknown;
      if (parsed && typeof parsed === "object") return toVerdict(parsed as Record<string, unknown>);
    } catch {
      // fall through to decision regex
    }
  }
  const m = /"decision"\s*:\s*"(approve|reject)"/.exec(text);
  if (m) return { decision: m[1] as "approve" | "reject", reason: text.slice(0, 500) };
  return { decision: "none", reason: `unparseable_verdict:${text.slice(0, 200)}` };
}
