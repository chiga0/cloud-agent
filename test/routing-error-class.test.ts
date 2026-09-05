import { describe, expect, it } from "vitest";
import {
  ERROR_CLASSES,
  classifyProviderError,
  errorClassFromHttpStatus,
  isErrorClass,
} from "../src/routing/error-class";
import { isCliErrorShape } from "../src/exec/cli-exit";
import {
  providerInfraCandidate,
  classifyAttemptFailure,
  routingInfraMode,
  type AttemptFailureSignals,
  type RouteDecision,
} from "../src/routing/classify";
import {
  PROVIDER_403_RESULT_LEN,
  PROVIDER_403_RESULT_TEXT,
  PROVIDER_ACCESS_DENIED_BARE,
  QUALITY_RESULT_TEXT,
} from "./fixtures/provider-error-report";

/**
 * provider 成因分类器(§13.23)的判据单测。纯函数,所以这里穷举「哪条输入落哪个成因」,
 * 不碰 DO 也不起沙箱。
 *
 * 三条纪律各有一组断言钉住:
 * 1. **按形状不按数值**:判读一处都不读 exit_code —— 同一份文本换七个退出码必须给出
 *    逐字段相同的结论(2026-09-03 标本的 11 是 `adjudicateCliExit` 上翻的产物,不是成因);
 * 2. **误报不行**:瞬态成因一律 is_infra=false,成功总结里*引用*这些字样一律不命中;
 * 3. **词表只有一份**:与 `src/exec/cli-exit.ts` 的形状表做锁步断言 —— 那张表认的整串
 *    错误形状,这边必须给出非 null 成因,否则两张表哪天分叉就是「同一故障两个名字」。
 */

const ALL_EXIT_CODES = [0, 1, 11, 12, 20, 53, 55, 127, -1];

describe("标本形状:2026-09-03 的 403 必须被认出来", () => {
  it("事故 result 文本逐字收录,长度就是取证的那个 95", () => {
    expect(PROVIDER_403_RESULT_TEXT.length).toBe(PROVIDER_403_RESULT_LEN);
  });

  it("整串 `[API Error: 403 …]` → provider_access_denied,且是确定性 infra", () => {
    expect(classifyProviderError({ result_text: PROVIDER_403_RESULT_TEXT })).toEqual({
      is_infra: true,
      error_class: "provider_access_denied",
    });
  });

  it("裸机器码 AccessDenied.Unpurchased 同因(端点直接回机器码的形态)", () => {
    expect(classifyProviderError({ result_text: PROVIDER_ACCESS_DENIED_BARE })).toEqual({
      is_infra: true,
      error_class: "provider_access_denied",
    });
  });

  it("前后空白不算散文:仍然命中(CLI 写行尾 \\n)", () => {
    expect(classifyProviderError({ result_text: `  ${PROVIDER_403_RESULT_TEXT}\n` }).error_class).toBe(
      "provider_access_denied",
    );
  });
});

describe("纪律①:判据不读 exit_code 的数值", () => {
  it("同一份 403 文本换任意退出码,结论逐字段相同", () => {
    const baseline = classifyProviderError({ result_text: PROVIDER_403_RESULT_TEXT, exit_code: 11 });
    for (const exit_code of ALL_EXIT_CODES) {
      expect(classifyProviderError({ result_text: PROVIDER_403_RESULT_TEXT, exit_code }), `exit ${exit_code}`).toEqual(
        baseline,
      );
    }
  });

  it("exit_code 单独在场(无可判读文本)不构成分流理由", () => {
    for (const exit_code of ALL_EXIT_CODES) {
      expect(classifyProviderError({ exit_code }), `exit ${exit_code}`).toEqual({
        is_infra: false,
        error_class: null,
      });
    }
  });

  it("11 只是本轮观察:形状不符的 11 一律 unknown", () => {
    expect(classifyProviderError({ result_text: QUALITY_RESULT_TEXT, exit_code: 11 })).toEqual({
      is_infra: false,
      error_class: null,
    });
  });
});

describe("状态码 → 成因:两侧共用同一张表", () => {
  it("资格/额度/模型不存在三类是确定性的", () => {
    for (const [status, cls] of [
      [401, "provider_access_denied"],
      [403, "provider_access_denied"],
      [404, "provider_model_unavailable"],
      [429, "provider_quota_exhausted"],
    ] as const) {
      const cls$ = errorClassFromHttpStatus(status);
      expect(cls$).toBe(cls);
      expect(classifyProviderError({ result_text: `[API Error: ${status} upstream said no]` })).toEqual({
        is_infra: true,
        error_class: cls$,
      });
    }
  });

  it("瞬态形态一律 is_infra=false:漏报可以,误报不行", () => {
    for (const status of [400, 408, 409, 500, 502, 503, 504, 599]) {
      const v = classifyProviderError({ result_text: `[API Error: ${status} bad gateway]` });
      expect(v.error_class, String(status)).toBe("upstream_error");
      expect(v.is_infra, String(status)).toBe(false);
    }
  });

  it("无状态码的包壳只说明「CLI 认为这是 API 错误」,不说明确定性", () => {
    expect(classifyProviderError({ result_text: "[API Error: fetch failed]" })).toEqual({
      is_infra: false,
      error_class: "upstream_error",
    });
  });

  it("裸 upstream_error 同样不主张 infra", () => {
    expect(classifyProviderError({ result_text: "upstream_error" })).toEqual({
      is_infra: false,
      error_class: "upstream_error",
    });
  });
});

describe("纪律②:误报面必须封死(整串匹配,包含不算)", () => {
  const notShapes = [
    // 成功总结里引用错误字样(§7.2.3 那三次俱毁的正身)
    `本轮结论:${PROVIDER_403_RESULT_TEXT} —— 但补丁本身已按要求完成`,
    `${PROVIDER_403_RESULT_TEXT} 是上一轮的报错,本轮已修`,
    // 散文里出现裸机器码
    `按 ${PROVIDER_ACCESS_DENIED_BARE} 的说法处理即可,其余不变`,
    "AccessDenied. 这句是人写的散文,不是错误本身",
    "insufficient_quota 这个字段名在 schema v2 里已废弃",
    // 多行:错误只是其中一行
    `summary line\n${PROVIDER_403_RESULT_TEXT}`,
    // 形状不完整
    "[API Error: 403 unclosed",
    "[API Error: 403 nested ] bracket]",
    "API Error: 403 no brackets at all",
    "",
    "   ",
    null,
    undefined,
  ];
  for (const text of notShapes) {
    it(`不命中:${JSON.stringify(text)?.slice(0, 60) ?? String(text)}`, () => {
      expect(classifyProviderError({ result_text: text, exit_code: 11 })).toEqual({
        is_infra: false,
        error_class: null,
      });
    });
  }

  // 状态码读不出的一律「包壳认识、成因不确定」:记为瞬态,绝不记成确定性 infra。
  it("状态码不可靠时不猜成因:仍是瞬态(is_infra=false)", () => {
    for (const text of [
      "[API Error: 4033 four digit status]",
      "[API Error: 40 three digit truncated]",
      "[API Error: not-a-number upstream]",
    ]) {
      expect(classifyProviderError({ result_text: text }), text).toEqual({
        is_infra: false,
        error_class: "upstream_error",
      });
    }
  });
});

describe("纪律③:词表只有一份 —— 与 cli-exit 的形状表锁步", () => {
  const cliErrorShapes = [
    PROVIDER_403_RESULT_TEXT,
    "[API Error: 429 too many requests]",
    "[API Error: fetch failed]",
    PROVIDER_ACCESS_DENIED_BARE,
    "AccessDenied.Unpurchased.SubCode",
    "model_not_found",
    "upstream_error",
    "insufficient_quota",
  ];

  it("cli-exit 认的整串形状,这边必须给出成因(两张表不得各活各的)", () => {
    for (const text of cliErrorShapes) {
      expect(isCliErrorShape(text), text).toBe(true);
      expect(classifyProviderError({ result_text: text }).error_class, text).not.toBeNull();
    }
  });

  it("反向:这边给出的成因只可能来自同一族形状", () => {
    for (const text of cliErrorShapes) {
      const v = classifyProviderError({ result_text: text });
      if (v.error_class !== null) expect(isCliErrorShape(text), text).toBe(true);
    }
  });

  it("成因只允许取自共享枚举,且 reviewer 的两个新成员确实在表里", () => {
    for (const cls of ["upstream_timeout", "bad_response_body"] as const) {
      expect(ERROR_CLASSES).toContain(cls);
      expect(isErrorClass(cls)).toBe(true);
    }
    expect(isErrorClass("reviewer_failure_class")).toBe(false);
    expect(isErrorClass(null)).toBe(false);
    expect(isErrorClass("PROVIDER_ACCESS_DENIED")).toBe(false);
    expect(new Set(ERROR_CLASSES).size).toBe(ERROR_CLASSES.length);
  });
});

describe("档位:ROUTING_INFRA_MODE 三档,缺省 shadow", () => {
  it("off / shadow / enforce 之外的任何值都落 shadow(写错字母不会悄悄拿到否决权)", () => {
    expect(routingInfraMode({})).toBe("shadow");
    expect(routingInfraMode({ ROUTING_INFRA_MODE: "" })).toBe("shadow");
    expect(routingInfraMode({ ROUTING_INFRA_MODE: "ENFORCE" })).toBe("shadow");
    expect(routingInfraMode({ ROUTING_INFRA_MODE: "enabled" })).toBe("shadow");
    expect(routingInfraMode({ ROUTING_INFRA_MODE: "off" })).toBe("off");
    expect(routingInfraMode({ ROUTING_INFRA_MODE: "shadow" })).toBe("shadow");
    expect(routingInfraMode({ ROUTING_INFRA_MODE: "enforce" })).toBe("enforce");
  });

  const signals = (over: Partial<AttemptFailureSignals> = {}) => ({
    role: "writer" as const,
    exit_code: 11,
    result_text: PROVIDER_403_RESULT_TEXT,
    ...over,
  });

  it("off:候选不产出,决策与既有语义逐字段一致", () => {
    expect(providerInfraCandidate(signals({ infra_mode: "off" }))).toBeNull();
    expect(classifyAttemptFailure(signals({ infra_mode: "off" }))).toEqual({
      kind: "quality",
      rule: "quality_fallback",
      action: "rework",
    } satisfies RouteDecision);
  });

  it("shadow(缺省):候选照出,决策与 off 档一字不差 —— 攒样本不改路由", () => {
    expect(providerInfraCandidate(signals({ infra_mode: "shadow" }))).toEqual({
      is_infra: true,
      error_class: "provider_access_denied",
    });
    expect(classifyAttemptFailure(signals({ infra_mode: "shadow" }))).toEqual(
      classifyAttemptFailure(signals({ infra_mode: "off" })),
    );
    // 不传档位 = 判据当不存在(调用方没接线也不会误伤)
    expect(providerInfraCandidate(signals())).toBeNull();
    expect(classifyAttemptFailure(signals())).toEqual({
      kind: "quality",
      rule: "quality_fallback",
      action: "rework",
    });
  });

  it("enforce:确定性 provider 错误改判 blocked,不再派返工", () => {
    expect(classifyAttemptFailure(signals({ infra_mode: "enforce" }))).toEqual({
      kind: "provider_infra",
      rule: "writer_provider_error_shape",
      action: "blocked",
      error_class: "provider_access_denied",
    });
  });

  it("enforce 也不吞瞬态:upstream_error 形状照旧返工", () => {
    expect(
      classifyAttemptFailure(
        signals({ infra_mode: "enforce", result_text: "[API Error: 502 bad gateway]" }),
      ),
    ).toEqual({ kind: "quality", rule: "quality_fallback", action: "rework" });
  });

  it("enforce 不越过既有两条预算判据(要先判到期还是先判端点,顺序写死)", () => {
    for (const exit of [53, 55]) {
      expect(
        classifyAttemptFailure(signals({ infra_mode: "enforce", exit_code: exit })).rule,
      ).not.toBe("writer_provider_error_shape");
    }
  });
});

describe("不扩域:verifier 与「形状不认识」一律走老路", () => {
  it("verifier 侧不产出 provider 候选(c12 已修 verifier 的分流,本棒不动)", () => {
    for (const mode of ["off", "shadow", "enforce"] as const) {
      expect(
        providerInfraCandidate({
          role: "verifier",
          exit_code: 1,
          result_text: PROVIDER_403_RESULT_TEXT,
          infra_mode: mode,
        }),
      ).toBeNull();
      expect(
        classifyAttemptFailure({
          role: "verifier",
          exit_code: 1,
          result_text: PROVIDER_403_RESULT_TEXT,
          infra_mode: mode,
        }),
      ).toEqual({ kind: "quality", rule: "quality_fallback", action: "rework" });
    }
  });

  it("空文本 / 质量文本在任何档位都不产出候选", () => {
    for (const mode of ["shadow", "enforce"] as const) {
      for (const result_text of ["", "   ", null, undefined, QUALITY_RESULT_TEXT]) {
        expect(
          providerInfraCandidate({ role: "writer", exit_code: 11, result_text, infra_mode: mode }),
          `${mode}/${String(result_text)}`,
        ).toBeNull();
      }
    }
  });

  it("provider_infra 只在确实命中形状时出现(既有 kind 取值不受影响)", () => {
    const kinds = [
      classifyAttemptFailure({ role: "writer", exit_code: 1 }).kind,
      classifyAttemptFailure({ role: "writer", exit_code: 53, infra_mode: "enforce" }).kind,
      classifyAttemptFailure({ role: "writer", exit_code: 1, infra_mode: "enforce" }).kind,
    ];
    expect(kinds).toEqual(["quality", "budget_turns", "quality"]);
  });
});
