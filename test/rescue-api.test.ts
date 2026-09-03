import { beforeAll, describe, expect, it } from "vitest";
import { createExecutionContext, env } from "cloudflare:test";
import worker from "../src/index";
import { TaskSession } from "../src/control/session";
import { putArtifact, sha256Hex, writeManifest, type ArtifactRef } from "../src/audit/evidence";
import type { BaseReport } from "../src/types";
import { buildAttemptManifest, type ExecOutcome } from "../src/exec/workflow";
import { applyMigrations } from "./d1";

/**
 * BLOCKED 抢救读面(`GET /api/tasks/:id/rescue`)的 handler 级测试。
 *
 * 这一棒的存在理由:c12 让被墙钟击杀的 writer 仍能导出差量,但那份 manifest 从不进入
 * `current_evidence`(M7 失败门禁),于是 `GET /candidate` 对 BLOCKED 任务恒 404 ——
 * 字段 `patch_complete` / `patch_incomplete_reason` 在 BLOCKED 路径上**没有读者**。
 * 这里就是把「接线真的接上了」钉成机器事实。
 *
 * 关键手法(修掉 c12 的反模式「消费者测试配合成 fixture、从不与生产者配对」):
 * 证据一律经**真实生产者** `buildAttemptManifest` + `writeManifest` 材质化并落 R2,
 * 再由 handler 读回。因此以下三处改动会让本文件变红:
 * - V6:workflow 构造 manifest 时不写 patch_complete / 原因;
 * - V10:index.ts 调用点不把该字段喂给读模型;
 * - V11:`?format=patch` 的 x-patch-complete 头被去掉。
 *
 * fixture 形状照真实标本(p4 受控死亡探针,task 2871575a / attempt 5a02c273):
 * `patch_complete=false` + `patch_incomplete_reason="budget_abort(exit=55)"` +
 * 非空 patch + 已固定基线。
 */

const TOKEN = env.WORKER_API_TOKEN;
const BASE_SHA = "9".repeat(40);
const PATCH_TEXT =
  "diff --git a/src/control/session.ts b/src/control/session.ts\n" +
  "@@ -708,6 +708,9 @@\n" +
  "+// 在途编辑:wall clock 到期时正在写的那一半\n";

interface ErrorBody {
  error?: { type?: string };
}

async function request(
  path: string,
  init: { method?: string; body?: unknown; token?: string | null } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (init.token !== null) headers.authorization = `Bearer ${init.token ?? TOKEN}`;
  return worker.fetch(
    new Request(`https://example.com${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
    env,
    createExecutionContext(),
  );
}

const ns = () => env.TASK_SESSION as DurableObjectNamespace<TaskSession>;
const stubFor = (taskId: string) => ns().get(ns().idFromName(taskId));

/** 执行面在预算到期那一刻交回的全部材料(与 collectQwenAttempt → slim 的产物同形)。 */
function killedWriterRun(patch: ArtifactRef): Pick<
  ExecOutcome,
  "transcript" | "stderr" | "patch" | "patchIncompleteReason" | "base"
> {
  const base: BaseReport = { sha: BASE_SHA, source: "resolved_default" };
  return {
    transcript: { key: "attempts/transcript", digest: "t".repeat(64), size: 128 },
    stderr: { key: "attempts/stderr", digest: "s".repeat(64), size: 0 },
    patch,
    patchIncompleteReason: "budget_abort(exit=55)",
    base,
  };
}

/**
 * @param exportPatch 执行面是否导出了差量(零差量死亡 = false)
 */
async function seedBlockedWriterKilled(
  opts: { exportPatch?: boolean; reportManifest?: boolean } = {},
): Promise<{ taskId: string; attemptId: string; manifestKey: string | null }> {
  const exportPatch = opts.exportPatch !== false;
  const taskId = crypto.randomUUID();
  const stub = stubFor(taskId);
  await stub.createTask({ prompt: "rescue", repo_url: "https://github.com/o/r" } as never, taskId);
  const { attempt_id } = await stub.startAttempt({
    role: "writer",
    idempotency_key: `${taskId}:attempt:1`,
    max_model_tokens: 1000,
    max_wall_seconds: 2100,
  });

  const patch = exportPatch
    ? await putArtifact(env.ARTIFACTS, PATCH_TEXT, `attempts/${attempt_id}`)
    : undefined;
  const run = exportPatch ? killedWriterRun(patch!) : { ...killedWriterRun(patch!), patch: undefined };
  const manifest = buildAttemptManifest(
    { task_id: taskId, attempt_id, role: "writer", spec_digest: "d".repeat(64), model: "qwen" },
    run,
    new Date().toISOString(),
  );
  const manifestRef = await writeManifest(env.EVIDENCE, manifest);

  const res = await stub.reportExecution({
    attempt_id,
    exit_code: 55,
    error: "qwen exited with code 55 (wall clock budget exhausted)",
    result_text: "正在改 session.ts",
    manifest_key: opts.reportManifest === false ? null : manifestRef.key,
    manifest_digest: opts.reportManifest === false ? null : manifestRef.digest,
    patch_digest: patch?.digest ?? null,
    base: { sha: BASE_SHA, source: "resolved_default" },
  });
  expect(res.ok).toBe(true);
  return { taskId, attemptId: attempt_id, manifestKey: manifestRef.key };
}

beforeAll(applyMigrations);

describe("GET /api/tasks/:id/rescue:BLOCKED 任务的差量取得到(handler 级)", () => {
  it("被击杀的 writer 差量可读:原因、不完整、不可应用,且照真实标本的形状", async () => {
    const { taskId, attemptId } = await seedBlockedWriterKilled();
    const res = await request(`/api/tasks/${taskId}/rescue`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown> & { warnings: string[] };

    expect(body.rescued).toBe(true);
    expect(body.pinned).toBe(false);
    expect(body.state).toBe("BLOCKED");
    expect(body.writer_attempt_id).toBe(attemptId);
    // 接线三点的正面证据:字段来自真实生产者,再经 handler 喂进读模型
    expect(body.patch_complete).toBe(false);
    expect(body.patch_incomplete_reason).toBe("budget_abort(exit=55)");
    expect(body.status).toBe("held_for_human");
    expect(body.verified).toBe(false);
    expect(body.safe_to_apply).toBe(false);
    // 抢救视图绝不冒充审批口径
    expect(body.binding_digest).toBeNull();
    expect((body.patch as { size: number }).size).toBe(new TextEncoder().encode(PATCH_TEXT).length);
    expect((body.base as { sha: string }).sha).toBe(BASE_SHA);
    const joined = body.warnings.join("\n");
    expect(joined).toContain("抢救视图");
    expect(joined).toContain("补丁不完整(budget_abort(exit=55))");
    expect(joined).toContain("不是它自认完成的候选");
  });

  it("生产者侧取证:落进 R2 的 manifest 字节自称不完整(钉住 buildAttemptManifest)", async () => {
    const { taskId, manifestKey } = await seedBlockedWriterKilled();
    const obj = await env.EVIDENCE.get(manifestKey!);
    expect(obj).not.toBeNull();
    const raw = await obj!.text();
    expect(raw).toContain('"patch_complete": false');
    expect(raw).toContain('"patch_incomplete_reason": "budget_abort(exit=55)"');
    // 判据仍是 present ⇔ incomplete:不写恒真的 patch_complete: true
    expect(raw).not.toContain('"patch_complete": true');
    // 读面报出的 patch 引用就是这份 manifest 里的那一个:同源,不是各说各话
    const manifest = JSON.parse(raw) as { patch: ArtifactRef };
    const view = (await (await request(`/api/tasks/${taskId}/rescue`)).json()) as { patch: ArtifactRef };
    expect(view.patch.key).toBe(manifest.patch.key);
    expect(view.patch.digest).toBe(manifest.patch.digest);
  });

  it("?format=patch 下载:逐字节校验后下发,状态全进响应头", async () => {
    const { taskId } = await seedBlockedWriterKilled();
    const res = await request(`/api/tasks/${taskId}/rescue?format=patch`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe(PATCH_TEXT);
    const digest = await sha256Hex(PATCH_TEXT);
    // V11 的钉子:只看头也必须知道拿到的是什么
    expect(res.headers.get("x-patch-complete")).toBe("false");
    expect(res.headers.get("x-safe-to-apply")).toBe("false");
    expect(res.headers.get("x-verified")).toBe("false");
    expect(res.headers.get("x-rescued")).toBe("true");
    expect(res.headers.get("x-pinned")).toBe("false");
    expect(res.headers.get("x-patch-digest")).toBe(digest);
    expect(res.headers.get("x-base-sha")).toBe(BASE_SHA);
    expect(res.headers.get("content-disposition")).toContain(`task-${taskId}-${digest.slice(0, 12)}.patch`);
  });
});

describe("rescue 的反向用例:不造候选、不抢口径、不交出未校验字节", () => {
  it("反向一:BLOCKED 但没有回报证据 → 404 no_rescue_yet,不给假视图", async () => {
    const { taskId } = await seedBlockedWriterKilled({ reportManifest: false });
    const res = await request(`/api/tasks/${taskId}/rescue`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrorBody).error?.type).toBe("no_rescue_yet");
  });

  it("反向二:零差量死亡(qwen 一分钟没写文件)→ 视图如实没有补丁,下载 404 no_patch", async () => {
    const { taskId } = await seedBlockedWriterKilled({ exportPatch: false });
    const res = await request(`/api/tasks/${taskId}/rescue`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { patch: unknown; patch_complete: boolean; warnings: string[] };
    expect(body.patch).toBeNull();
    // 没有 patch 可挂,原因不得凭空写进 manifest(workflow 的双条件判据)
    expect(body.patch_complete).toBe(true);
    expect(body.warnings.join("")).toContain("没有可下载的补丁文件");

    const dl = await request(`/api/tasks/${taskId}/rescue?format=patch`);
    expect(dl.status).toBe(404);
    expect(((await dl.json()) as ErrorBody).error?.type).toBe("no_patch");
  });

  it("反向三:读 rescue 不动审批口径 —— /candidate 与 /evidence 仍 404,current_evidence 仍空", async () => {
    const { taskId } = await seedBlockedWriterKilled();
    expect((await request(`/api/tasks/${taskId}/rescue`)).status).toBe(200);

    const candidate = await request(`/api/tasks/${taskId}/candidate`);
    expect(candidate.status).toBe(404);
    expect(((await candidate.json()) as ErrorBody).error?.type).toBe("no_candidate_yet");

    const evidence = await request(`/api/tasks/${taskId}/evidence`);
    expect(evidence.status).toBe(404);
    expect(((await evidence.json()) as ErrorBody).error?.type).toBe("no_evidence_yet");

    const snap = (await (await request(`/api/tasks/${taskId}`)).json()) as {
      task: { state: string; awaiting_human: boolean; current_evidence: unknown };
    };
    expect(snap.task.state).toBe("BLOCKED");
    expect(snap.task.awaiting_human).toBe(true);
    expect(snap.task.current_evidence).toBeNull();

    // 审批门禁一字未动:抢救产物没有可核对的绑定,approve 必须被拒
    const approve = await request(`/api/tasks/${taskId}/approve`, {
      method: "POST",
      body: { decision: "approve", attempt_id: "att", evidence_digest: "x".repeat(64) },
    });
    expect(approve.ok).toBe(false);
  });

  it("反向四:非 BLOCKED 任务不开放 rescue;字节被改动则拒绝下发", async () => {
    const taskId = crypto.randomUUID();
    const stub = stubFor(taskId);
    await stub.createTask({ prompt: "running" } as never, taskId);
    const running = await request(`/api/tasks/${taskId}/rescue`);
    expect(running.status).toBe(404);
    expect(((await running.json()) as ErrorBody).error?.type).toBe("not_blocked");

    const blocked = await seedBlockedWriterKilled();
    const obj = await env.EVIDENCE.get(blocked.manifestKey!);
    expect(obj).not.toBeNull();
    const manifest = (await obj!.json()) as { patch: ArtifactRef };
    await env.ARTIFACTS.put(manifest.patch.key, "tampered bytes");
    const tampered = await request(`/api/tasks/${blocked.taskId}/rescue?format=patch`);
    expect(tampered.status).toBe(500);
    const err = (await tampered.json()) as { error: { type: string; actual: string } };
    expect(err.error.type).toBe("integrity_error");
    expect(err.error.actual).toBe(await sha256Hex("tampered bytes"));
  });
});
