import type { BaseSource } from "../exec/base";
import type { ArtifactRef, BaseRef } from "./evidence";

/**
 * 候选交付视图。
 *
 * 这是**读模型投影,不是新的状态对象**:候选的事实源仍然是钉住的 writer
 * manifest + TaskRecord.base + 最新决策,本模块只负责把它们拼成人能直接
 * 使用的形状,并确保一件事 —— 让消费方一眼分清「独立验证过」和「只是产出过」。
 * 被判定不通过的候选绝不能看起来像可直接提交。
 */

export type CandidateStatus =
  | "unverified"
  | "verified"
  | "verification_failed"
  | "approved"
  | "rejected"
  | "held_for_human";

export interface CandidateEvidence {
  writer_attempt_id: string;
  writer_manifest_key: string;
  writer_manifest_digest: string;
  verifier_attempt_id: string | null;
  verifier_manifest_digest: string | null;
}

export interface CandidateDecision {
  decision: string;
  actor: string;
  /** 决策者身份:verifier 的 reject 与 reviewer/人工的 reject 语义完全不同 */
  by: "verifier" | "reviewer" | "human";
}

export interface CandidateInput {
  task_id: string;
  state: string;
  awaiting_human: boolean;
  /** 任务当前冻结的基线(返工轮会继承它,也可能因 base.moved 已经换了) */
  base: BaseRef | null;
  /** 钉住的 writer manifest 里记的基线 —— 补丁实际能重放的那个 commit;v1 manifest 没有 */
  candidate_base: BaseRef | null;
  evidence: CandidateEvidence | null;
  patch: ArtifactRef | null;
  decision: CandidateDecision | null;
  binding_digest: string | null;
}

export interface CandidateView {
  task_id: string;
  status: CandidateStatus;
  /** 钉住的证据里是否有通过结论的独立验证 */
  verified: boolean;
  /** 基线已知 + 有补丁 + 判定非否决:三者齐备才可以直接 git apply / 提交 */
  safe_to_apply: boolean;
  /** 应用该补丁时应处的 commit;null = 基线未固定,重放不保证成功 */
  base: { sha: string | null; source: BaseSource } | null;
  patch: ArtifactRef | null;
  writer_attempt_id: string | null;
  verifier_attempt_id: string | null;
  state: string;
  awaiting_human: boolean;
  decision: CandidateDecision | null;
  binding_digest: string | null;
  /** 诚实性声明:未验证、基线未固定、已被否决等,消费方必须展示 */
  warnings: string[];
}

export function assembleCandidate(input: CandidateInput): CandidateView {
  const ev = input.evidence;
  const decidedReject =
    input.decision?.decision === "reject" || input.state === "REJECTED";
  const verificationFailed = decidedReject && input.decision?.by === "verifier";
  const approved =
    input.state === "DONE" &&
    (input.decision?.decision === "approve" || input.decision?.decision === "accept_with_notes");

  const status: CandidateStatus = verificationFailed
    ? "verification_failed"
    : decidedReject
      ? "rejected"
      : input.awaiting_human
        ? "held_for_human"
        : approved
          ? "approved"
          : ev?.verifier_manifest_digest
            ? "verified"
            : "unverified";

  // 没有 binding_digest 就没有可核对的证据绑定口径,此时声称"验证过"无从取证
  const verified =
    Boolean(ev?.verifier_manifest_digest) && Boolean(input.binding_digest) && status !== "verification_failed";

  // 交付时必须说清「这份补丁是对哪个 commit 的」:任务基线可能已被后续轮次换掉,
  // 而钉住的候选永远只对它自己材质化时的那个 commit 成立。
  const delivered = input.candidate_base ?? null;

  const warnings: string[] = [];
  if (!ev) {
    warnings.push("尚无钉住的候选证据:writer 未回报,或回报未落证据。");
  }
  if (!input.patch) {
    warnings.push("该候选没有可下载的补丁文件(非 repo 任务,或 writer 未导出变更)。");
  }
  if (!delivered || delivered.source === "unknown_legacy") {
    warnings.push(
      "基线未固定:补丁只与抓取时刻的默认分支绑定,不保证能在其它 commit 上重放。",
    );
  } else if (input.base && input.base.sha !== delivered.sha) {
    warnings.push(
      `此候选基于 commit ${delivered.sha},而任务当前基线已是 ${input.base.sha}` +
        `(基线在候选产生后发生过变更)。请在 ${delivered.sha} 上重放这份补丁。`,
    );
  }
  if (status === "verification_failed") {
    warnings.push("独立验证未通过(干净沙箱重放或验收命令失败),该候选不应提交。");
  }
  if (status === "rejected") {
    warnings.push("该候选已被否决(reviewer 或人工判定不通过),不应提交。");
  }
  if (status === "held_for_human") {
    warnings.push("任务已转人工,自动判定未收敛;候选内容未经终态确认。");
  }
  if (status === "unverified") {
    warnings.push("尚未经过独立验证:这只是产出过的候选,不是在干净沙箱重放并通过验收的候选。");
  }
  if (input.decision?.decision === "accept_with_notes") {
    warnings.push("以附注放行:否决意见留档但未触发返工,请连同 /evidence 里的 reason 一起看。");
  }

  return {
    task_id: input.task_id,
    status,
    verified,
    safe_to_apply:
      (status === "verified" || status === "approved") && Boolean(input.patch) && Boolean(delivered),
    base: delivered ? { sha: delivered.sha, source: delivered.source } : null,
    patch: input.patch,
    writer_attempt_id: ev?.writer_attempt_id ?? null,
    verifier_attempt_id: ev?.verifier_attempt_id ?? null,
    state: input.state,
    awaiting_human: input.awaiting_human,
    decision: input.decision,
    binding_digest: input.binding_digest,
    warnings,
  };
}

/** 下载文件名:带上候选 digest 前缀,便于本地核对拿到的确实是那一份。 */
export function candidateFileName(taskId: string, patchDigest: string): string {
  return `task-${taskId}-${patchDigest.slice(0, 12)}.patch`;
}
