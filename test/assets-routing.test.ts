import { beforeAll, describe, expect, it } from "vitest";
import { createExecutionContext, env } from "cloudflare:test";
import worker from "../src/index";
import type { TaskSession } from "../src/control/session";
import { applyMigrations } from "./d1";
import { loadWranglerConfig, matchesRunWorkerFirst } from "./wrangler-config";
import prodWranglerRaw from "../wrangler.jsonc?raw";
import spaFixtureRaw from "./fixtures/spa/index.html?raw";
import webEntryRaw from "../web/index.html?raw";

/**
 * 静态资产上线后的**分区契约**(w2a,docs/product.md §2/§4/§7)。
 *
 * 背景一句话:挂上 assets 并配 `not_found_handling: "single-page-application"` 之后,
 * 「没人要的路径」不再 404,而是 200 + index.html。于是漏列 `run_worker_first` 的 API
 * 不会报错,只会安静地从 JSON 变成一坨 HTML —— curl 侧像好事(它本来就拿到过 JSON),
 * 浏览器侧全是坏消息,而且只在部署后才显现。§7 把它列为头号风险。
 *
 * 这道风险被拆成三段,每段各自钉:
 * 1. **配置面**:assets 的四项设置逐项钉死(run_worker_first 逐字节比数组,顺序也算)。
 *    漏一条 = 这里红。运行时的资产路由器不听测试使唤,配置就是它唯一可读的真相。
 * 2. **覆盖面**:每条 API 路径都必须被某条 run_worker_first 规则盖住;客户端路由必须
 *    **盖不住**(否则 SPA 页面拿回 JSON —— 那是 §2 里否决 `/tasks/:id` 同形的原始动机)。
 *    两个方向一起钉,才排掉「把 `true` 或 `/*` 写进去图省事」这种把分区彻底抹平的做法。
 * 3. **行为面**:worker 对 API 的答复必须是 JSON(流端点是 text/event-stream),
 *    未匹配路径经资产层必须落回 SPA 入口。
 *
 * 与 test/api-prefix.test.ts 的分工:那个文件钉「端点挂在 /api 之下且命中分发」,
 * 本文件钉「/api 之下的请求真的先经 worker、其余真的落 SPA」。清单新增端点时两边都要随动。
 */

const config = loadWranglerConfig(prodWranglerRaw);
const TOKEN = env.WORKER_API_TOKEN;

/**
 * 资产命名空间的**测试侧**取法。
 *
 * 为什么不写进 src/types.ts 的 Env,也不扩 test/env.d.ts 里的 `Cloudflare.Env`:那个
 * interface 必须与 AppEnv **结构全等**。DO 的桩类型是按它推断的(`TaskSession extends
 * DurableObject<Env>`),给它加任何成员都会让 `runInDurableObject(stub, …)` 的实例推断
 * 退化到基类,于是基类里可选的 `alarm?()` 在 test/session-do.test.ts 变成「可能未定义」
 * 的编译错误 —— 一个与本题无关的连锁反应(实测踩过)。而 worker 代码本来也不读资产
 * (请求给谁由运行时的 run_worker_first 决定),所以这个类型只属于本文件。
 */
interface AssetsNamespace {
  fetch(request: Request): Promise<Response>;
}
const assets = (env as unknown as { ASSETS: AssetsNamespace }).ASSETS;

/** 刻意挂在鉴权门**之前**的两条(见 src/index.ts 的分支注释):它们的 401 语义不成立。 */
const PREAUTH_PATHS = new Set(["/api/session/login", "/api/session/logout"]);

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

/** 与 test/api-prefix.test.ts 同形状的夹具:让每条路径都打在真实 id 上,而不是靠 404 猜路由。 */
async function seedRunningTask(): Promise<{ taskId: string; attemptId: string }> {
  const ns = env.TASK_SESSION as DurableObjectNamespace<TaskSession>;
  const taskId = crypto.randomUUID();
  const stub = ns.get(ns.idFromName(taskId));
  await stub.createTask({ prompt: "assets routing" }, taskId);
  const { attempt_id } = await stub.startAttempt({
    role: "writer",
    idempotency_key: `${taskId}:attempt:1`,
    max_model_tokens: 1000,
    max_wall_seconds: 600,
  });
  return { taskId, attemptId: attempt_id };
}

/**
 * 必须是 `application/json` 的 API 路径。RUNNING 任务 + 没有结果/候选/证据,所以这些
 * 端点此刻大多返回 404 —— 状态码不是本文件的主题,**响应的介质类型**才是:
 * 「404 且是 JSON」是对的,「200 且是 HTML」就是 §7 描述的整站级故障。
 * 带 `?format=patch` 的下载面与 result/transcript 的正文口径由各端点自己的测试钉。
 */
function jsonEndpoints(
  taskId: string,
  attemptId: string,
): Array<{ method: string; path: string; body?: unknown }> {
  return [
    { method: "POST", path: "/api/tasks", body: { nope: true } }, // → 400 invalid_spec
    { method: "GET", path: `/api/tasks/${taskId}` },
    { method: "GET", path: `/api/tasks/${taskId}/result` }, // → 404 no_result_yet
    { method: "GET", path: `/api/tasks/${taskId}/evidence` },
    { method: "GET", path: `/api/tasks/${taskId}/candidate` },
    { method: "GET", path: `/api/tasks/${taskId}/rescue` },
    { method: "POST", path: `/api/tasks/${taskId}/approve`, body: { decision: "nope" } }, // → 400
    { method: "GET", path: `/api/tasks/${taskId}/attempts/${attemptId}/transcript` },
    { method: "GET", path: "/api/admin/tasks" },
    { method: "GET", path: "/api/admin/attempts" },
    { method: "GET", path: "/api/admin/events" }, // 缺 task_id → 400
    { method: "GET", path: "/api/admin/chain-check" },
    { method: "GET", path: "/api/session/me" },
    { method: "POST", path: "/api/session/login", body: { token: "wrong-on-purpose" } }, // → 401
    { method: "POST", path: "/api/session/logout" }, // 门前分支,照样在 /api 分区里
    // /api 之下**没有对应端点**的路径:也必须由 worker 答 JSON。漏了这条分区,
    // 一个打错的 API 地址会拿到 200 + SPA,前端 JSON.parse 抛错才知道不对。
    { method: "GET", path: "/api/no/such/endpoint" },
  ];
}

/** 唯一的非 JSON API:SSE。单列出来钉死,免得它被当成「例外可以随便加」的先例。 */
function streamEndpoints(taskId: string): Array<{ method: string; path: string }> {
  return [{ method: "GET", path: `/api/tasks/${taskId}/events/stream` }];
}

/** 归 worker 的非 API 路径:健康检查与过渡期旧页面(§2 分区表)。 */
function otherWorkerPaths(taskId: string): string[] {
  return ["/healthz", `/live/${taskId}`, "/live"];
}

/**
 * 必须**落给资产**(不被 run_worker_first 盖住)的路径:客户端路由与构建产物。
 * 这正是 /api/* 迁移换来的东西 —— 盖住任何一条,浏览器导航过去拿到的是 JSON。
 */
function clientRoutes(taskId: string): string[] {
  return [
    "/", // 资产层的 SPA 入口(w2b 起 landingHtml 已从 worker 删除,`/` 只剩资产这一条路)
    "/login",
    "/tasks",
    `/tasks/${taskId}`,
    "/approvals",
    "/audit",
    "/assets/probe.js",
    "/favicon.ico",
  ];
}

beforeAll(applyMigrations);

describe("assets 配置面", () => {
  it("assets 四项逐字钉死:目录 dist、绑定 ASSETS、SPA 兜底、worker-first 清单顺序内容都不许多也不缺", () => {
    expect(config.assets).toBeDefined();
    const assets = config.assets ?? {};
    // 与 package.json 的 build 产物目录同源于 test/web-build-base.test.ts 的交叉核对
    expect(assets.directory).toBe("dist");
    expect(assets.binding).toBe("ASSETS");
    expect(assets.not_found_handling).toBe("single-page-application");
    expect(assets.run_worker_first).toEqual(["/api/*", "/live", "/live/*", "/healthz"]);
  });

  it("分区靠白名单,不靠 run_worker_first: true 或 /* 这种把两半抹平的写法", () => {
    const rules = config.assets?.run_worker_first;
    expect(Array.isArray(rules), "run_worker_first 写成 true 会让所有请求先进 worker,SPA 资产永远读不到").toBe(
      true,
    );
    if (!Array.isArray(rules)) return;
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule, "只有 /* 的规则等于没有分区").not.toBe("/*");
      expect(rule, "空规则会匹配一切").not.toBe("");
    }
  });
});

describe("run_worker_first 覆盖面", () => {
  it("匹配器自身的反例:上面两条断言不是空转", () => {
    // 精确规则两端锚定:`/live` 不得连 `/livenet` 一起盖住
    expect(matchesRunWorkerFirst(["/live"], "/live")).toBe(true);
    expect(matchesRunWorkerFirst(["/live"], "/livenet")).toBe(false);
    expect(matchesRunWorkerFirst(["/live"], "/live/abc")).toBe(false);
    expect(matchesRunWorkerFirst(["/live/*"], "/live/abc")).toBe(true);
    expect(matchesRunWorkerFirst(["/api/*"], "/api/tasks/x/events/stream")).toBe(true);
    expect(matchesRunWorkerFirst(["/api/*"], "/apix/tasks")).toBe(false);
    // 空清单必须判「不覆盖」,否则「每条 API 都被盖住」那条断言会永远绿
    expect(matchesRunWorkerFirst([], "/api/tasks")).toBe(false);
    expect(() => matchesRunWorkerFirst(["!/*"], "/api/tasks")).toThrow();
  });

  it("全部 API 路径与健康面都被某条规则盖住", async () => {
    const { taskId, attemptId } = await seedRunningTask();
    const rules = (config.assets?.run_worker_first ?? []) as string[];
    const paths = [
      ...jsonEndpoints(taskId, attemptId).map((e) => e.path),
      ...streamEndpoints(taskId).map((e) => e.path),
      ...otherWorkerPaths(taskId),
    ];
    for (const path of paths) {
      expect(
        matchesRunWorkerFirst(rules, path),
        `${path} 没被 run_worker_first 盖住:它会静默落到 SPA 的 index.html(§7 头号风险)`,
      ).toBe(true);
    }
  });

  it("客户端路由与构建产物一律盖不住(归资产),且新页面路由不需要动这份清单", async () => {
    const { taskId } = await seedRunningTask();
    const rules = (config.assets?.run_worker_first ?? []) as string[];
    for (const path of clientRoutes(taskId)) {
      expect(matchesRunWorkerFirst(rules, path), `${path} 应当由资产应答`).toBe(false);
    }
  });
});

describe("worker 应答面:API 永远是 JSON,不是 HTML", () => {
  it("带凭据打全部 /api 端点:content-type 是 application/json,且没有一个 text/html", async () => {
    const { taskId, attemptId } = await seedRunningTask();
    for (const ep of jsonEndpoints(taskId, attemptId)) {
      const res = await request(ep.path, { method: ep.method, body: ep.body });
      const type = res.headers.get("content-type") ?? "";
      expect(type, `${ep.method} ${ep.path} 的响应介质`).toContain("application/json");
      expect(type.toLowerCase(), `${ep.method} ${ep.path} 绝不能是 HTML`).not.toContain("text/html");
      await res.body?.cancel().catch(() => undefined);
    }
  });

  it("SSE 端点是 text/event-stream(唯一的非 JSON API 答复)", async () => {
    const { taskId } = await seedRunningTask();
    for (const ep of streamEndpoints(taskId)) {
      const res = await request(ep.path);
      expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
      // 泵会一直活着:读完必须 cancel,否则在 workerd 里留一个没人关的流。
      await res.body?.cancel().catch(() => undefined);
    }
  });

  it("未鉴权也是 JSON 401:被 SPA 吞掉的形状是 200 + HTML,两者必须分得开", async () => {
    const { taskId, attemptId } = await seedRunningTask();
    for (const ep of jsonEndpoints(taskId, attemptId)) {
      const res = await request(ep.path, { method: ep.method, body: ep.body, token: null });
      const type = res.headers.get("content-type") ?? "";
      expect(type, `${ep.method} ${ep.path}`).toContain("application/json");
      if (!PREAUTH_PATHS.has(ep.path)) {
        // 鉴权门在分发之前,所以连 /api 下的未知路径都是 401 而不是 404:形状与
        // 「200 + index.html」一眼可分,前端那条 401 → 跳登录才是可用的信号。
        expect(res.status, `${ep.method} ${ep.path} 缺凭据应 401`).toBe(401);
      }
      await res.body?.cancel().catch(() => undefined);
    }
  });

  it("/live/:taskId 与 /healthz 保持原形状(过渡期旧页面是 HTML,健康检查是 JSON)", async () => {
    const { taskId } = await seedRunningTask();
    const live = await request(`/live/${taskId}`);
    expect(live.headers.get("content-type") ?? "").toContain("text/html");
    const health = await request("/healthz");
    expect(health.headers.get("content-type") ?? "").toContain("application/json");
  });
});

describe("资产应答面:未匹配路径落 SPA 入口", () => {
  /**
   * 这里打的是资产命名空间(`assets`,即线上 `env.ASSETS`),不是入口路由器 ——
   * `run_worker_first` 由运行时的顶层路由执行,单测里 `worker.fetch()` 绕过它。所以本段钉的是
   * 「资产层在没人认领时会返回什么」,上一段钉的是「worker 认领时会返回什么」,配置面钉的是
   * 「谁认领」。三段合起来才是完整的防线,线上真实组合由操作员部署后 curl 全 API 前缀冒烟。
   */
  it("深链接(客户端路由)拿到 200 + index.html,而不是 404", async () => {
    // `/` 排在最前:w2b 退役 landingHtml 之后,根路径**只有**资产这一条路可走。
    for (const path of ["/", "/tasks/" + crypto.randomUUID(), "/approvals", "/login", "/audit"]) {
      const res = await assets.fetch(new Request(`https://example.com${path}`));
      expect(res.status, `${path} 应落 SPA 入口`).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain("text/html");
      const body = await res.text();
      expect(body).toContain('id="root"');
    }
  });

  it("命中的资产按自身介质应答,不被 SPA 兜底污染", async () => {
    const res = await assets.fetch(new Request("https://example.com/assets/probe.js"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("javascript");
    expect(await res.text()).toContain("spaProbe");
  });

  it("夹具与真实入口同形状:同一个 #root 锚点 + module 脚本入口", () => {
    // 夹具(test/fixtures/spa)与 web/index.html 脱钩时,上面两条断言就成自证了。
    expect(spaFixtureRaw).toContain('<div id="root"></div>');
    expect(webEntryRaw).toContain('<div id="root"></div>');
    expect(spaFixtureRaw).toMatch(/<script type="module" src="\/assets\/probe\.js"><\/script>/);
    expect(webEntryRaw).toMatch(/<script type="module" src="\/src\/main\.tsx"><\/script>/);
  });
});
