import { describe, expect, it } from "vitest";
import {
  assessReviewRejection,
  describeVerifyFailure,
  isNoProgress,
  MATERIAL_LIMITS,
  normalizeForMatch,
  reviewTaskSection,
  type ReviewMaterial,
  type ReviewVerdict,
} from "../src/control/gates";
import { parseReviewVerdict } from "../src/exec/extract";
import {
  W4A_ACCEPTANCE,
  W4A_TASK_PROMPT,
  W4A_VERDICT,
  W4A_WRITER_RESULT,
} from "./fixtures/w4a-review-c21";

/**
 * 门禁分级判定单测:reviewer 的 reject 什么时候值得为它重开一个沙箱。
 * 病理来源是「一句空洞的『感觉不对』= 一轮全仪式返工」,因此这里逐条钉住
 * 降级原因,而不是只测 happy path。
 */

const ACCEPTANCE = ["脚本输出 hello world", "文件名为 hello.py"];

const MATERIAL: ReviewMaterial = {
  task_prompt: "写一个脚本,让它输出 hello world",
  writer_result: "已创建 hello.py,内容为 print('hello world')",
  verify_output: '{"apply":{"exit_code":0},"verify":{"exit_code":0}}',
  patch_excerpt: "--- /dev/null\n+++ b/hello.py\n+print('hello world')",
};

function reject(over: Partial<ReviewVerdict> = {}): ReviewVerdict {
  return {
    decision: "reject",
    reason: "输出不符合要求",
    failed_criteria: [0],
    fix_instructions: ["把 print 的内容改成 hello world 后再提交"],
    evidence: [{ source: "writer_result", quote: "已创建 hello.py,内容为" }],
    ...over,
  };
}

function assess(
  over: Partial<ReviewVerdict> = {},
  args: { acceptance?: string[]; material?: ReviewMaterial | null } = {},
) {
  return assessReviewRejection({
    acceptance: "acceptance" in args ? args.acceptance : ACCEPTANCE,
    material: "material" in args ? (args.material ?? null) : MATERIAL,
    verdict: reject(over),
  });
}

describe("assessReviewRejection:reject 必须举证", () => {
  it("要素齐全的 reject 成立", () => {
    expect(assess()).toEqual({ honored: true });
  });

  it("任务没声明验收标准时,任何 reject 都只是附注", () => {
    expect(assess({}, { acceptance: undefined })).toEqual({ honored: false, reason: "no_acceptance_criteria" });
    expect(assess({}, { acceptance: [] })).toEqual({ honored: false, reason: "no_acceptance_criteria" });
  });

  it("不指出具体失败标准 → 降级", () => {
    expect(assess({ failed_criteria: [] })).toEqual({ honored: false, reason: "no_failed_criteria" });
    expect(assess({ failed_criteria: undefined })).toEqual({ honored: false, reason: "no_failed_criteria" });
  });

  it("标准编号越界 → 降级(编号只能来自喂入的验收标准)", () => {
    expect(assess({ failed_criteria: [7] })).toEqual({ honored: false, reason: "criteria_index_out_of_range" });
    expect(assess({ failed_criteria: [0, -1] })).toEqual({ honored: false, reason: "criteria_index_out_of_range" });
  });

  it("没有修复指令 → 降级", () => {
    expect(assess({ fix_instructions: undefined })).toEqual({
      honored: false,
      reason: "missing_fix_instruction",
    });
  });

  it("指令空洞到不可执行 → 降级", () => {
    expect(assess({ fix_instructions: ["再检查一下"] })).toEqual({
      honored: false,
      reason: "instruction_too_short",
    });
  });

  it("不引用证据 → 降级", () => {
    expect(assess({ evidence: undefined })).toEqual({ honored: false, reason: "no_evidence_quote" });
  });

  it("引用能在材料中找到(换行/缩进/大小写差异不算伪造)", () => {
    expect(
      assess({
        evidence: [{ source: "writer_result", quote: "已创建 hello.py,\n   内容为   print('hello world')" }],
      }),
    ).toEqual({ honored: true });
    expect(
      assess({ evidence: [{ source: "task_prompt", quote: "写一个脚本,让它输出 HELLO WORLD" }] }),
    ).toEqual({ honored: true });
  });

  it("引用编造出来 → 降级", () => {
    expect(
      assess({ evidence: [{ source: "writer_result", quote: "文件里什么都没写,是空文件哦" }] }),
    ).toEqual({ honored: false, reason: "quote_not_found" });
  });

  it("引用短到能命中任意文本 → 不构成证据", () => {
    expect(assess({ evidence: [{ source: "writer_result", quote: "hello" }] })).toEqual({
      honored: false,
      reason: "quote_not_found",
    });
  });

  it("引用被材料截断切断 → 降级(材料以喂入版本为准)", () => {
    const truncated: ReviewMaterial = { ...MATERIAL, writer_result: MATERIAL.writer_result.slice(0, 12) };
    expect(assess({}, { material: truncated })).toEqual({ honored: false, reason: "quote_not_found" });
  });

  it("引用了未喂入的材料(如非 repo 任务的 patch)→ 判定不确定", () => {
    expect(assess({ evidence: [{ source: "patch", quote: "print('hello world')" }] }, {
      material: { ...MATERIAL, patch_excerpt: null },
    })).toEqual({ honored: false, reason: "material_missing" });
  });

  it("材料没留存 → 判定不确定,不能算 reviewer 的错", () => {
    expect(assess({}, { material: null })).toEqual({ honored: false, reason: "material_missing" });
  });
});

describe("normalizeForMatch / MATERIAL_LIMITS", () => {
  it("去掉空白并忽略大小写", () => {
    expect(normalizeForMatch("  A\n\t B  ")).toBe("ab");
  });

  it("四类材料都有上限(喂入与核对必须同源)", () => {
    expect(Object.keys(MATERIAL_LIMITS).sort()).toEqual([
      "patch",
      "task_prompt",
      "verify_output",
      "writer_result",
    ]);
    for (const limit of Object.values(MATERIAL_LIMITS)) expect(limit).toBeGreaterThan(0);
  });
});

describe("isNoProgress:无进展熔断", () => {
  it("任一侧缺失不判(否则 writer 失败会被误熔断)", () => {
    expect(isNoProgress(null, "abc")).toBe(false);
    expect(isNoProgress("abc", null)).toBe(false);
    expect(isNoProgress(undefined, undefined)).toBe(false);
    expect(isNoProgress("", "")).toBe(false);
  });

  it("两轮候选摘要相同才停", () => {
    expect(isNoProgress("abc", "abc")).toBe(true);
    expect(isNoProgress("abc", "abd")).toBe(false);
  });
});

describe("describeVerifyFailure:把验证报告译成修复指令", () => {
  it("补丁无法重放 → 指令里带上 git 输出", () => {
    const report = JSON.stringify({
      apply: { exit_code: 1, stderr_tail: "error: patch failed: hello.py:1" },
      verify: null,
    });
    const lines = describeVerifyFailure(report);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("git apply");
    expect(lines[0]).toContain("error: patch failed: hello.py:1");
  });

  it("基线已冻结 → 指令点名该 commit,且不再让 writer 追最新分支", () => {
    const report = JSON.stringify({
      base: { sha: "f".repeat(40) },
      apply: { exit_code: 1, stderr_tail: "error: patch does not apply" },
      verify: null,
    });
    const lines = describeVerifyFailure(report, "a".repeat(40));
    expect(lines[0]).toContain("f".repeat(40));
    expect(lines[0]).not.toContain("最新默认分支");
  });

  it("无基线(legacy 任务)→ 仍给可用指令,不编造 sha", () => {
    const report = JSON.stringify({
      apply: { exit_code: 1, stderr_tail: "error: patch does not apply" },
      verify: null,
    });
    const lines = describeVerifyFailure(report, null);
    expect(lines[0]).toContain("重新生成可重放的补丁");
    expect(lines[0]).not.toMatch(/[0-9a-f]{40}/);
  });

  it("验证命令失败 → 指令里带上 stdout 尾部", () => {
    const report = JSON.stringify({
      apply: { exit_code: 0, stderr_tail: "" },
      verify: { exit_code: 127, stdout_tail: "bash: pytest: command not found", stderr_tail: "" },
    });
    const lines = describeVerifyFailure(report);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("exit_code=127");
    expect(lines[0]).toContain("pytest: command not found");
  });

  it("报告缺失或不可解析也要给出可用指令(不能返回空)", () => {
    for (const raw of [null, undefined, "", "not json"]) {
      const lines = describeVerifyFailure(raw);
      expect(lines.length).toBeGreaterThan(0);
      expect(lines[0].length).toBeGreaterThan(10);
    }
  });
});

describe("parseReviewVerdict:解析失败不是 reject", () => {
  it("整行 JSON 的结构化裁决原样解析", () => {
    const text = JSON.stringify({
      decision: "reject",
      reason: "没有实现",
      failed_criteria: [1],
      fix_instructions: ["补上 CLI 入口并保证 python -m 可运行"],
      evidence: [{ source: "writer_result", quote: "已创建 hello.py" }],
    });
    expect(parseReviewVerdict(text)).toMatchObject({
      decision: "reject",
      failed_criteria: [1],
      evidence: [{ source: "writer_result" }],
    });
  });

  it("夹带解释文字时仍能取出 JSON 片段", () => {
    expect(parseReviewVerdict('结论如下: {"decision":"approve","reason":"切题"} 以上。').decision).toBe(
      "approve",
    );
  });

  it("完全无法解析 → none,而不是 reject", () => {
    const v = parseReviewVerdict("我觉得这个产出大概还行吧,不太确定。");
    expect(v.decision).toBe("none");
    expect(v.reason).toContain("unparseable_verdict");
  });

  it("decision 值不合法 → none", () => {
    expect(parseReviewVerdict('{"decision":"maybe","reason":"再说"}').decision).toBe("none");
  });
});

/**
 * c21:验收标准块与喂入 prompt 同源。§N.38 取证(w4a,transcript 6187213d):
 * reviewer 诚实引用自己被展示的验收标准原文会被判 quote_not_found,因为标准块
 * 进了 LLM prompt 却不在 material 核对面里,违反 gates.ts 自己声明的
 * 「材料与实际喂入一致」不变量。修的是材料组成,不是命中规则 —— 防伪造负向一根不松。
 */
describe("c21:reviewTaskSection 一次组装两处消费", () => {
  const merged = reviewTaskSection(W4A_TASK_PROMPT, W4A_ACCEPTANCE);

  it("格式钉:原始任务 + 空行 + 标准头 + 编号从 0 的标准列表,与 prompt 模板逐字同形", () => {
    expect(reviewTaskSection("任务正文", ["甲标准", "乙标准"])).toBe(
      "任务正文\n\n【验收标准(编号从 0 开始)】\n0. 甲标准\n1. 乙标准",
    );
    expect(reviewTaskSection("任务正文", [])).toBe(
      "任务正文\n\n【验收标准(编号从 0 开始)】\n(任务未声明验收标准)",
    );
  });

  it("fixture 自洽:三条 evidence 引用逐条命中其声明的源面(排除 fixture 错位假红)", () => {
    const surfaces: Record<string, string> = {
      task_prompt: merged,
      writer_result: W4A_WRITER_RESULT,
    };
    for (const item of W4A_VERDICT.evidence ?? []) {
      expect(normalizeForMatch(surfaces[item.source])).toContain(normalizeForMatch(item.quote));
    }
  });

  it("w4a 真实判词:并入标准块后 assessReviewRejection 判 honored:true", () => {
    const material: ReviewMaterial = {
      task_prompt: merged.slice(0, MATERIAL_LIMITS.task_prompt),
      writer_result: W4A_WRITER_RESULT.slice(0, MATERIAL_LIMITS.writer_result),
      verify_output: null,
      patch_excerpt: null,
    };
    expect(
      assessReviewRejection({ acceptance: W4A_ACCEPTANCE, verdict: W4A_VERDICT, material }),
    ).toEqual({ honored: true });
  });

  it("旧组成(不含标准块)下确实 quote_not_found —— 钉住病因本身,修复点在材料组成", () => {
    const legacy: ReviewMaterial = {
      task_prompt: W4A_TASK_PROMPT.slice(0, MATERIAL_LIMITS.task_prompt),
      writer_result: W4A_WRITER_RESULT.slice(0, MATERIAL_LIMITS.writer_result),
      verify_output: null,
      patch_excerpt: null,
    };
    expect(
      assessReviewRejection({ acceptance: W4A_ACCEPTANCE, verdict: W4A_VERDICT, material: legacy }),
    ).toEqual({ honored: false, reason: "quote_not_found" });
  });

  it("防伪造负向不弱化:跨源引用 / 改写 / 编造 仍然 quote_not_found", () => {
    const material: ReviewMaterial = {
      task_prompt: merged.slice(0, MATERIAL_LIMITS.task_prompt),
      writer_result: W4A_WRITER_RESULT.slice(0, MATERIAL_LIMITS.writer_result),
      verify_output: null,
      patch_excerpt: null,
    };
    // ① 跨源:标准原文在 task_prompt 面里存在,标成 writer_result 源必须不命中
    const crossSource: ReviewVerdict = {
      ...W4A_VERDICT,
      evidence: [
        {
          source: "writer_result",
          quote: "无新事件 >90s 黄、>300s 红(Date.now() 差值,阈值常量自权威导入)",
        },
      ],
    };
    expect(
      assessReviewRejection({ acceptance: W4A_ACCEPTANCE, verdict: crossSource, material }),
    ).toEqual({ honored: false, reason: "quote_not_found" });
    // ② 改写:>300s 抄成 >301s,去掉空白后仍不逐字
    const paraphrased: ReviewVerdict = {
      ...W4A_VERDICT,
      evidence: [
        {
          source: "task_prompt",
          quote: "无新事件 >90s 黄、>301s 红(Date.now() 差值,阈值常量自权威导入)",
        },
      ],
    };
    expect(
      assessReviewRejection({ acceptance: W4A_ACCEPTANCE, verdict: paraphrased, material }),
    ).toEqual({ honored: false, reason: "quote_not_found" });
    // ③ 编造:材料里根本没有的句子
    const fabricated: ReviewVerdict = {
      ...W4A_VERDICT,
      evidence: [{ source: "task_prompt", quote: "writer 隐瞒了三处阻断性缺陷未修复" }],
    };
    expect(
      assessReviewRejection({ acceptance: W4A_ACCEPTANCE, verdict: fabricated, material }),
    ).toEqual({ honored: false, reason: "quote_not_found" });
  });

  it("截断不变量:并入后整体按 MATERIAL_LIMITS.task_prompt 截断,截断点落在标准块内", () => {
    expect(MATERIAL_LIMITS.task_prompt).toBe(6000);
    const longPrompt = "长".repeat(5900) + "尾部标记";
    const truncated = reviewTaskSection(longPrompt, W4A_ACCEPTANCE).slice(
      0,
      MATERIAL_LIMITS.task_prompt,
    );
    expect(truncated.length).toBeLessThanOrEqual(6000);
    expect(truncated.startsWith("长".repeat(100))).toBe(true);
    expect(truncated).toContain("【验收标准(编号从 0 开始)】");
  });
});
