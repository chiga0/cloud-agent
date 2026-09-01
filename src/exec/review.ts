import type { Env } from "../types";
import { putArtifact, type ArtifactRef } from "../audit/evidence";

export interface ReviewLLMResult {
  exitCode: number;
  transcript: ArtifactRef;
  transcriptRaw: string;
  stderr: ArtifactRef;
  tokens: number;
}

/**
 * reviewer 走纯 LLM 调用(无工具):审查是"判断"不是"执行",
 * qwen-code 这类 coding agent 即使被禁止也会执行查询,输出不可控。
 * 直连百炼 compatible-mode 一次性 chat 调用,秒级返回,
 * 天然只产出文本(要求一行 JSON),token 从 usage 字段记账。
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
    return { exitCode: 12, transcript, transcriptRaw: errText, stderr, tokens: 0 };
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
    return { exitCode: 12, transcript, transcriptRaw, stderr, tokens: 0 };
  }

  let parsed: { choices?: Array<{ message?: { content?: string } }>; usage?: { total_tokens?: number } };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    const stderr = await putArtifact(env.ARTIFACTS, "invalid JSON response", `attempts/${args.attemptId}`);
    return { exitCode: 12, transcript, transcriptRaw, stderr, tokens: 0 };
  }
  const text = parsed.choices?.[0]?.message?.content ?? "";
  const stderr = await putArtifact(env.ARTIFACTS, "", `attempts/${args.attemptId}`);
  return {
    exitCode: 0,
    transcript,
    transcriptRaw: text,
    stderr,
    tokens: parsed.usage?.total_tokens ?? 0,
  };
}
