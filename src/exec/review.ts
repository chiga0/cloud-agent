import type { Env } from "../types";
import type { TranscriptUsage } from "./extract";
import { putArtifact, type ArtifactRef } from "../audit/evidence";

export interface ReviewLLMResult {
  exitCode: number;
  transcript: ArtifactRef;
  transcriptRaw: string;
  stderr: ArtifactRef;
  tokens: number;
  /**
   * chat completions 的用量拆分。上游用的是 OpenAI 风格字段名,这里规范化成与
   * qwen stream-json 同一套口径(input/output/total)好让台账只有一个形状;
   * 隐式缓存命中不下发,故 cache_read 缺省 —— 成本按全 fresh 计(保守)。
   */
  usage: TranscriptUsage | null;
}

/** 把 chat completions 的 usage 规范化为台账口径;没有任何数值字段即 null。 */
function normalizeChatUsage(
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined,
): TranscriptUsage | null {
  if (!usage) return null;
  const out: TranscriptUsage = {
    input_tokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : undefined,
    output_tokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : undefined,
    total_tokens: typeof usage.total_tokens === "number" ? usage.total_tokens : undefined,
  };
  if (out.input_tokens === undefined && out.output_tokens === undefined && out.total_tokens === undefined) {
    return null;
  }
  return out;
}

/**
 * reviewer 走纯 LLM 调用(无工具):审查是"判断"不是"执行",
 * qwen-code 这类 coding agent 即使被禁止也会执行查询,输出不可控。
 * 直连百炼 compatible-mode 一次性 chat 调用,天然只产出文本(要求一行 JSON),
 * token 从 usage 字段记账。
 *
 * ⚠️ 「秒级返回」这个前提是错的,prod 台账实测(56 次带首尾时刻的 reviewer attempt):
 * 墙钟中位 **27.0s**;记下 token 的 50 次最长排到 64.6s(另有一次 08-31 的 250s 无法拆解,
 * 不计入),而 **6 次 0 token 的全部落在 67.8–71.1s** —— 60s abort + 约 8~11s 排队/step 开销。
 * 也就是说下面那个 60_000ms 上限正好压在成功延迟的天花板附近:6/56 ≈ 11% 的审查以
 * `reviewer_unavailable` 收场,且集中在差量大的候选上。更要紧的是 12 这一个码今天同时代表
 * 三件事(传输失败/超时、非 2xx、响应体解析不了),三者含义与处置完全不同 ——
 * 分流与上限都归 c15 处理,这里只记账不改动。
 */
export async function runReviewLLM(
  env: Env,
  args: { attemptId: string; prompt: string; model: string },
): Promise<ReviewLLMResult> {
  const started = Date.now();
  const body = {
    model: args.model,
    messages: [
      { role: "system", content: "严格按 user 消息给出的 JSON schema 输出一行 JSON,不输出任何其他内容、不输出 markdown。" },
      { role: "user", content: args.prompt },
    ],
    temperature: 0,
    max_tokens: 1200,
  };

  let resp: Response;
  let raw: string;
  try {
    resp = await fetch(`${env.MODEL_UPSTREAM_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.DASHSCOPE_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    raw = await resp.text();
  } catch (err) {
    const errText = `review LLM call failed: ${String(err).slice(0, 500)}`;
    const transcript = await putArtifact(env.ARTIFACTS, errText, `attempts/${args.attemptId}`);
    const stderr = await putArtifact(env.ARTIFACTS, errText, `attempts/${args.attemptId}`);
    return { exitCode: 12, transcript, transcriptRaw: errText, stderr, tokens: 0, usage: null };
  }

  const transcriptRaw = JSON.stringify({
    type: "review-llm",
    model: args.model,
    status: resp.status,
    ms: Date.now() - started,
    prompt: args.prompt,
    response: raw,
  });
  const transcript = await putArtifact(env.ARTIFACTS, transcriptRaw, `attempts/${args.attemptId}`);

  if (!resp.ok) {
    const stderr = await putArtifact(
      env.ARTIFACTS,
      `HTTP ${resp.status}\n${raw.slice(0, 4000)}`,
      `attempts/${args.attemptId}`,
    );
    return { exitCode: 12, transcript, transcriptRaw, stderr, tokens: 0, usage: null };
  }

  let parsed: {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    const stderr = await putArtifact(env.ARTIFACTS, "invalid JSON response", `attempts/${args.attemptId}`);
    return { exitCode: 12, transcript, transcriptRaw, stderr, tokens: 0, usage: null };
  }
  const text = parsed.choices?.[0]?.message?.content ?? "";
  const stderr = await putArtifact(env.ARTIFACTS, "", `attempts/${args.attemptId}`);
  return {
    exitCode: 0,
    transcript,
    transcriptRaw: text,
    stderr,
    tokens: parsed.usage?.total_tokens ?? 0,
    usage: normalizeChatUsage(parsed.usage),
  };
}
