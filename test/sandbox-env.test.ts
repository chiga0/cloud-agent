import { describe, expect, it } from "vitest";
import { sandboxModelEnv } from "../src/exec/sandbox";
import type { Env } from "../src/types";

const base = { MODEL_UPSTREAM_BASE: "https://upstream.invalid/v1" } as Env;

/**
 * 注入容器的那把 key 决定「沙箱泄露能烧掉什么」,所以两件事要钉住:
 * 配了独立低权 key 时绝不混用高权 key;没配时明确回落而不是静默失败。
 */
describe("sandboxModelEnv", () => {
  it("uses the dedicated low-privilege key for the container", () => {
    const env = { ...base, DASHSCOPE_API_KEY: "high", SANDBOX_MODEL_API_KEY: "low" };
    const out = sandboxModelEnv(env, "m1");
    expect(out.OPENAI_API_KEY).toBe("low");
    expect(out.OPENAI_BASE_URL).toBe(env.MODEL_UPSTREAM_BASE);
    expect(out.OPENAI_MODEL).toBe("m1");
  });

  it("falls back to the shared control-plane key when unconfigured", () => {
    const env = { ...base, DASHSCOPE_API_KEY: "high" };
    expect(sandboxModelEnv(env, "m1").OPENAI_API_KEY).toBe("high");
  });

  it("warns on the fallback so the degraded state is greppable in logs", () => {
    const warns: string[] = [];
    const original = console.warn;
    console.warn = (msg?: unknown) => warns.push(String(msg));
    try {
      sandboxModelEnv({ ...base, DASHSCOPE_API_KEY: "high" }, "m1");
      sandboxModelEnv({ ...base, DASHSCOPE_API_KEY: "high", SANDBOX_MODEL_API_KEY: "low" }, "m1");
    } finally {
      console.warn = original;
    }
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("credential_fallback");
  });
});
