import { beforeAll, describe, expect, it } from "vitest";
import { createExecutionContext, env } from "cloudflare:test";
import worker from "../src/index";
import { TaskSession } from "../src/control/session";
import { ingestTranscript, type ObsTranscriptReader } from "../src/obs/ingest";
import { OBS_EVENT_KINDS, type AgentEventV1 } from "../src/obs/events";
import {
  LIVE_STALL_DANGER_SECONDS,
  LIVE_STALL_WARN_SECONDS,
  LIVE_TEXT_SUMMARY_MAX_CHARS,
  escapeHtmlText,
  liveStreamPath,
  renderLivePage,
  scriptJsonString,
} from "../src/obs/live";
import { SseReader } from "./sse";
import { applyMigrations } from "./d1";

/**
 * GET /live/:taskId —— Live UI(第④层下半)。
 *
 * 这组用例能钉住的与钉不住的,要先说清:页面是**字符串产物**,单测可以钉内容
 * (阈值数字、EventSource、流路径、kind 徽章、转义),但钉不住渲染后的视觉效果与
 * JS 的运行时行为(计时器是否真的每秒自增、阈值跨越时颜色是否真的变、坏帧是否真的
 * 只跳过一条)。凡属后者,代码里逐处标了「此处需浏览器实测」,不要把这些断言当成
 * 「UI 行为已验证」。
 *
 * 值得单独钉一条的是**路径自洽**:从页面里抠出 STREAM_URL 再真去 GET 它,必须拿到
 * 200 的 text/event-stream。这一条把「UI 连的是哪条流」从注释变成断言 —— 上一期的
 * 帧格式改了路径或口径时,这里会红,而不是留一个打不开数据的白屏页面。
 */

const TOKEN = env.WORKER_API_TOKEN;
const TS = "2026-09-02T00:00:00.000Z";

interface ErrorBody {
  error: { type: string };
}

const ns = () => env.TASK_SESSION as DurableObjectNamespace<TaskSession>;

async function request(
  path: string,
  opts: { token?: string | null } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? TOKEN}`;
  return worker.fetch(new Request(`https://example.com${path}`, { headers }), env, createExecutionContext());
}

function reader(content: string): ObsTranscriptReader {
  return {
    async readFile() {
      return { content };
    },
  };
}

/** RUNNING 的任务 + 一条已摄取的事件:够开页面,也够让流真推出第一帧。 */
async function seedRunningTask(): Promise<{ taskId: string; attemptId: string }> {
  const taskId = crypto.randomUUID();
  const stub = ns().get(ns().idFromName(taskId));
  await stub.createTask({ prompt: "live ui" }, taskId);
  const { attempt_id } = await stub.startAttempt({
    role: "writer",
    idempotency_key: `${taskId}:attempt:1`,
    max_model_tokens: 1000,
    max_wall_seconds: 600,
  });
  await ingestTranscript({
    bucket: env.ARTIFACTS,
    reader: reader(`${JSON.stringify({ type: "assistant", content: [{ type: "text", text: "hi" }] })}\n`),
    taskId,
    attemptId: attempt_id,
    now: () => TS,
  });
  return { taskId, attemptId: attempt_id };
}

beforeAll(applyMigrations);

describe("GET /live/:taskId", () => {
  it("200 + text/html:页面含 EventSource、真实流路径、停滞阈值常量与「最后事件」", async () => {
    const { taskId } = await seedRunningTask();
    const res = await request(`/live/${taskId}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();

    expect(body).toContain("EventSource");
    expect(body).toContain(`/tasks/${taskId}/events/stream`);
    expect(body).toContain("最后事件");
    // 阈值是判据,必须能在产物里读到具体数字(缺省渲染成 JS 常量声明)
    expect(LIVE_STALL_WARN_SECONDS).toBe(90);
    expect(LIVE_STALL_DANGER_SECONDS).toBe(300);
    expect(body).toContain(`var STALL_WARN_SECONDS = 90;`);
    expect(body).toContain(`var STALL_DANGER_SECONDS = 300;`);
    expect(body).toContain(`var TEXT_MAX = ${LIVE_TEXT_SUMMARY_MAX_CHARS};`);
    // 规格点名要显示的东西:徽章清单、end 帧文案、坏帧计数、tool_names/raw_type
    for (const kind of OBS_EVENT_KINDS) expect(body).toContain(`>${kind}<`);
    expect(body).toContain("流已结束");
    expect(body).toContain("坏帧");
    expect(body).toContain("tool_names");
    expect(body).toContain("raw_type");
    expect(body).toContain(taskId);
  });

  it("全内联零依赖:没有外链、没有 <link>、没有 src=、没有任何 scheme", async () => {
    const { taskId } = await seedRunningTask();
    const body = await (await request(`/live/${taskId}`)).text();
    expect(body).not.toMatch(/https?:\/\//);
    expect(body).not.toMatch(/<link\b/i);
    expect(body).not.toMatch(/\bsrc\s*=/i);
    expect(body).not.toMatch(/@import/i);
    expect(body).toContain("<style>");
    expect(body).toContain("<script>");
  });

  it("鉴权与 404 语义和 /tasks/:id/events 同源:无凭据 401、不存在 404", async () => {
    expect(TOKEN).toBeTruthy();
    const { taskId } = await seedRunningTask();
    expect((await request(`/live/${taskId}`, { token: null })).status).toBe(401);
    expect((await request(`/live/${taskId}`, { token: "wrong" })).status).toBe(401);

    const missing = await request(`/live/${crypto.randomUUID()}`);
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as ErrorBody).error.type).toBe("not_found");

    // 畸形 id 与缺 id:走的是全局兜底 404(路由正则同 /tasks/:id/*),不进渲染。
    expect((await request("/live/not-a-uuid")).status).toBe(404);
    expect((await request("/live")).status).toBe(404);
  });

  it("路径自洽:从页面抠出的 STREAM_URL 真能开出 SSE,帧形状正是渲染器读的字段", async () => {
    const { taskId } = await seedRunningTask();
    const body = await (await request(`/live/${taskId}`)).text();
    const urlInPage = /var STREAM_URL = "([^"]*)";/.exec(body);
    expect(urlInPage, "页面必须把流地址渲染成 JS 字符串常量").not.toBeNull();
    expect(urlInPage![1]).toBe(`/tasks/${taskId}/events/stream`);
    expect(urlInPage![1]).toBe(liveStreamPath(taskId));

    // 真去连一次:200 的 event-stream,且 data 可解析回带 kind/seq/ts/payload 的信封。
    const stream = await request(urlInPage![1]);
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    const sse = new SseReader(stream.body!.getReader());
    try {
      const frames = await sse.take(1);
      expect(SseReader.eventIds(frames)).toEqual([1]);
      const ev = SseReader.events(frames)[0] as AgentEventV1;
      expect([ev.seq, ev.kind, typeof ev.ts, typeof ev.payload]).toEqual([1, "assistant", "string", "object"]);
    } finally {
      await sse.cancel();
    }
  });
});

describe("renderLivePage(纯函数)", () => {
  it("taskId 来自 URL 路径:两个上下文各自转义,畸形 id 出不了字符串字面量", () => {
    const evil = `<script>alert(1)</script>`;
    const page = renderLivePage(evil);
    // 注入体一个字节都不许出现:原文既不进 HTML 文本,也不进 JS 字面量
    expect(page).not.toContain(evil);
    expect(page.match(/<script/g)).toHaveLength(1);
    expect(page).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    // 流路径里走的是 URL 编码,不是 HTML 转义(&amp; 在 URL 里不会被还原)
    expect(page).toContain("/tasks/%3Cscript%3Ealert(1)%3C%2Fscript%3E/events/stream");
  });

  it("escapeHtmlText:& 最先替换(否则 &lt; 会被二次替换成 &amp;lt;)", () => {
    expect(escapeHtmlText("&<>\"'")).toBe("&amp;&lt;&gt;&quot;&#39;");
    expect(escapeHtmlText("<b>")).toBe("&lt;b&gt;");
    expect(escapeHtmlText("a&quot;b")).toBe("a&amp;quot;b");
  });

  it("scriptJsonString:</script> 与 U+2028 出不了 script 元素", () => {
    expect(scriptJsonString("</script>")).toBe(`"\\u003c/script\\u003e"`);
    expect(scriptJsonString("</script>")).not.toContain("<");
    expect(scriptJsonString("a\u2028b\u2029c")).toBe(`"a\\u2028b\\u2029c"`);
    expect(scriptJsonString('a"b')).toBe(`"a\\"b"`);
  });

  it("state 徽章初值渲染进来并转义;缺省 unknown", () => {
    expect(renderLivePage("t-1", { state: "RUNNING" })).toContain("state: RUNNING");
    expect(renderLivePage("t-1", { state: null })).toContain("state: unknown");
    expect(renderLivePage("t-1")).toContain("state: unknown");
    expect(renderLivePage("t-1", { state: "<x>" })).toContain("state: &lt;x&gt;");
  });

  it("空 taskId 直接抛(它会生成一条永远不出事件的流,看起来是「活着」)", () => {
    expect(() => renderLivePage("")).toThrow(/live_bad_task_id/);
  });

  it("生成的内联 JS 能编译:字符串产物里的语法错误是静默的,必须单独钉", () => {
    const page = renderLivePage("0f6f1f2c-0000-4000-8000-000000000002", { state: "RUNNING" });
    const m = /<script>([\s\S]*?)<\/script>/.exec(page);
    expect(m, "页面必须含一段内联 script").not.toBeNull();
    expect(m![1]).toContain("new EventSource");
    // new Function 只编译不执行:不需要 DOM 就能抓到「整页白屏」的那一类错
    // (模板字面量转义走偏、拼接漏引号等)。运行时行为仍需浏览器实测,见下。
    expect(() => new Function(m![1])).not.toThrow();
  });

  it("kind 徽章覆盖 OBS_EVENT_KINDS 全部取值,且清单只派生自权威常量", () => {
    const page = renderLivePage("0f6f1f2c-0000-4000-8000-000000000001");
    for (const kind of OBS_EVENT_KINDS) {
      expect(page).toContain(`>${kind}<`);
      expect(page).toContain(`.k-${kind}`);
    }
    expect(OBS_EVENT_KINDS).toContain("tool_result");
  });
});
