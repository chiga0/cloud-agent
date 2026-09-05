import type { Env } from "../types";
import { totalFromUsage, type TranscriptUsage } from "./extract";
import { putArtifact, type ArtifactRef } from "../audit/evidence";
import { errorClassFromHttpStatus, type ErrorClass } from "../routing/error-class";

export interface ReviewLLMResult {
  exitCode: number;
  transcript: ArtifactRef;
  transcriptRaw: string;
  stderr: ArtifactRef;
  tokens: number;
  /**
   * 失败成因(§13.23)。成功时为 undefined;失败时**必非 undefined** —— 三个 exit 12 位点
   * 各自回答的是不同的问题(超时 / 端点拒绝 / 响应体读不懂),共用一个码就等于把
   * 「该调上限」和「该查端点」两种处置压成一个不可分辨的信号。
   */
  errorClass?: ErrorClass;
  /**
   * chat completions 的用量拆分。上游用的是 OpenAI 风格字段名,这里规范化成与
   * qwen stream-json 同一套口径(input/output/total)好让台账只有一个形状;
   * 隐式缓存命中不下发,故 cache_read 缺省 —— 成本按全 fresh 计(保守)。
   */
  usage: TranscriptUsage | null;
}

/**
 * reviewer chat 调用的墙钟上限(毫秒)。
 *
 * 这个数是**算出来的**,不是拍的。输入是 prod 台账实测(56 次带首尾时刻的 reviewer attempt,
 * 分布抄在本文件原来的注释里):
 * - `REVIEW_OBS_SLOWEST_SUCCESS_MS = 64_600`:记到 token 的 50 次里最长的一次 ——
 *   这是**真实成功**能慢到的已知上界;
 * - 倍数 1.5:未观测尾部的余量。样本只有 50 个成功点,最大值之外没有任何分位数可估,
 *   所以余量按「至少比已知最慢成功慢一半」取,而不是挑一个整齐的 120s;
 * - 向上取整到整秒。
 *
 * ⇒ 97_000ms。对照旧值 60_000:它**低于**已观测的最慢真实成功(64.6s),即旧上限不是
 * 「安全线」而是一堵压在成功延迟天花板上的墙 —— 那 6 次 0 token 的 67.8~71.1s
 * (= 60s abort + 约 8~11s 排队/step 开销)就是这么来的:6/56 ≈ 11% 的审查注定拿不到结论。
 *
 * 与外层预算的现场核对(abort 必须早于 attempt/step 预算,否则换个死法而已):
 * - reviewer attempt 的截止 = `startAttempt({max_wall_seconds:
 *   resolveBudget(undefined, env).budgetSeconds})` → `statemachine.attemptDeadline`
 *   排的 DO alarm。prod 配的 `DEFAULT_MAX_WALL_SECONDS = 3600`(wrangler.jsonc),
 *   代码缺省 `FALLBACK_MAX_WALL_SECONDS = 3600`:108s(= 97s abort + 11.1s 实测最大开销)
 *   < 3600s,**余量 33 倍**;
 * - Workflows 侧:reviewer 走单个 `step.do("exec", EXEC_RETRIES)`,而 `runReviewLLM`
 *   **自己 catch 掉 abort 并返回结果**,从不抛错 ⇒ 不触发 step 重试(否则会 ×3 = 324s);
 * - workerd 挂起检测(单条 await 约 29:48 被杀,见 §7.2.2 与 MAX_WRITER_WALL_MINUTES 注释):
 *   108s < 1788s,**余量 16 倍**。
 * 这条不等式由 `test/review-error-class.test.ts` 钉住:将来谁把上限改成「一个更大的数」
 * 而越过 attempt 截止,测试会红。
 */
export const REVIEW_OBS_SLOWEST_SUCCESS_MS = 64_600;
export const REVIEW_TIMEOUT_HEADROOM = 1.5;
export const REVIEW_LLM_TIMEOUT_MS =
  Math.ceil((REVIEW_OBS_SLOWEST_SUCCESS_MS * REVIEW_TIMEOUT_HEADROOM) / 1000) * 1000;

/**
 * 传输层异常 → 成因。`AbortSignal.timeout` 到期在 workerd 里回 `DOMException{"TimeoutError"}`;
 * 判据先读 `name`,再退到错误文本(异常被包一层时 name 会丢)。**只有**超时形状算
 * `upstream_timeout`,其余传输失败(连接重置、DNS 解析不出)落 `upstream_error` ——
 * 两者的处置不同:前者是上限该复核,后者要查端点。
 */
export function reviewTransportClass(err: unknown): ErrorClass {
  const bag = err as { name?: unknown; message?: unknown; cause?: unknown } | null;
  if (bag?.name === "TimeoutError" || bag?.name === "AbortError") return "upstream_timeout";
  // name 可能随包装丢失(DOMException → Error → 字符串各层都有人这么干),所以退到文本;
  // 判据仍是**超时形状**这几个词,不是「有 error 字样就算」——那会把质量失败也吸进来。
  const text = `${String(err)} ${String(bag?.message ?? "")} ${String(bag?.cause ?? "")}`;
  return /\bTimeoutError\b|\bAbortError\b|timeout|timed out|abort/i.test(text)
    ? "upstream_timeout"
    : "upstream_error";
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
 * 也就是说原来那个 60_000ms 上限正好压在成功延迟的天花板附近:6/56 ≈ 11% 的审查以
 * `reviewer_unavailable` 收场,且集中在差量大的候选上。更要紧的是 12 这一个码曾同时代表
 * 三件事(传输失败/超时、非 2xx、响应体解析不了),三者含义与处置完全不同。
 * §13.23 两样都处理了:上限按上面的算式重取(`REVIEW_LLM_TIMEOUT_MS`),三个位点各带一个
 * `errorClass`(与 writer 的 provider 分类同一份词表,见 `src/routing/error-class.ts`)。
 * 退出码**仍是 12** —— 换码等于悄悄改路由语义(`onReviewerReport` 按 exit!=0 判 unavailable),
 * 分流靠枚举,不靠新造数值。
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
      signal: AbortSignal.timeout(REVIEW_LLM_TIMEOUT_MS),
    });
    raw = await resp.text();
  } catch (err) {
    // 位点①:传输失败或到期 abort。错误原文只进 transcript/stderr 产物(供操作员读数),
    // 进事件链的只有 errorClass。
    const errorClass = reviewTransportClass(err);
    const errText = `review LLM call failed: ${String(err).slice(0, 500)}`;
    const transcript = await putArtifact(env.ARTIFACTS, errText, `attempts/${args.attemptId}`);
    const stderr = await putArtifact(env.ARTIFACTS, errText, `attempts/${args.attemptId}`);
    return { exitCode: 12, transcript, transcriptRaw: errText, stderr, errorClass, tokens: 0, usage: null };
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
    // 位点②:端点明确回非 2xx。状态码 → 成因用与 writer 侧同一张表(403 在两个读面上
    // 必须叫同一个名字),原文留在 stderr 产物里。
    const errorClass = errorClassFromHttpStatus(resp.status);
    const stderr = await putArtifact(
      env.ARTIFACTS,
      `HTTP ${resp.status}\n${raw.slice(0, 4000)}`,
      `attempts/${args.attemptId}`,
    );
    return { exitCode: 12, transcript, transcriptRaw, stderr, errorClass, tokens: 0, usage: null };
  }

  let parsed: {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    // 位点③:2xx 但响应体不是可读的 JSON —— 端点/网关换了形状,与「慢」和「拒绝」都无关。
    const stderr = await putArtifact(env.ARTIFACTS, "invalid JSON response", `attempts/${args.attemptId}`);
    return {
      exitCode: 12,
      transcript,
      transcriptRaw,
      stderr,
      errorClass: "bad_response_body" as const,
      tokens: 0,
      usage: null,
    };
  }
  const text = parsed.choices?.[0]?.message?.content ?? "";
  const stderr = await putArtifact(env.ARTIFACTS, "", `attempts/${args.attemptId}`);
  // 单次 chat 调用 = 一次调用的全部用量,累加在这个退化情形下就是它本身。
  // tokens 从同一个 usage 对象派生(不重抄一遍 total 的推导):raw total 与四元组
  // 必须是同一个量的两种写法,否则 reviewer 与 writer 的台账又是两套口径。
  const usage = normalizeChatUsage(parsed.usage);
  return {
    exitCode: 0,
    transcript,
    transcriptRaw: text,
    stderr,
    tokens: usage === null ? 0 : totalFromUsage(usage),
    usage,
  };
}
