import { describe, expect, it } from "vitest";
import { AuthorityConflict, type TaskState } from "../src/types";
import {
  TASK_TRANSITIONS,
  assertTransition,
  decideRework,
  isLegalTransition,
} from "../src/control/statemachine";
import { compositeEvidenceDigest } from "../src/audit/evidence";

const STATES: TaskState[] = [
  "PENDING",
  "RUNNING",
  "VERIFYING",
  "AWAITING_APPROVAL",
  "DONE",
  "REJECTED",
  "BLOCKED",
];

describe("TASK_TRANSITIONS", () => {
  it("覆盖全部状态且终态无出边", () => {
    for (const s of STATES) expect(TASK_TRANSITIONS[s]).toBeDefined();
    for (const t of ["DONE", "REJECTED", "BLOCKED"] as TaskState[]) {
      expect(TASK_TRANSITIONS[t]).toEqual([]);
    }
  });

  it("允许 M6 主链路转换", () => {
    expect(isLegalTransition("PENDING", "RUNNING")).toBe(true);
    expect(isLegalTransition("RUNNING", "VERIFYING")).toBe(true);
    expect(isLegalTransition("RUNNING", "AWAITING_APPROVAL")).toBe(true);
    expect(isLegalTransition("VERIFYING", "AWAITING_APPROVAL")).toBe(true);
    expect(isLegalTransition("VERIFYING", "RUNNING")).toBe(true);
    expect(isLegalTransition("AWAITING_APPROVAL", "DONE")).toBe(true);
    expect(isLegalTransition("AWAITING_APPROVAL", "REJECTED")).toBe(true);
    expect(isLegalTransition("AWAITING_APPROVAL", "RUNNING")).toBe(true);
  });

  it("拒绝非法转换", () => {
    expect(isLegalTransition("PENDING", "DONE")).toBe(false);
    expect(isLegalTransition("DONE", "RUNNING")).toBe(false);
    expect(isLegalTransition("PENDING", "AWAITING_APPROVAL")).toBe(false);
  });

  it("assertTransition 非法时抛 AuthorityConflict", () => {
    expect(() => assertTransition("PENDING", "DONE")).toThrowError(AuthorityConflict);
    expect(() => assertTransition("DONE", "RUNNING")).toThrowError(AuthorityConflict);
    expect(() => assertTransition("RUNNING", "VERIFYING")).not.toThrow();
  });
});

describe("decideRework(writer 失败门禁的预算判断)", () => {
  it("预算内 rework,达到上限判定耗尽", () => {
    expect(decideRework({ writerAttempts: 1, maxAttempts: 3 }).action).toBe("rework");
    expect(decideRework({ writerAttempts: 2, maxAttempts: 3 }).action).toBe("rework");
    expect(decideRework({ writerAttempts: 3, maxAttempts: 3 }).action).toBe("exhausted");
    expect(decideRework({ writerAttempts: 5, maxAttempts: 3 }).action).toBe("exhausted");
  });
});

describe("compositeEvidenceDigest", () => {
  it("确定性:相同输入相同结果", async () => {
    const parts = [
      { role: "writer", attempt_id: "w1", digest: "d1" },
      { role: "verifier", attempt_id: "v1", digest: "d2" },
    ];
    const a = await compositeEvidenceDigest(parts);
    const b = await compositeEvidenceDigest([...parts]);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("顺序敏感且成员变化即变化", async () => {
    const writer = { role: "writer", attempt_id: "w1", digest: "d1" };
    const verifier = { role: "verifier", attempt_id: "v1", digest: "d2" };
    const reviewer = { role: "reviewer", attempt_id: "r1", digest: "d3" };
    const base = await compositeEvidenceDigest([writer, verifier]);
    expect(await compositeEvidenceDigest([verifier, writer])).not.toBe(base);
    expect(await compositeEvidenceDigest([writer])).not.toBe(base);
    expect(await compositeEvidenceDigest([writer, verifier, reviewer])).not.toBe(base);
  });

  it("空组合也有稳定摘要", async () => {
    const a = await compositeEvidenceDigest([]);
    const b = await compositeEvidenceDigest([]);
    expect(a).toBe(b);
  });
});
