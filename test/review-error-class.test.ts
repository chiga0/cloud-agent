import { afterEach, describe, expect, it } from "vitest";
import {
  REVIEW_LLM_TIMEOUT_MS,
  REVIEW_OBS_SLOWEST_SUCCESS_MS,
  REVIEW_TIMEOUT_HEADROOM,
  reviewTransportClass,
  runReviewLLM,
  type ReviewLLMResult,
} from "../src/exec/review";
import { FALLBACK_MAX_WALL_SECONDS } from "../src/control/budget";
import { ERROR_CLASSES, type ErrorClass } from "../src/routing/error-class";
import type { Env } from "../src/types";

/**
 * reviewer 的三个 exit 12 位点分流(§13.23)。
 *
 * 三件事过去共用一个码:传输失败/到期 abort、端点回非 2xx、2xx 但响应体读不懂。
 * 这里逐个注入,要求**同码不同因**:退出码一字不改(换码等于悄悄改 `onReviewerReport`
 * 的路由语义),成因各归各的枚举。
 *
 * 另外钉住超时上限是算出来的、且 abort 仍早于外层预算 —— 「改成一个大数」过不了这组断言。
 */

const realFetch = globalThis.fetch;

const env = {
  ARTIFACTS: { put: async () => null },
  MODEL_UPSTREAM_BASE: "https://example.invalid/v1",
  DASHSCOPE_API_KEY: "test-key",
} as unknown as Env;

async function callWith(fetchImpl: typeof fetch): Promise<ReviewLLMResult> {
  globalThis.fetch = fetchImpl;
  return runReviewLLM(env, { attemptId: "attempt-review-cls", prompt: "p", model: "test-model" });
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("三个位点各给一个成因,退出码保持 12", () => {
  it("位点①:AbortSignal.timeout 到期 → upstream_timeout", async () => {
    const r = await callWith((async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }) as typeof fetch);
    expect(r.exitCode).toBe(12);
    expect(r.errorClass).toBe("upstream_timeout");
    expect(r.tokens).toBe(0);
  });

  it("位点①的另一种死法:连接层失败 → upstream_error(不是超时)", async () => {
    const r = await callWith((async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: "Error: read ECONNRESET" });
    }) as typeof fetch);
    expect(r.exitCode).toBe(12);
    expect(r.errorClass).toBe("upstream_error");
  });

  it("位点①的第三种死法:resp.text() 半路抛 → 按异常形状判,不猜", async () => {
    const r = await callWith((async () =>
      new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{\"choices\":"));
          controller.error(new Error("terminated: network error"));
        },
      }))
    ) as typeof fetch);
    expect(r.exitCode).toBe(12);
    expect(r.errorClass).toBeDefined();
    expect(r.errorClass).not.toBe("bad_response_body");
  });

  it("位点②:非 2xx → 按状态码取因,与 writer 侧同一张表", async () => {
    for (const [status, cls] of [
      [403, "provider_access_denied"],
      [429, "provider_quota_exhausted"],
      [500, "upstream_error"],
    ] as const) {
      const r = await callWith((async () => new Response("quota got out", { status })) as typeof fetch);
      expect(r.exitCode, String(status)).toBe(12);
      expect(r.errorClass, String(status)).toBe(cls);
    }
  });

  it("位点③:2xx 但响应体不是 JSON → bad_response_body", async () => {
    const r = await callWith((async () =>
      new Response("<!doctype html><title>gateway</title>", { status: 200 })
    ) as typeof fetch);
    expect(r.exitCode).toBe(12);
    expect(r.errorClass).toBe("bad_response_body");
  });

  it("成功路径不带成因", async () => {
    const r = await callWith((async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "{\"decision\":\"accept\",\"reason\":\"ok\"}" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        { status: 200 },
      )
    ) as typeof fetch);
    expect(r.exitCode).toBe(0);
    expect(r.errorClass).toBeUndefined();
    expect(r.tokens).toBe(15);
  });

  it("三个位点的成因两两不同(三因合一已经不再成立)", async () => {
    const classes = await Promise.all([
      callWith((async () => {
        throw new DOMException("timeout", "TimeoutError");
      }) as typeof fetch).then((r) => r.errorClass),
      callWith((async () => new Response("no", { status: 403 })) as typeof fetch).then(
        (r) => r.errorClass,
      ),
      callWith((async () => new Response("not json", { status: 200 })) as typeof fetch).then(
        (r) => r.errorClass,
      ),
    ]);
    expect(new Set(classes).size).toBe(3);
    for (const cls of classes) {
      expect(cls).not.toBeNull();
      expect(isKnownClass(cls)).toBe(true);
    }
  });

  it("原始响应体不进成因:枚举之外不携带任何文本", async () => {
    const secret = "Bearer sk-super-secret-response-body";
    const r = await callWith((async () => new Response(secret, { status: 403 })) as typeof fetch);
    expect(r.errorClass).toBe("provider_access_denied");
    expect(String(r.errorClass)).not.toContain(secret);
    // 原文只在产物里(操作员读数用),事件链只转述枚举
    expect(r.transcriptRaw).toContain("403");
  });
});

function isKnownClass(v: unknown): v is ErrorClass {
  return typeof v === "string" && (ERROR_CLASSES as readonly string[]).includes(v);
}

describe("上限的算式与外层预算的关系", () => {
  it("97s = 最慢真实成功 64.6s × 1.5 余量,向上取整到整秒", () => {
    expect(REVIEW_TIMEOUT_HEADROOM).toBeGreaterThan(1);
    expect(REVIEW_LLM_TIMEOUT_MS).toBe(
      Math.ceil((REVIEW_OBS_SLOWEST_SUCCESS_MS * REVIEW_TIMEOUT_HEADROOM) / 1000) * 1000,
    );
    expect(REVIEW_LLM_TIMEOUT_MS).toBe(97_000);
  });

  it("新上限必须**高于**已观测的最慢真实成功,否则还是在掐成功", () => {
    expect(REVIEW_LLM_TIMEOUT_MS).toBeGreaterThan(REVIEW_OBS_SLOWEST_SUCCESS_MS);
  });

  it("abort + 实测最大开销(11.1s)仍远早于 attempt 截止与 step 预算", () => {
    const QUEUE_OVERHEAD_MAX_MS = 11_100; // 67.8~71.1s 那 6 次里最大的一段
    const worstCase = REVIEW_LLM_TIMEOUT_MS + QUEUE_OVERHEAD_MAX_MS;
    // 本仓最紧的一次 attempt 截止 = 测试环境的 DEFAULT_MAX_WALL_SECONDS(600s)
    expect(worstCase).toBeLessThan(600_000);
    // 代码缺省预算(3600s)下余量 33 倍
    expect(worstCase).toBeLessThan(FALLBACK_MAX_WALL_SECONDS * 1000);
    // workerd 单条 await 的挂起检测 ≈ 29:48(§7.2.2),必须留足余量
    expect(worstCase).toBeLessThan(29 * 60_000);
  });
});

describe("reviewTransportClass:超时与传输失败可分辨,且不靠宽泛关键词", () => {
  it("name 在场优先读 name", () => {
    expect(reviewTransportClass(new DOMException("x", "TimeoutError"))).toBe("upstream_timeout");
    expect(reviewTransportClass(new DOMException("x", "AbortError"))).toBe("upstream_timeout");
  });

  it("被包一层(name 丢了)才退到文本形状", () => {
    expect(reviewTransportClass({ name: "DOMException", message: "The operation was aborted due to timeout" })).toBe(
      "upstream_timeout",
    );
  });

  it("连接层失败不算超时", () => {
    expect(reviewTransportClass(new TypeError("fetch failed"))).toBe("upstream_error");
    expect(reviewTransportClass(Object.assign(new TypeError("fetch failed"), { cause: "ECONNRESET" }))).toBe(
      "upstream_error",
    );
  });
});
