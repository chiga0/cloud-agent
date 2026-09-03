import type { Env, TaskSpec, TaskState } from "./types";
import { ATTEMPT_ROLES } from "./types";
import { handleQueue } from "./exec/queue";
import { ATTEMPT_STATES, TaskSession } from "./control/session";
import { TASK_TRANSITIONS } from "./control/statemachine";
import type { EvidenceManifest } from "./audit/evidence";
import { sha256Hex } from "./audit/evidence";
import { assembleCandidate, candidateFileName } from "./audit/candidate";
import { isValidSha } from "./exec/base";
import type { AgentEventV1 } from "./obs/events";
import { readObsAttemptEvents } from "./obs/journal";
import {
  OBS_SSE_TAIL_INTERVAL_MS,
  createObsStreamSession,
  obsStreamResponse,
  parseObsLastEventId,
  type ObsStreamDeps,
} from "./obs/stream";
import { renderLivePage } from "./obs/live";

export { AttemptWorkflow } from "./exec/workflow";
export { ContainerProxy } from "@cloudflare/sandbox";
export { Sandbox } from "./exec/sandbox-do";
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
      <dt>POST /tasks/:id/approve</dt><dd>审批,只收 <code>approve</code> / <code>reject</code>(必须带 attempt_id + evidence_digest,需鉴权;<code>accept_with_notes</code> 是控制面内部降级决策,不由外部提交)</dd>
      <dt>GET /tasks/:id/evidence</dt><dd>钉住的候选 manifest + approve 所需 attempt_id / binding_digest(需鉴权)</dd>
      <dt>GET /tasks/:id/candidate</dt><dd>候选交付视图:基线 commit、patch 引用、判定标签与诚实性告警(需鉴权)</dd>
      <dt>GET /tasks/:id/candidate?format=patch</dt><dd>下载补丁正文(<code>curl -o candidate.patch</code> 后本地 <code>git apply</code>);下发前重算 sha256,状态在 <code>x-candidate-status</code> / <code>x-safe-to-apply</code> 头里</dd>
      <dt>GET /tasks/:id/events</dt><dd>在途事件流(需鉴权):读 Observation 层的 R2 段文件 journal,<strong>不经 D1 终态归档</strong>,因此任务 <code>RUNNING</code> 期间就有内容 —— 这是它相对 <code>/admin/events</code>(只读已归档的 hash chain)的核心增量。数据来自 poll 相每 30s 的 transcript 增量摄取:<strong>模型悬挂表现为「新事件停止而进程 alive」,凭最后一条事件的 <code>ts</code> 与轮询周期对比即可在 5 分钟内发现</strong>。按 attempt 创建序、attempt 内按 <code>generation</code> 与 <code>seq</code> 升序返回 <code>{"task_id",state,"events":[AgentEventV1],"count",total,"next_cursor","unreadable_attempts"}</code>;信封为 <code>{v:1,task_id,attempt_id,generation,seq,ts,kind,payload}</code>,<code>kind</code> ∈ system/assistant/user/tool_use/tool_result/result/error/raw(认不出的行不丢)。payload 已在 ingress 过白名单:只留类型/工具名/token 用量/时长/退出码等枚举字段,自由文本 ≤2048 字符并对平台注入的凭据值精确打码。分页:<code>?after=</code>(扁平有序流上已读的条数,默认 0)、<code>?limit=</code>(默认 500,上限 2000,非数字或越界 → 400);<code>next_cursor</code> 无后续时为 <code>null</code>。任务不存在 → 404;从未摄取过事件 → 空列表而不是 404</dd>
      <dt>GET /tasks/:id/attempts/:aid/transcript</dt><dd>attempt 的 transcript 原文(verifier 为 JSON 验证报告,需鉴权)</dd>
      <dt>GET /admin/chain-check</dt><dd>校验 D1 归档的事件 hash chain(需鉴权)</dd>
      <dt>GET /admin/tasks</dt><dd>归档任务列表(需鉴权):<strong>只读</strong>投影,数据源仅为 D1 归档的 <code>tasks</code> 表 —— 任务到终态才归档,因此<strong>不含仍在 DO 中运行、尚未归档的任务</strong>(实时状态看 <code>GET /tasks/:id</code>)。按 <code>updated_at</code> 降序返回 <code>{"tasks":[{id,state,created_at,updated_at,version}],"count":N}</code>;可选 <code>?state=</code> 精确过滤(合法取值见状态机,非法 → 400)、可选 <code>?limit=</code>(默认 50,上限 200,非数字或越界 → 400)</dd>
      <dt>GET /admin/events</dt><dd>归档事件流(需鉴权):按任务回放审计事件的 hash chain。<strong>只读</strong>投影,数据源仅为 D1 归档的 <code>events</code> 表 —— 事件随任务终态才归档,因此<strong>只含已归档(终态)任务的事件</strong>,<strong>看不到仍在 DO 中运行、尚未归档的在途事件</strong>(实时状态看 <code>GET /tasks/:id</code>)。<code>?task_id=</code>(36 字符 UUID)<strong>必填</strong>:每 task 的 <code>seq</code> 才是分页脊线,跨 task 分页无意义;缺失或畸形 → 400。按 <code>seq</code> 升序(审计回放顺序)返回 <code>{"events":[{seq,kind,digest,prev_digest,created_at,canonical}],"next_cursor":&lt;string|null&gt;}</code>。<code>canonical</code> 是 D1 <code>payload</code> 列<strong>逐字原文</strong>(即 <code>JSON.stringify({task_id,kind,payload})</code>,正是被 hash 的那个串),不解析、不重新序列化 —— 客户端因此能独立重算 <code>digest == sha256Hex((prev_digest ?? "GENESIS") + canonical)</code> 并逐条核对 <code>prev_digest</code>,即在本地重放一遍 <code>/admin/chain-check</code>。安全:审计 journal 按构造<strong>绝不携带</strong>一次性模型代理凭据 <code>proxy_token</code>(它只存在于 <code>attempts</code> 表,从不进事件链)。游标分页:<code>?limit=</code>(默认 50,上限 200,非数字或越界 → 400)、<code>?cursor=</code>(不透明游标,首页省略;畸形 → 400),<code>next_cursor</code> 为下一页起点、无后续时为 <code>null</code>;过滤不命中返回空列表而不是 404</dd>
      <dt>GET /admin/attempts</dt><dd>归档 attempt 列表(需鉴权):按任务复盘各 attempt(writer / verifier / reviewer)的终态与 token 消耗。<strong>只读</strong>投影,数据源仅为 D1 归档的 <code>attempts</code> 表 —— attempt 随任务终态才归档,因此<strong>不含尚未归档的在途 attempt</strong>(实时状态看 <code>GET /tasks/:id</code>)。按 <code>created_at</code> 降序返回 <code>{"attempts":[{id,task_id,role,state,tokens_used,input_tokens,cache_read_tokens,output_tokens,cost_weighted_tokens,max_model_tokens,max_wall_seconds,workflow_instance_id,created_at,finished_at}],"count":N}</code>(<code>count</code> 是本次返回条数,受 limit 截断)。口径:<code>tokens_used</code> 是 raw total(历史可比,<strong>不是成本</strong> —— r11 实测其 96.9% 是最便宜的隐式缓存命中);四元组拆分与 <code>cost_weighted_tokens</code>(缓存命中按 <code>CACHE_READ_COST_FACTOR</code> 折扣加权)才是成本口径,今后看成本看后者。四列与 <code>cost_weighted_tokens</code> 为 <code>null</code> 表示该记录产生时未记过拆分口径(M8 前的历史行),<strong>不等于消耗为 0</strong>。安全投影:<code>proxy_token</code>(一次性模型代理凭据)<strong>绝不下发</strong>,内部去重用的 <code>idempotency_key</code> 同样不进投影。可选过滤器按 AND 组合:<code>?task_id=</code>(36 字符 UUID,畸形 → 400)、<code>?role=</code>(writer/reviewer/verifier)、<code>?state=</code>(RUNNING/SUCCEEDED/FAILED/BLOCKED;合法取值来自权威声明,非法 → 400,不命中返回空列表)、<code>?limit=</code>(默认 50,上限 200,非数字或越界 → 400)</dd>
    </dl>
  </div>

  <div class="card">
    <strong>CLI 示例</strong>
    <pre style="overflow:auto"><code>curl -X POST ${base}/tasks \\
  -H "Authorization: Bearer $WORKER_API_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"spec":{"prompt":"在 /workspace 写一个 hello.py 并运行","acceptance":["存在 hello.py","运行输出 hello"]}}'</code></pre>
    <div class="sub" style="margin:12px 0 0">acceptance 决定 reviewer 的否决权:没有验收标准时,它的 reject 只作为附注留档。</div>
  </div>
</main>
</body>
</html>`;
}

function checkApiToken(req: Request, env: Env): boolean {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  return !!env.WORKER_API_TOKEN && token === env.WORKER_API_TOKEN;
}

/**
 * acceptance 是 reviewer 的 reject 能否成立的前提(没有它,任何否决都只是附注),
 * 因此在入口处校验形状。上限与 gates.ts 的判定口径一致。
 */
function validateAcceptance(acceptance: unknown): string | null {
  if (acceptance == null) return null;
  if (!Array.isArray(acceptance)) return "acceptance must be an array of strings";
  if (acceptance.length > 8) return "acceptance supports at most 8 criteria";
  for (const c of acceptance) {
    if (typeof c !== "string") return "each acceptance criterion must be a string";
    const len = c.trim().length;
    if (len < 3 || len > 500) return "each acceptance criterion must be 3–500 characters";
  }
  return null;
}

/**
 * `base_sha` 与 prompt 不同:它会被控制面持久化并重放进每个新沙箱的 shell,
 * 因此入口就必须按最严的规格校验(DO 侧同规则再校验一次作为权威兜底)。
 */
function validateBaseSha(baseSha: unknown): string | null {
  if (baseSha == null) return null;
  if (!isValidSha(baseSha)) {
    return "base_sha must be a full lowercase hex commit id (40 or 64 chars)";
  }
  return null;
}

async function handleCreateTask(req: Request, env: Env): Promise<Response> {
  const body = (await req.json()) as {
    spec: TaskSpec;
    model?: string;
    budget?: { max_model_tokens?: number; max_wall_seconds?: number };
    review_evidence_mode?: string;
  };
  if (!body?.spec?.prompt) {
    return Response.json({ error: { type: "invalid_spec", detail: "spec.prompt required" } }, { status: 400 });
  }
  const acceptanceError = validateAcceptance(body.spec.acceptance);
  if (acceptanceError) {
    return Response.json({ error: { type: "invalid_acceptance", detail: acceptanceError } }, { status: 400 });
  }
  const baseShaError = validateBaseSha(body.spec.base_sha);
  if (baseShaError) {
    return Response.json({ error: { type: "invalid_base_sha", detail: baseShaError } }, { status: 400 });
  }
  const mode =
    body.review_evidence_mode === "enforce" || body.review_evidence_mode === "shadow"
      ? body.review_evidence_mode
      : undefined;

  const taskId = crypto.randomUUID();
  const session = TaskSession.from(env, taskId);
  await session.createTask(body.spec, taskId, mode);
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
  const res = await TaskSession.from(env, taskId).getEvidenceSummary();
  if (!res.found) return Response.json({ error: { type: "not_found" } }, { status: 404 });
  if (!res.key) {
    return Response.json({ error: { type: "no_evidence_yet" } }, { status: 404 });
  }
  const obj = await env.EVIDENCE.get(res.key);
  if (!obj) {
    return Response.json({ error: { type: "evidence_missing", detail: res.key } }, { status: 404 });
  }
  const manifest = (await obj.json()) as EvidenceManifest;
  return Response.json({
    attempt_id: res.writer_attempt_id,
    verifier_attempt_id: res.verifier_attempt_id,
    awaiting_human: res.awaiting_human,
    digest: res.digest,
    binding_digest: res.binding_digest,
    manifest,
  });
}

/**
 * GET /tasks/:id/candidate —— 候选交付接口(只读,不写任何外部系统)。
 *
 * 下发补丁前必须重算字节 sha256 并与 manifest 记录的 digest 比对:内容寻址
 * 只在写入时成立,把未校验的字节交出去等于让「拿到的补丁」和「验证过的补丁」
 * 之间没有可核对的链接。status / base 同时进响应头,`curl -O` 的人不看 body
 * 也不会把被否决的候选当成可直接提交的成品。
 */
async function handleGetCandidate(env: Env, taskId: string, format: string | null): Promise<Response> {
  if (format !== null && format !== "patch") {
    return Response.json(
      { error: { type: "invalid_format", detail: "only ?format=patch is supported" } },
      { status: 400 },
    );
  }
  const refs = await TaskSession.from(env, taskId).getCandidateRefs();
  if (!refs.found) return Response.json({ error: { type: "not_found" } }, { status: 404 });
  const manifestKey = refs.evidence?.writer_manifest_key;
  if (!manifestKey) {
    return Response.json({ error: { type: "no_candidate_yet" } }, { status: 404 });
  }
  const manifestObj = await env.EVIDENCE.get(manifestKey);
  if (!manifestObj) {
    return Response.json({ error: { type: "evidence_missing", detail: manifestKey } }, { status: 404 });
  }
  const manifest = (await manifestObj.json()) as EvidenceManifest;
  const view = assembleCandidate({
    task_id: taskId,
    state: refs.state,
    awaiting_human: refs.awaiting_human,
    base: refs.base,
    candidate_base: manifest.base ?? null,
    evidence: refs.evidence,
    patch: manifest.patch ?? null,
    decision: refs.decision,
    binding_digest: refs.binding_digest,
  });
  if (format === null) return Response.json(view);

  if (!view.patch) {
    return Response.json(
      { error: { type: "no_patch", detail: "该候选没有补丁文件", status: view.status, warnings: view.warnings } },
      { status: 404 },
    );
  }
  const patchObj = await env.ARTIFACTS.get(view.patch.key);
  if (!patchObj) {
    return Response.json({ error: { type: "artifact_missing", detail: view.patch.key } }, { status: 404 });
  }
  const body = await patchObj.arrayBuffer();
  const digest = await sha256Hex(body);
  if (digest !== view.patch.digest) {
    return Response.json(
      {
        error: { type: "integrity_error", key: view.patch.key, expected: view.patch.digest, actual: digest },
      },
      { status: 500 },
    );
  }
  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "content-disposition": `attachment; filename="${candidateFileName(taskId, digest)}"`,
      "x-candidate-status": view.status,
      "x-verified": String(view.verified),
      "x-safe-to-apply": String(view.safe_to_apply),
      "x-base-sha": view.base?.sha ?? "unpinned",
      "x-patch-digest": digest,
    },
  });
}

async function handleGetAttemptTranscript(
  env: Env,
  taskId: string,
  attemptId: string,
): Promise<Response> {
  const res = await TaskSession.from(env, taskId).getAttemptManifestKey(attemptId);
  if (!res.found) return Response.json({ error: { type: "not_found" } }, { status: 404 });
  if (!res.key) {
    return Response.json({ error: { type: "no_evidence_yet" } }, { status: 404 });
  }
  const manifestObj = await env.EVIDENCE.get(res.key);
  if (!manifestObj) {
    return Response.json({ error: { type: "evidence_missing", detail: res.key } }, { status: 404 });
  }
  const manifest = (await manifestObj.json()) as EvidenceManifest;
  const artifact = await env.ARTIFACTS.get(manifest.transcript.key);
  if (!artifact) {
    return Response.json({ error: { type: "artifact_missing", detail: manifest.transcript.key } }, { status: 404 });
  }
  return new Response(artifact.body, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/** Observation 事件的读端点分页口径(与 /admin/* 的归档 limit 刻意不同:这里读 R2 段文件)。 */
const DEFAULT_OBS_LIMIT = 500;
const MAX_OBS_LIMIT = 2000;

/**
 * query 里出现了参数名,空值就不是「缺省」:`?after=` 被当成 0 会让客户端从头再读
 * 一遍已经看过的流(分页最典型的静默重放)。/admin/events 的空 cursor 同样判非法。
 */
function parseObsInt(raw: string): number {
  return raw.trim().length === 0 ? Number.NaN : Number(raw);
}

/**
 * `after` 是「扁平有序流里已读过的条数」,不是事件自带的 seq。
 *
 * 为什么不是 seq:seq 只在 (attempt, generation) 内单调,一个任务的多条 attempt
 * 各有各的 seq —— 拿它当跨 attempt 的游标就会出现在 attempt2 上 `after=50` 把
 * attempt1 的 50 条之后全部漏掉的荒谬结果。用位置序号做游标,跨 attempt 天然有序,
 * 代价是「新事件插进更早的 attempt」会让游标漂移;实际不会发生(轮次串行),
 * 每条事件都自带 seq/attempt_id/generation,客户端要精确锚点可以看它们。
 */
function parseObsAfter(raw: string | null): { after: number; error: string | null } {
  if (raw === null) return { after: 0, error: null };
  const parsed = parseObsInt(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return { after: 0, error: "after must be a non-negative integer" };
  }
  return { after: parsed, error: null };
}

function parseObsLimit(raw: string | null): { limit: number; error: string | null } {
  if (raw === null) return { limit: DEFAULT_OBS_LIMIT, error: null };
  const parsed = parseObsInt(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_OBS_LIMIT) {
    return { limit: 0, error: `limit must be an integer within [1, ${MAX_OBS_LIMIT}]` };
  }
  return { limit: parsed, error: null };
}

/**
 * GET /tasks/:id/events —— 在途事件的只读投影(数据源:**R2 journal,不经 D1**)。
 *
 * 这就是它与 GET /admin/events 的全部差别:后者读的是终态才归档的 hash chain,
 * 任务 RUNNING 时返回空 —— 于是 C2-r6 那种 24 分钟模型悬挂,外圈在 /tasks/:id 里
 * 只看到 `state: RUNNING`,与正常无异。本端点直接读 poll 相每 30s 增量摄取的段文件,
 * 因此「新事件停止但进程 alive」这件事在事件流里 5 分钟内就是可见的(判据:最后一条
 * 事件的 ts 与当前时刻的差,对比 poll 周期 30s)。
 *
 * 有序返回该任务**全部 attempt** 的事件:attempt 顺序取 TaskSession DO 里的 attempts
 * 数组序(= 创建序,与 GET /tasks/:id 同源),attempt 内按 generation、seq 升序。
 * 不解析、不加工 payload:journal 里是什么就返回什么(白名单已在 ingress 完成)。
 *
 * 某 attempt 的 index 读坏了不能让整个任务看不到事件:记 stderr 并把该 attempt 列进
 * `unreadable_attempts`,让读者知道这一段视图不完整 —— 静默少一批事件比报错更糟。
 */
async function handleGetTaskEvents(url: URL, env: Env, taskId: string): Promise<Response> {
  const afterParsed = parseObsAfter(url.searchParams.get("after"));
  if (afterParsed.error !== null) {
    return Response.json(
      { error: { type: "invalid_after", detail: afterParsed.error } },
      { status: 400 },
    );
  }
  const limitParsed = parseObsLimit(url.searchParams.get("limit"));
  if (limitParsed.error !== null) {
    return Response.json(
      { error: { type: "invalid_limit", detail: limitParsed.error } },
      { status: 400 },
    );
  }
  const after = afterParsed.after;
  const limit = limitParsed.limit;

  const snap = await TaskSession.from(env, taskId).getSnapshot();
  if (!snap) return Response.json({ error: { type: "not_found" } }, { status: 404 });

  const events: AgentEventV1[] = [];
  const unreadable: string[] = [];
  let total = 0;
  let more = false;
  for (const attempt of snap.attempts) {
    // 页面已满时仍要问一遍该 attempt 的条数:skip=MAX_INT 只读 index,不下载任何段
    const skip = more ? Number.MAX_SAFE_INTEGER : Math.max(0, after - total);
    let page: { events: AgentEventV1[]; total: number };
    try {
      page = await readObsAttemptEvents(env.ARTIFACTS, taskId, attempt.id, skip);
    } catch (err) {
      console.warn(
        `obs_read_attempt_failed task=${taskId} attempt=${attempt.id} err=${String(err).slice(0, 300)}`,
      );
      unreadable.push(attempt.id);
      continue;
    }
    total += page.total;
    if (more) continue;
    const room = limit - events.length;
    if (page.events.length > room) {
      events.push(...page.events.slice(0, room));
      more = true;
    } else {
      events.push(...page.events);
    }
  }

  return Response.json({
    task_id: taskId,
    state: snap.task.state,
    events,
    count: events.length,
    total,
    next_cursor: more ? after + events.length : null,
    unreadable_attempts: unreadable,
  });
}

/**
 * GET /tasks/:id/events/stream —— 在途事件的 **SSE 投影**(第④层可观测架构的上半)。
 *
 * 与 handleGetTaskEvents 是同一个位置游标的两种读法(拉/推),两者互为恢复源:
 * 流断了就 `GET /events?after=<最后看到的 id>`,分页翻不动了就带 `Last-Event-ID` 重连。
 * 这个互换成立**仅因为**帧 id 与 `after` 同口径(都 = 已读条数,扁平序 1-based 位置)——
 * 口径的推导与三条不变量写在 src/obs/stream.ts 顶部;位置在两个端点里的分配规则刻意
 * 同构(见 obsStreamStep 与 handleGetTaskEvents),不同构的两个实现迟早漂移。
 *
 * 为什么是独立端点而不是把 /events 改成「可选流式」:后者的 Content-Type 与响应形状会
 * 随 query 变化,同一个 URL 两种契约最容易让客户端猜错;而 SSE 的连接生命周期(取消、
 * 保活、终止帧)是一整套自己的约定,值得单独一个路径。
 *
 * 本函数只做装配,泵的逻辑(含 teardown 不变量)全在 obs/stream.ts 且可单测:
 * - 校验 `Last-Event-ID`(缺省 0 = 从头回放),非法 → 400,风格与 `invalid_after` 一致;
 * - 任务不存在 → 404(必须在建流**之前**判掉:流一旦 200 就没法再补状态码);
 * - deps 的真实装配:`getSnapshot()` 短读 + `readObsAttemptEvents` + `setTimeout`。
 *   连接**不挂进 TaskSession DO**(DO 是 blockConcurrencyWhile 重度单写者,长连接会
 *   挤占权威写并发 —— 架构定稿的明确禁令);每轮那次 getSnapshot 是短读,不是禁令对象。
 */
async function handleGetTaskEventStream(req: Request, env: Env, taskId: string): Promise<Response> {
  const last = parseObsLastEventId(req.headers.get("last-event-id"));
  if (last.error !== null) {
    return Response.json(
      { error: { type: "invalid_last_event_id", detail: last.error } },
      { status: 400 },
    );
  }
  const snap = await TaskSession.from(env, taskId).getSnapshot();
  if (!snap) return Response.json({ error: { type: "not_found" } }, { status: 404 });

  const deps: ObsStreamDeps = {
    readSnapshot: async (id) => {
      const next = await TaskSession.from(env, id).getSnapshot();
      return next ? { state: next.task.state, attemptIds: next.attempts.map((a) => a.id) } : null;
    },
    readAttemptEvents: (id, attemptId, skip) =>
      readObsAttemptEvents(env.ARTIFACTS, id, attemptId, skip),
    // cancel 必须真的清掉定时器:泵的另一半(settle 等待中的那一拍)在 stream.ts 里。
    schedule: (ms, fire) => {
      const timer = setTimeout(fire, ms);
      return { cancel: () => clearTimeout(timer) };
    },
    tailIntervalMs: OBS_SSE_TAIL_INTERVAL_MS,
    warn: (message) => console.warn(message),
  };
  return obsStreamResponse(taskId, deps, createObsStreamSession(last.value)).response;
}

/**
 * GET /live/:taskId —— 在途事件时间线的**人眼端**(第④层下半)。页面怎么来的、为什么
 * 全内联、停滞阈值为什么是 90/300,都写在 src/obs/live.ts 顶部;这里只负责鉴权、404
 * 与响应头。事件内容一律由浏览器的 EventSource 拉,本函数不读 journal 的一个字节。
 *
 * **为什么一个「只是给人看」的页面也要鉴权**:事件 payload 已在 ingress 过白名单脱敏,
 * 所以这里泄露的不是密钥 —— 泄露的是**任务存在性本身**,以及 state、事件条数、agent
 * 正在动哪个仓库这类元信息。它们对竞争对手或扫描器就是有价值的信号,而本项目的口径从来
 * 是「凡带任务信息的出口一律同一条 checkApiToken」(§11 全表无例外)。在这个前提下
 * 404 才能有意义:不鉴权的话,「这个 taskId 存在」会无条件回答出来 —— 未鉴权的 404
 * 与鉴权后的 404 是两台机器。
 *
 * **已知前提(EventSource 带不了 Authorization 头,本期不解决)**:浏览器发起的
 * EventSource 无法携带自定义头,而 §9.6 那条流只认 `Authorization: Bearer`。所以直连
 * 会得到 401,页面会显示连接中断的提示。要让它真跑通,二选一都在别的棒里:部署侧用
 * 注入凭据的反代理解 `/tasks/*`,或者给流端点加一次性短期 token。**刻意不在本期做**
 * —— 本期硬约束是不改 SSE 端点的任何行为(含它的鉴权),而把 token 塞进 URL 会让凭据
 * 进浏览器历史、访问日志和 Referer,那是拿观测面换一个泄露面。
 * 此处需浏览器实测:401 与断连在 EventSource 前端不可区分,页面的提示是否够用只能实测。
 */
async function handleLivePage(env: Env, taskId: string): Promise<Response> {
  // 与 /tasks/:id/events* 完全同源的 404 语义,且必须在生成 HTML **之前**判掉:
  // 一旦 200 + text/html 发出去,就没法再补一个 404(同 §9.6 建流前判 404 的理由)。
  const snap = await TaskSession.from(env, taskId).getSnapshot();
  if (!snap) return Response.json({ error: { type: "not_found" } }, { status: 404 });
  return new Response(renderLivePage(taskId, { state: snap.task.state }), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // 不缓存:缓存住的就是一个不会再自增的停滞计时器 —— 这个页面的全部价值在于「现在」。
      // 不给 frame-ancestors/CSP:内联脚本本页必须有,而加 CSP 头会引出一整套新契约(下一棒的事)。
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
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

/** 合法 state 取值从权威转换表派生:状态机增删状态时这里自动跟上,不留第二份清单。 */
const TASK_STATES: readonly TaskState[] = Object.keys(TASK_TRANSITIONS) as TaskState[];

const DEFAULT_ADMIN_LIMIT = 50;
const MAX_ADMIN_LIMIT = 200;

/**
 * 归档读端点(`/admin/tasks`、`/admin/attempts`)共用的 limit 口径:缺省 50,
 * 只接受 [1, 200] 内的整数。`error` 非空即 400 —— 一份规则,不各写一份。
 */
function parseAdminLimit(raw: string | null):
  | { limit: number; error: null }
  | { limit: null; error: string } {
  if (raw === null) return { limit: DEFAULT_ADMIN_LIMIT, error: null };
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_ADMIN_LIMIT) {
    return { limit: null, error: `limit must be an integer within [1, ${MAX_ADMIN_LIMIT}]` };
  }
  return { limit: parsed, error: null };
}

interface ArchivedTaskRow {
  id: string;
  state: string;
  created_at: string;
  updated_at: string;
  version: number;
}

/**
 * GET /admin/tasks —— 归档任务列表(只读投影,数据源仅为 D1 `tasks` 表)。
 *
 * 归档只在终态发生,所以这里**看不到仍在 DO 中运行、尚未归档的任务** —— 它是
 * 复盘与「捞需要人工处理的任务」的视图,不是实时看板;实时状态仍走 /tasks/:id。
 * 不引入新的状态对象,也不碰控制面状态机与归档写路径。
 */
async function handleAdminTasks(url: URL, env: Env): Promise<Response> {
  const state = url.searchParams.get("state");
  if (state !== null && !(TASK_STATES as readonly string[]).includes(state)) {
    return Response.json(
      {
        error: {
          type: "invalid_state",
          detail: `state must be one of ${TASK_STATES.join(", ")}`,
        },
      },
      { status: 400 },
    );
  }

  const { limit, error } = parseAdminLimit(url.searchParams.get("limit"));
  if (error !== null) {
    return Response.json({ error: { type: "invalid_limit", detail: error } }, { status: 400 });
  }

  const sql =
    "SELECT id, state, created_at, updated_at, version FROM tasks" +
    (state === null ? "" : " WHERE state = ?") +
    " ORDER BY updated_at DESC LIMIT ?";
  const params: Array<string | number> = state === null ? [] : [state];
  params.push(limit);
  const rows = await env.DB.prepare(sql).bind(...params).all<ArchivedTaskRow>();
  // count 是本次返回的条数(受 limit 截断),不是表里的总匹配数。
  return Response.json({ tasks: rows.results, count: rows.results.length });
}

/**
 * 归档 attempt 的投影字段。`proxy_token`(一次性模型代理凭据)与
 * `idempotency_key`(内部去重管道)**刻意不在列表里**:读投影不该成为
 * 凭据的第二条出口,复盘要的是结果、终态与 token 消耗,不是拿回能重放的钥匙。
 *
 * 用量四元组(input/cache_read/output)与成本加权值同 raw total 并列:tokens_used
 * 保持历史口径可比,成本口径看 cost_weighted_tokens。`null` 是该记录产生时还没有
 * 拆分口径(M8 前的历史行)或执行面没拿到 usage —— 不等于「消耗为 0」。
 */
interface ArchivedAttemptRow {
  id: string;
  task_id: string;
  role: string;
  state: string;
  tokens_used: number;
  input_tokens: number | null;
  cache_read_tokens: number | null;
  output_tokens: number | null;
  cost_weighted_tokens: number | null;
  max_model_tokens: number;
  max_wall_seconds: number;
  workflow_instance_id: string | null;
  created_at: string;
  finished_at: string | null;
}

/** 与 `/tasks/:id` 路由同一个 id 口径:36 字符 `[0-9a-f-]` UUID。 */
const TASK_ID_RE = /^[0-9a-f-]{36}$/;

/**
 * GET /admin/attempts —— 归档 attempt 列表(只读投影,数据源仅为 D1 `attempts` 表)。
 *
 * 按任务复盘各 attempt(writer/verifier/reviewer)的执行结果、终态与 token 消耗。
 * 与 /admin/tasks 同理:归档只在终态发生,**看不到仍在 DO 中运行、尚未归档的
 * 在途 attempt** —— 实时状态仍走 /tasks/:id。不新增状态对象,不碰状态机与归档
 * 写路径;role/state 的合法取值直接引用权威声明(ATTEMPT_ROLES / ATTEMPT_STATES),
 * 不在这里另立清单。
 *
 * 过滤器可组合(AND 语义):`?task_id=` 精确匹配、`?role=`、`?state=`;
 * 过滤不命中返回空列表而不是 404。`?limit=` 缺省 50、上限 200。
 */
async function handleAdminAttempts(url: URL, env: Env): Promise<Response> {
  const taskId = url.searchParams.get("task_id");
  if (taskId !== null && !TASK_ID_RE.test(taskId)) {
    return Response.json(
      {
        error: {
          type: "invalid_task_id",
          detail: "task_id must be a 36-character task uuid",
        },
      },
      { status: 400 },
    );
  }

  const role = url.searchParams.get("role");
  if (role !== null && !(ATTEMPT_ROLES as readonly string[]).includes(role)) {
    return Response.json(
      {
        error: {
          type: "invalid_role",
          detail: `role must be one of ${ATTEMPT_ROLES.join(", ")}`,
        },
      },
      { status: 400 },
    );
  }

  const state = url.searchParams.get("state");
  if (state !== null && !(ATTEMPT_STATES as readonly string[]).includes(state)) {
    return Response.json(
      {
        error: {
          type: "invalid_state",
          detail: `state must be one of ${ATTEMPT_STATES.join(", ")}`,
        },
      },
      { status: 400 },
    );
  }

  const { limit, error } = parseAdminLimit(url.searchParams.get("limit"));
  if (error !== null) {
    return Response.json({ error: { type: "invalid_limit", detail: error } }, { status: 400 });
  }

  // 值一律走占位符绑定,拼进 SQL 的只有下面这段固定的列名/WHERE 片段。
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (taskId !== null) {
    where.push("task_id = ?");
    params.push(taskId);
  }
  if (role !== null) {
    where.push("role = ?");
    params.push(role);
  }
  if (state !== null) {
    where.push("state = ?");
    params.push(state);
  }
  params.push(limit);
  const sql =
    "SELECT id, task_id, role, state, tokens_used, input_tokens, cache_read_tokens," +
    " output_tokens, cost_weighted_tokens, max_model_tokens, max_wall_seconds," +
    " workflow_instance_id, created_at, finished_at FROM attempts" +
    (where.length === 0 ? "" : ` WHERE ${where.join(" AND ")}`) +
    " ORDER BY created_at DESC LIMIT ?";
  const rows = await env.DB.prepare(sql).bind(...params).all<ArchivedAttemptRow>();
  // count 是本次返回的条数(受 limit 截断),不是表里的总匹配数。
  return Response.json({ attempts: rows.results, count: rows.results.length });
}

/**
 * 归档事件流的投影行。D1 的 `payload` 列存的是 **canonical 串**(`appendEvent` 里
 * 被 hash 的那个 `JSON.stringify({task_id, kind, payload})`),不是内层 payload 对象。
 */
interface ArchivedEventRow {
  seq: number;
  kind: string;
  digest: string;
  prev_digest: string | null;
  created_at: string;
  payload: string;
}

const EVENT_CURSOR_PREFIX = "evt1:";
/** 合法游标只是 `evt1:<seq>` 的 base64url(十几个字符);超出这个长度的一定是垃圾输入。 */
const MAX_EVENT_CURSOR_CHARS = 128;

/**
 * base64url 且无 padding:游标要原样回传进 query string,标准 base64 里的 `+` 会被
 * query 解析成空格、`/` 与 `=` 也常在复制粘贴中出事 —— 那是分页游标最典型的一类坏法,
 * 在编码这一侧就消掉,而不是要求客户端「记得」转义。
 */
function toBase64Url(text: string): string {
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(raw: string): string {
  const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
  return atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
}

function encodeEventCursor(seq: number): string {
  return toBase64Url(`${EVENT_CURSOR_PREFIX}${seq}`);
}

/**
 * 游标不透明:编码的是「上一页最后一条的 seq」这个位置,而不是页号。
 * 解不开一律判非法(→ 400),绝不退化成「当作首页」—— 那会让一次拼错的翻页
 * 静默重放已经看过的行,而回放审计最不能接受的就是「看不出漏了什么」。
 */
function decodeEventCursor(raw: string): number | null {
  if (raw.length === 0 || raw.length > MAX_EVENT_CURSOR_CHARS) return null;
  let decoded: string;
  try {
    decoded = fromBase64Url(raw);
  } catch {
    return null;
  }
  if (!decoded.startsWith(EVENT_CURSOR_PREFIX)) return null;
  const digits = decoded.slice(EVENT_CURSOR_PREFIX.length);
  if (!/^\d+$/.test(digits)) return null;
  const seq = Number(digits);
  return Number.isSafeInteger(seq) ? seq : null;
}

/**
 * GET /admin/events —— 归档事件流的只读投影(数据源仅为 D1 `events` 表)。
 *
 * 用途是按任务回放审计 hash chain,所以刻意不做任何服务端加工:`canonical` 逐字
 * 透出,重算 digest 留给客户端(`digest == sha256Hex((prev_digest ?? "GENESIS") +
 * canonical)`,与 handleChainCheck 同口径、同一个 sha256Hex)。这样「端点返回的
 * 内容」自己就是可核验的证据,而不是「服务端声称链没断」。同理,`proxy_token`
 * 按构造不进事件链(它只存在于 attempts 表),journal 因而不是凭据的第二条出口。
 *
 * `?task_id=` 必填:分页脊线是每 task 的 seq(唯一索引 idx_events_task_seq),跨
 * task 的 seq 互不相干,混在一起分页没有意义。`?limit=` 与 `/admin/tasks`、
 * `/admin/attempts` 共用 parseAdminLimit;`?cursor=` 省略即首页。
 *
 * 归档只在终态发生,因此这里**看不到仍在 DO 中运行、尚未归档的在途事件** —— 实时
 * 状态仍走 /tasks/:id。不新增状态对象,不碰状态机与归档写路径。
 */
async function handleAdminEvents(url: URL, env: Env): Promise<Response> {
  const taskId = url.searchParams.get("task_id");
  if (taskId === null) {
    return Response.json(
      {
        error: {
          type: "invalid_task_id",
          detail: "task_id is required (pagination is keyed by per-task seq)",
        },
      },
      { status: 400 },
    );
  }
  if (!TASK_ID_RE.test(taskId)) {
    return Response.json(
      {
        error: {
          type: "invalid_task_id",
          detail: "task_id must be a 36-character task uuid",
        },
      },
      { status: 400 },
    );
  }

  const rawCursor = url.searchParams.get("cursor");
  let afterSeq = 0;
  if (rawCursor !== null) {
    const decoded = decodeEventCursor(rawCursor);
    if (decoded === null) {
      return Response.json(
        {
          error: { type: "invalid_cursor", detail: "cursor must be an opaque page cursor" },
        },
        { status: 400 },
      );
    }
    afterSeq = decoded;
  }

  const { limit, error } = parseAdminLimit(url.searchParams.get("limit"));
  if (error !== null) {
    return Response.json({ error: { type: "invalid_limit", detail: error } }, { status: 400 });
  }

  // 值一律走占位符绑定,SQL 是固定串 —— 游标解码出的也只是数字。
  // 多取一条只为判断「后面还有没有」:恰好取满 limit 且确实还有后续才给游标,
  // 否则末页会返回一个指向空页的 next_cursor,客户端就永远等不到 null。
  const rows = await env.DB.prepare(
    "SELECT seq, kind, digest, prev_digest, created_at, payload FROM events" +
      " WHERE task_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?",
  )
    .bind(taskId, afterSeq, limit + 1)
    .all<ArchivedEventRow>();
  const page = rows.results.slice(0, limit);
  return Response.json({
    events: page.map((row) => ({
      seq: row.seq,
      kind: row.kind,
      digest: row.digest,
      prev_digest: row.prev_digest,
      created_at: row.created_at,
      canonical: row.payload,
    })),
    next_cursor:
      rows.results.length > limit ? encodeEventCursor(page[page.length - 1].seq) : null,
  });
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

    if (url.pathname === "/admin/tasks" && req.method === "GET") {
      return handleAdminTasks(url, env);
    }

    if (url.pathname === "/admin/attempts" && req.method === "GET") {
      return handleAdminAttempts(url, env);
    }

    if (url.pathname === "/admin/events" && req.method === "GET") {
      return handleAdminEvents(url, env);
    }

    // Live UI(第④层下半)。id 的正则与下面 /tasks/:id/* **同一条**([0-9a-f-]{36}):
    // 畸形 id 在这里就 404,不进渲染 —— 但 renderLivePage 仍然自己转义,理由见它上方注释。
    // 刻意不做 /live 列表页:那需要跨任务枚举,与 /admin/tasks 的归档口径纠缠,是另一棒。
    const liveMatch = /^\/live\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (liveMatch && req.method === "GET") {
      return handleLivePage(env, liveMatch[1]);
    }

    const taskMatch =
      /^\/tasks\/([0-9a-f-]{36})(\/approve|\/result|\/evidence|\/candidate|\/events\/stream|\/events)?$/.exec(url.pathname);
    if (taskMatch) {
      if (req.method === "GET" && !taskMatch[2]) return handleGetTask(env, taskMatch[1]);
      if (req.method === "GET" && taskMatch[2] === "/result") {
        return handleGetResult(env, taskMatch[1]);
      }
      if (req.method === "GET" && taskMatch[2] === "/evidence") {
        return handleGetEvidence(env, taskMatch[1]);
      }
      if (req.method === "GET" && taskMatch[2] === "/events") {
        return handleGetTaskEvents(url, env, taskMatch[1]);
      }
      if (req.method === "GET" && taskMatch[2] === "/events/stream") {
        return handleGetTaskEventStream(req, env, taskMatch[1]);
      }
      if (req.method === "GET" && taskMatch[2] === "/candidate") {
        return handleGetCandidate(env, taskMatch[1], url.searchParams.get("format"));
      }
      if (req.method === "POST" && taskMatch[2] === "/approve") {
        return handleApprove(req, env, taskMatch[1]);
      }
    }

    const attemptMatch =
      /^\/tasks\/([0-9a-f-]{36})\/attempts\/([0-9a-f-]{36})\/transcript$/.exec(url.pathname);
    if (attemptMatch && req.method === "GET") {
      return handleGetAttemptTranscript(env, attemptMatch[1], attemptMatch[2]);
    }

    return Response.json({ error: { type: "not_found" } }, { status: 404 });
  },

  queue: handleQueue,
};
