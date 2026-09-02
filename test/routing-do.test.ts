import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import type { TaskSession } from "../src/control/session";
import { applyMigrations } from "./d1";
import {
  ENV_TRANSIENT_VERIFY_STDERR_TAIL,
  QUALITY_VERIFY_STDERR_TAIL,
  envTransientReport,
  verifyReport,
} from "./fixtures/env-transient-report";

/**
 * 路由分流的权威侧测试(M9.5②③):分类器接进 TaskSession 的两个返工决策点之后,
 * 「预算到期 → BLOCKED 且不派返工」「环境签名 → 只多一条事件、路由逐字段照旧」
 * 「质量失败 → 语义不变」三件事必须钉在真 DO + 真事件链上。
 *
 * 2026-09-02 的死亡螺旋正是这三件事里少了第一件:writer 一次成功 → verifier 因沙箱
 * 出站 ECONNRESET 落 verify exit 1(apply 0,补丁完好)→ 当质量失败全量返工 ×2 →
 * 两轮各跑满 2400s 撞 exit 55 → 55 又被当失败再返工 → 熔断 BLOCKED。
 */

const ns = () => env.TASK_SESSION as DurableObjectNamespace<TaskSession>;
const BUDGET = { max_model_tokens: 1000, max_wall_seconds: 60 };

type Stub = ReturnType<typeof newStub>;
type Snapshot = NonNullable<Awaited<ReturnType<Stub["getSnapshot"]>>>;

function newStub() {
  return ns().get(ns().newUniqueId());
}

function kinds(snap: Snapshot): string[] {
  return snap.events.map((e) => e.kind);
}

function payloads(snap: Snapshot, kind: string): Array<Record<string, unknown>> {
  return snap.events.filter((e) => e.kind === kind).map((e) => JSON.parse(e.payload));
}

function chainIntact(events: Snapshot["events"]): void {
  for (let i = 1; i < events.length; i++) {
    expect(events[i].prev_digest).toBe(events[i - 1].digest);
  }
  expect(events[0].prev_digest).toBeNull();
}

async function createTask(stub: Stub, spec: Record<string, unknown> = { prompt: "routing" }): Promise<string> {
  const taskId = crypto.randomUUID();
  await stub.createTask(spec as never, taskId);
  return taskId;
}

/** 起一个 attempt 并按给定要素回报终态。 */
async function report(
  stub: Stub,
  args: {
    role: "writer" | "verifier";
    exit_code: number;
    result_text?: string | null;
    error?: string;
    verify_context?: { writer_manifest_key: string };
    manifest_key?: string;
    manifest_digest?: string;
    patch_digest?: string | null;
  },
): Promise<string> {
  const { attempt_id } = await stub.startAttempt({
    role: args.role,
    idempotency_key: crypto.randomUUID(),
    verify_context: args.verify_context,
    ...BUDGET,
  });
  const res = await stub.reportExecution({
    attempt_id,
    exit_code: args.exit_code,
    error: args.error,
    result_text: args.result_text ?? "已按要求完成",
    manifest_key: args.manifest_key ?? `manifests/task/${args.role}/${attempt_id}.json`,
    manifest_digest: args.manifest_digest ?? `digest-${attempt_id}`,
    patch_digest: args.patch_digest ?? null,
  });
  expect(res.ok).toBe(true);
  return attempt_id;
}

/** writer 成功并钉住候选(此后 verifier 的结论才会被采信)。返回其 manifest key。 */
async function writerSucceeds(stub: Stub): Promise<string> {
  const attempt_id = await report(stub, { role: "writer", exit_code: 0, patch_digest: "candidate-1" });
  return `manifests/task/writer/${attempt_id}.json`;
}

function blockedReason(snap: Snapshot): string {
  const transitions = payloads(snap, "task.transition").filter((p) => p.to === "BLOCKED");
  expect(transitions).toHaveLength(1);
  return String(transitions[0].reason);
}

beforeAll(applyMigrations);

describe("路由分流:预算到期(enforce 档)", () => {
  it("writer exit 55 → 任务 BLOCKED,且没有新的 writer attempt", async () => {
    const stub = newStub();
    await createTask(stub);
    const attempt_id = await report(stub, { role: "writer", exit_code: 55 });

    const snap = await stub.getSnapshot();
    expect(kinds(snap!)).toContain("route_decision");
    expect(payloads(snap!, "route_decision")).toEqual([
      {
        attempt_id,
        role: "writer",
        exit_code: 55,
        outcome_kind: "budget_abort",
        rule: "writer_exit_55_budget_abort",
        action: "blocked",
        enforced: true,
      },
    ]);

    expect(snap!.task.state).toBe("BLOCKED");
    expect(snap!.task.awaiting_human).toBe(true);
    expect(snap!.attempts.filter((a) => a.role === "writer")).toHaveLength(1);
    // 死亡螺旋的那一步:绝不再派同规格返工
    expect(kinds(snap!)).not.toContain("writer.rework_scheduled");
    expect(kinds(snap!)).not.toContain("verify.requested");
    expect(kinds(snap!)).not.toContain("review.requested");
    // BLOCKED 的结论必须自带语义与旋钮,且说清不是 token 预算
    const reason = blockedReason(snap!);
    expect(reason).toContain("budget_abort");
    expect(reason).toContain("exit 55");
    expect(reason).toContain("不是 token 预算");
    expect(snap!.attempts.find((a) => a.id === attempt_id)!.state).toBe("FAILED");
    chainIntact(snap!.events);
  });

  it("writer exit 53 → BLOCKED,reason 与 55 可分辨(要调的旋钮不同)", async () => {
    const stub = newStub();
    await createTask(stub);
    await report(stub, { role: "writer", exit_code: 53 });

    const snap = await stub.getSnapshot();
    const [decision] = payloads(snap!, "route_decision");
    expect(decision).toMatchObject({
      outcome_kind: "budget_turns",
      rule: "writer_exit_53_session_turns",
      action: "blocked",
      enforced: true,
    });
    expect(snap!.task.state).toBe("BLOCKED");
    expect(snap!.attempts.filter((a) => a.role === "writer")).toHaveLength(1);
    const reason = blockedReason(snap!);
    expect(reason).toContain("budget_turns");
    expect(reason).toContain("--max-session-turns");
    expect(reason).not.toContain("budget_abort");
    chainIntact(snap!.events);
  });

  it("返工轮的 writer 同样分流:预算到期不再往下烧第 3 轮", async () => {
    const stub = newStub();
    await createTask(stub);
    // 第 1 轮:普通质量失败 → 照旧返工
    await report(stub, { role: "writer", exit_code: 1 });
    let snap = await stub.getSnapshot();
    expect(snap!.attempts.filter((a) => a.role === "writer")).toHaveLength(2);
    expect(kinds(snap!)).toContain("writer.rework_scheduled");

    // 第 2 轮:跑满墙钟 → 停下,而不是再开第 3 轮
    const second = snap!.attempts.filter((a) => a.role === "writer")[1].id;
    await stub.reportExecution({
      attempt_id: second,
      exit_code: 55,
      result_text: "",
      manifest_key: `manifests/task/writer/${second}.json`,
      manifest_digest: `digest-${second}`,
    });

    snap = await stub.getSnapshot();
    expect(snap!.task.state).toBe("BLOCKED");
    expect(snap!.attempts.filter((a) => a.role === "writer")).toHaveLength(2);
    expect(kinds(snap!).filter((k) => k === "writer.rework_scheduled")).toHaveLength(1);
    expect(payloads(snap!, "route_decision").at(-1)).toMatchObject({
      attempt_id: second,
      outcome_kind: "budget_abort",
    });
    chainIntact(snap!.events);
  });
});

describe("路由分流:质量失败语义不变(enforce 兜底档)", () => {
  it("writer exit 1 → 照旧返工,只多一条 quality 分类", async () => {
    const stub = newStub();
    await createTask(stub);
    const attempt_id = await report(stub, { role: "writer", exit_code: 1 });

    const snap = await stub.getSnapshot();
    expect(payloads(snap!, "route_decision")).toEqual([
      {
        attempt_id,
        role: "writer",
        exit_code: 1,
        outcome_kind: "quality",
        rule: "quality_fallback",
        action: "rework",
        enforced: true,
      },
    ]);
    expect(snap!.task.state).toBe("RUNNING");
    expect(snap!.attempts.filter((a) => a.role === "writer")).toHaveLength(2);
    expect(kinds(snap!)).toContain("writer.rework_scheduled");
    chainIntact(snap!.events);
  });
});

describe("路由分流:环境签名(shadow 档,只发事件)", () => {
  /** writer 成功 → verifier 按给定 stderr_tail 失败,返回终态快照。 */
  async function verifyFails(stderrTail: string): Promise<{ snap: Snapshot; verifierId: string }> {
    const stub = newStub();
    const taskId = await createTask(stub, { prompt: "routing env", repo_url: "https://example.invalid/r.git" });
    const writerKey = await writerSucceeds(stub);
    // 报告里的 attempt_id 只是报告自身字段:DO 侧的血缘核对认的是 writer_manifest_key
    const verifierId = await report(stub, {
      role: "verifier",
      exit_code: 1,
      verify_context: { writer_manifest_key: writerKey },
      result_text: verifyReport({
        taskId,
        attemptId: "verifier-report",
        verify: { exit_code: 1, stdout_tail: "", stderr_tail: stderrTail },
      }),
    });
    return { snap: (await stub.getSnapshot())!, verifierId };
  }

  it("2026-09-02 标本 → 记 env_transient(enforced=false),路由照旧返工", async () => {
    const { snap } = await verifyFails(ENV_TRANSIENT_VERIFY_STDERR_TAIL);

    const [decision] = payloads(snap, "route_decision");
    expect(decision).toMatchObject({
      role: "verifier",
      exit_code: 1,
      outcome_kind: "env_transient",
      rule: "verifier_env_network_signature",
      action: "none",
      enforced: false,
    });

    // shadow 的定义:分类之外什么都不变
    expect(snap.task.state).toBe("RUNNING");
    expect(kinds(snap)).toContain("verify.rework_scheduled");
    expect(snap.attempts.filter((a) => a.role === "writer")).toHaveLength(2);
    expect(snap.attempts.filter((a) => a.role === "verifier")).toHaveLength(1);
    chainIntact(snap.events);
  });

  it("环境签名与普通质量失败的路由行为逐字段一致(只有分类不同)", async () => {
    const envCase = await verifyFails(ENV_TRANSIENT_VERIFY_STDERR_TAIL);
    const qualityCase = await verifyFails(QUALITY_VERIFY_STDERR_TAIL);

    // 刻意不含 route_decision 自己的 outcome_kind/rule/action/enforced:那正是被允许
    // 不同的部分(下面单独钉)。也不含 rework 事件的 instructions —— 里面带的是各自
    // 报告的 stderr 原文,本就该不同;这里要钉的是「处置动作」没变。
    const shape = (snap: Snapshot) => ({
      kinds: kinds(snap),
      state: snap.task.state,
      awaiting_human: snap.task.awaiting_human,
      writers: snap.attempts.filter((a) => a.role === "writer").length,
      verifiers: snap.attempts.filter((a) => a.role === "verifier").length,
      reworkCount: payloads(snap, "verify.rework_scheduled").length,
      reworkFields: payloads(snap, "verify.rework_scheduled").map((p) => Object.keys(p).sort()),
      reworkReason: payloads(snap, "verify.rework_scheduled").map((p) => p.reason),
      reworkAttemptNumber: payloads(snap, "verify.rework_scheduled").map((p) => p.attempt_number),
      decisionCount: payloads(snap, "route_decision").length,
    });

    expect(shape(envCase.snap)).toEqual(shape(qualityCase.snap));
    // shadow 档的「不同」只许发生在分类记录上:env 不主张动作,quality 主张返工
    expect(payloads(envCase.snap, "route_decision")[0]).toMatchObject({
      outcome_kind: "env_transient",
      action: "none",
      enforced: false,
    });
    expect(payloads(qualityCase.snap, "route_decision")[0]).toMatchObject({
      outcome_kind: "quality",
      action: "rework",
      enforced: true,
    });
    // 两边都真的返了工(shadow 不改变路由 = 环境签名这一轮仍是新 writer)
    expect(qualityCase.snap.attempts.filter((a) => a.role === "writer")).toHaveLength(2);
  });

  it("被到期击杀的 verifier(-1)也留分类:有签名记 env_transient,路由行为不变", async () => {
    const stub = newStub();
    const taskId = await createTask(stub, { prompt: "routing kill", repo_url: "https://example.invalid/r.git" });
    const writerKey = await writerSucceeds(stub);
    const verifierId = await report(stub, {
      role: "verifier",
      exit_code: 1,
      verify_context: { writer_manifest_key: writerKey },
      result_text: envTransientReport({ taskId, attemptId: "verifier-report" }),
    });
    // 第二个 verifier:workflow 的击杀兜底回报(§13.19 的 longrun_wall_exceeded 形态)
    const killed = await stub.startAttempt({
      role: "verifier",
      idempotency_key: crypto.randomUUID(),
      verify_context: { writer_manifest_key: writerKey },
      ...BUDGET,
    });
    await stub.reportExecution({
      attempt_id: killed.attempt_id,
      exit_code: -1,
      error: "longrun_wall_exceeded role=verifier",
      result_text: verifyReport({
        taskId,
        attemptId: killed.attempt_id,
        verify: { exit_code: -1, stdout_tail: "", stderr_tail: ENV_TRANSIENT_VERIFY_STDERR_TAIL },
      }),
    });

    const snap = (await stub.getSnapshot())!;
    const decisions = payloads(snap, "route_decision");
    expect(decisions.at(0)).toMatchObject({ attempt_id: verifierId, outcome_kind: "env_transient" });
    expect(decisions.at(-1)).toMatchObject({
      attempt_id: killed.attempt_id,
      role: "verifier",
      exit_code: -1,
      outcome_kind: "env_transient",
      action: "none",
      enforced: false,
    });
    // 击杀回报仍按既有语义进返工闭环
    expect(kinds(snap)).toContain("attempt.blocked");
    expect(kinds(snap)).toContain("verify.rework_scheduled");
    chainIntact(snap.events);
  });

  it("没有报告的 workflow 异常回报(-1 且无 result_text)→ quality,仍进返工闭环", async () => {
    const stub = newStub();
    await createTask(stub, { prompt: "routing workflow error", repo_url: "https://example.invalid/r.git" });
    const writerKey = await writerSucceeds(stub);
    const { attempt_id } = await stub.startAttempt({
      role: "verifier",
      idempotency_key: crypto.randomUUID(),
      verify_context: { writer_manifest_key: writerKey },
      ...BUDGET,
    });
    await stub.reportExecution({
      attempt_id,
      exit_code: -1,
      error: "Attempt failed due to internal workflows error",
    });

    const snap = await stub.getSnapshot();
    expect(payloads(snap!, "route_decision").at(-1)).toMatchObject({
      attempt_id,
      role: "verifier",
      exit_code: -1,
      outcome_kind: "quality",
      rule: "quality_fallback",
      action: "rework",
      enforced: true,
    });
    expect(kinds(snap!)).toContain("verify.rework_scheduled");
    expect(snap!.task.state).toBe("RUNNING");
    chainIntact(snap!.events);
  });
});

describe("route_decision 事件真实入链可读", () => {
  it("seq 单调、digest 链接、终态归档后 D1 events 里能按 kind 查回原文", async () => {
    const stub = newStub();
    const taskId = await createTask(stub);
    const attempt_id = await report(stub, { role: "writer", exit_code: 55 });

    const snap = await stub.getSnapshot();
    const events = snap!.events;
    const idx = events.findIndex((e) => e.kind === "route_decision");
    expect(idx).toBeGreaterThan(0);
    // 分类发生在 writer.failed 之后、task.transition(BLOCKED) 之前:先记账再改路由
    expect(events[idx - 1].kind).toBe("writer.failed");
    expect(events[idx + 1].kind).toBe("task.transition");
    expect(events.map((e) => e.seq)).toEqual([...new Set(events.map((e) => e.seq))].sort((x, y) => x - y));
    chainIntact(events);

    // BLOCKED 即归档:D1 的读端(§13 的 /admin/events 数据源)必须取得到同一条
    const rows = await env.DB.prepare(
      "SELECT seq, kind, payload, digest, prev_digest FROM events WHERE task_id = ? AND kind = 'route_decision' ORDER BY seq",
    )
      .bind(taskId)
      .all<{ seq: number; kind: string; payload: string; digest: string; prev_digest: string | null }>();
    expect(rows.results).toHaveLength(1);
    const canonical = JSON.parse(rows.results[0].payload) as {
      task_id: string;
      kind: string;
      payload: Record<string, unknown>;
    };
    expect(canonical.task_id).toBe(taskId);
    expect(canonical.kind).toBe("route_decision");
    expect(canonical.payload).toEqual({
      attempt_id,
      role: "writer",
      exit_code: 55,
      outcome_kind: "budget_abort",
      rule: "writer_exit_55_budget_abort",
      action: "blocked",
      enforced: true,
    });
    expect(rows.results[0].digest).toBe(events[idx].digest);
    expect(rows.results[0].prev_digest).toBe(events[idx].prev_digest);
  });
});
