import type { Env, TaskSpec } from "./types";
import { handleQueue } from "./exec/queue";
import { TaskSession } from "./control/session";
import type { EvidenceManifest } from "./audit/evidence";
import { sha256Hex } from "./audit/evidence";

export { AttemptWorkflow } from "./exec/workflow";
export { Sandbox } from "@cloudflare/sandbox";
export { TaskSession } from "./control/session";

function unauthorized(): Response {
  return Response.json({ error: { type: "unauthorized" } }, { status: 401 });
}

function landingHtml(env: Env): string {
  const model = env.DEFAULT_MODEL ?? "unknown";
  const envName = env.ENVIRONMENT ?? "unknown";
  const base = env.PUBLIC_URL ?? "";
  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>cloud-agent</title>
<style>
  body { font-family: -apple-system, "SF Mono", Menlo, monospace; background:#0b0f14; color:#e6edf3; margin:0; padding:48px 24px; }
  main { max-width:720px; margin:0 auto; }
  h1 { font-size:22px; margin:0 0 8px; }
  .sub { color:#8b949e; margin-bottom:32px; }
  .card { background:#161b22; border:1px solid #30363d; border-radius:10px; padding:20px; margin-bottom:16px; }
  .k { color:#7ee787; }
  .v { color:#e6edf3; }
  a { color:#58a6ff; text-decoration:none; }
  a:hover { text-decoration:underline; }
  code { background:#21262d; padding:2px 6px; border-radius:4px; font-size:13px; }
  .endpoints dt { font-family:monospace; color:#d2a8ff; margin-top:12px; }
  .endpoints dd { margin-left:16px; color:#c9d1d9; }
</style>
</head>
<body>
<main>
  <h1>cloud-agent</h1>
  <div class="sub">Coding agent on Cloudflare Workers · TaskSession DO authority · Durable Workflows · R2 evidence</div>

  <div class="card">
    <div><span class="k">environment:</span> <span class="v">${envName}</span></div>
    <div><span class="k">default_model:</span> <span class="v">${model}</span></div>
    <div><span class="k">base_url:</span> <span class="v">${base}</span></div>
    <div><span class="k">healthz:</span> <a href="/healthz">/healthz</a></div>
  </div>

  <div class="card endpoints">
    <strong>API</strong>
    <dl>
      <dt>GET /healthz</dt><dd>公开,返回 <code>{"ok":true}</code></dd>
      <dt>POST /tasks</dt><dd>创建任务(需要 <code>Authorization: Bearer WORKER_API_TOKEN</code>)</dd>
      <dt>GET /tasks/:id</dt><dd>查询任务、attempts 与事件链(需鉴权)</dd>
      <dt>GET /tasks/:id/result</dt><dd>读取 agent 最终答案(纯文本,需鉴权)</dd>
      <dt>POST /tasks/:id/approve</dt><dd>审批(必须带 attempt_id + evidence_digest,需鉴权)</dd>
      <dt>GET /tasks/:id/evidence</dt><dd>最新 attempt 的 evidence manifest + binding_digest(需鉴权)</dd>
      <dt>GET /tasks/:id/attempts/:aid/transcript</dt><dd>attempt 的 transcript 原文(需鉴权)</dd>
      <dt>GET /tasks/:id/attempts/:aid/verify</dt><dd>attempt 的 verify 输出(需鉴权)</dd>
      <dt>GET /admin/chain-check</dt><dd>校验 D1 归档的事件 hash chain(需鉴权)</dd>
    </dl>
  </div>

  <div class="card">
    <strong>CLI 示例</strong>
    <pre style="overflow:auto"><code>curl -X POST ${base}/tasks \\
  -H "Authorization: Bearer $WORKER_API_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"spec":{"prompt":"在 /workspace 写一个 hello.py 并运行"}}'</code></pre>
  </div>
</main>
</body>
</html>`;
}

function checkApiToken(req: Request, env: Env): boolean {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  return !!env.WORKER_API_TOKEN && token === env.WORKER_API_TOKEN;
}

async function handleCreateTask(req: Request, env: Env): Promise<Response> {
  const body = (await req.json()) as {
    spec: TaskSpec;
    model?: string;
    budget?: { max_model_tokens?: number; max_wall_seconds?: number };
  };
  if (!body?.spec?.prompt) {
    return Response.json({ error: { type: "invalid_spec", detail: "spec.prompt required" } }, { status: 400 });
  }

  const taskId = crypto.randomUUID();
  const session = TaskSession.from(env, taskId);
  await session.createTask(body.spec, taskId);
  const attempt = await session.startAttempt({
    role: "writer",
    idempotency_key: `${taskId}:attempt:1`,
    max_model_tokens: body.budget?.max_model_tokens ?? Number(env.DEFAULT_MAX_MODEL_TOKENS),
    max_wall_seconds: body.budget?.max_wall_seconds ?? Number(env.DEFAULT_MAX_WALL_SECONDS),
  });

  return Response.json({
    task_id: taskId,
    attempt_id: attempt.attempt_id,
    workflow: attempt.workflow_instance_id,
  });
}

async function handleGetTask(env: Env, taskId: string): Promise<Response> {
  const snap = await TaskSession.from(env, taskId).getSnapshot();
  if (!snap) return Response.json({ error: { type: "not_found" } }, { status: 404 });
  return Response.json(snap);
}

async function handleGetResult(env: Env, taskId: string): Promise<Response> {
  const res = await TaskSession.from(env, taskId).getResultText();
  if (!res.found) return Response.json({ error: { type: "not_found" } }, { status: 404 });
  if (res.result_text === null) {
    return Response.json({ error: { type: "no_result_yet" } }, { status: 404 });
  }
  return new Response(res.result_text, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

async function handleGetEvidence(env: Env, taskId: string): Promise<Response> {
  const res = await TaskSession.from(env, taskId).getManifestKey();
  if (!res.found) return Response.json({ error: { type: "not_found" } }, { status: 404 });
  if (!res.key) {
    return Response.json({ error: { type: "no_evidence_yet" } }, { status: 404 });
  }
  const obj = await env.EVIDENCE.get(res.key);
  if (!obj) {
    return Response.json({ error: { type: "evidence_missing", detail: res.key } }, { status: 404 });
  }
  const manifest = (await obj.json()) as EvidenceManifest;
  return Response.json({ digest: res.digest, binding_digest: res.binding_digest, manifest });
}

async function handleGetAttemptArtifact(
  env: Env,
  taskId: string,
  attemptId: string,
  which: "transcript" | "verify",
): Promise<Response> {
  const res = await TaskSession.from(env, taskId).getManifestKey(attemptId);
  if (!res.found) return Response.json({ error: { type: "not_found" } }, { status: 404 });
  if (!res.key) {
    return Response.json({ error: { type: "no_evidence_yet" } }, { status: 404 });
  }
  const manifestObj = await env.EVIDENCE.get(res.key);
  if (!manifestObj) {
    return Response.json({ error: { type: "evidence_missing", detail: res.key } }, { status: 404 });
  }
  const manifest = (await manifestObj.json()) as EvidenceManifest;
  const ref = which === "transcript" ? manifest.transcript : manifest.verify;
  if (!ref) {
    return Response.json(
      { error: { type: "no_verify_artifact", detail: "verify_command 未配置或未执行" } },
      { status: 404 },
    );
  }
  const artifact = await env.ARTIFACTS.get(ref.key);
  if (!artifact) {
    return Response.json({ error: { type: "artifact_missing", detail: ref.key } }, { status: 404 });
  }
  return new Response(artifact.body, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

async function handleApprove(req: Request, env: Env, taskId: string): Promise<Response> {
  const body = (await req.json()) as {
    decision?: string;
    actor?: string;
    attempt_id?: string;
    evidence_digest?: string;
  };
  if (body?.decision !== "approve" && body?.decision !== "reject") {
    return Response.json({ error: { type: "invalid_decision" } }, { status: 400 });
  }
  const res = await TaskSession.from(env, taskId).submitDecision({
    attempt_id: body.attempt_id,
    evidence_digest: body.evidence_digest,
    decision: body.decision,
    actor: body.actor ?? "human:api",
  });
  if (!res.ok) {
    const status =
      res.error === "evidence_required"
        ? 400
        : res.error === "task not found"
          ? 404
          : 409;
    return Response.json({ error: { type: res.error, state: res.state } }, { status });
  }
  return Response.json({ ok: true });
}

/** 校验 D1 归档的事件 hash chain:重算 digest 对比,断链即 broken。 */
async function handleChainCheck(env: Env): Promise<Response> {
  const tasks = await env.DB.prepare("SELECT DISTINCT task_id FROM events").all<{ task_id: string }>();
  let checked = 0;
  let broken = 0;
  const brokenTasks: string[] = [];
  for (const t of tasks.results) {
    const rows = await env.DB.prepare(
      "SELECT seq, payload, digest, prev_digest FROM events WHERE task_id = ? ORDER BY seq",
    )
      .bind(t.task_id)
      .all<{ seq: number; payload: string; digest: string; prev_digest: string | null }>();
    checked++;
    let prev: string | null = null;
    for (const row of rows.results) {
      if (row.prev_digest !== prev) {
        broken++;
        brokenTasks.push(`${t.task_id}:${row.seq}:prev`);
        continue;
      }
      const expect = await sha256Hex((prev ?? "GENESIS") + row.payload);
      if (expect !== row.digest) {
        broken++;
        brokenTasks.push(`${t.task_id}:${row.seq}:digest`);
      }
      prev = row.digest;
    }
  }
  return Response.json({ checked, broken, brokenTasks: brokenTasks.slice(0, 20) });
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/healthz") return Response.json({ ok: true, env: env.ENVIRONMENT });

    if (url.pathname === "/" && req.method === "GET") {
      return new Response(landingHtml(env), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (!checkApiToken(req, env)) return unauthorized();

    if (url.pathname === "/tasks" && req.method === "POST") return handleCreateTask(req, env);

    if (url.pathname === "/admin/chain-check" && req.method === "GET") {
      return handleChainCheck(env);
    }

    const taskMatch = /^\/tasks\/([0-9a-f-]{36})(\/approve|\/result|\/evidence)?$/.exec(url.pathname);
    if (taskMatch) {
      if (req.method === "GET" && !taskMatch[2]) return handleGetTask(env, taskMatch[1]);
      if (req.method === "GET" && taskMatch[2] === "/result") {
        return handleGetResult(env, taskMatch[1]);
      }
      if (req.method === "GET" && taskMatch[2] === "/evidence") {
        return handleGetEvidence(env, taskMatch[1]);
      }
      if (req.method === "POST" && taskMatch[2] === "/approve") {
        return handleApprove(req, env, taskMatch[1]);
      }
    }

    const attemptMatch =
      /^\/tasks\/([0-9a-f-]{36})\/attempts\/([0-9a-f-]{36})\/(transcript|verify)$/.exec(
        url.pathname,
      );
    if (attemptMatch && req.method === "GET") {
      return handleGetAttemptArtifact(
        env,
        attemptMatch[1],
        attemptMatch[2],
        attemptMatch[3] as "transcript" | "verify",
      );
    }

    return Response.json({ error: { type: "not_found" } }, { status: 404 });
  },

  queue: handleQueue,
};
