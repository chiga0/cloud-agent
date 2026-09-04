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
 *
 * 这是 raw total 的**唯一**推导处。台账有两处消费它(DO 快照的 `total_tokens`、
 * D1 归档的 `tokens_used`),两处各算一遍就是两套口径 —— 与 resolveBudget 同一条
 * 教训:第二次实现必然在某天悄悄漂移。
 */
export function totalFromUsage(u: TranscriptUsage): number {
  return u.total_tokens ?? (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
}

/**
 * 累加值与 result 累计值对不上时抛出的错误。
 *
 * 为什么是抛错而不是「取其中一个」:在一个格式正常的 transcript 里,
 * 「逐次调用之和」与「result 的会话累计值」不是两个可以互相近似的估计,而是
 * **同一个量的两种记法** —— 它们不等意味着我们对这份 transcript 的理解本身就是错的
 * (usage 事件有重复、有缺失,或 total 的含义不是 input+output)。此时取任一侧都是
 * 编一个来源不明的数,而成本台账的全部价值就在于「这个数字答得出是从哪来的」。
 */
export class TranscriptLedgerMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptLedgerMismatch";
  }
}

/** 一次 attempt 的用量账:累加出的四元组 + 由它派生的 raw total。 */
export interface AttemptUsageLedger {
  /**
   * 该 attempt 全部单次调用累加出的会话累计用量。
   * 一个带 usage 的 assistant 事件都没有时为 null(=「未记录」,不是 0)。
   */
  usage: TranscriptUsage | null;
  /** raw total 口径(台账的 tokens_used):恒 = totalFromUsage(usage),usage 为 null 时 0。 */
  total: number;
  /** 参与累加的单次调用数。诊断量:漏记倍数 = 会话累计 / 单次调用。 */
  calls: number;
  /** assistant 事件里未携带 usage 的条数 —— 被杀态下低估的头号嫌疑。 */
  assistantWithoutUsage: number;
  /** 只有部分调用上报、因此整体留空的字段(部分和是伪装成总量的欠计,不如不记)。 */
  underreportedFields: (keyof TranscriptUsage)[];
}

/**
 * 单次调用某字段的值。total 特殊:上游没写时由 input+output 推出 ——
 * `total_tokens = input_tokens + output_tokens`(input 含 cache_read)是上游恒等式,
 * 推出的是事实,不是猜。
 */
function perCallField(u: TranscriptUsage, field: keyof TranscriptUsage): number | undefined {
  const direct = u[field];
  if (direct !== undefined) return direct;
  if (field === "total_tokens" && (u.input_tokens !== undefined || u.output_tokens !== undefined)) {
    return (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
  }
  return undefined;
}

/** 把累加结果收敛成 usage 四元组:只保留「每次调用都上报了」的字段。 */
function accumulatedUsage(
  sums: Partial<Record<keyof TranscriptUsage, number>>,
  present: Partial<Record<keyof TranscriptUsage, number>>,
  calls: number,
): TranscriptUsage {
  const out: TranscriptUsage = {};
  for (const field of USAGE_FIELDS) {
    if (present[field] === calls) out[field] = sums[field] as number;
  }
  return out;
}

function fmtUsage(u: TranscriptUsage | null): string {
  if (u === null) return "∅";
  return USAGE_FIELDS.map((f) => `${f}=${u[f] ?? "-"}`).join(" ");
}

/**
 * 完成态对账:累加值必须与 result 事件的会话累计值逐项相等。
 *
 * 为什么完成态也要对账(r2 的教训):完成态长期「看起来准」是因为旧提取恰好挑中了
 * result 那条 —— 那靠的是「累计值总比单次大」这个巧合,不是任何约束。一旦 transcript
 * 里出现重复的 usage 事件(重试、子会话拼接)或缺 usage 的 assistant 事件,巧合就会失效,
 * 而失真方向无人知晓。对账把「同源」从一句约定变成一条会响的检查。
 *
 * 判据严格:任一侧字段缺失到无法比较也算失败 —— 无法证明相等就不能宣称相等。
 */
function reconcileWithResult(ledger: AttemptUsageLedger, resultUsage: TranscriptUsage, context: {
  resultEvents: number;
  otherUsageEvents: number;
  otherUsageTotal: number;
}): void {
  const diffs: string[] = [];
  const mismatch: string[] = [];
  const acc = ledger.usage;

  if (acc === null) {
    mismatch.push(
      `累加侧没有任何带 usage 的 assistant 事件,无法与 result 累计值(${fmtUsage(resultUsage)})对账` +
        `—— 说明这份 transcript 的单次调用不落 usage,不能凭空拿 result 当累加值`,
    );
  } else {
    for (const field of USAGE_FIELDS) {
      const a = acc[field];
      const r = resultUsage[field];
      if (a === undefined || r === undefined) {
        if (r !== undefined && a === undefined) {
          mismatch.push(
            `${field}:result=${r} 而累加侧未上报 —— 该字段只在部分调用里出现,` +
              `部分和不是总量(${ledger.calls} 次调用)`,
          );
        }
        continue;
      }
      if (a !== r) {
        const ratio = r !== 0 ? (r / a).toFixed(2) : "inf";
        mismatch.push(`${field}:累加=${a} result=${r} 差=${r - a}(result/累加=${ratio}×)`);
      }
    }
  }

  if (ledger.assistantWithoutUsage > 0) {
    diffs.push(`${ledger.assistantWithoutUsage} 条 assistant 事件不带 usage(累加只会低估)`);
  }
  if (ledger.underreportedFields.length > 0) {
    diffs.push(`字段 ${ledger.underreportedFields.join("/")} 在部分调用缺失,累加侧整体留空`);
  }
  if (context.resultEvents > 1) {
    diffs.push(`transcript 里有 ${context.resultEvents} 条带 usage 的 result 事件(疑似多轮会话拼接)`);
  }
  if (context.otherUsageEvents > 0) {
    diffs.push(
      `${context.otherUsageEvents} 条非 assistant/result 事件带 usage(合计 ${context.otherUsageTotal}),` +
        `未纳入累加 —— 未知事件类型,不能猜它是不是重复计数`,
    );
  }
  if (mismatch.length === 0) return;

  throw new TranscriptLedgerMismatchError(
    `token_ledger_unreconciled calls=${ledger.calls} 累加(${fmtUsage(acc)}) ≠ ` +
      `result 累计(${fmtUsage(resultUsage)}):${mismatch.join("; ")}` +
      (diffs.length > 0 ? `| 差异来源候选:${diffs.join("; ")}` : "| 差异来源候选:无(格式与约定一致,数值仍不等)"),
  );
}

/**
 * 逐事件累加提取该 attempt 的会话累计用量 —— **完成态与被杀态共用这一条路径**。
 *
 * 为什么必须逐事件累加(r2 prod 取证,任务 `76464e22`):旧实现是「有 result 用 result、
 * 没 result 用最大的一条 assistant」。被墙钟击杀的任务根本没有 result 事件,于是回落到
 * 单次调用的量级:归档四元组 input 221,006 / cache_read 219,186 / output 161 / 加权 45,818,
 * 而按事件流累加出的真实会话总量是 input 10,686,994 / 加权 2,495,488 —— **input 漏 48.4×、
 * 加权漏 54.5×**。被杀任务恰恰是最贵、最需要成本可见性的那批(C8 路由分类与人工成本审计
 * 都吃这个数),而失败形态让漏记只发生在失败任务上:偏差不是噪声,是系统性的。
 *
 * 为什么「最后一次(或最大一次)调用」不是合法回落:单次调用用量与会话累计用量是两个
 * **不同的量**,用一个填另一个必然错,且错多少取决于「还剩多少调用没被读到」——
 * 恰好是被杀位置决定的。没有任何场景需要这个回落;它只是把「没记」换成了「记错」。
 *
 * result 事件的用法只有一处:当对账基准(见 reconcileWithResult),绝不参与累加 ——
 * 它已经是累计值,再加进去就是双计。
 *
 * 无 usage 事件 → usage=null(「未记录」与「零消耗」严格区分)。完成态对不上 → 抛
 * TranscriptLedgerMismatchError,两个候选值都不取。
 */
export function accumulateUsageFromTranscript(transcript: string): AttemptUsageLedger {
  const lines = transcript.split("\n").filter((l) => l.trim().length > 0);
  const sums: Partial<Record<keyof TranscriptUsage, number>> = {};
  const present: Partial<Record<keyof TranscriptUsage, number>> = {};
  let calls = 0;
  let assistantWithoutUsage = 0;
  let resultUsage: TranscriptUsage | null = null;
  let resultEvents = 0;
  let otherUsageEvents = 0;
  let otherUsageTotal = 0;

  for (const line of lines) {
    let evt: unknown;
    try {
      evt = JSON.parse(line);
    } catch {
      // non-JSON line, ignore
      continue;
    }
    if (!evt || typeof evt !== "object") continue;
    const record = evt as Record<string, unknown>;
    const usage = usageOfEvent(record);
    const type = record.type;

    if (type === "result") {
      // 累计值只当基准用:最后一次 result 对应当前会话(与 extractResultFromTranscript 同约定)
      if (usage) {
        resultUsage = usage;
        resultEvents += 1;
      }
      continue;
    }
    if (type === "assistant") {
      if (!usage) {
        assistantWithoutUsage += 1;
        continue;
      }
      calls += 1;
      for (const field of USAGE_FIELDS) {
        const value = perCallField(usage, field);
        if (value === undefined) continue;
        sums[field] = (sums[field] ?? 0) + value;
        present[field] = (present[field] ?? 0) + 1;
      }
      continue;
    }
    // 其它类型带 usage:不属于「单次调用」的已知形状,不猜它的语义,只留诊断。
    if (usage) {
      otherUsageEvents += 1;
      otherUsageTotal += totalFromUsage(usage);
    }
  }

  const acc = calls === 0 ? null : accumulatedUsage(sums, present, calls);
  const ledger: AttemptUsageLedger = {
    usage: acc,
    total: acc === null ? 0 : totalFromUsage(acc),
    calls,
    assistantWithoutUsage,
    underreportedFields: USAGE_FIELDS.filter((f) => present[f] !== undefined && present[f] !== calls),
  };
  // 被杀态没有 result 可比:累加值是此刻唯一可主张的口径,不报错也不编基准。
  if (resultUsage) reconcileWithResult(ledger, resultUsage, { resultEvents, otherUsageEvents, otherUsageTotal });
  return ledger;
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
