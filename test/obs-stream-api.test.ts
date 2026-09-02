import { beforeAll, describe, expect, it } from "vitest";
import { createExecutionContext, env } from "cloudflare:test";
import worker from "../src/index";
import { TaskSession } from "../src/control/session";
import { ingestTranscript, type ObsTranscriptReader } from "../src/obs/ingest";
import { obsIndexPath } from "../src/obs/journal";
import type { AgentEventV1 } from "../src/obs/events";
import { SseReader, type SseFrame, ident } from "./sse";
import { applyMigrations } from "./d1";

/**
 * GET /tasks/:id/events/stream —— 走真实 HTTP 路由的 SSE 投影。
 *
 * 这组用例钉的是**契约**:路由、鉴权、400 口径、帧形状、以及最重要的一条 ——
 * 帧 id 与 `GET /events` 的 `after` 是同一个数(「往返自洽」用例)。上一轮把事件帧
 * id 写成 0-based 索引、end 帧写成总条数,同一条流两套口径,浏览器按标准回传
 * `Last-Event-ID` 就会重发边界那条、`id: 0` 更是从头全量重放。
 *
 * 尾读节拍/ping/tail 增量在 test/obs-stream.test.ts 用假时钟钉(不真等 3s);这里
 * 刻意把多数用例的任务推到终态(BLOCKED),泵会在推完增量的那一轮自己发 end 关流 ——
 * 于是既不用等定时器,也顺手钉住了「打开的流全部收敛」这条 workerd teardown 不变量。
 * 唯一保持 RUNNING 的回放用例读完帧立刻 cancel body,绝不留下没关的流。
 */

const TOKEN = env.WORKER_API_TOKEN;
const TS = "2026-09-02T00:00:00.000Z";

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

async function request(path: string, opts: { token?: string | null; lastEventId?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? TOKEN}`;
  if (opts.lastEventId !== undefined) headers["last-event-id"] = opts.lastEventId;
  return worker.fetch(new Request(`https://example.com${path}`, { headers }), env, createExecutionContext());
}

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
 * 造任务并按 perAttempt 条数摄取事件;`terminal` 时把 writer 报成基建错误
 * (exit_code<0 → attempt 与任务一起 BLOCKED)—— 这是最短的合法终态路径。
 */
async function seedTask(
  perAttempt: number[],
  opts: { terminal?: boolean } = {},
): Promise<{ taskId: string; attemptIds: string[]; state: string }> {
  const taskId = crypto.randomUUID();
  const stub = ns().get(ns().idFromName(taskId));
  await stub.createTask({ prompt: "obs stream api" }, taskId);

  const attemptIds: string[] = [];
  for (let i = 0; i < perAttempt.length; i++) {
    const { attempt_id } = await stub.startAttempt({
      role: "writer",
      idempotency_key: `${taskId}:attempt:${i + 1}`,
      max_model_tokens: 1000,
      max_wall_seconds: 600,
    });
    attemptIds.push(attempt_id);
    const rows = Array.from({ length: perAttempt[i] }, (_, n) => ndjson(i * 100 + n));
    await ingestTranscript({
      bucket: env.ARTIFACTS,
      reader: reader(rows.length > 0 ? `${rows.join("\n")}\n` : ""),
      taskId,
      attemptId: attempt_id,
      now: () => TS,
    });
  }
  if (opts.terminal) {
    await stub.reportExecution({
      attempt_id: attemptIds[attemptIds.length - 1],
      exit_code: -1,
      error: "container died",
    });
  }
  const snap = await stub.getSnapshot();
  return { taskId, attemptIds, state: snap!.task.state };
}

/** 开一条流并把帧读干净(RUNNING 的任务不会自己收尾,所以读完必须 cancel)。 */
async function readStream(
  taskId: string,
  opts: { lastEventId?: string; count: number | null; token?: string | null },
): Promise<{ status: number; frames: SseFrame[]; contentType: string | null }> {
  const res = await request(`/tasks/${taskId}/events/stream`, opts);
  const sse = new SseReader(res.body!.getReader());
  try {
    const frames = opts.count === null ? await sse.drain() : await sse.take(opts.count);
    return { status: res.status, frames, contentType: res.headers.get("content-type") };
  } finally {
    await sse.cancel();
  }
}

beforeAll(applyMigrations);

describe("GET /tasks/:id/events/stream", () => {
  it("RUNNING 即可回放全部已有事件:Content-Type、id 从 1 起严格递增、data 可解析回信封", async () => {
    const { taskId, attemptIds } = await seedTask([5]);
    const { status, frames, contentType } = await readStream(taskId, { count: 5 });
    expect(status).toBe(200);
    expect(contentType).toBe("text/event-stream; charset=utf-8");
    expect(SseReader.eventIds(frames)).toEqual([1, 2, 3, 4, 5]);

    const events = SseReader.events(frames);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(events.every((e) => e.attempt_id === attemptIds[0])).toBe(true);
    expect(events.every((e) => e.v === 1 && typeof e.ts === "string")).toBe(true);
    // 一帧一个 data 行:自由文本再长也不拆帧(否则位置游标与续传点全部失真)
    for (const f of frames) {
      expect(f.raw.split("\n").filter((l) => l.startsWith("data:")).length).toBe(1);
      expect(f.raw.startsWith(`id: ${f.id}\nevent: agent\ndata: `)).toBe(true);
    }
  });

  it("缺省从流头回放,不重发也不漏读:与 GET /events 一次读全逐条相同", async () => {
    const { taskId } = await seedTask([3, 2], { terminal: true });
    expect(taskId).toBeTruthy();
    const { frames } = await readStream(taskId, { count: 6 });
    const streamed = SseReader.events(frames);
    const paged = (await (await request(`/tasks/${taskId}/events`)).json()) as EventsBody;
    expect(streamed.map(ident)).toEqual(paged.events.map(ident));
    expect(SseReader.eventIds(frames)).toEqual([1, 2, 3, 4, 5]);
    expect(paged.total).toBe(5);
  });

  it("断点续传:Last-Event-ID: 2 → 只收到 id 为 3、4、5 的三帧", async () => {
    const { taskId } = await seedTask([5], { terminal: true });
    const { frames } = await readStream(taskId, { lastEventId: "2", count: 4 });
    expect(SseReader.eventIds(frames)).toEqual([3, 4, 5]);
    expect(SseReader.events(frames).map((e) => e.seq)).toEqual([3, 4, 5]);
    expect(frames[3].event).toBe("end");
    expect(frames[3].id, "end 帧 id = 总条数,与最后一个事件帧同口径").toBe(5);
  });

  it("往返自洽:最后一帧的 id 喂给 /events?after= 与当 Last-Event-ID 都是 0 重发", async () => {
    const { taskId } = await seedTask([5], { terminal: true });
    const { frames } = await readStream(taskId, { count: 6 });
    const lastId = SseReader.eventIds(frames)[SseReader.eventIds(frames).length - 1];
    expect(lastId).toBe(5);

    const paged = (await (await request(`/tasks/${taskId}/events?after=${lastId}`)).json()) as EventsBody;
    expect(paged.events).toEqual([]);
    expect(paged.total).toBe(5);

    const again = await readStream(taskId, { lastEventId: String(lastId), count: 1 });
    expect(SseReader.eventIds(again.frames), "续传点之后没有第二条可读").toEqual([]);
    expect(again.frames[0].event).toBe("end");
    expect(again.frames[0].id).toBe(5);
  });

  it("口径同源的可执行证据:中间帧 id=2 时,?after=2 与 Last-Event-ID: 2 读出同一批事件", async () => {
    const { taskId } = await seedTask([5], { terminal: true });
    const paged = (await (await request(`/tasks/${taskId}/events?after=2`)).json()) as EventsBody;
    const stream = await readStream(taskId, { lastEventId: "2", count: 4 });
    const eventFrames = stream.frames.filter((f) => f.event === "agent");
    expect(eventFrames.map((f) => f.id)).toEqual([3, 4, 5]);
    expect(SseReader.events(stream.frames).map(ident)).toEqual(paged.events.map(ident));
    expect(SseReader.events(stream.frames).map((f) => f.seq)).toEqual(paged.events.map((e) => e.seq));
  });

  it("end 帧:任务离开 RUNNING 且增量推完 → 一帧 end 后流关闭", async () => {
    const { taskId, state } = await seedTask([4], { terminal: true });
    expect(state).toBe("BLOCKED");
    const res = await request(`/tasks/${taskId}/events/stream`);
    const sse = new SseReader(res.body!.getReader());
    try {
      const frames = await sse.drain();
      expect(frames.length, "4 事件 + 1 end,不多不少(关掉即收敛)").toBe(5);
      expect(frames.map((f) => f.event)).toEqual(["agent", "agent", "agent", "agent", "end"]);
      expect(frames[4].id).toBe(4);
      expect(JSON.parse(frames[4].data!)).toMatchObject({ task_id: taskId, events: 4 });
    } finally {
      await sse.cancel();
    }
  });

  it("非法 Last-Event-ID → 400 invalid_last_event_id;header 缺省 = 0 合法", async () => {
    const { taskId } = await seedTask([1]);
    for (const raw of ["abc", "-1", "1.5", "", "   ", "1e400", "0x10"]) {
      const res = await request(`/tasks/${taskId}/events/stream`, { lastEventId: raw });
      expect(res.status, `last-event-id=${JSON.stringify(raw)} 应被拒绝`).toBe(400);
      expect(((await res.json()) as ErrorBody).error.type).toBe("invalid_last_event_id");
    }
    // 合法值开的是真流:读完必须取消,否则在 workerd 里留一个还在等下一拍的泵。
    const ok = await request(`/tasks/${taskId}/events/stream`, { lastEventId: "0" });
    expect(ok.status).toBe(200);
    await ok.body!.cancel();
  });

  it("鉴权与 /events 同一条 checkApiToken 路径;任务不存在 → 404", async () => {
    expect(TOKEN).toBeTruthy();
    const { taskId } = await seedTask([1]);
    expect((await request(`/tasks/${taskId}/events/stream`, { token: null })).status).toBe(401);
    expect((await request(`/tasks/${taskId}/events/stream`, { token: "wrong" })).status).toBe(401);
    const missing = await request(`/tasks/${crypto.randomUUID()}/events/stream`);
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as ErrorBody).error.type).toBe("not_found");
  });

  it("某 attempt 的 journal 读坏:流不死,坏的那个进 end 帧的 unreadable_attempts", async () => {
    const { taskId, attemptIds } = await seedTask([2, 2], { terminal: true });
    await env.ARTIFACTS.put(obsIndexPath(taskId, attemptIds[0]), "not json");
    const { frames } = await readStream(taskId, { count: 3 });
    expect(SseReader.events(frames).map((e) => e.seq)).toEqual([1, 2]);
    expect(SseReader.events(frames).every((e) => e.attempt_id === attemptIds[1])).toBe(true);
    const end = frames[2];
    expect(end.event).toBe("end");
    expect(JSON.parse(end.data!).unreadable_attempts).toEqual([attemptIds[0]]);
  });

  it("没有 /live、没有任何 HTML:本期只做 SSE 投影(下半是下一期)", async () => {
    const res = await request("/live");
    expect(res.status).toBe(404);
    const html = await (await request("/")).text();
    expect(html).not.toContain("/events/stream");
    expect(html).not.toContain("text/event-stream");
  });
});
