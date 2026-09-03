import { beforeAll, describe, expect, it } from "vitest";
import { createExecutionContext, env } from "cloudflare:test";
import worker from "../src/index";
import { TaskSession } from "../src/control/session";
import { ingestTranscript, type ObsTranscriptReader } from "../src/obs/ingest";
import { OBS_SECRET_MASK, type AgentEventV1 } from "../src/obs/events";
import { applyMigrations } from "./d1";

/**
 * GET /api/tasks/:id/events —— 在途事件流的读端点。
 *
 * 这个端点存在的全部理由是:**任务 RUNNING 时就读得到事件**。`/api/admin/events` 做不到,
 * 因为它读的是终态才归档的 D1 行 —— 所以这里刻意钉两件事:
 * 1. 数据源是 R2 journal:D1 归档表一条事件都没有,端点仍然返回全部内容;
 * 2. 多 attempt 的有序拼接,以及 after/limit 的分页边界(含跨 attempt 拼接处、
 *    跨定长段边界处 —— 这两处是分页最容易静默漏读的地方)。
 *
 * 信封里没有 digest/prev_digest 同样是承诺的一部分:Observation 层不建 hash chain
 * (权威层才需要),把它钉成用例而不是留在「以后再说」。
 */

const TOKEN = env.WORKER_API_TOKEN;
const KEY = "sk-1234567890abcdef1234567890abcdef";

interface ErrorBody {
  error: { type: string; detail?: string };
}

interface EventsBody {
  task_id: string;
  state: string;
  events: AgentEventV1[];
  count: number;
  total: number;
  next_cursor: number | null;
  unreadable_attempts: string[];
}

const ns = () => env.TASK_SESSION as DurableObjectNamespace<TaskSession>;

async function request(path: string, token: string | null = TOKEN): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return worker.fetch(
    new Request(`https://example.com${path}`, { headers }),
    env,
    createExecutionContext(),
  );
}

async function eventsBody(path: string): Promise<{ status: number; body: EventsBody }> {
  const res = await request(path);
  return { status: res.status, body: (await res.json()) as EventsBody };
}

/** 事件的身份:跨 attempt 有序性的可比对的钥匙。 */
const ident = (e: AgentEventV1) => `${e.attempt_id.slice(0, 8)}/${e.generation}/${e.seq}`;

function reader(content: string): ObsTranscriptReader {
  return {
    async readFile() {
      return { content };
    },
  };
}

function ndjson(turn: number): string {
  return JSON.stringify({
    type: "assistant",
    content: [{ type: "text", text: `turn ${turn}` }],
    usage: { input_tokens: turn, output_tokens: 1 },
  });
}

/**
 * 造一个 RUNNING 中的任务,并按 perAttempt 给的条数为每条 attempt 摄取一轮事件。
 * ts 每 attempt 一个定值(摄取的 ts 就是「本轮的时刻」,同轮同值 —— 与真实路径一致)。
 */
async function seedTaskWithEvents(
  perAttempt: number[],
  opts: { extraLines?: string[]; secrets?: string[] } = {},
): Promise<{ taskId: string; attemptIds: string[] }> {
  const taskId = crypto.randomUUID();
  const stub = ns().get(ns().idFromName(taskId));
  await stub.createTask({ prompt: "obs events api" }, taskId);

  const attemptIds: string[] = [];
  for (let i = 0; i < perAttempt.length; i++) {
    const { attempt_id } = await stub.startAttempt({
      role: "writer",
      idempotency_key: `${taskId}:attempt:${i + 1}`,
      max_model_tokens: 1000,
      max_wall_seconds: 600,
    });
    attemptIds.push(attempt_id);
    const rows = [
      ...Array.from({ length: perAttempt[i] }, (_, n) => ndjson(i * 100 + n)),
      ...(opts.extraLines ?? []),
    ];
    await ingestTranscript({
      bucket: env.ARTIFACTS,
      reader: reader(rows.length > 0 ? `${rows.join("\n")}\n` : ""),
      taskId,
      attemptId: attempt_id,
      now: () => `2026-09-01T00:0${i}:00.000Z`,
      secrets: opts.secrets,
    });
  }
  return { taskId, attemptIds };
}

beforeAll(applyMigrations);

describe("GET /api/tasks/:id/events", () => {
  it("任务 RUNNING 即可读,内容 entirely 来自 R2:D1 归档表一条事件都没有", async () => {
    const { taskId, attemptIds } = await seedTaskWithEvents([3]);
    const { status, body } = await eventsBody(`/api/tasks/${taskId}/events`);
    expect(status).toBe(200);
    expect(body.task_id).toBe(taskId);
    expect(body.state).toBe("RUNNING");
    expect(body.count).toBe(3);
    expect(body.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(body.events.every((e) => e.attempt_id === attemptIds[0])).toBe(true);

    // 归档只在终态发生:此刻 events/attempts 都是空的,而事件已经读得到 ——
    // 这一条就是本端点相对 /api/admin/events 的全部增量
    const events = await env.DB.prepare("SELECT count(*) AS n FROM events WHERE task_id = ?")
      .bind(taskId)
      .first<{ n: number }>();
    expect(events!.n).toBe(0);
    const attempts = await env.DB.prepare("SELECT count(*) AS n FROM attempts WHERE task_id = ?")
      .bind(taskId)
      .first<{ n: number }>();
    expect(attempts!.n).toBe(0);
  });

  it("信封就是承诺的 8 个字段:不建 hash chain,也不外带 transcript 原文", async () => {
    const { taskId } = await seedTaskWithEvents([1]);
    const { body } = await eventsBody(`/api/tasks/${taskId}/events`);
    const evt = body.events[0];
    expect(Object.keys(evt).sort()).toEqual([
      "attempt_id",
      "generation",
      "kind",
      "payload",
      "seq",
      "task_id",
      "ts",
      "v",
    ]);
    expect(evt).not.toHaveProperty("digest");
    expect(evt).not.toHaveProperty("prev_digest");
    // payload 里只有白名单后的东西:原始 content 数组不该出现
    expect(JSON.stringify(evt.payload).toLowerCase()).not.toContain("content");
    expect(evt.payload.text).toBe("turn 0");
  });

  it("白名单与凭据打码在 ingress 已完成:端点文本里没有 key 原文", async () => {
    const { taskId } = await seedTaskWithEvents([1], {
      secrets: [KEY],
      extraLines: [
        JSON.stringify({
          type: "assistant",
          proxy_token: KEY,
          content: [{ type: "text", text: `using ${KEY} against upstream` }],
        }),
      ],
    });
    const text = await (await request(`/api/tasks/${taskId}/events`)).text();
    expect(text).not.toContain(KEY);
    expect(text).toContain(OBS_SECRET_MASK);
    const body = JSON.parse(text) as EventsBody;
    expect(body.count).toBe(2);
    expect(Object.keys(body.events[1].payload).sort()).toEqual(["text"]);
  });

  it("多 attempt 按平台 attempt 序拼接,attempt 内按 generation/seq 升序", async () => {
    const { taskId, attemptIds } = await seedTaskWithEvents([3, 2]);
    const { body } = await eventsBody(`/api/tasks/${taskId}/events`);
    expect(body.total).toBe(5);
    expect(body.events.map((e) => `${e.attempt_id === attemptIds[0] ? "a1" : "a2"}:${e.seq}`)).toEqual([
      "a1:1",
      "a1:2",
      "a1:3",
      "a2:1",
      "a2:2",
    ]);
  });

  it("?after/?limit 逐页翻等于一次读全,跨 attempt 边界不断序", async () => {
    const { taskId } = await seedTaskWithEvents([3, 2]);
    const p1 = await eventsBody(`/api/tasks/${taskId}/events?limit=2`);
    expect(p1.body.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(p1.body.next_cursor).toBe(2);

    const p2 = await eventsBody(`/api/tasks/${taskId}/events?after=2&limit=2`);
    // 这一页的第 1 条是 attempt1 的尾、第 2 条已是 attempt2 的头
    expect(p2.body.events.map((e) => `${e.attempt_id.slice(0, 0)}${e.generation}:${e.seq}`)).toEqual([
      "1:3",
      "1:1",
    ]);
    expect(p2.body.next_cursor).toBe(4);

    const p3 = await eventsBody(`/api/tasks/${taskId}/events?after=4&limit=2`);
    expect(p3.body.events.map((e) => e.seq)).toEqual([2]);
    expect(p3.body.next_cursor).toBeNull();

    const all = await eventsBody(`/api/tasks/${taskId}/events`);
    expect([...p1.body.events, ...p2.body.events, ...p3.body.events].map(ident)).toEqual(
      all.body.events.map(ident),
    );

    const past = await eventsBody(`/api/tasks/${taskId}/events?after=999999`);
    expect(past.body.events).toEqual([]);
    expect(past.body.next_cursor).toBeNull();
    expect(past.body.total).toBe(5);
  });

  it("?after 跨定长段边界时按 index 的段清单定位,不错位也不漏读", async () => {
    const { taskId } = await seedTaskWithEvents([250]);
    const edge = await eventsBody(`/api/tasks/${taskId}/events?after=199&limit=3`);
    expect(edge.body.events.map((e) => e.seq)).toEqual([200, 201, 202]);
    expect(edge.body.next_cursor).toBe(202);

    const tail = await eventsBody(`/api/tasks/${taskId}/events?after=249`);
    expect(tail.body.events.map((e) => e.seq)).toEqual([250]);
    expect(tail.body.next_cursor).toBeNull();

    // 整段被跳过的请求仍然报得出 total(条数来自 index,不需要下载段)
    const beyond = await eventsBody(`/api/tasks/${taskId}/events?after=250`);
    expect(beyond.body.events).toEqual([]);
    expect(beyond.body.total).toBe(250);
  });

  it("limit 缺省 500、上限 2000;越界与非数字 → 400", async () => {
    const { taskId } = await seedTaskWithEvents([2]);
    expect((await eventsBody(`/api/tasks/${taskId}/events`)).body.count).toBe(2);
    expect((await eventsBody(`/api/tasks/${taskId}/events?limit=2000`)).status).toBe(200);
    for (const limit of ["0", "-1", "2001", "abc", "1.5", "", "1e400"]) {
      const res = await request(`/api/tasks/${taskId}/events?limit=${encodeURIComponent(limit)}`);
      expect(res.status, `limit=${JSON.stringify(limit)} 应被拒绝`).toBe(400);
      expect(((await res.json()) as ErrorBody).error.type).toBe("invalid_limit");
    }
  });

  it("after 只接受非负整数", async () => {
    const { taskId } = await seedTaskWithEvents([1]);
    for (const after of ["-1", "1.5", "abc", "", "1e400"]) {
      const res = await request(`/api/tasks/${taskId}/events?after=${encodeURIComponent(after)}`);
      expect(res.status, `after=${JSON.stringify(after)} 应被拒绝`).toBe(400);
      expect(((await res.json()) as ErrorBody).error.type).toBe("invalid_after");
    }
    expect((await eventsBody(`/api/tasks/${taskId}/events?after=0`)).status).toBe(200);
  });

  it("从未摄取过事件 → 空列表而不是 404(第一轮轮询还没跑完是常态)", async () => {
    const { taskId } = await seedTaskWithEvents([]);
    const { status, body } = await eventsBody(`/api/tasks/${taskId}/events`);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      events: [],
      count: 0,
      total: 0,
      next_cursor: null,
      unreadable_attempts: [],
    });
  });

  it("任务不存在 → 404", async () => {
    const res = await request(`/api/tasks/${crypto.randomUUID()}/events`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrorBody).error.type).toBe("not_found");
  });

  it("鉴权与 GET /api/tasks/:id 同一条 checkApiToken 路径", async () => {
    expect(TOKEN).toBeTruthy();
    const { taskId } = await seedTaskWithEvents([1]);
    expect((await request(`/api/tasks/${taskId}/events`, null)).status, "缺 token 应 401").toBe(401);
    expect((await request(`/api/tasks/${taskId}/events`, "wrong-token")).status, "错 token 应 401").toBe(401);
    expect((await request(`/api/tasks/${taskId}/events`)).status).toBe(200);
  });

  it("某 attempt 的 journal 读坏了:其余照常返回,坏的那个如实列出", async () => {
    const { taskId, attemptIds } = await seedTaskWithEvents([2, 2]);
    await env.ARTIFACTS.put(`obs/${taskId}/${attemptIds[0]}/index.json`, "not json");
    const res = await request(`/api/tasks/${taskId}/events`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as EventsBody;
    expect(body.unreadable_attempts).toEqual([attemptIds[0]]);
    expect(body.events.map((e) => e.attempt_id)).toEqual([attemptIds[1], attemptIds[1]]);
  });

  it("落地页登记该端点,并如实说明它读 R2、RUNNING 即可用", async () => {
    const html = await (await request("/")).text();
    expect(html).toContain("<dt>GET /api/tasks/:id/events</dt>");
    expect(html).toContain("不经 D1 终态归档");
    expect(html).toContain("新事件停止而进程 alive");
  });
});
