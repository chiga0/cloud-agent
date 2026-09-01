import { describe, expect, it } from "vitest";
import {
  assembleCandidate,
  candidateFileName,
  type CandidateInput,
} from "../src/audit/candidate";

/**
 * 候选交付视图单测。核心不是字段拼得对不对,而是**诚实性**:
 * 「独立验证过的候选」与「只是产出过的候选」绝不能长得一样,被否决的候选
 * 更不能看起来可以直接提交 —— 这个接口是人把补丁带回本地用的最后一公里。
 */

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

const patch = { key: "artifacts/sha256/aa/bb/" + SHA_A, digest: SHA_B, size: 412 };
const writerEvidence = {
  writer_attempt_id: "att-writer",
  writer_manifest_key: "manifests/task/t1/att-writer-x.json",
  writer_manifest_digest: SHA_A,
  verifier_attempt_id: "att-verifier",
  verifier_manifest_digest: SHA_B,
};

function view(over: Partial<CandidateInput> = {}) {
  return assembleCandidate({
    task_id: "t1",
    state: "AWAITING_APPROVAL",
    awaiting_human: false,
    base: { sha: SHA_A, source: "resolved_default" },
    candidate_base: { sha: SHA_A, source: "resolved_default" },
    evidence: writerEvidence,
    patch,
    decision: null,
    binding_digest: SHA_B,
    ...over,
  });
}

describe("assembleCandidate:状态标签", () => {
  it("有 verifier 证据但未裁决 → verified,且允许应用", () => {
    const v = view();
    expect(v.status).toBe("verified");
    expect(v.verified).toBe(true);
    expect(v.safe_to_apply).toBe(true);
    expect(v.warnings.join("")).not.toContain("不应提交");
  });

  it("没有 verifier 证据 → unverified,必须明说没验证过", () => {
    const v = view({
      evidence: { ...writerEvidence, verifier_attempt_id: null, verifier_manifest_digest: null },
    });
    expect(v.status).toBe("unverified");
    expect(v.verified).toBe(false);
    expect(v.safe_to_apply).toBe(false);
    expect(v.warnings.some((w) => w.includes("尚未经过独立验证"))).toBe(true);
  });

  it("verifier 判 reject → verification_failed,与人工否决区分开", () => {
    const v = view({
      state: "REJECTED",
      decision: { decision: "reject", actor: "agent:att-verifier", by: "verifier" },
    });
    expect(v.status).toBe("verification_failed");
    expect(v.verified).toBe(false);
    expect(v.safe_to_apply).toBe(false);
    expect(v.warnings.some((w) => w.includes("独立验证未通过"))).toBe(true);
  });

  it("reviewer 判 reject → rejected,同样不得应用", () => {
    const v = view({
      state: "REJECTED",
      decision: { decision: "reject", actor: "agent:att-reviewer", by: "reviewer" },
    });
    expect(v.status).toBe("rejected");
    expect(v.safe_to_apply).toBe(false);
    expect(v.warnings.some((w) => w.includes("已被否决"))).toBe(true);
  });

  it("awaiting_human 优先于 DONE 之前的任何放行标签", () => {
    const v = view({ state: "BLOCKED", awaiting_human: true });
    expect(v.status).toBe("held_for_human");
    expect(v.safe_to_apply).toBe(false);
  });

  it("人工 approve 收尾 → approved", () => {
    const v = view({
      state: "DONE",
      decision: { decision: "approve", actor: "human:api", by: "human" },
    });
    expect(v.status).toBe("approved");
    expect(v.safe_to_apply).toBe(true);
  });

  it("accept_with_notes 留档提示:放行但否决意见未触发返工", () => {
    const v = view({
      state: "DONE",
      decision: { decision: "accept_with_notes", actor: "agent:att-reviewer", by: "reviewer" },
    });
    expect(v.status).toBe("approved");
    expect(v.warnings.some((w) => w.includes("以附注放行"))).toBe(true);
  });

  it("缺 binding_digest 时不得声称 verified(没有可核对的证据口径)", () => {
    const v = view({ binding_digest: null });
    expect(v.verified).toBe(false);
  });
});

describe("assembleCandidate:基线口径", () => {
  it("v1 manifest 无基线 → 明说不保证可重放,且不给 safe_to_apply", () => {
    const v = view({ candidate_base: null });
    expect(v.base).toBeNull();
    expect(v.safe_to_apply).toBe(false);
    expect(v.warnings.some((w) => w.includes("基线未固定"))).toBe(true);
  });

  it("unknown_legacy 与无基线同口径处理", () => {
    const v = view({
      base: null,
      candidate_base: { sha: SHA_A, source: "unknown_legacy" },
    });
    expect(v.warnings.some((w) => w.includes("基线未固定"))).toBe(true);
  });

  it("任务基线已移动 → 交付视图报告候选自己的基线并点名差异", () => {
    const v = view({
      base: { sha: SHA_B, source: "resolved_default" },
      candidate_base: { sha: SHA_A, source: "pinned" },
    });
    expect(v.base?.sha).toBe(SHA_A);
    const warn = v.warnings.find((w) => w.includes("任务当前基线已是"));
    expect(warn).toBeDefined();
    expect(warn).toContain(SHA_A);
    expect(warn).toContain(SHA_B);
  });

  it("非 repo 任务没有补丁 → 如实报告没有可下载文件", () => {
    const v = view({ patch: null, state: "DONE", decision: { decision: "approve", actor: "human:api", by: "human" } });
    expect(v.patch).toBeNull();
    expect(v.safe_to_apply).toBe(false);
    expect(v.warnings.some((w) => w.includes("没有可下载的补丁文件"))).toBe(true);
  });

  it("writer 尚未回报 → 不给假候选,也不崩", () => {
    const v = view({ evidence: null, candidate_base: null, patch: null, binding_digest: null });
    expect(v.status).toBe("unverified");
    expect(v.writer_attempt_id).toBeNull();
    expect(v.warnings.some((w) => w.includes("尚无钉住的候选证据"))).toBe(true);
  });
});

describe("candidateFileName", () => {
  it("文件名带 task 与 patch digest 前缀,便于本地核对拿到的是哪一份", () => {
    expect(candidateFileName("t1", SHA_B)).toBe(`task-t1-${SHA_B.slice(0, 12)}.patch`);
  });
});
