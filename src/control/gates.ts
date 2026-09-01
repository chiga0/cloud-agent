/**
 * 门禁分级的判定规则(reviewer 的 reject 是否值得为它重开一个沙箱)。
 *
 * 设计前提:机械硬门禁(writer exit_code≠0、独立验证失败、超时/预算、证据缺失)
 * 有天然否决权,不经本模块;只有 reviewer 的主观裁决要交证据。病理是返工一轮
 * = 新沙箱 + 重新 clone + 重灌上下文,一次空洞的「感觉不对」代价极高。
 *
 * 纯函数,无 env / 无 DO 依赖,便于穷举单测。
 */

export type ReviewSource = "task_prompt" | "writer_result" | "verify_output" | "patch";

export interface ReviewVerdict {
  decision: "approve" | "reject" | "none";
  reason: string;
  /** 指向 spec.acceptance 的下标(0 基) */
  failed_criteria?: number[];
  /** 可直接执行的修复指令,祈使句 */
  fix_instructions?: string[];
  /** 必须是 reviewer 被告知的材料里能逐字找到的片段 */
  evidence?: Array<{ source: ReviewSource; quote: string }>;
}

/** 实际喂给 reviewer 的材料(截断后的原文),用于核对它引用的证据是否真的出现过。 */
export interface ReviewMaterial {
  task_prompt: string;
  writer_result: string;
  verify_output: string | null;
  patch_excerpt: string | null;
}

export type DowngradeReason =
  | "no_acceptance_criteria"
  | "no_failed_criteria"
  | "criteria_index_out_of_range"
  | "missing_fix_instruction"
  | "instruction_too_short"
  | "no_evidence_quote"
  | "quote_not_found"
  | "material_missing";

export type RejectAssessment = { honored: true } | { honored: false; reason: DowngradeReason };

/** 短于此的「指令」不具备可执行性(如「再检查一下」) */
export const MIN_INSTRUCTION_CHARS = 10;
/** 短于此的引用可以命中任意文本,不构成证据 */
export const MIN_QUOTE_CHARS = 12;

/**
 * 喂给 reviewer 的材料上限。**必须与实际喂入的截断一致** ——
 * 证据核对拿这些长度后的文本做逐字匹配,截断前/后不一致会让合理 reject 永远举证失败。
 */
export const MATERIAL_LIMITS = {
  task_prompt: 6000,
  writer_result: 2000,
  verify_output: 1000,
  patch: 4000,
} as const;

/**
 * 去掉所有空白 + 忽略大小写。折叠成单空格不够:模型换行重排中文原文时断点处
 * 本就没有空格,会把真实引用判成伪造 —— 那是把返工病理反着制造一遍。
 *  anti-fabrication 不依赖空格:去掉空白后字符序列仍必须逐字命中。
 */
export function normalizeForMatch(s: string): string {
  return s.replace(/\s+/g, "").toLowerCase();
}

function materialOf(material: ReviewMaterial, source: ReviewSource): string | null {
  switch (source) {
    case "task_prompt":
      return material.task_prompt;
    case "writer_result":
      return material.writer_result;
    case "verify_output":
      return material.verify_output;
    case "patch":
      return material.patch_excerpt;
  }
}

/**
 * reviewer 的 reject 要成立,必须同时:指出哪条验收标准失败(且 spec 真的声明了
 * 标准)、给出可执行修复指令、并引用它被告知的材料里逐字存在的证据。
 * 任一不满足即不成立 —— 语义上降级为 accept-with-notes(不返工)。
 */
export function assessReviewRejection(args: {
  acceptance?: string[];
  verdict: ReviewVerdict;
  material: ReviewMaterial | null;
}): RejectAssessment {
  if (!args.material) return { honored: false, reason: "material_missing" };

  const acceptance = args.acceptance ?? [];
  if (acceptance.length === 0) return { honored: false, reason: "no_acceptance_criteria" };

  const criteria = args.verdict.failed_criteria ?? [];
  if (criteria.length === 0) return { honored: false, reason: "no_failed_criteria" };
  for (const index of criteria) {
    if (!Number.isInteger(index) || index < 0 || index >= acceptance.length) {
      return { honored: false, reason: "criteria_index_out_of_range" };
    }
  }

  const instructions = args.verdict.fix_instructions ?? [];
  if (instructions.length === 0) return { honored: false, reason: "missing_fix_instruction" };
  if (instructions.some((i) => normalizeForMatch(i).length < MIN_INSTRUCTION_CHARS)) {
    return { honored: false, reason: "instruction_too_short" };
  }

  const evidence = args.verdict.evidence ?? [];
  if (evidence.length === 0) return { honored: false, reason: "no_evidence_quote" };
  for (const item of evidence) {
    const sourceMaterial = materialOf(args.material, item.source);
    if (sourceMaterial == null || sourceMaterial.length === 0) {
      return { honored: false, reason: "material_missing" };
    }
    if (item.quote.trim().length < MIN_QUOTE_CHARS) {
      return { honored: false, reason: "quote_not_found" };
    }
    if (!normalizeForMatch(sourceMaterial).includes(normalizeForMatch(item.quote))) {
      return { honored: false, reason: "quote_not_found" };
    }
  }

  return { honored: true };
}

/**
 * 无进展熔断:两轮候选摘要相同才停。任一侧为空(如 writer 失败时根本产不出
 * patch)不做判断,否则会误触发。
 */
export function isNoProgress(prev: string | null | undefined, next: string | null | undefined): boolean {
  return Boolean(prev) && Boolean(next) && prev === next;
}

interface VerifyReportShape {
  base?: { sha?: string | null };
  apply?: { exit_code?: number; stderr_tail?: string };
  verify?: { exit_code?: number; stdout_tail?: string; stderr_tail?: string } | null;
}

/**
 * 把独立验证报告译成下一轮 writer 能直接照做的指令。
 * 返工一轮 = 新沙箱 + 重新 clone + 重灌上下文,只带一句 "verify exit_code=1"
 * 等于让 agent 从零猜哪里坏了。报告解析不出来时退化为兜底文案,不返回空数组。
 *
 * `currentBase` 是控制面冻结的基线:基线已固定的前提下 apply 失败不再可能是
 * 「上游移动了」,它就是指候选本身有问题 —— 文案必须把这一点说清,否则 writer
 * 会去追一条根本不存在的「最新分支」。
 */
export function describeVerifyFailure(
  reportText: string | null | undefined,
  currentBase?: string | null,
): string[] {
  const fallback = [
    "独立验证未通过(无法解析验证报告)。请在干净环境重放你的变更后自行运行仓库的验证命令再提交。",
  ];
  if (!reportText) return fallback;
  let report: VerifyReportShape;
  try {
    report = JSON.parse(reportText) as VerifyReportShape;
  } catch {
    return fallback;
  }

  const base = report.base?.sha ?? currentBase ?? null;
  const lines: string[] = [];
  const applyCode = report.apply?.exit_code ?? 0;
  if (applyCode !== 0) {
    lines.push(
      `候选变更无法在冻结基线上 git apply(exit_code=${applyCode})。` +
        (base
          ? `基线已固定为 commit ${base},验证器重放的正是它 —— 补丁与这份基线冲突或格式损坏才是失败原因,` +
            `请基于该基线重做变更,不要同步或切换到其它分支。`
          : `补丁与基线冲突或格式损坏,请重新生成可重放的补丁。`) +
        `git 输出:\n${tail(report.apply?.stderr_tail)}`,
    );
    return lines;
  }
  const verify = report.verify;
  if (verify && verify.exit_code !== 0) {
    lines.push(
      `验证命令在干净沙箱重放候选变更后失败(exit_code=${verify.exit_code}),而你的执行环境里可能因为残留状态没暴露这个问题。` +
        `请修复后确保该命令在全新 clone + 应用你的变更后会通过。stdout:\n${tail(verify.stdout_tail)}\nstderr:\n${tail(verify.stderr_tail)}`,
    );
    return lines;
  }
  if (!verify) {
    lines.push("补丁应用成功但未运行验证命令,验证器判定失败。请确认任务的验收命令可执行并给出可通过的变更。");
    return lines;
  }
  return fallback;
}

function tail(text: string | undefined, max = 1200): string {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return "(无输出)";
  return trimmed.length > max ? trimmed.slice(-max) : trimmed;
}
