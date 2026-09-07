import { beforeAll, describe, expect, it } from "vitest";
import { createExecutionContext, env } from "cloudflare:test";
import worker from "../src/index";
import { applyMigrations } from "./d1";

/**
 * GET /live/:taskId —— w4b 退役后的形状:301 → /tasks/:taskId。
 *
 * 退役口径(product.md §5):旧的内联 HTML 页面(原 src/obs/live.ts)整体删除,
 * SSE 数据端点(/api/tasks/:id/events/stream)与监督器 detect 判据零改动 ——
 * 后两者的契约分别由 test/obs-stream-api.test.ts 与 test/supervisor-detect.test.ts
 * 钉着,本文件只管这一条重定向本身的语义。
 *
 * 三条语义各有一句为什么:
 * 1. **301 = 永久**:人眼端已迁到 SPA 详情页,这条路径不会再回来;302/307 是「临时」,
 *    会让缓存与书签永远留着一次多余的中转。
 * 2. **重定向不查任务存在性**:handler 对任何 uuid 形状的 id 都 301(零 DO 读)。旧页面
 *    的 404-vs-200 是「任务存在性」的泄露面(§11 鉴权注释),重定向把泄露面整个关掉了
 *    —— 不存在的任务在 SPA 详情页里得到它的 not_found,而不是在门这里提前回答。
 * 3. **鉴权门原样覆盖 /live**:无凭据 401 与迁移前一致(这是全局门的既有边界,
 *    不是本棒新加的);畸形 id 不匹配路由正则,落全局兜底 404。
 *
 * 钉不住的:浏览器真的跟随 301 后 SPA 怎么渲染 —— 那是资产层 + SPA 的事,
 * 由部署后的操作员浏览器实测覆盖(§N 证据链)。
 */

const TOKEN = env.WORKER_API_TOKEN;

beforeAll(applyMigrations);

async function request(
  path: string,
  opts: { token?: string | null } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? TOKEN}`;
  return worker.fetch(new Request(`https://example.com${path}`, { headers }), env, createExecutionContext());
}

describe("GET /live/:taskId(w4b 退役:301 到详情页)", () => {
  it("301(永久)+ Location 指向 /tasks/:taskId —— 永久 redirect,不是 302/307 的临时中转", async () => {
    expect(TOKEN).toBeTruthy();
    const taskId = crypto.randomUUID();
    const res = await request(`/live/${taskId}`);
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(`/tasks/${taskId}`);
  });

  it("不存在的任务同样 301:重定向零 DO 读,旧页面的 404 存在性泄露面就此关闭", async () => {
    const taskId = crypto.randomUUID();
    const res = await request(`/live/${taskId}`);
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(`/tasks/${taskId}`);
  });

  it("鉴权门原样覆盖 /live:无凭据与错凭据都是 401,迁移前一致", async () => {
    const taskId = crypto.randomUUID();
    expect((await request(`/live/${taskId}`, { token: null })).status).toBe(401);
    expect((await request(`/live/${taskId}`, { token: "wrong" })).status).toBe(401);
  });

  it("畸形 id 与缺 id:路由正则同迁移前,落全局兜底 404(不进重定向)", async () => {
    const notUuid = await request("/live/not-a-uuid");
    expect(notUuid.status).toBe(404);
    expect(((await notUuid.json()) as { error: { type: string } }).error.type).toBe("not_found");
    expect((await request("/live")).status).toBe(404);
  });

  it("重定向体是空的:301 只是路标,不该再携带一份页面(哪怕一句文案)", async () => {
    const res = await request(`/live/${crypto.randomUUID()}`);
    expect((await res.text()).trim()).toBe("");
  });
});
