import { beforeAll, describe, expect, it } from "vitest";
import { createExecutionContext, env } from "cloudflare:test";
import worker from "../src/index";
import { TaskSession } from "../src/control/session";
import { liveStreamPath, renderLivePage } from "../src/obs/live";
import { applyMigrations } from "./d1";

/**
 * /api 前缀迁移的钉子测试。这个文件是唯一的机器防线,背景:
 *
 * w2 起本 Worker 会挂 Workers Static Assets 并配 `not_found_handling:
 * "single-page-application"` —— 届时**任何未匹配的 GET 都返回 SPA 的 index.html
 * (200 + text/html)**,而不是 404。一个漏挂在 /api 之外的 API 端点不会报错:
 * curl 拿到 JSON(它本来就是 API),浏览器却拿到 HTML(被 SPA fallback 吞掉)——
 * 静默的、按客户端而异的故障,是最难查的一类。因此:
 * 1. 旧路径必须**已死**(404 not_found),不留兼容层 —— 见「旧路径」用例;
 * 2. 全部 API 端点必须挂在 /api/* 且命中分发 —— 见「分发命中清单」用例。
 *    **将来新增 API 端点时,把它的 method+path 加进 API_ENDPOINTS 清单**;
 *    漏加或漏挂 /api 只有这里会红,SPA fallback 上线后没有任何东西会提醒你。
 * 3. Live 页面的流地址是唯一藏在工作区产物里的 API 调用(liveStreamPath),
 *    漏改在本棒完全不可见,必须有独立的断言 —— 见「STREAM_URL」用例。
 */

const TOKEN = env.WORKER_API_TOKEN;

interface ErrorBody {
  error?: { type?: string };
}

async function request(
  path: string,
  init: { method?: string; body?: unknown; token?: string | null } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (init.token !== null) headers.authorization = `Bearer ${init.token ?? TOKEN}`;
  const res = worker.fetch(
    new Request(`https://example.com${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
    env,
    createExecutionContext(),
  );
  return res;
}

/** 响应体是不是全局兜底的 not_found —— 「命中分发 vs 落到 404」的判据。 */
async function isNotFound(res: Response): Promise<boolean> {
  if (res.status !== 404) return false;
  try {
    return ((await res.json()) as ErrorBody).error?.type === "not_found";
  } catch {
    return false;
  }
}

const ns = () => env.TASK_SESSION as DurableObjectNamespace<TaskSession>;

/** RUNNING 的任务 + 一个 attempt:让每个端点都有真实 id 可打,而不是靠 404 猜路由。 */
async function seedRunningTask(): Promise<{ taskId: string; attemptId: string }> {
  const taskId = crypto.randomUUID();
  const stub = ns().get(ns().idFromName(taskId));
  await stub.createTask({ prompt: "api prefix" }, taskId);
  const { attempt_id } = await stub.startAttempt({
    role: "writer",
    idempotency_key: `${taskId}:attempt:1`,
    max_model_tokens: 1000,
    max_wall_seconds: 600,
  });
  return { taskId, attemptId: attempt_id };
}

/**
 * 已迁移的 /api 端点清单。新增端点必须同步加进来(见文件头理由 2)。
 * expected 是带合法夹具、正确鉴权下的响应特征 —— 只要求「不是 not_found」,
 * 具体业务语义由各端点自己的测试文件钉,这里钉的是路由归属。
 */
function apiEndpoints(taskId: string, attemptId: string): Array<{ method: string; path: string; body?: unknown }> {
  return [
    { method: "POST", path: "/api/tasks", body: { nope: true } }, // → 400 invalid_spec,分发命中
    { method: "GET", path: `/api/tasks/${taskId}` },
    { method: "GET", path: `/api/tasks/${taskId}/result` },
    { method: "GET", path: `/api/tasks/${taskId}/evidence` },
    { method: "GET", path: `/api/tasks/${taskId}/candidate` },
    { method: "GET", path: `/api/tasks/${taskId}/events` },
    { method: "GET", path: `/api/tasks/${taskId}/events/stream` },
    { method: "POST", path: `/api/tasks/${taskId}/approve`, body: { decision: "nope" } }, // → 400
    { method: "GET", path: `/api/tasks/${taskId}/attempts/${attemptId}/transcript` },
    { method: "GET", path: "/api/admin/chain-check" },
    { method: "GET", path: "/api/admin/tasks" },
    { method: "GET", path: "/api/admin/attempts" },
    { method: "GET", path: "/api/admin/events" }, // 缺 task_id → 400,同样命中分发
  ];
}

beforeAll(applyMigrations);

describe("/api 前缀契约", () => {
  it("旧路径已死:不带 /api 的端点一律 404 not_found,不留兼容层", async () => {
    expect(TOKEN).toBeTruthy();
    const { taskId, attemptId } = await seedRunningTask();
    const dead: Array<{ method: string; path: string }> = [
      { method: "POST", path: "/tasks" },
      { method: "GET", path: `/tasks/${taskId}` },
      { method: "GET", path: `/tasks/${taskId}/result` },
      { method: "GET", path: `/tasks/${taskId}/evidence` },
      { method: "GET", path: `/tasks/${taskId}/candidate` },
      { method: "GET", path: `/tasks/${taskId}/events` },
      { method: "GET", path: `/tasks/${taskId}/events/stream` },
      { method: "POST", path: `/tasks/${taskId}/approve` },
      { method: "GET", path: `/tasks/${taskId}/attempts/${attemptId}/transcript` },
      { method: "GET", path: "/admin/chain-check" },
      { method: "GET", path: "/admin/tasks" },
      { method: "GET", path: "/admin/attempts" },
      { method: "GET", path: "/admin/events" },
    ];
    for (const { method, path } of dead) {
      const res = await request(path, { method });
      expect(res.status, `${method} ${path} 必须 404`).toBe(404);
      expect(await isNotFound(res), `${method} ${path} 必须落到全局 not_found`).toBe(true);
    }
  });

  it("分发命中清单:全部 /api 端点带凭据打真实请求,没有一个落到 not_found", async () => {
    const { taskId, attemptId } = await seedRunningTask();
    for (const ep of apiEndpoints(taskId, attemptId)) {
      const res = await request(ep.path, { method: ep.method, body: ep.body });
      expect(await isNotFound(res), `${ep.method} ${ep.path} 不该落到 not_found`).toBe(false);
      // SSE 的泵会一直活着:读完必须 cancel,否则在 workerd 里留一个没人关的流。
      await res.body?.cancel().catch(() => undefined);
    }
  });

  it("分发命中清单(未鉴权):同一批端点 401 unauthorized,而不是 not_found", async () => {
    const { taskId, attemptId } = await seedRunningTask();
    for (const ep of apiEndpoints(taskId, attemptId)) {
      const res = await request(ep.path, { method: ep.method, token: null });
      expect(res.status, `${ep.method} ${ep.path} 缺 token 应 401`).toBe(401);
      expect(((await res.json()) as ErrorBody).error?.type).toBe("unauthorized");
    }
  });

  it("非 API 路由逐字段不变:/healthz 公开、GET / 公开、/live/:id 仍是页面", async () => {
    const health = await request("/healthz", { token: null });
    expect(health.status).toBe(200);
    expect(((await health.json()) as { ok: boolean }).ok).toBe(true);

    const landing = await request("/", { token: null });
    expect(landing.status).toBe(200);
    expect(landing.headers.get("content-type")).toContain("text/html");

    const { taskId } = await seedRunningTask();
    const live = await request(`/live/${taskId}`);
    expect(live.status).toBe(200);
    expect(live.headers.get("content-type")).toContain("text/html");
    // 页面路由不在 /api 下,也不会被 SPA fallback 的 API 分区波及
    const badLive = await request("/live/not-a-uuid", { token: null });
    expect(badLive.status).toBe(401); // /live 在鉴权门之后,与迁移前一致
  });

  it("STREAM_URL 防漏改:renderLivePage 产出的流地址必须以 /api/ 开头", () => {
    const taskId = crypto.randomUUID();
    const page = renderLivePage(taskId, { state: "RUNNING" });
    const urlInPage = /var STREAM_URL = "([^"]*)";/.exec(page);
    expect(urlInPage, "页面必须把流地址渲染成 JS 字符串常量").not.toBeNull();
    expect(urlInPage![1], "流地址漏挂 /api 会在 SPA fallback 上线后被静默吞掉").toMatch(/^\/api\//);
    expect(urlInPage![1]).toBe(`/api/tasks/${taskId}/events/stream`);
    // 导出函数自身同样钉住(它被 __STREAM_URL__ 注入点复用)
    expect(liveStreamPath(taskId)).toBe(`/api/tasks/${taskId}/events/stream`);
  });
});
