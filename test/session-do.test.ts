import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import type { TaskSession } from "../src/control/session";
import type { ReviewVerdict } from "../src/control/gates";
import { compositeEvidenceDigest } from "../src/audit/evidence";
import { applyMigrations } from "./d1";

/**
 * TaskSession DO 并发测试。
 *
 * 背景:DO 的 input gate 不保护 RPC,多个并发 RPC 在同一 isolate 内
 * 于 await 边界交错。loadAll → 变更 → saveAll 若无
 * blockConcurrencyWhile 保护,并发 createTask 会各自读到空状态并各写
 * 一条 task.created(事件链双份 = 修复前该测试应为红)。
 */

const ns = () => env.TASK_SESSION as DurableObjectNamespace<TaskSession>;

function chainIntact(events: Array<{ prev_digest: string | null; digest: string }>): void {
  for (let i = 1; i < events.length; i++) {
    expect(events[i].prev_digest).toBe(events[i - 1].digest);
  }
}

describe("TaskSession DO 并发", () => {
  it("并发 createTask 恰好产生 1 条 task.created", async () => {
    const taskId = crypto.randomUUID();
    const stub = ns().get(ns().newUniqueId());
    const spec = { prompt: "concurrency: createTask" };

    const results = await Promise.all(
      Array.from({ length: 8 }, () => stub.createTask(spec, taskId)),
    );

    expect(new Set(results.map((r) => r.spec_digest)).size).toBe(1);
    const snap = await stub.getSnapshot();
    expect(snap).not.toBeNull();
    expect(snap!.task.id).toBe(taskId);
    expect(snap!.events.filter((e) => e.kind === "task.created")).toHaveLength(1);
    chainIntact(snap!.events);
  });

  it("createTask 与并发 getSnapshot 无撕裂读", async () => {
    const taskId = crypto.randomUUID();
    const stub = ns().get(ns().newUniqueId());

    const writes = Promise.all(
      Array.from({ length: 4 }, () => stub.createTask({ prompt: "tear test" }, taskId)),
    );
    const reads = Promise.all(
      Array.from({ length: 20 }, () => stub.getSnapshot()),
    );
    await writes;
    const snaps = await reads;

    for (const snap of snaps) {
      if (!snap) continue;
      expect(snap.task.state).toBe("PENDING");
      expect(snap.events.filter((e) => e.kind === "task.created")).toHaveLength(1);
      chainIntact(snap.events);
    }
    const final = await stub.getSnapshot();
    expect(final!.events.filter((e) => e.kind === "task.created")).toHaveLength(1);
  });

  it("并发 startAttempt(同幂等键)恰好创建 1 个 attempt", async (ctx) => {
    const taskId = crypto.randomUUID();
    const stub = ns().get(ns().newUniqueId());
    await stub.createTask({ prompt: "concurrency: startAttempt" }, taskId);

    const key = `${taskId}:attempt:1`;
    let results: Array<{ attempt_id: string; workflow_instance_id: string | null }>;
    try {
      results = await Promise.all(
        Array.from({ length: 5 }, () =>
          stub.startAttempt({
            role: "writer",
            idempotency_key: key,
            max_model_tokens: 1000,
            max_wall_seconds: 60,
          }),
        ),
      );
    } catch (err) {
      // miniflare 不支持 workflows 绑定时跳过(计划预案)
      if (String(err).match(/workflow|not supported|unknown binding|unrecognized/i)) {
        return ctx.skip();
      }
      throw err;
    }

    expect(new Set(results.map((r) => r.attempt_id)).size).toBe(1);
    const snap = await stub.getSnapshot();
    expect(snap!.attempts).toHaveLength(1);
    expect(snap!.task.state).toBe("RUNNING");
    chainIntact(snap!.events);
  });
});

/**
 * M7 门禁路径:一轮返工 = 新沙箱 + 重新 clone + 重灌上下文,所以「谁有权否决」
 * 必须逐个钉住。这几条用例对应的都是会直接制造无谓返工的洞。
 */

const BUDGET = { max_model_tokens: 1000, max_wall_seconds: 60 };

function newStub() {
  return ns().get(ns().newUniqueId());
}
type Stub = ReturnType<typeof newStub>;

async function createTask(
  stub: Stub,
  spec: Record<string, unknown> = { prompt: "gates" },
  mode?: "shadow" | "enforce",
) {
  await stub.createTask(spec as never, crypto.randomUUID(), mode);
}

async function writerOk(
  stub: Stub,
  over: { patch_digest?: string | null; result_text?: string } = {},
): Promise<string> {
  const { attempt_id } = await stub.startAttempt({
    role: "writer",
    idempotency_key: crypto.randomUUID(),
    ...BUDGET,
  });
  const res = await stub.reportExecution({
    attempt_id,
    exit_code: 0,
    result_text: over.result_text ?? "已按要求完成",
    manifest_key: `manifests/task/w/${attempt_id}.json`,
    manifest_digest: `writer-digest-${attempt_id}`,
    patch_digest: over.patch_digest ?? null,
  });
  expect(res.ok).toBe(true);
  return attempt_id;
}

async function reviewerReport(
  stub: Stub,
  args: { exit_code: number; error?: string; review?: ReviewVerdict },
): Promise<string> {
  const { attempt_id } = await stub.startAttempt({
    role: "reviewer",
    idempotency_key: crypto.randomUUID(),
    ...BUDGET,
  });
  const res = await stub.reportExecution({ attempt_id, ...args });
  expect(res.ok).toBe(true);
  return attempt_id;
}

function kinds(snap: NonNullable<Awaited<ReturnType<Stub["getSnapshot"]>>>): string[] {
  return snap.events.map((e) => e.kind);
}

describe("TaskSession DO 门禁分级", () => {
  beforeAll(applyMigrations);

  it("reviewer 基建失败不返工,原地等人工", async () => {
    const stub = newStub();
    await createTask(stub);
    await writerOk(stub);
    expect((await stub.getSnapshot())!.task.state).toBe("AWAITING_APPROVAL");

    await reviewerReport(stub, { exit_code: 12, error: "upstream 502 from model gateway" });

    const snap = await stub.getSnapshot();
    expect(snap!.task.awaiting_human).toBe(true);
    expect(snap!.task.state).toBe("AWAITING_APPROVAL");
    expect(kinds(snap!)).toContain("review.unavailable");
    expect(kinds(snap!)).not.toContain("review.retry_scheduled");
    // 模型抖动换来的不是新一轮 writer,而是「停下来」
    expect(snap!.attempts.filter((a) => a.role === "writer")).toHaveLength(1);
    expect(kinds(snap!)).not.toContain("decision.recorded");
    chainIntact(snap!.events);
  });

  it("awaiting_human 之后自动裁决只留档,终态只能人工给", async () => {
    const stub = newStub();
    await createTask(stub);
    await writerOk(stub);
    await reviewerReport(stub, { exit_code: 12, error: "boom" });

    await reviewerReport(stub, { exit_code: 0, review: { decision: "approve", reason: "看起来没问题" } });

    const snap = await stub.getSnapshot();
    expect(kinds(snap!)).toContain("review.advisory_ignored_awaiting_human");
    expect(kinds(snap!)).not.toContain("decision.recorded");
    expect(snap!.task.state).toBe("AWAITING_APPROVAL");
    expect(snap!.task.awaiting_human).toBe(true);

    const ev = await stub.getEvidenceSummary();
    const done = await stub.submitDecision({
      attempt_id: ev.writer_attempt_id!,
      evidence_digest: ev.binding_digest!,
      decision: "approve",
      actor: "human:test",
    });
    expect(done.ok).toBe(true);
    expect((await stub.getSnapshot())!.task.state).toBe("DONE");
  });

  it("/evidence 的 binding_digest 与 submitDecision 同源", async () => {
    const stub = newStub();
    await createTask(stub);
    const writerId = await writerOk(stub);

    const ev = await stub.getEvidenceSummary();
    expect(ev.writer_attempt_id).toBe(writerId);
    expect(
      await compositeEvidenceDigest([
        { role: "writer", attempt_id: writerId, digest: `writer-digest-${writerId}` },
      ]),
    ).toBe(ev.binding_digest);

    expect(
      (
        await stub.submitDecision({
          attempt_id: writerId,
          evidence_digest: "f".repeat(64),
          decision: "approve",
          actor: "human:test",
        })
      ).error,
    ).toBe("evidence_mismatch");
    expect(
      (
        await stub.submitDecision({
          attempt_id: crypto.randomUUID(),
          evidence_digest: ev.binding_digest!,
          decision: "approve",
          actor: "human:test",
        })
      ).error,
    ).toBe("attempt_not_current_writer");
    expect((await stub.getSnapshot())!.task.state).toBe("AWAITING_APPROVAL");

    const ok = await stub.submitDecision({
      attempt_id: ev.writer_attempt_id!,
      evidence_digest: ev.binding_digest!,
      decision: "approve",
      actor: "human:test",
    });
    expect(ok.ok).toBe(true);

    const snap = await stub.getSnapshot();
    expect(snap!.task.state).toBe("DONE");
    const decision = snap!.events.find((e) => e.kind === "decision.recorded");
    expect(JSON.parse(decision!.payload).evidence_digest).toBe(ev.binding_digest);
    chainIntact(snap!.events);
  });

  it("血缘不符的验证结论不采信、不钉证据", async () => {
    const stub = newStub();
    await createTask(stub);
    const writerId = await writerOk(stub);

    const stale = await stub.startAttempt({
      role: "verifier",
      idempotency_key: crypto.randomUUID(),
      verify_context: { writer_manifest_key: "manifests/task/w/stale.json" },
      ...BUDGET,
    });
    await stub.reportExecution({
      attempt_id: stale.attempt_id,
      exit_code: 0,
      manifest_key: "manifests/task/v/stale.json",
      manifest_digest: "stale-verifier-digest",
      result_text: '{"apply":{"exit_code":0},"verify":{"exit_code":0}}',
    });

    let snap = await stub.getSnapshot();
    expect(kinds(snap!)).toContain("evidence.lineage_mismatch");
    expect(kinds(snap!)).not.toContain("verify.completed");
    expect((await stub.getEvidenceSummary()).verifier_attempt_id).toBeNull();

    const fresh = await stub.startAttempt({
      role: "verifier",
      idempotency_key: crypto.randomUUID(),
      verify_context: {
        writer_manifest_key: `manifests/task/w/${writerId}.json`,
      },
      ...BUDGET,
    });
    await stub.reportExecution({
      attempt_id: fresh.attempt_id,
      exit_code: 0,
      manifest_key: `manifests/task/v/${fresh.attempt_id}.json`,
      manifest_digest: `verifier-digest-${fresh.attempt_id}`,
      result_text: '{"apply":{"exit_code":0},"verify":{"exit_code":0}}',
    });

    snap = await stub.getSnapshot();
    expect(kinds(snap!)).toContain("verify.completed");
    const ev = await stub.getEvidenceSummary();
    expect(ev.verifier_attempt_id).toBe(fresh.attempt_id);
    // 陈旧验证器的 digest 绝不能进组合证据:它验的不是当前候选
    expect(
      await compositeEvidenceDigest([
        { role: "writer", attempt_id: writerId, digest: `writer-digest-${writerId}` },
        { role: "verifier", attempt_id: fresh.attempt_id, digest: `verifier-digest-${fresh.attempt_id}` },
      ]),
    ).toBe(ev.binding_digest);
    chainIntact(snap!.events);
  });

  it("两轮候选逐字节相同 → 熔断转人工,不再派 verifier/reviewer", async () => {
    const stub = newStub();
    await createTask(stub);
    const first = await writerOk(stub, { patch_digest: "same-candidate" });
    const afterFirst = await stub.getSnapshot();
    expect(kinds(afterFirst!).filter((k) => k === "review.requested")).toHaveLength(1);

    const second = await writerOk(stub, { patch_digest: "same-candidate" });
    expect(second).not.toBe(first);

    const snap = await stub.getSnapshot();
    expect(kinds(snap!)).toContain("gate.no_progress");
    expect(kinds(snap!).filter((k) => k === "review.requested")).toHaveLength(1);
    expect(kinds(snap!)).not.toContain("verify.requested");
    expect(snap!.task.awaiting_human).toBe(true);
    expect(snap!.task.state).toBe("AWAITING_APPROVAL");
    // 熔断钉住的是最新候选,人工据此裁决
    expect((await stub.getEvidenceSummary()).writer_attempt_id).toBe(second);
    chainIntact(snap!.events);
  });

  it("enforce:空洞的 reject 降级为「通过 + 附注」,不起新沙箱", async () => {
    const stub = newStub();
    await createTask(stub, { prompt: "gates", acceptance: ["脚本输出 hello world"] }, "enforce");
    await writerOk(stub);

    await reviewerReport(stub, {
      exit_code: 0,
      review: { decision: "reject", reason: "感觉不太对" },
    });

    const snap = await stub.getSnapshot();
    const assessed = snap!.events.find((e) => e.kind === "review.reject_assessed");
    expect(JSON.parse(assessed!.payload)).toMatchObject({ honored: false, reason: "no_failed_criteria", mode: "enforce" });
    expect(kinds(snap!)).toContain("review.downgraded");
    expect(kinds(snap!)).not.toContain("review.retry_scheduled");
    expect(snap!.attempts.filter((a) => a.role === "writer")).toHaveLength(1);
    expect(snap!.task.state).toBe("DONE");
    const decision = snap!.events.find((e) => e.kind === "decision.recorded");
    expect(JSON.parse(decision!.payload).decision).toBe("accept_with_notes");
    chainIntact(snap!.events);
  });

  it("shadow:同样判定为不成立的 reject 仍照旧返工,只多记一条评估", async () => {
    const stub = newStub();
    await createTask(stub, { prompt: "gates", acceptance: ["脚本输出 hello world"] }, "shadow");
    await writerOk(stub);

    await reviewerReport(stub, {
      exit_code: 0,
      review: { decision: "reject", reason: "感觉不太对" },
    });

    const snap = await stub.getSnapshot();
    const assessed = snap!.events.find((e) => e.kind === "review.reject_assessed");
    expect(JSON.parse(assessed!.payload)).toMatchObject({ honored: false, mode: "shadow" });
    expect(kinds(snap!)).not.toContain("review.downgraded");
    expect(kinds(snap!)).toContain("review.retry_scheduled");
    expect(snap!.attempts.filter((a) => a.role === "writer")).toHaveLength(2);
    expect(snap!.task.state).toBe("RUNNING");
    chainIntact(snap!.events);
  });
});
