import { describe, expect, it } from "vitest";
import {
  EXIT_BUDGET_ABORT,
  EXIT_SESSION_TURNS_LIMIT,
  classifyAttemptFailure,
  parseVerifyReport,
  ruleMode,
  type RouteDecision,
  type VerifyReportSignals,
} from "../src/routing/classify";
import {
  APPLY_FAILED_STDERR_TAIL,
  ENV_TRANSIENT_VERIFY_STDERR_TAIL,
  ERESOLVE_VERIFY_STDERR_TAIL,
  LOCAL_REFUSED_VERIFY_STDERR_TAIL,
  QUALITY_VERIFY_STDERR_TAIL,
} from "./fixtures/env-transient-report";

/**
 * 路由分类器单测(M9.5②③)。
 *
 * 判据是纯函数,所以这里穷举的是「哪条输入落哪条规则」,不碰 DO。
 * 两条 enforce 档判据要钉死:命中的 kind/rule/action,以及**只有 writer 能命中**
 * (verifier 的退出码来自任务自己的 verify_command,不是平台下发的预算语义)。
 * 环境签名判据要钉死两面:命中即分类、且 action=none(shadow 档不改路由);
 * 以及最容易误报的那几类「看起来像网络」的输出不得命中。
 */

const TASK_ID = "6d4574df-1a25-48dc-8bd9-c2449f21ddf7";
const VERIFIER_ATTEMPT = "f1673050";

function report(over: Partial<VerifyReportSignals> = {}): VerifyReportSignals {
  return {
    apply: { exit_code: 0, stderr_tail: "" },
    verify: { exit_code: 1, stderr_tail: ENV_TRANSIENT_VERIFY_STDERR_TAIL },
    ...over,
  };
}

describe("预算判据:qwen 自己下发的退出码", () => {
  it("writer exit 53 → budget_turns,强制档,主张 blocked", () => {
    expect(EXIT_SESSION_TURNS_LIMIT).toBe(53);
    const d = classifyAttemptFailure({ role: "writer", exit_code: 53 });
    expect(d).toEqual({
      kind: "budget_turns",
      rule: "writer_exit_53_session_turns",
      action: "blocked",
    } satisfies RouteDecision);
    expect(ruleMode(d.rule)).toBe("enforce");
  });

  it("writer exit 55 → budget_abort,强制档,主张 blocked", () => {
    expect(EXIT_BUDGET_ABORT).toBe(55);
    const d = classifyAttemptFailure({ role: "writer", exit_code: 55 });
    expect(d).toEqual({
      kind: "budget_abort",
      rule: "writer_exit_55_budget_abort",
      action: "blocked",
    } satisfies RouteDecision);
    expect(ruleMode(d.rule)).toBe("enforce");
  });

  it("两条预算判据都不主张返工(同规格返工必然复现)", () => {
    for (const exit of [53, 55]) {
      expect(classifyAttemptFailure({ role: "writer", exit_code: exit }).action).toBe("blocked");
    }
  });

  it("预算判据只认 writer:verifier 的 55 来自任务自己的 verify_command", () => {
    // 误命中会把真质量失败洗成平台问题(比返工更坏:任务被静默停成 BLOCKED)
    for (const exit of [53, 55]) {
      expect(classifyAttemptFailure({ role: "verifier", exit_code: exit })).toEqual({
        kind: "quality",
        rule: "quality_fallback",
        action: "rework",
      });
    }
  });
});

describe("环境签名判据:apply 成功 + verify 失败 + 网络签名", () => {
  it("2026-09-02 标本夹具 → env_transient,shadow 档,不改路由", () => {
    const d = classifyAttemptFailure({
      role: "verifier",
      exit_code: 1,
      verify_report: report(),
    });
    expect(d).toEqual({
      kind: "env_transient",
      rule: "verifier_env_network_signature",
      action: "none",
    } satisfies RouteDecision);
    expect(ruleMode(d.rule)).toBe("shadow");
  });

  it("签名至少覆盖 ECONNRESET / ENOTFOUND / ETIMEDOUT", () => {
    for (const errno of ["ECONNRESET", "ENOTFOUND", "ETIMEDOUT"]) {
      const d = classifyAttemptFailure({
        role: "verifier",
        exit_code: 1,
        verify_report: report({
          verify: { exit_code: 1, stderr_tail: `npm error code ${errno}\nnpm error network aborted` },
        }),
      });
      expect(d.kind, errno).toBe("env_transient");
    }
  });

  it("`npm error code <网络码>` 前缀算签名", () => {
    for (const code of ["ECONNRESET", "EAI_AGAIN", "ENETUNREACH", "ERR_SOCKET_TIMEOUT", "ECONNREFUSED"]) {
      const d = classifyAttemptFailure({
        role: "verifier",
        exit_code: 1,
        verify_report: report({ verify: { exit_code: 1, stderr_tail: `npm error code ${code}` } }),
      });
      expect(d.kind, code).toBe("env_transient");
    }
  });

  it("npm 自己归类为网络的行(npm error network …)算签名", () => {
    const d = classifyAttemptFailure({
      role: "verifier",
      exit_code: 1,
      verify_report: report({
        verify: { exit_code: 1, stderr_tail: "npm error network aborted" },
      }),
    });
    expect(d.kind).toBe("env_transient");
  });

  it("apply 失败时网络签名不生效:候选不可重放是质量事实", () => {
    const d = classifyAttemptFailure({
      role: "verifier",
      exit_code: 20,
      verify_report: {
        apply: { exit_code: 1, stderr_tail: APPLY_FAILED_STDERR_TAIL },
        verify: { exit_code: 1, stderr_tail: ENV_TRANSIENT_VERIFY_STDERR_TAIL },
      },
    });
    expect(d.kind).toBe("quality");
  });

  it("没有 verify 阶段(未跑 verify_command)不签", () => {
    const d = classifyAttemptFailure({
      role: "verifier",
      exit_code: 20,
      verify_report: { apply: { exit_code: 0, stderr_tail: "" }, verify: null },
    });
    expect(d.kind).toBe("quality");
  });

  it("报告缺失/非 verifier 角色时签名规则无从命中", () => {
    expect(classifyAttemptFailure({ role: "verifier", exit_code: 1, verify_report: null }).kind).toBe("quality");
    expect(
      classifyAttemptFailure({ role: "writer", exit_code: 1, verify_report: report() }).kind,
    ).toBe("quality");
  });
});

describe("环境签名不误报:不是「像网络」就算环境", () => {
  it("普通断言失败 → quality", () => {
    const d = classifyAttemptFailure({
      role: "verifier",
      exit_code: 1,
      verify_report: report({ verify: { exit_code: 1, stderr_tail: QUALITY_VERIFY_STDERR_TAIL } }),
    });
    expect(d.kind).toBe("quality");
  });

  it("`npm error code ERESOLVE` 同是 E 前缀但不是网络类 → quality", () => {
    const d = classifyAttemptFailure({
      role: "verifier",
      exit_code: 1,
      verify_report: report({ verify: { exit_code: 1, stderr_tail: ERESOLVE_VERIFY_STDERR_TAIL } }),
    });
    expect(d.kind).toBe("quality");
  });

  it("测试连不上本地服务的裸 ECONNREFUSED → quality(只有 npm 自己的 error code 行才算出站故障)", () => {
    const d = classifyAttemptFailure({
      role: "verifier",
      exit_code: 1,
      verify_report: report({
        verify: { exit_code: 1, stderr_tail: LOCAL_REFUSED_VERIFY_STDERR_TAIL },
      }),
    });
    expect(d.kind).toBe("quality");
  });

  it("签名只看 verify 的 stderr_tail,apply 侧的文本不参与", () => {
    const d = classifyAttemptFailure({
      role: "verifier",
      exit_code: 1,
      verify_report: {
        apply: { exit_code: 0, stderr_tail: ENV_TRANSIENT_VERIFY_STDERR_TAIL },
        verify: { exit_code: 1, stderr_tail: QUALITY_VERIFY_STDERR_TAIL },
      },
    });
    expect(d.kind).toBe("quality");
  });

  it("报告里 verify 阶段成功时不命中:签名只针对失败的 verify", () => {
    const d = classifyAttemptFailure({
      role: "verifier",
      exit_code: 1,
      verify_report: report({
        verify: { exit_code: 0, stderr_tail: ENV_TRANSIENT_VERIFY_STDERR_TAIL },
      }),
    });
    expect(d.kind).toBe("quality");
  });
});

describe("quality 兜底:维持既有返工语义", () => {
  it("writer 的其它非零退出码一律 quality/rework", () => {
    for (const exit of [1, 11, 20, 127, -1]) {
      expect(classifyAttemptFailure({ role: "writer", exit_code: exit })).toEqual({
        kind: "quality",
        rule: "quality_fallback",
        action: "rework",
      });
    }
  });

  it("verifier 侧不存在 blocked 动作(环境签名是 shadow 档)", () => {
    const inputs = [
      { role: "verifier" as const, exit_code: 1 },
      { role: "verifier" as const, exit_code: 1, verify_report: report() },
      { role: "verifier" as const, exit_code: -1 },
      { role: "verifier" as const, exit_code: 53 },
      { role: "verifier" as const, exit_code: 55 },
    ];
    for (const input of inputs) {
      expect(classifyAttemptFailure(input).action, JSON.stringify(input)).not.toBe("blocked");
    }
  });

  it("兜底档有强制力:它不是启发式,它就是既有硬门禁", () => {
    expect(ruleMode("quality_fallback")).toBe("enforce");
  });
});

describe("parseVerifyReport:只认形状,不猜语义", () => {
  it("容忍报告里的额外字段(stdout_tail / schema_version / base)", () => {
    const text = JSON.stringify({
      schema_version: 2,
      task_id: TASK_ID,
      attempt_id: VERIFIER_ATTEMPT,
      writer_manifest_key: "manifests/task/x/writer.json",
      base: { sha: null, source: "unknown_legacy" },
      apply: { exit_code: 0, stderr_tail: "" },
      verify: { exit_code: 1, stdout_tail: "npm warn", stderr_tail: "npm error code ECONNRESET" },
    });
    expect(parseVerifyReport(text)).toEqual({
      apply: { exit_code: 0, stderr_tail: "" },
      verify: { exit_code: 1, stderr_tail: "npm error code ECONNRESET" },
    });
  });

  it("verify 为 null 是合法形态(apply 失败或没有 verify_command)", () => {
    const text = JSON.stringify({ apply: { exit_code: 20, stderr_tail: "boom" }, verify: null });
    expect(parseVerifyReport(text)).toEqual({
      apply: { exit_code: 20, stderr_tail: "boom" },
      verify: null,
    });
  });

  it("不可解析 / 形状不符 / 空输入一律 null(交回 quality 兜底)", () => {
    for (const raw of [
      null,
      undefined,
      "",
      "not json",
      "已按要求完成",
      "[]",
      "null",
      JSON.stringify({ apply: { exit_code: 0 } }),
      JSON.stringify({ apply: { exit_code: "0", stderr_tail: "" } }),
      JSON.stringify({ apply: { exit_code: 0, stderr_tail: "" }, verify: { exit_code: 1 } }),
      JSON.stringify({ apply: { exit_code: 0, stderr_tail: "" }, verify: "boom" }),
    ]) {
      expect(parseVerifyReport(raw as string | null | undefined), String(raw)).toBeNull();
    }
  });
});
