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

export interface ReviewDecision {
  decision: "approve" | "reject";
  reason: string;
}

/**
 * 解析 reviewer 的裁决。reviewer 走纯 LLM,输入就是单行 JSON 回答
 * (不是 NDJSON transcript,不能经 extractResultFromTranscript 处理)。
 * 依次尝试:整段 JSON 解析 → 文本中搜索 JSON 片段 → 关键词兜底。
 */
export function extractReviewDecision(text: string): ReviewDecision {
  try {
    const parsed = JSON.parse(text) as { decision?: unknown; reason?: unknown };
    if (parsed.decision === "approve" || parsed.decision === "reject") {
      return { decision: parsed.decision, reason: String(parsed.reason ?? "") };
    }
  } catch {
    // fall through to fragment search
  }
  const m = text.match(/\{"decision"\s*:\s*"(approve|reject)"(?:[^}]*"reason"\s*:\s*"((?:[^"\\]|\\.)*)")?\}/);
  if (m) {
    return { decision: m[1] as "approve" | "reject", reason: m[2] ? JSON.parse(`"${m[2]}"`) : "" };
  }
  const lower = text.toLowerCase();
  return {
    decision: lower.includes("approve") && !lower.includes("reject") ? "approve" : "reject",
    reason: text.slice(0, 500),
  };
}
