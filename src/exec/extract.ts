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
 * 从 qwen-code stream-json transcript 提取 token 用量。
 * type=result 事件的 usage 字段优先;不存在时累加所有 usage 字段。
 * 返回 total_tokens 整数,无法解析则返回 0。
 */
export function extractTokensFromTranscript(transcript: string): number {
  const lines = transcript.split("\n").filter((l) => l.trim().length > 0);
  let best = 0;

  for (const line of lines) {
    try {
      const evt = JSON.parse(line) as Record<string, unknown>;
      const usage = evt.usage as Record<string, number> | undefined;
      if (!usage) continue;
      const total =
        typeof usage.total_tokens === "number"
          ? usage.total_tokens
          : (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
      // type=result usage is cumulative; take the last/largest value seen
      if (total > best) best = total;
    } catch {
      // non-JSON line, ignore
    }
  }

  return best;
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
