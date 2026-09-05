import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import type { TaskSession } from "../src/control/session";
import {
  ARCHIVE_RETRY_LADDER_MS,
  SANDBOX_DESTROY_BUDGET_MS,
  archiveRetryDelayMs,
} from "../src/control/session";
import type { ReviewVerdict } from "../src/control/gates";
import type { TranscriptUsage } from "../src/exec/extract";
import { compositeEvidenceDigest } from "../src/audit/evidence";
import { reportArgsFrom, type ReportMessage } from "../src/exec/queue";
import type { ErrorClass } from "../src/routing/error-class";
import { applyMigrations } from "./d1";

/**
 * 沙箱销毁的假实现入口。
 *
 * 缺省 `fake = null` ⇒ getSandbox **抛错**,与「测试环境没有 Sandbox 绑定」时的真实行为
 * 同形:既有的「销毁失败不阻塞终态写入」用例继续测它本来测的那条路径,不因为本棒
 * 引入 mock 而换形状;workflow 侧的 sandbox 用法也一律照旧抛。
 * 只有需要控制销毁耗时的用例临时装一个 fake,afterEach 摘掉。
 *
 * vi.hoisted 不是习惯性防卫:工厂在 import 阶段就被调用,那时普通 `let` 还在 TDZ 里。
 */
const sandboxHook = vi.hoisted(() => ({
  fake: null as null | ((attemptId: string) => Promise<void>),
  calls: [] as string[],
}));

vi.mock("@cloudflare/sandbox", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getSandbox: (_ns: unknown, attemptId: string) => {
      const fake = sandboxHook.fake;
      if (!fake) throw new Error("Sandbox binding is not configured in the test environment");
      sandboxHook.calls.push(attemptId);
      return { destroy: () => fake(attemptId) };
    },
  };
});

/**
 * TaskSession DO 并发测试。
 *
 * 背景:DO 的 input gate 不保护 RPC,多个并发 RPC 在同一 isolate 内
 * 于 await 边界交错。loadAll → 变更 → saveAll 若无
 * blockConcurrencyWhile 保护,并发 createTask 会各自读到空状态并各写
 * 一条 task.created(事件链双份 = 修复前该测试应为红)。
 */

const ns = () => env.TASK_SESSION as DurableObjectNamespace<TaskSession>;

// 迁移含不可重复执行的 ALTER TABLE:整个文件应用一次,而不是每个 suite 一次
beforeAll(applyMigrations);

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
  args: { exit_code: number; error?: string; error_class?: ErrorClass | null; review?: ReviewVerdict },
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

function payloads(
  snap: NonNullable<Awaited<ReturnType<Stub["getSnapshot"]>>>,
  kind: string,
): Array<Record<string, unknown>> {
  return snap.events.filter((e) => e.kind === kind).map((e) => JSON.parse(e.payload));
}

async function writerReport(
  stub: Stub,
  over: {
    exit_code?: number;
    base?: { sha: string; source: string; fallback?: string } | null;
    patch_digest?: string | null;
    result_text?: string;
    role?: "writer" | "reviewer" | "verifier";
    verify_context?: { writer_manifest_key: string };
  } = {},
): Promise<string> {
  const { attempt_id } = await stub.startAttempt({
    role: over.role ?? "writer",
    idempotency_key: crypto.randomUUID(),
    verify_context: over.verify_context,
    ...BUDGET,
  });
  const res = await stub.reportExecution({
    attempt_id,
    exit_code: over.exit_code ?? 0,
    result_text: over.result_text ?? "已按要求完成",
    manifest_key: `manifests/task/w/${attempt_id}.json`,
    manifest_digest: `digest-${attempt_id}`,
    patch_digest: over.patch_digest ?? null,
    base: over.base as never,
  });
  expect(res.ok).toBe(true);
  return attempt_id;
}

describe("TaskSession DO 门禁分级", () => {
  it("reviewer 基建失败不返工,原地等人工", async () => {
    const stub = newStub();
    await createTask(stub);
    await writerOk(stub);
    expect((await stub.getSnapshot())!.task.state).toBe("AWAITING_APPROVAL");

    await reviewerReport(stub, {
      exit_code: 12,
      error: "upstream 502 from model gateway",
      error_class: "upstream_error",
    });

    const snap = await stub.getSnapshot();
    expect(snap!.task.awaiting_human).toBe(true);
    expect(snap!.task.state).toBe("AWAITING_APPROVAL");
    expect(kinds(snap!)).toContain("review.unavailable");
    expect(kinds(snap!)).not.toContain("review.retry_scheduled");
    // 模型抖动换来的不是新一轮 writer,而是「停下来」
    expect(snap!.attempts.filter((a) => a.role === "writer")).toHaveLength(1);
    expect(kinds(snap!)).not.toContain("decision.recorded");
    // §13.23:reason 只带枚举。`error` 那段自由文本(以及它带的响应体线索)不进权威链
    const [unavailable] = payloads(snap!, "review.unavailable");
    expect(unavailable).toEqual({
      attempt_id: expect.any(String),
      reason: "reviewer_unavailable:upstream_error",
      exit_code: 12,
      error_class: "upstream_error",
    });
    expect(JSON.stringify(unavailable)).not.toContain("model gateway");
    chainIntact(snap!.events);
  });

  it("三个 exit 12 位点在权威链上可分辨,处置逐字相同(三因合一已拆开)", async () => {
    for (const cls of ["upstream_timeout", "provider_access_denied", "bad_response_body"] as const) {
      const stub = newStub();
      await createTask(stub);
      await writerOk(stub);
      await reviewerReport(stub, { exit_code: 12, error_class: cls });

      const snap = await stub.getSnapshot();
      const [unavailable] = payloads(snap!, "review.unavailable");
      expect(unavailable.error_class, cls).toBe(cls);
      expect(unavailable.reason, cls).toBe(`reviewer_unavailable:${cls}`);
      // 分流只让原因可分辨,不改路由动作:既不返工也不放行,照旧交人工
      expect(snap!.task.state, cls).toBe("AWAITING_APPROVAL");
      expect(snap!.task.awaiting_human, cls).toBe(true);
      expect(kinds(snap!).filter((k) => k === "writer.rework_scheduled"), cls).toHaveLength(0);
      expect(kinds(snap!), cls).not.toContain("route.infra_candidate");
    }
  });

  it("旧样本没有成因时不猜:reason 落 unclassified,处置不变", async () => {
    const stub = newStub();
    await createTask(stub);
    await writerOk(stub);
    await reviewerReport(stub, { exit_code: 12 });

    const snap = await stub.getSnapshot();
    const [unavailable] = payloads(snap!, "review.unavailable");
    expect(unavailable.error_class).toBe("unclassified");
    expect(unavailable.reason).toBe("reviewer_unavailable:unclassified");
    expect(snap!.task.awaiting_human).toBe(true);
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

/**
 * M8 基线冻结:候选必须说清它对哪个 commit 成立,跨轮比较与「可重放」都以此为前提。
 * 这里钉的是控制面职责 —— 谁是基线的权威、失败时走哪条路、返工轮继承什么。
 */

const BASE_A = "a".repeat(40);
const BASE_B = "b".repeat(40);

describe("TaskSession DO 基线冻结", () => {
  it("writer 回报的基线成为任务权威,返工轮继承同一 commit", async () => {
    const stub = newStub();
    await createTask(stub, { prompt: "m8", acceptance: ["脚本输出 hello world"] }, "shadow");

    await writerReport(stub, {
      patch_digest: "p-1",
      base: { sha: BASE_A, source: "resolved_default" },
    });
    let snap = await stub.getSnapshot();
    expect(snap!.task.base).toEqual({ sha: BASE_A, source: "resolved_default" });
    expect(kinds(snap!)).toContain("base.frozen");
    expect(snap!.task.state).toBe("AWAITING_APPROVAL");

    // shadow 下成立的 reject 触发返工:新沙箱必须落回同一个 commit
    await reviewerReport(stub, { exit_code: 0, review: { decision: "reject", reason: "没按要求" } });
    snap = await stub.getSnapshot();
    const writerPins = payloads(snap!, "attempt.created").filter((p) => p.role === "writer");
    expect(writerPins).toHaveLength(2);
    expect(writerPins[1].base_pin).toBe(BASE_A);
    expect(kinds(snap!)).not.toContain("base.moved");
    chainIntact(snap!.events);
  });

  it("shadow 回落默认分支:留 base.fallback + base.moved,并清零无进展基准", async () => {
    const stub = newStub();
    await createTask(
      stub,
      { prompt: "m8", base_sha: BASE_A, acceptance: ["脚本输出 hello world"] },
      "shadow",
    );
    // 人工指定的基线在入口处即成为任务事实
    expect((await stub.getSnapshot())!.task.base).toEqual({ sha: BASE_A, source: "pinned" });

    await writerReport(stub, { patch_digest: "p-1", base: { sha: BASE_A, source: "pinned" } });
    await reviewerReport(stub, { exit_code: 0, review: { decision: "reject", reason: "没按要求" } });

    // 第二轮:pinned 基线不可达,执行面按 shadow 回落默认分支并如实报告
    await writerReport(stub, {
      patch_digest: "p-1",
      base: { sha: BASE_B, source: "resolved_default", fallback: "pinned base unreachable" },
    });

    const snap = await stub.getSnapshot();
    expect(kinds(snap!)).toContain("base.fallback");
    expect(kinds(snap!)).toContain("base.moved");
    expect(snap!.task.base).toEqual({ sha: BASE_B, source: "resolved_default" });
    // 基线换了还拿旧基准比,会把正常努力误判成无进展熔断
    expect(kinds(snap!)).not.toContain("gate.no_progress");
    chainIntact(snap!.events);
  });

  it("基线材质化失败 fail-closed:BLOCKED 转人工,不烧返工预算、不派下游", async () => {
    const stub = newStub();
    await createTask(stub, {
      prompt: "m8",
      repo_url: "https://example.invalid/r.git",
      base_sha: BASE_A,
    });
    const { attempt_id } = await stub.startAttempt({
      role: "writer",
      idempotency_key: crypto.randomUUID(),
      ...BUDGET,
    });
    const res = await stub.reportExecution({
      attempt_id,
      exit_code: 21,
      result_text: "base materialization failed: unreachable",
    });
    expect(res.ok).toBe(true);

    const snap = await stub.getSnapshot();
    expect(kinds(snap!)).toContain("base.failed");
    expect(snap!.task.state).toBe("BLOCKED");
    expect(snap!.task.awaiting_human).toBe(true);
    // 环境事实不是候选质量判定:重开沙箱在同一个 SHA 上必然同样失败
    expect(snap!.attempts.filter((a) => a.role === "writer")).toHaveLength(1);
    expect(kinds(snap!)).not.toContain("writer.rework_scheduled");
    expect(kinds(snap!)).not.toContain("verify.requested");
    expect(kinds(snap!)).not.toContain("review.requested");
    // 失败不改写基线权威,人工据此重指
    expect(snap!.task.base).toEqual({ sha: BASE_A, source: "pinned" });
    chainIntact(snap!.events);
  });

  it("补丁超限(24)同属容量事实:BLOCKED 转人工,不返工,reason 与基线失败可区分", async () => {
    const stub = newStub();
    await createTask(stub, {
      prompt: "m9",
      repo_url: "https://example.invalid/r.git",
    });
    const { attempt_id } = await stub.startAttempt({
      role: "writer",
      idempotency_key: crypto.randomUUID(),
      ...BUDGET,
    });
    const res = await stub.reportExecution({
      attempt_id,
      exit_code: 24,
      result_text: "",
      error: "patch too large: 9999999 bytes > 1048576 limit",
    });
    expect(res.ok).toBe(true);

    const snap = await stub.getSnapshot();
    expect(kinds(snap!)).toContain("base.failed");
    expect(snap!.task.state).toBe("BLOCKED");
    expect(snap!.task.awaiting_human).toBe(true);
    // 超限不是质量判定:不给「缩小 diff」的返工,人决定调上限还是拆任务
    expect(snap!.attempts.filter((a) => a.role === "writer")).toHaveLength(1);
    expect(kinds(snap!)).not.toContain("writer.rework_scheduled");
    expect(kinds(snap!)).not.toContain("verify.requested");
    const [transition] = payloads(snap!, "task.transition").filter(
      (p) => p.to === "BLOCKED",
    );
    expect(transition.reason).toContain("patch exceeds size cap");
    expect(transition.reason).not.toContain("base materialization");
    chainIntact(snap!.events);
  });

  it("result_text 为空串时 base.failed 仍留得下诊断(prod 实际形态)", async () => {
    const stub = newStub();
    await createTask(stub, {
      prompt: "m8",
      repo_url: "https://example.invalid/r.git",
      base_sha: BASE_A,
    });
    const { attempt_id } = await stub.startAttempt({
      role: "writer",
      idempotency_key: crypto.randomUUID(),
      ...BUDGET,
    });
    // 基线失败时 transcript 是纯文本,提取器返回 null,workflow 落成 ""(非 null)
    await stub.reportExecution({
      attempt_id,
      exit_code: 21,
      result_text: "",
      manifest_key: "manifests/task/w/x.json",
    });

    const [payload] = payloads((await stub.getSnapshot())!, "base.failed");
    expect(payload.detail).not.toBe("");
    expect(payload.detail).toContain("exit_code=21");
    expect(payload.manifest_key).toBe("manifests/task/w/x.json");
  });

  it("verifier 报的基线与任务不符 → 结论不采信", async () => {
    const stub = newStub();
    await createTask(stub, { prompt: "m8", repo_url: "https://example.invalid/r.git" });
    const writerId = await writerReport(stub, {
      patch_digest: "p-1",
      base: { sha: BASE_A, source: "pinned" },
    });

    const stale = await writerReport(stub, {
      role: "verifier",
      verify_context: { writer_manifest_key: `manifests/task/w/${writerId}.json` },
      base: { sha: BASE_B, source: "pinned" },
      result_text: '{"apply":{"exit_code":0},"verify":{"exit_code":0}}',
    });

    const snap = await stub.getSnapshot();
    expect(kinds(snap!)).toContain("base.lineage_mismatch");
    expect(kinds(snap!)).not.toContain("verify.completed");
    expect((await stub.getEvidenceSummary()).verifier_attempt_id).toBeNull();
    expect(stale).toBeTruthy();
    chainIntact(snap!.events);
  });
});

describe("exec-report 消息映射", () => {
  it("逐字段转发,新增字段漏映射即红", () => {
    const body: ReportMessage = {
      schema_version: 1,
      type: "exec-report",
      task_id: "t1",
      session_id: "sess",
      attempt_id: "att",
      exit_code: 0,
      error: "none",
      // §13.23 的枚举位点:执行面按形状判出的失败成因。少映射一行就是这里红 ——
      // reviewer 的三个 exit 12 会重新糊成一个不可分辨的信号。
      error_class: "upstream_timeout",
      transcript_digest: "td",
      manifest_key: "mk",
      manifest_digest: "md",
      tokens: 7,
      usage: { input_tokens: 5, cache_read_input_tokens: 4, output_tokens: 2, total_tokens: 7 },
      result_text: "done",
      patch_digest: "pd",
      base: { sha: BASE_A, source: "resolved_default" },
      review: { decision: "approve", reason: "ok" },
    };
    const args = reportArgsFrom(body);
    expect(args.base).toEqual(body.base);
    expect(args.patch_digest).toBe("pd");
    expect(args.error_class).toBe("upstream_timeout");
    const forwarded = Object.keys(args).sort();
    const expected = Object.keys(body)
      .filter((k) => !["schema_version", "type", "task_id", "session_id"].includes(k))
      .sort();
    expect(forwarded).toEqual(expected);
  });
});

/**
 * Fix B(r7):attempt 终态即销毁沙箱。r7 prod 实测任务 BLOCKED 后孤儿 qwen
 * 仍烧 token 2.5 分钟 —— 终态转换必须主动 destroy 容器。
 * 测试环境没有 Sandbox 绑定:getSandbox 抛错被 catch,走 `sandbox_destroy
 * failed` 日志路径,恰好断言「机制开火 + 失败不阻塞权威写入」。
 */
describe("attempt 终态销毁沙箱", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    sandboxHook.fake = null;
    sandboxHook.calls.length = 0;
  });

  function spyDestroyLogs() {
    const warns: string[] = [];
    const infos: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => {
      warns.push(a.map(String).join(" "));
    });
    vi.spyOn(console, "info").mockImplementation((...a: unknown[]) => {
      infos.push(a.map(String).join(" "));
    });
    return { warns, infos, all: () => [...warns, ...infos] };
  }

  const flush = () => new Promise((r) => setTimeout(r, 100));

  it("writer exit<0 → BLOCKED 时销毁沙箱,销毁失败不阻塞终态写入", async () => {
    const logs = spyDestroyLogs();
    const stub = newStub();
    await createTask(stub);
    const { attempt_id } = await stub.startAttempt({
      role: "writer",
      idempotency_key: crypto.randomUUID(),
      ...BUDGET,
    });
    const res = await stub.reportExecution({
      attempt_id,
      exit_code: -1,
      error: "internal workflows error",
    });
    expect(res.ok).toBe(true);
    await flush();

    expect(
      logs.warns.some((l) =>
        l.includes(`sandbox_destroy failed attempt=${attempt_id}`) &&
        l.includes("reason=attempt_blocked:workflow_error"),
      ),
    ).toBe(true);
    const snap = await stub.getSnapshot();
    expect(snap!.task.state).toBe("BLOCKED");
    chainIntact(snap!.events);
  });

  it("writer SUCCEEDED 同样销毁(reason=attempt_finished:exit=0)", async () => {
    const logs = spyDestroyLogs();
    const stub = newStub();
    await createTask(stub);
    const attempt_id = await writerOk(stub);
    await flush();

    expect(
      logs.all().some((l) =>
        l.includes(`sandbox_destroy`) &&
        l.includes(`attempt=${attempt_id}`) &&
        l.includes("reason=attempt_finished:exit=0"),
      ),
    ).toBe(true);
  });

  it("reviewer 终态不触发销毁:LLM 直连从无沙箱,不发无谓 RPC", async () => {
    const logs = spyDestroyLogs();
    const stub = newStub();
    await createTask(stub);
    await writerOk(stub);
    logs.warns.length = 0;
    logs.infos.length = 0;

    await reviewerReport(stub, { exit_code: 12, error: "upstream 502" });
    await flush();

    expect(logs.all().some((l) => l.includes("sandbox_destroy"))).toBe(false);
  });

  /**
   * c11b 第 1 条。prod 那次事故的形状是:destroy 卡 30004ms,而它挂在 ctx.waitUntil 上
   * ⇒ RPC 跟着一起卡 ⇒ 终态回报 exceededWallTime ⇒ 归档停滞的整条链从这儿开始。
   *
   * 时限**砍的是等待,不是销毁**,所以这一条同时钉三头:
   * - 交给 waitUntil 的那个 promise 在预算内了结(= `sandbox_destroy timeout` 日志在预算
   *   时刻出现,而不是等假销毁自己返回)。RPC 寿命由它决定;测试基座不替我们延长
   *   RPC,所以「回报本身花多久」在这里不是判据,**日志时刻**才是。
   * - 假销毁仍被调用(`sandboxHook.calls`)—— 加时限不等于把销毁删掉:孤儿 qwen 继续烧
   *   token、容器内凭据残留这两个理由仍然成立。
   * - 超时的 grep 口径与 ok/failed 同族:`sandbox_destroy timeout ... budget_ms=`。
   * 假销毁睡 3 倍预算:不睡过预算就无法证明是**时限**了结了等待,而不是销毁碰巧快。
   */
  it("销毁超过预算:等待在时限内了结,销毁本身照发并留下超时日志", async () => {
    const logs = spyDestroyLogs();
    sandboxHook.fake = () =>
      new Promise((r) => setTimeout(r, SANDBOX_DESTROY_BUDGET_MS * 3));

    const stub = newStub();
    await createTask(stub);
    const { attempt_id } = await stub.startAttempt({
      role: "writer",
      idempotency_key: crypto.randomUUID(),
      ...BUDGET,
    });

    const startedAt = Date.now();
    const res = await stub.reportExecution({ attempt_id, exit_code: -1, error: "workflow hung" });
    expect(res.ok).toBe(true);

    const lineAt = ((): number | null => {
      const hits = logs.warns.filter((l) => l.includes("sandbox_destroy timeout"));
      return hits.length > 0 ? Date.now() - startedAt : null;
    });
    let observed: number | null = null;
    for (let i = 0; i < 80; i++) {
      observed = lineAt();
      if (observed !== null) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    expect(observed, "没有等到 sandbox_destroy timeout 日志").not.toBeNull();
    // 预算到点即了结:假销毁还要再睡两倍预算,所以这一条只有时限能解释。
    expect(observed!).toBeLessThan(SANDBOX_DESTROY_BUDGET_MS + 1_500);
    const timeoutLine = logs.warns.find((l) => l.includes("sandbox_destroy timeout"))!;
    expect(timeoutLine).toContain(`attempt=${attempt_id}`);
    expect(timeoutLine).toContain("reason=attempt_blocked:workflow_error");
    expect(timeoutLine).toContain(`budget_ms=${SANDBOX_DESTROY_BUDGET_MS}`);
    // 没有被「因为太慢所以删掉」:销毁确实发出去了。
    expect(sandboxHook.calls).toContain(attempt_id);
    // 了结只有一次:超时之后不再有第二条销毁日志(等待方已经放手)。
    expect(logs.all().filter((l) => l.includes("sandbox_destroy"))).toHaveLength(1);

    const snap = await stub.getSnapshot();
    expect(snap!.task.state).toBe("BLOCKED");
    chainIntact(snap!.events);
  }, SANDBOX_DESTROY_BUDGET_MS * 2 + 20_000);
});

/**
 * attempt 的 token 台账:raw total 之外还要记下用量四元组与成本加权值。
 *
 * 钉三件事:① tokens_used 的既有语义不变(仍 = raw total,r11 那个 6,949,711);
 * ② 四列来自 usage,加权值按 CACHE_READ_COST_FACTOR(测试环境未配 → 回落 0.2);
 * ③ 没有 usage 时四列是 NULL 而不是 0 —— 「未记录」与「零消耗」在审计面上是两回事。
 */
describe("attempt token 台账落库", () => {
  const R11_USAGE: TranscriptUsage = {
    input_tokens: 6_886_340,
    cache_read_input_tokens: 6_733_762,
    output_tokens: 63_371,
    total_tokens: 6_949_711,
  };
  /** factor=0.2:(input-cache_read) + output + round(cache_read*0.2) */
  const R11_COST = 1_562_701;

  interface LedgerRow {
    state: string;
    tokens_used: number;
    input_tokens: number | null;
    cache_read_tokens: number | null;
    output_tokens: number | null;
    cost_weighted_tokens: number | null;
  }

  async function ledgerRow(attemptId: string): Promise<LedgerRow> {
    const row = await env.DB.prepare(
      "SELECT state, tokens_used, input_tokens, cache_read_tokens, output_tokens, cost_weighted_tokens" +
        " FROM attempts WHERE id = ?",
    )
      .bind(attemptId)
      .first<LedgerRow>();
    // 查不到行 = 归档没发生,那和「四列为 null」是两种故障,不能混为一谈
    expect(row).not.toBeNull();
    return row!;
  }

  /** writer 回报 → 人工 approve 到 DONE(终态才归档)。usage 原样透传。 */
  async function reportAndArchive(over: {
    usage?: TranscriptUsage | null;
    tokens?: number;
    exit_code?: number;
    error?: string;
  }): Promise<{ stub: Stub; attempt_id: string }> {
    const stub = newStub();
    await stub.createTask({ prompt: "ledger" } as never, crypto.randomUUID());
    const { attempt_id } = await stub.startAttempt({
      role: "writer",
      idempotency_key: crypto.randomUUID(),
      ...BUDGET,
    });
    const res = await stub.reportExecution({
      attempt_id,
      exit_code: over.exit_code ?? 0,
      error: over.error,
      tokens: over.tokens ?? R11_USAGE.total_tokens,
      usage: over.usage,
      result_text: "已按要求完成",
      manifest_key: `manifests/task/w/${attempt_id}.json`,
      manifest_digest: `digest-${attempt_id}`,
    });
    expect(res.ok).toBe(true);

    if ((over.exit_code ?? 0) === 0) {
      const ev = await stub.getEvidenceSummary();
      const done = await stub.submitDecision({
        attempt_id: ev.writer_attempt_id!,
        evidence_digest: ev.binding_digest!,
        decision: "approve",
        actor: "human:test",
      });
      expect(done.ok).toBe(true);
    }
    return { stub, attempt_id };
  }

  it("带 usage → 四元组与成本加权值入归档行,tokens_used 仍是 raw total", async () => {
    const { stub, attempt_id } = await reportAndArchive({ usage: R11_USAGE });

    const row = await ledgerRow(attempt_id);
    expect(row.state).toBe("SUCCEEDED");
    expect(row.tokens_used).toBe(6_949_711);
    expect({
      input_tokens: row.input_tokens,
      cache_read_tokens: row.cache_read_tokens,
      output_tokens: row.output_tokens,
    }).toEqual({
      input_tokens: 6_886_340,
      cache_read_tokens: 6_733_762,
      output_tokens: 63_371,
    });
    // 96.9% 是缓存命中:加权值只有 raw total 的两成出头
    expect(row.cost_weighted_tokens).toBe(R11_COST);

    const snap = await stub.getSnapshot();
    const [captured] = payloads(snap!, "result.captured");
    expect(captured.total_tokens).toBe(6_949_711);
    expect(captured.cost_weighted_tokens).toBe(R11_COST);
    chainIntact(snap!.events);
  });

  it("不带 usage → 四列 NULL(不是 0),raw total 照常记", async () => {
    const { stub, attempt_id } = await reportAndArchive({});

    const row = await ledgerRow(attempt_id);
    expect(row.tokens_used).toBe(6_949_711);
    expect([row.input_tokens, row.cache_read_tokens, row.output_tokens, row.cost_weighted_tokens]).toEqual([
      null,
      null,
      null,
      null,
    ]);

    const [captured] = payloads((await stub.getSnapshot())!, "result.captured");
    expect(captured.cost_weighted_tokens).toBeNull();
  });

  it("回报缺 cache_read 一项时:已知的照记,成本保守按全 fresh 计", async () => {
    const { attempt_id } = await reportAndArchive({
      usage: { input_tokens: 1_000, output_tokens: 200, total_tokens: 1_200 },
    });

    const row = await ledgerRow(attempt_id);
    expect(row.input_tokens).toBe(1_000);
    expect(row.output_tokens).toBe(200);
    expect(row.cache_read_tokens).toBeNull();
    expect(row.cost_weighted_tokens).toBe(1_200);
  });

  it("BLOCKED 终态同样留台账:到期击杀的 attempt 钱已经花了", async () => {
    const { attempt_id } = await reportAndArchive({
      usage: R11_USAGE,
      exit_code: -1,
      error: "longrun_wall_exceeded",
    });

    const row = await ledgerRow(attempt_id);
    expect(row.state).toBe("BLOCKED");
    expect(row.tokens_used).toBe(6_949_711);
    expect(row.cost_weighted_tokens).toBe(R11_COST);
  });

  /**
   * 两口径同源(r2 的 48.4× 漏记就是「两套口径靠约定维持」的代价):
   * 快照事件里的 total_tokens 与归档四元组必须由**同一个累加产物**给出 ——
   * DO 侧重算一遍而不是照抄消息里那个冗余的 tokens 字段。
   */
  it("reported tokens 与 usage 派生值不一致:两处都取派生值(不各信一遍)", async () => {
    const { stub, attempt_id } = await reportAndArchive({
      usage: R11_USAGE,
      tokens: 221_167, // 旧形状:某一次单调用的 total
    });

    const row = await ledgerRow(attempt_id);
    expect(row.tokens_used).toBe(6_949_711);
    expect(row.cost_weighted_tokens).toBe(R11_COST);
    const [captured] = payloads((await stub.getSnapshot())!, "result.captured");
    // 同一个量:快照与归档若来自两次计算,这里就会分叉
    expect(captured.total_tokens).toBe(row.tokens_used);
    expect(captured.cost_weighted_tokens).toBe(row.cost_weighted_tokens);
  });

  it("被击杀 attempt 带逐事件累加的 usage:台账记会话总量而非末次调用", async () => {
    // r2 任务 76464e22:逐事件累加出的会话总量(旧实现只记到末次调用的量级)
    const { attempt_id } = await reportAndArchive({
      usage: {
        input_tokens: 10_686_994,
        cache_read_input_tokens: 10_245_632,
        output_tokens: 5_000,
        total_tokens: 10_691_994,
      },
      tokens: 10_691_994,
      exit_code: -1,
      error: "longrun_wall_exceeded",
    });

    const row = await ledgerRow(attempt_id);
    expect(row.state).toBe("BLOCKED");
    expect(row.tokens_used).toBe(10_691_994);
    expect(row.input_tokens).toBe(10_686_994);
    expect(row.cache_read_tokens).toBe(10_245_632);
    // 加权 2,495,488 = fresh 441,362 + output 5,000 + round(10,245,632×0.2);
    // 旧实现记的是 45,818(漏 54.5×)
    expect(row.cost_weighted_tokens).toBe(2_495_488);
  });
});

/**
 * c11 主修:一次 DO RPC 被杀不得把权威链写成「重号 + 不可归档」的损坏状态。
 *
 * (a)(b)(c) 受同一条平台事实约束(workerd 的实测语义,不是本仓的选择):**抛异常的 RPC
 * 会整体丢弃该轮的 storage 写**,并把该 DO 实例的 input gate 打成 broken —— 之后每次
 * 调用都返回同一个错误,且每个这样的调用都会给测试进程留下一条 unhandled rejection
 * (`durableObjectReset`)。所以「链已前进、状态陈旧」的残骸在 miniflare 里既造不出来
 * 也读不到,而任何让 RPC 往外抛的用例都会把整个套件染红。用例因此钉可观测的那一半:
 * 取号与归档看的是链(唯一在被杀后仍前进的结构),而不是 `task.next_seq`。
 *
 * (d)(e)(f) 钉这一节的其余三块判别力:
 * - (d) 封箱簿记本身 —— 追过两个分片边界,核对 `events:arc` 登记、`events:cur` 裁剪、
 *   分片键编号、计数器镜像与 D1 归档行数五者是否互相自洽;
 * - (e) 对账告警的噪声面 —— 正常轮次一条 `seq_reconciled` 都不许有(反向半边钉在 (e2):
 *   镜像真陈旧时必须恰好一条,并以链为准修回来。两半合起来才钉住「对账只在读时做一次」);
 * - (f) 判重兜底的反推写回 —— 重放命中链上终态事件时,`attempt.state` 由链事件派生,
 *   而不是停在陈旧值上。
 *
 * (f) 需要的「链已前进、状态陈旧」形状无法靠被杀的 RPC 造出来(见上),但可以直接把
 * `attempts` 这一层拨回陈旧值 —— 被测的是判据读哪一层,不是 storage 会不会半写。
 */
describe("事件与状态同一次原子写(c11)", () => {
  async function chainOf(stub: Stub) {
    return (await stub.getSnapshot())!;
  }

  async function driveToDone(stub: Stub, taskId: string): Promise<void> {
    await stub.createTask({ prompt: "atomic write" } as never, taskId);
    await writerOk(stub);
    await reviewerReport(stub, { exit_code: 0, review: { decision: "approve", reason: "看着可以" } });
    const snap = await chainOf(stub);
    if (snap.task.state === "AWAITING_APPROVAL") {
      const ev = await stub.getEvidenceSummary();
      const done = await stub.submitDecision({
        attempt_id: ev.writer_attempt_id!,
        evidence_digest: ev.binding_digest!,
        decision: "approve",
        actor: "human:test",
      });
      expect(done.ok).toBe(true);
    }
  }

  it("(a) 取号来自链尾:归档写进 D1 时 (task_id, seq) 不重号", async () => {
    const taskId = crypto.randomUUID();
    const stub = newStub();
    await driveToDone(stub, taskId);

    const snap = await chainOf(stub);
    expect(snap.task.state).toBe("DONE");
    const seqs = snap.events.map((e) => e.seq);
    // 链是 1..N 连续无重号:任何一次从陈旧计数器取号的重放都会在这里露出来
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    // next_seq 降级为对账字段:它是链的镜像,不是取号来源
    expect(snap.task.next_seq).toBe(seqs.length + 1);

    // 真实代码路径上的 UNIQUE 约束(migrations/0003 idx_events_task_seq):prod 事故里
    // 重号的链正是撞它,导致整批归档永久失败。归档落地 ⇒ 索引吃下了这一批。
    const archived = await env.DB.prepare(
      "SELECT COUNT(*) AS rows_total, COUNT(DISTINCT seq) AS seqs_unique FROM events WHERE task_id = ?",
    )
      .bind(taskId)
      .first<{ rows_total: number; seqs_unique: number }>();
    expect(archived!.rows_total).toBe(seqs.length);
    expect(archived!.seqs_unique).toBe(seqs.length);
  });

  it("(b) 同一份终态回报重放 4 次:链只前进一块", async () => {
    const stub = newStub();
    await createTask(stub);
    const { attempt_id } = await stub.startAttempt({
      role: "writer",
      idempotency_key: crypto.randomUUID(),
      ...BUDGET,
    });
    const report = { attempt_id, exit_code: 0, result_text: "已按要求完成" };
    const first = await stub.reportExecution(report);
    expect(first.ok).toBe(true);

    const seqsFirst = (await chainOf(stub)).events.map((e) => e.seq);
    expect(new Set(seqsFirst).size).toBe(seqsFirst.length);

    for (let i = 0; i < 4; i++) {
      const again = await stub.reportExecution(report);
      expect(again).toMatchObject({ ok: true, ignored: true });
    }

    const replayed = await chainOf(stub);
    // 链一块都没再前进:重复回报既不再追加事件,也不推进取号
    expect(replayed.events.map((e) => e.seq)).toEqual(seqsFirst);
    expect(replayed.task.next_seq).toBe(seqsFirst.length + 1);
  });

  it("(c) 本轮内部抛异常:照样落盘,且落下的内容与链自洽", async () => {
    const taskId = crypto.randomUUID();
    const stub = newStub();
    await stub.createTask({ prompt: "mid-round failure" } as never, taskId);
    await writerOk(stub);
    // reviewer 抖动一次 ⇒ awaiting_human + AWAITING_APPROVAL:终态只能由人工给,
    // 于是下面这条 submitDecision 会走完整的 finishApproval(含唤醒 writer)。
    await reviewerReport(stub, { exit_code: 12, error: "reviewer boom" });
    const awaiting = await chainOf(stub);
    expect(awaiting.task.state).toBe("AWAITING_APPROVAL");
    const ev = await stub.getEvidenceSummary();

    const bag = env as unknown as Record<string, unknown>;
    const realWorkflow = bag.ATTEMPT_WORKFLOW;
    // 抽掉 workflow 绑定 ⇒ finishApproval 唤醒 writer 时抛 ⇒ notifyWriter 自己接住并往
    // 链里补一条 workflow.notify_failed。异常被吞在业务体里,落盘出口照常执行:
    // 要钉的就是「异常轮次也交出与链自洽的状态」,而不是把事件丢在半路。
    delete bag.ATTEMPT_WORKFLOW;
    const done = await stub.submitDecision({
      attempt_id: ev.writer_attempt_id!,
      evidence_digest: ev.binding_digest!,
      decision: "approve",
      actor: "human:test",
    });
    bag.ATTEMPT_WORKFLOW = realWorkflow;
    expect(done.ok).toBe(true);

    const snap = await chainOf(stub);
    expect(snap.task.state).toBe("DONE");
    const seqs = snap.events.map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    expect(kinds(snap)).toContain("workflow.notify_failed");
    // 链与状态一起前进:归档批次与链逐条对齐(静默丢事件会让这里少几行)
    const rows = await env.DB.prepare("SELECT COUNT(*) AS c FROM events WHERE task_id = ?")
      .bind(taskId)
      .first<{ c: number }>();
    expect(rows!.c).toBe(seqs.length);
  });

  /**
   * 与 src/control/session.ts 的 `EVENTS_PER_SHARD` 同值。刻意在测试里抄一份常量:
   * 边界用例的判别力正来自「第 100 条必须封箱」这个具体数字 —— 把阈值改成永不封箱
   * (或每次追加都封箱)的变异必须把 (d) 打红。改了 src 的阈值就得同步改这一行。
   */
  const SHARD = 100;

  /** DO storage 里事件分片的最小读投影(键与形状见 session.ts 的 loadAll/persist)。 */
  interface StoredEvent {
    seq: number;
  }

  /**
   * 直接读原始分片簿记。`getSnapshot` 给的是这三处拼回来的链,只能看出「链不对」;
   * 读原始键才分得出是**哪一格**不对(索引没登记 / 分片体没落盘 / 当前分片没裁剪)。
   */
  async function readShardState(stub: Stub): Promise<{
    arcKeys: string[];
    shards: Record<string, StoredEvent[]>;
    cur: StoredEvent[];
  }> {
    return runInDurableObject(stub, async (_instance, state) => {
      const arcKeys = (await state.storage.get<string[]>("events:arc")) ?? [];
      const shards: Record<string, StoredEvent[]> = {};
      for (const key of arcKeys) shards[key] = (await state.storage.get<StoredEvent[]>(key)) ?? [];
      const cur = (await state.storage.get<StoredEvent[]>("events:cur")) ?? [];
      return { arcKeys, shards, cur };
    });
  }

  /** 把 `task` 行的计数器镜像拨回陈旧值(链不动)。 */
  async function staleNextSeqMirror(stub: Stub, value: number): Promise<void> {
    await runInDurableObject(stub, async (_instance, state) => {
      const task = await state.storage.get<{ next_seq: number }>("task");
      if (task) await state.storage.put("task", { ...task, next_seq: value });
    });
  }

  /** 把 `attempts` 里那条回报的状态拨回 RUNNING、finished_at 清空(链不动)。 */
  async function staleAttemptMirror(stub: Stub, attemptId: string): Promise<void> {
    await runInDurableObject(stub, async (_instance, state) => {
      const attempts =
        (await state.storage.get<Array<{ id: string; state: string; finished_at: string | null }>>(
          "attempts",
        )) ?? [];
      await state.storage.put(
        "attempts",
        attempts.map((a) =>
          a.id === attemptId ? { ...a, state: "RUNNING", finished_at: null } : a,
        ),
      );
    });
  }

  function spyWarns(): string[] {
    const warns: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => {
      warns.push(a.map(String).join(" "));
    });
    return warns;
  }

  // 只为本块 (e)/(e2) 的 console.warn 探针收口;(a)(b)(c) 不装 mock,restoreAllMocks 是空操作。
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("(d) 追过分片边界:封箱簿记与链、计数器镜像、D1 归档逐格对齐", async () => {
    const taskId = crypto.randomUUID();
    const stub = newStub();
    await stub.createTask({ prompt: "shard boundary" } as never, taskId);
    await writerOk(stub);
    const afterWriter = (await chainOf(stub)).events.length;

    // 一轮「起 reviewer attempt + 回报基建失败」恰好往链里追加 5 条:
    // attempt.created / attempt.exec_finished / result.captured / evidence.manifest /
    // review.unavailable。reviewer 不改任务状态,推进量因此与轮次严格线性 ——
    // 跨过封箱边界时才知道第 100 条落在哪一轮。
    const PER_ROUND = 5;
    const rounds = Math.ceil((2 * SHARD + 13 - afterWriter) / PER_ROUND);
    // 纪律:**串行**推进,一次一条 RPC。上一代这里是 112 事件 × 16 并发的 Promise.all
    // 风暴 —— 几百个 workflow 实例同时起落,正是容器 teardown 噪声把整套测试染红的来源。
    // 串行只慢不到一秒,换来的是可预测的取号序列与干净的 teardown。
    for (let i = 0; i < rounds; i++) {
      const { attempt_id } = await stub.startAttempt({
        role: "reviewer",
        idempotency_key: crypto.randomUUID(),
        ...BUDGET,
      });
      expect(
        (
          await stub.reportExecution({
            attempt_id,
            exit_code: 12,
            error: "upstream 502 from model gateway",
          })
        ).ok,
      ).toBe(true);
    }

    // ① 链:1..N 连续无重号,长度等于推进模型。封箱簿记错任何一处 —— 分片体没落盘、
    //    键没登记进 arcKeys(curShard 清空后那 100 条就此蒸发)、curShard 没裁剪
    //    (读回来一份重复)、分片键撞车(后一轮盖掉前一轮)—— 在这里都表现为缺段或重号。
    const snap = await chainOf(stub);
    const seqs = snap.events.map((e) => e.seq);
    expect(
      seqs.length,
      `链长应为 ${afterWriter} + ${rounds}×${PER_ROUND}`,
    ).toBe(afterWriter + rounds * PER_ROUND);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    const sealed = Math.floor(seqs.length / SHARD);
    expect(sealed).toBeGreaterThanOrEqual(2);

    // ② 已封箱部分:索引按 `evt:0`、`evt:1` … 升序登记,每片恰好装满分片阈值条。
    const raw = await readShardState(stub);
    expect(raw.arcKeys).toEqual(Array.from({ length: sealed }, (_, i) => `evt:${i}`));
    for (let i = 0; i < sealed; i++) {
      const key = `evt:${i}`;
      expect(raw.shards[key], `封箱分片 ${key} 必须真的落盘`).toBeDefined();
      expect((raw.shards[key] ?? []).map((e) => e.seq)).toEqual(
        Array.from({ length: SHARD }, (_, k) => i * SHARD + k + 1),
      );
    }
    // ③ 当前分片已裁剪:只剩最后一个边界之后的尾巴,不留封走那份的副本。
    expect(raw.cur.map((e) => e.seq)).toEqual(
      Array.from({ length: seqs.length % SHARD }, (_, k) => sealed * SHARD + k + 1),
    );
    // ④ 计数器镜像 = 链尾 + 1:同步只发生在 persist(临界区出口)这一次。
    expect(snap.task.next_seq).toBe(seqs.length + 1);

    // ⑤ 归档写的是拼回来的整条链:分片少一格,D1 行数就对不上链长。
    const ev = await stub.getEvidenceSummary();
    expect(
      (
        await stub.submitDecision({
          attempt_id: ev.writer_attempt_id!,
          evidence_digest: ev.binding_digest!,
          decision: "approve",
          actor: "human:test",
        })
      ).ok,
    ).toBe(true);

    const done = await chainOf(stub);
    expect(done.task.state).toBe("DONE");
    const doneSeqs = done.events.map((e) => e.seq);
    expect(doneSeqs).toEqual(doneSeqs.map((_, i) => i + 1));
    // 终态这一步至少留下 decision.recorded + task.transition 两条
    expect(doneSeqs.length).toBeGreaterThanOrEqual(seqs.length + 2);
    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS rows_total, COUNT(DISTINCT seq) AS seqs_unique FROM events WHERE task_id = ?",
    )
      .bind(taskId)
      .first<{ rows_total: number; seqs_unique: number }>();
    // 200+ 条跨分片的链撞的是真实代码路径上的 UNIQUE(task_id, seq):重号会让整批
    // 归档当场失败(prod 5489dc8a 的次生灾害),行数对不上就是缺段或静默丢事件。
    expect(rows!.rows_total).toBe(doneSeqs.length);
    expect(rows!.seqs_unique).toBe(doneSeqs.length);
    chainIntact(done.events);
  });

  it("(e) 正常轮次一条 seq_reconciled 都没有:对账不是每次追加的前置断言", async () => {
    const warns = spyWarns();
    const stub = newStub();
    await createTask(stub);
    await writerOk(stub);
    await reviewerReport(stub, { exit_code: 0, review: { decision: "approve", reason: "看着可以" } });
    const snap = await chainOf(stub);
    expect(snap.task.state).toBe("DONE");

    // 建单→执行→裁决→归档一整轮,每次 loadAll 读到的 stored 与 chain 都该逐字相等。
    // 把对账搬进 appendEvent(每追加一条就跑一次)、或让 persist 不再同步镜像,都会让
    // 这里刷出一堆 seq_reconciled:那是「计数器又偷偷变回取号来源」的信号。
    expect(warns.filter((l) => l.includes("seq_reconciled"))).toEqual([]);
  });

  it("(e2) 镜像真陈旧时:对账恰好一条,且以链为准修回来", async () => {
    const taskId = crypto.randomUUID();
    const stub = newStub();
    await stub.createTask({ prompt: "reconcile" } as never, taskId);
    const before = await chainOf(stub);
    const chain = before.events.length + 1;
    // 事件已落盘、task 行没跟上 —— 正是 prod 5489dc8a 里那个不再前进的镜像字段。
    await staleNextSeqMirror(stub, 1);

    const warns = spyWarns();
    const read = await chainOf(stub);
    const reconciled = warns.filter((l) => l.includes("seq_reconciled"));
    // 一次载入最多一条:既不许静默吞掉不一致,也不许每次读都刷。
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]).toContain(`task=${taskId}`);
    expect(reconciled[0]).toContain("stored=1");
    expect(reconciled[0]).toContain(`chain=${chain}`);
    // 以链为准:计数器只是镜像,读的时候被链覆盖。
    expect(read.task.next_seq).toBe(chain);
  });

  it("(f) 重放命中链上终态事件:attempt.state 由链反推写回,不留陈旧值", async () => {
    const cases: Array<{ exit_code: number; derived: string; error?: string }> = [
      { exit_code: 0, derived: "SUCCEEDED" },
      { exit_code: 1, derived: "FAILED" },
      { exit_code: -1, derived: "BLOCKED", error: "internal workflows error" },
    ];

    for (const c of cases) {
      const stub = newStub();
      await createTask(stub);
      const { attempt_id } = await stub.startAttempt({
        role: "writer",
        idempotency_key: crypto.randomUUID(),
        ...BUDGET,
      });
      const report = {
        attempt_id,
        exit_code: c.exit_code,
        error: c.error,
        result_text: "已按要求完成",
      };
      expect((await stub.reportExecution(report)).ok).toBe(true);

      const first = await chainOf(stub);
      expect(first.attempts.find((a) => a.id === attempt_id)!.state).toBe(c.derived);
      const seqsFirst = first.events.map((e) => e.seq);

      // 造出判据要处理的那一组合:链已前进、状态镜像陈旧。
      await staleAttemptMirror(stub, attempt_id);
      expect((await chainOf(stub)).attempts.find((a) => a.id === attempt_id)!.state).toBe("RUNNING");

      for (let i = 0; i < 4; i++) {
        const again = await stub.reportExecution(report);
        expect(again).toMatchObject({ ok: true, ignored: true });
        // 只有第一次重放走链判重这条兜底(此时状态镜像还是 RUNNING);之后状态已被
        // 反推写回,前一道 `state !== RUNNING` 守卫就把它挡住了。
        expect(again.reason).toBe(i === 0 ? "already_in_chain" : undefined);
      }

      const after = await chainOf(stub);
      // (b) 钉的是「重放不再推进链」,这里钉的是「重放把状态修回与链一致」。
      expect(after.events.map((e) => e.seq)).toEqual(seqsFirst);
      const repaired = after.attempts.find((a) => a.id === attempt_id)!;
      expect(repaired.state).toBe(c.derived);
      expect(repaired.finished_at).not.toBeNull();
      chainIntact(after.events);
    }
  });
});

/**
 * c11b 第 2 条:归档停滞必须**看得见**且**不空转**。
 *
 * prod 事实(durableObjectId 6cf8a28c7c65…):`catch { setAlarm(now + 30_000) }` 把异常吞了,
 * 于是那条 DO 每 30.07 秒醒一次、wallTime 84–132ms、outcome=ok、零日志、零异常,连续 100+ 次,
 * 而且该分支在 watchdog 续期之前 return ⇒ 它从此只做空转这一件事。
 * 这里造的就是那一形态:任务已终态、archived=false、归档**永久**失败(损坏记录新代码也修不好)。
 *
 * 断言口径按规格:**排定的时刻值**(读 storage.getAlarm()),不是真的等 30 秒。
 */
describe("归档停滞可发现性(c11b)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  interface StoredTask {
    id: string;
    state: string;
    archived: boolean;
    archive_retry_step: number;
  }

  function spyErrors() {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errors.push(a.map(String).join(" "));
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    return errors;
  }

  /** 档位到底存在哪:直接读 storage 里那一行,不看实例内存 —— 见下面的用例注释。 */
  function storedTask(stub: Stub): Promise<StoredTask | null> {
    return runInDurableObject(stub, async (_instance, state) =>
      (await state.storage.get<StoredTask>("task")) ?? null,
    );
  }

  const snapOf = (stub: Stub) => stub.getSnapshot();

  /**
   * `alarm` 是 DO 的生命周期方法,**不能**经 RPC 调(workerd:'alarm' is a reserved method),
   * 所以只能拿实例本体调。平台侧由 storage.getAlarm() 到点触发,这里复现同一次进入。
   */
  const fireAlarm = (stub: Stub) =>
    runInDurableObject(stub, async (instance) => instance.alarm());

  function scheduledAlarm(stub: Stub): Promise<number | null> {
    return runInDurableObject(stub, async (_instance, state) =>
      (await state.storage.getAlarm()) ?? null,
    );
  }

  /** 把任务拨成「已终态但归档没落地」—— 停滞分支的唯一入口条件。 */
  async function stallArchive(stub: Stub): Promise<void> {
    await runInDurableObject(stub, async (_instance, state) => {
      const task = await state.storage.get<StoredTask>("task");
      if (!task) throw new Error("fixture: task 还没建");
      await state.storage.put("task", { ...task, state: "BLOCKED", archived: false });
    });
  }

  /**
   * 让 `archive()` 对这个 attempt 的批量写**永久**失败:attempts.id 是 PRIMARY KEY,
   * 而归档只 `DELETE ... WHERE task_id = ?` 再 INSERT ⇒ 先占住那个 id(挂在另一条任务下),
   * 这一批就必然撞约束。
   *
   * 刻意不 DROP TABLE:那是整库级的破坏,同文件后面的用例会一起红,而本条要测的是
   * 「一次归档失败」,不是「schema 没了」。返回清理函数,用例结束即恢复。
   */
  async function poisonArchive(attemptId: string): Promise<() => Promise<void>> {
    const otherTaskId = crypto.randomUUID();
    const stamp = "2026-01-01T00:00:00.000Z";
    await env.DB.prepare(
      "INSERT INTO tasks (id, spec, spec_digest, state, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(otherTaskId, "{}", "0".repeat(64), "DONE", 1, stamp, stamp)
      .run();
    await env.DB.prepare(
      "INSERT INTO attempts (id, task_id, role, state, idempotency_key, tokens_used," +
        " max_model_tokens, max_wall_seconds, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(attemptId, otherTaskId, "writer", "SUCCEEDED", `${attemptId}:poison`, 0, 1, 1, stamp)
      .run();
    return async () => {
      await env.DB.prepare("DELETE FROM attempts WHERE id = ?").bind(attemptId).run();
      await env.DB.prepare("DELETE FROM tasks WHERE id = ?").bind(otherTaskId).run();
    };
  }

  /** 建一条「有链、已终态、归档会永久失败」的任务;返回 stub 与清理函数。 */
  async function stalledTaskWithChain(): Promise<{
    stub: Stub;
    taskId: string;
    unpoison: () => Promise<void>;
  }> {
    const stub = newStub();
    const taskId = crypto.randomUUID();
    await stub.createTask({ prompt: "archive stall" } as never, taskId);
    const { attempt_id } = await stub.startAttempt({
      role: "writer",
      idempotency_key: crypto.randomUUID(),
      ...BUDGET,
    });
    const unpoison = await poisonArchive(attempt_id);
    await stallArchive(stub);
    return { stub, taskId, unpoison };
  }

  it("(d) 归档失败喊出 archive_stalled,且重试排程按阶梯变大、封顶不停表", async () => {
    const errors = spyErrors();
    const { stub, taskId, unpoison } = await stalledTaskWithChain();
    try {
      // 走满一整条阶梯再多一次:证明「封顶」是停在 30min 而不是停表,也不是无限加档。
      const rounds = ARCHIVE_RETRY_LADDER_MS.length + 1;
      for (let step = 0; step < rounds; step++) {
        const before = Date.now();
        await fireAlarm(stub);
        const scheduled = await scheduledAlarm(stub);
        expect(scheduled, `第 ${step + 1} 次失败必须仍然排了 alarm(不许停表)`).not.toBeNull();
        const delay = scheduled! - before;
        // 断言的是**排定的时刻值**:±2s 足以区分 30s/2min/10min/30min,又容得下 D1 报错的耗时。
        expect(Math.abs(delay - archiveRetryDelayMs(step))).toBeLessThan(2_000);
        // 档位必须是「与链同一次原子写」带走的那个字段:做成实例属性时这一行必红
        // —— 内存里的计数器不会出现在 storage 的 task 行里。
        expect((await storedTask(stub))!.archive_retry_step).toBe(
          Math.min(step + 1, ARCHIVE_RETRY_LADDER_MS.length - 1),
        );
      }

      const stalled = errors.filter((l) => l.includes("archive_stalled"));
      expect(stalled).toHaveLength(rounds);
      expect(stalled[0]).toContain(`task=${taskId}`);
      expect(stalled[0]).toContain(`retry_in_ms=${ARCHIVE_RETRY_LADDER_MS[0]}`);
      expect(stalled[0]).toMatch(/error=\S/);
      // 阶梯的语义:同一个 reason 出现的次数与醒来的次数一样多 —— 没有一次静默轮空。
      expect(new Set(stalled.map((l) => l.slice(0, l.indexOf("attempt=")))).size).toBe(1);
    } finally {
      await unpoison();
    }
  });

  it("(d2) 归档成功即清零档位,且停滞解除后不再排重试", async () => {
    const errors = spyErrors();
    const { stub, taskId, unpoison } = await stalledTaskWithChain();
    try {
      await fireAlarm(stub);
      const stepAfterFail = (await storedTask(stub))!.archive_retry_step;
      expect(stepAfterFail).toBeGreaterThan(0);
      // 第 1 档那次排程就是「停滞还在」的证据;成功归档之后不许再排一次新的重试。
      const scheduledAtStall = await scheduledAlarm(stub);

      await unpoison();
      await fireAlarm(stub);

      const task = (await snapOf(stub))!.task;
      expect(task.archived).toBe(true);
      expect((await storedTask(stub))!.archive_retry_step).toBe(0);
      expect(await scheduledAlarm(stub)).toBe(scheduledAtStall);
      expect(errors.filter((l) => l.includes(`archive_stalled task=${taskId}`))).toHaveLength(1);
    } finally {
      await unpoison();
    }
  });

  it("(d3) 归档停滞不再挡住 watchdog:RUNNING attempt 仍被回收,且阶梯排程不被覆盖", async () => {
    const errors = spyErrors();
    const stub = newStub();
    const taskId = crypto.randomUUID();
    await stub.createTask({ prompt: "stall + watchdog" } as never, taskId);
    const { attempt_id } = await stub.startAttempt({
      role: "writer",
      idempotency_key: crypto.randomUUID(),
      ...BUDGET,
    });
    // 墙钟早已过期(created_at 拨到 1 小时前,max_wall_seconds=60 + 宽限 300s)。
    await runInDurableObject(stub, async (_instance, state) => {
      const attempts = await state.storage.get<Array<Record<string, unknown>>>("attempts");
      await state.storage.put(
        "attempts",
        attempts!.map((a) =>
          a.id === attempt_id
            ? { ...a, created_at: new Date(Date.now() - 3_600_000).toISOString() }
            : a,
        ),
      );
      const task = await state.storage.get<StoredTask>("task");
      await state.storage.put("task", { ...task!, state: "BLOCKED", archived: false });
    });
    const unpoison = await poisonArchive(attempt_id);
    try {
      const before = Date.now();
      await fireAlarm(stub);

      // 原实现在这里 return:attempt 永远停在 RUNNING,链上永远少一条 attempt.blocked。
      const snap = (await snapOf(stub))!;
      expect(snap.attempts.find((a) => a.id === attempt_id)!.state).toBe("BLOCKED");
      expect(snap.events.map((e) => e.kind)).toContain("attempt.blocked");
      // 而续期覆盖不了阶梯:terminal ⇒ nextWatchdogAlarm 返回 null ⇒ 第 1 档仍在。
      expect(Math.abs((await scheduledAlarm(stub))! - before - ARCHIVE_RETRY_LADDER_MS[0])).toBeLessThan(
        2_000,
      );
      expect(errors.some((l) => l.includes(`archive_stalled task=${taskId}`))).toBe(true);
    } finally {
      await unpoison();
    }
  });

  /**
   * 把 DO 当前分片里 seq=`seq` 的那条复制 `copies` 份(同 seq、别的 digest),复现
   * pre-c11a 并发追加被 DO 快照冻结下来的形态:prod 标本 5489dc8a 的 seq 4–9 各有 4–5 份。
   *
   * 走 storage 直写而不是造 RPC:重号快照**造不出来**(写层的 seq CAS 早在 c11a 修好了),
   * 只能作为存量损坏被注入。本棒测的正是「已经带病的存量快照怎么体面地死」。
   */
  async function duplicateSeqInSnapshot(stub: Stub, seq: number, copies: number): Promise<void> {
    await runInDurableObject(stub, async (_instance, state) => {
      type Row = {
        seq: number;
        kind: string;
        payload: unknown;
        canonical: string;
        digest: string;
        prev_digest: string | null;
        created_at: string;
      };
      const cur = (await state.storage.get<Row[]>("events:cur")) ?? [];
      const row = cur.find((e) => e.seq === seq);
      if (!row) throw new Error(`夹具:当前分片里没有 seq=${seq} 的事件`);
      await state.storage.put(
        "events:cur",
        cur.concat(
          Array.from({ length: copies }, (_, i) => ({
            ...row,
            digest: `${i}`.repeat(64),
            prev_digest: `f${i}`.repeat(32).slice(0, 64),
          })),
        ),
      );
    });
  }

  const countRows = async (sql: string, id: string): Promise<number> => {
    const row = await env.DB.prepare(sql).bind(id).first<{ n: number | string }>();
    return Number(row?.n ?? -1);
  };

  it("(d4) 快照自带重号 seq ⇒ 归档在构批之前拒收:具名日志 + D1 一条请求也没打", async () => {
    const errors = spyErrors();
    const stub = newStub();
    const taskId = crypto.randomUUID();
    await stub.createTask({ prompt: "duplicate seq snapshot" } as never, taskId);
    await stub.startAttempt({ role: "writer", idempotency_key: crypto.randomUUID(), ...BUDGET });
    await stallArchive(stub);
    await duplicateSeqInSnapshot(stub, 1, 4); // seq 1 一共 5 份

    const before = Date.now();
    await fireAlarm(stub);

    // ① 失效有名字:一行可 grep 的 archive_rejected,带 task_id 与重号清单。
    const rejected = errors.filter((l) => l.includes("archive_rejected"));
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toContain(`task=${taskId}`);
    expect(rejected[0]).toContain("reason=duplicate_seq");
    expect(rejected[0]).toContain("duplicate_seqs=1");
    expect(rejected[0]).toContain("duplicate_seq_count=1");
    expect(rejected[0]).toContain("d1_batch_constructed=false");

    // ② 不碰 D1:整批没构造,四张表一条都没写(原先每 30 分钟白打一整批)。
    expect(await countRows("SELECT COUNT(*) AS n FROM events WHERE task_id = ?", taskId)).toBe(0);
    expect(await countRows("SELECT COUNT(*) AS n FROM attempts WHERE task_id = ?", taskId)).toBe(0);
    expect(await countRows("SELECT COUNT(*) AS n FROM tasks WHERE id = ?", taskId)).toBe(0);

    // ③ 幂等处置(方案 b):阶梯算术一行未改 —— 仍然喊 archive_stalled、仍然排下一次,
    //    只是 error 里带的是**有名字的拒收**,而不是神秘的 D1 UNIQUE 报错。
    //    判据在构批之前,顺带省下 D1 往返 —— 那是另一条轴,不改变阶梯形状(§6.2.4)。
    const stalled = errors.filter((l) => l.includes("archive_stalled"));
    expect(stalled).toHaveLength(1);
    expect(stalled[0]).toContain("duplicated seq");
    expect(stalled[0]).not.toContain("UNIQUE constraint");
    expect((await storedTask(stub))!.archive_retry_step).toBe(1);
    expect(
      Math.abs((await scheduledAlarm(stub))! - before - ARCHIVE_RETRY_LADDER_MS[0]),
    ).toBeLessThan(2_000);

    // ④ 没有新状态:任务仍是 BLOCKED、仍未归档。拒收不改权威,只拒绝投影。
    const snap = (await snapOf(stub))!;
    expect(snap.task.state).toBe("BLOCKED");
    expect(snap.task.archived).toBe(false);
    expect(snap.events.length).toBeGreaterThan(1);
  });

  it("(d5) 干净快照回归:同一条 alarm 归档路径行为一字未变(全量落 D1、置位、零拒收日志)", async () => {
    const errors = spyErrors();
    const stub = newStub();
    const taskId = crypto.randomUUID();
    await stub.createTask({ prompt: "clean snapshot" } as never, taskId);
    await stub.startAttempt({ role: "writer", idempotency_key: crypto.randomUUID(), ...BUDGET });
    await stallArchive(stub);
    const doSeqs = (await snapOf(stub))!.events.map((e) => e.seq);
    expect(doSeqs.length).toBeGreaterThan(0);

    await fireAlarm(stub);

    const after = (await snapOf(stub))!;
    expect(after.task.archived).toBe(true);
    expect(after.events.map((e) => e.seq)).toEqual(doSeqs);
    expect((await storedTask(stub))!.archive_retry_step).toBe(0);
    const rows = await env.DB.prepare("SELECT seq FROM events WHERE task_id = ? ORDER BY seq")
      .bind(taskId)
      .all<{ seq: number }>();
    expect(rows.results.map((r) => r.seq)).toEqual(doSeqs);
    expect(await countRows("SELECT COUNT(*) AS n FROM attempts WHERE task_id = ?", taskId)).toBe(1);
    // 判据是「有重号才拒」,不是「归档前先自查一遍并抱怨」:干净链必须零噪声。
    expect(errors.filter((l) => l.includes("archive_rejected"))).toEqual([]);
    expect(errors.filter((l) => l.includes("archive_stalled"))).toEqual([]);
  });
});

