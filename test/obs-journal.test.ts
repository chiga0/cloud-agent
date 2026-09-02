import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import {
  OBS_SEGMENT_EVENTS,
  loadObsIndex,
  obsIndexPath,
  obsSegmentKey,
  readObsAttemptEvents,
  type ObsIndexV1,
} from "../src/obs/journal";
import { ingestObsBestEffort, ingestTranscript, takeCompleteLines, type ObsTranscriptReader } from "../src/obs/ingest";
import type { AgentEventV1 } from "../src/obs/events";

/**
 * Observation 层的存储与游标:R2 段文件 journal + poll 相增量摄取。
 *
 * 钉住的四件事都是 durable 重放/悬挂取证会真踩的:
 * - 增量:**只**发新行,不完整尾行留在原地;
 * - 幂等:durable 重放把同一批字节喂第二次,事件数不变(游标存在 journal 里,
 *   不存在 workflow 的 step 返回值里 —— 重放下携带式游标必然滞后);
 * - 换代:transcript 被替换/截断时开新代,旧代段一个字节都不动,seq 不串号;
 * - 段滚动:写满开新段,已写满的段不再重写(R2 无 append,开放段只增不减)。
 *
 * R2 走 pool-workers 的真实 miniflare 实例,不用手搓假桶:游标一致性依赖 put 的
 * 原子性与 get 的读己写语义,假桶最容易把这俩糊过去。
 */

const TASK = "11111111-1111-4111-8111-111111111111";
const ATTEMPT = "22222222-2222-4222-8222-222222222222";
const TS = "2026-09-01T00:00:00.000Z";
const BUCKET = env.ARTIFACTS;

/** 假 transcript:长命令的 stdout 是追加写的文件,这里按同样形状造。 */
function fakeTranscript() {
  let content = "";
  const reader: ObsTranscriptReader = {
    async readFile() {
      return { content };
    },
  };
  return {
    reader,
    set: (s: string) => {
      content = s;
    },
    append: (s: string) => {
      content += s;
    },
    get text() {
      return content;
    },
  };
}

function line(over: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ type: "assistant", content: [{ type: "text", text: "step" }], ...over })}\n`;
}

function lines(n: number, from = 1): string {
  return Array.from({ length: n }, (_, i) => line({ seq_hint: from + i })).join("");
}

function ingest(taskId: string, attemptId: string, reader: ObsTranscriptReader, bucket = BUCKET) {
  return ingestTranscript({ bucket, reader, taskId, attemptId, now: () => TS });
}

function readAll(taskId = TASK, attemptId = ATTEMPT, skip = 0) {
  return readObsAttemptEvents(BUCKET, taskId, attemptId, skip);
}

/** 记录每次 put 的桶代理:验证「已写满的段不再被重写」要看写入轨迹,光看最终态看不出来。 */
function recordingBucket(bucket: R2Bucket) {
  const puts: string[] = [];
  const wrapped = {
    async put(key: string, value: string | ArrayBuffer, options?: R2PutOptions) {
      puts.push(key);
      return bucket.put(key, value, options);
    },
    async get(key: string) {
      return bucket.get(key);
    },
  };
  return { bucket: wrapped as unknown as R2Bucket, puts };
}

async function segmentBody(key: string): Promise<AgentEventV1[]> {
  const obj = await BUCKET.get(key);
  if (!obj) throw new Error(`missing segment ${key}`);
  return (await obj.text())
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as AgentEventV1);
}

const freshAttempt = () => crypto.randomUUID();

describe("takeCompleteLines", () => {
  const enc = new TextEncoder();

  it("只按完整行推进偏移,尾行原样留着", () => {
    const bytes = enc.encode("a\nb\nc");
    const r = takeCompleteLines(bytes, 0);
    expect(r.lines).toEqual(["a", "b"]);
    expect(r.consumed_bytes).toBe(4);
    expect(r.tail_bytes).toBe(1);
  });

  it("从已消费偏移起只看窗口:空窗口 0 行 0 推进", () => {
    const bytes = enc.encode("a\nb\n");
    expect(takeCompleteLines(bytes, 4)).toEqual({ lines: [], consumed_bytes: 0, tail_bytes: 0 });
  });

  it("没有换行符时整窗口都是余量;空行占字节但不产事件", () => {
    expect(takeCompleteLines(enc.encode("partial"), 0).tail_bytes).toBe(7);
    // 完整窗口是 "a\n\n\n":两个空行推进字节偏移,却不产事件("b" 还是尾行余量)
    const blank = takeCompleteLines(enc.encode("a\n\n\nb"), 0);
    expect(blank.lines).toEqual(["a"]);
    expect(blank.consumed_bytes).toBe(4);
    expect(blank.tail_bytes).toBe(1);
  });
});

describe("增量摄取", () => {
  it("每轮只发新增的完整行,seq 在代内连续", async () => {
    const t = fakeTranscript();
    const attemptId = freshAttempt();
    t.set(line() + line());
    expect(await ingest(TASK, attemptId, t.reader)).toMatchObject({ events: 2, generation: 1, max_seq: 2 });

    t.append(line());
    expect(await ingest(TASK, attemptId, t.reader)).toMatchObject({ events: 1, max_seq: 3 });

    const { events, total } = await readAll(TASK, attemptId);
    expect(total).toBe(3);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(events.every((e) => e.attempt_id === attemptId && e.task_id === TASK)).toBe(true);
  });

  it("不完整尾行不进事件流,下一轮拼齐后只产一条", async () => {
    const t = fakeTranscript();
    const attemptId = freshAttempt();
    const half = '{"type":"assistant","content":[{"type":"text","text":"写完了一半"';
    t.set(line() + half);

    const first = await ingest(TASK, attemptId, t.reader);
    expect(first.events).toBe(1);
    expect(first.tail_held_bytes).toBe(new TextEncoder().encode(half).byteLength);
    const idx = await loadObsIndex(BUCKET, TASK, attemptId);
    expect(idx!.offset_bytes).toBe(new TextEncoder().encode(line()).byteLength);

    t.append("}]}\n");
    const second = await ingest(TASK, attemptId, t.reader);
    expect(second.events).toBe(1);
    expect(second.max_seq).toBe(2);

    const { events } = await readAll(TASK, attemptId);
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
    expect(events[1].payload.text).toBe("写完了一半");
  });

  it("重放幂等:同一批字节喂两次,事件数与段内容都不变", async () => {
    const t = fakeTranscript();
    const attemptId = freshAttempt();
    t.set(lines(3));
    await ingest(TASK, attemptId, t.reader);
    const before = await loadObsIndex(BUCKET, TASK, attemptId);

    for (let round = 0; round < 3; round++) {
      const again = await ingest(TASK, attemptId, t.reader);
      expect(again.events).toBe(0);
      expect(again.segments_written).toEqual([]);
    }
    const after = await loadObsIndex(BUCKET, TASK, attemptId);
    expect(after).toEqual(before);
    expect((await readAll(TASK, attemptId)).events).toHaveLength(3);
  });

  it("step 重试时旧游标滞后也不会重发:游标读自已存 index,不靠调用方携带", async () => {
    const t = fakeTranscript();
    const attemptId = freshAttempt();
    t.set(lines(4));
    await ingest(TASK, attemptId, t.reader);
    // 模拟驱逐后 step 用旧的内存游标重跑同一轮:同一入口再调一次即可,结果必须为空
    const replay = await ingest(TASK, attemptId, t.reader);
    expect(replay).toMatchObject({ events: 0, generation: 1, offset_bytes: replay.offset_bytes });
    expect(replay.offset_bytes).toBe(new TextEncoder().encode(lines(4)).byteLength);
  });

  it("无新增完整行时不落任何写(30s 空轮询不该刷 R2 小对象)", async () => {
    const t = fakeTranscript();
    const attemptId = freshAttempt();
    const { bucket, puts } = recordingBucket(BUCKET);
    t.set(lines(2));
    await ingest(TASK, attemptId, t.reader, bucket);
    const round1 = puts.length;
    expect(round1).toBeGreaterThan(0);

    await ingest(TASK, attemptId, t.reader, bucket);
    expect(puts).toHaveLength(round1);
  });
});

describe("generation 换代", () => {
  it("transcript 被替换:开新代、seq 重开、旧代段一字不动", async () => {
    const t = fakeTranscript();
    const attemptId = freshAttempt();
    t.set(lines(2));
    await ingest(TASK, attemptId, t.reader);
    const g1Key = obsSegmentKey(TASK, attemptId, 1, 1);
    const g1Before = await segmentBody(g1Key);

    // 容器重启后 longrun.sh 的 `>` 重定向把文件清成了另一轮执行的输出。
    // 有意让新文件比旧游标长:这时「变短」判不出来,只有前缀指纹能救。
    t.set(line({ type: "system", subtype: "init" }) + lines(5));
    const r = await ingest(TASK, attemptId, t.reader);
    expect(r).toMatchObject({ generation: 2, events: 6, max_seq: 6, bumped: "transcript_replaced" });

    expect(await segmentBody(g1Key)).toEqual(g1Before);
    const idx = await loadObsIndex(BUCKET, TASK, attemptId);
    expect(idx!.generation).toBe(2);
    expect(idx!.segments.map((s) => [s.generation, s.seg, s.first_seq, s.last_seq])).toEqual([
      [1, 1, 1, 2],
      [2, 1, 1, 6],
    ]);

    const { events, total } = await readAll(TASK, attemptId);
    expect(total).toBe(8);
    expect(events.map((e) => `${e.generation}:${e.seq}`)).toEqual([
      "1:1",
      "1:2",
      "2:1",
      "2:2",
      "2:3",
      "2:4",
      "2:5",
      "2:6",
    ]);
    expect(events[2].kind).toBe("system");
  });

  it("文件变短同样换代(旧偏移已失去意义)", async () => {
    const t = fakeTranscript();
    const attemptId = freshAttempt();
    t.set(lines(5));
    await ingest(TASK, attemptId, t.reader);
    t.set(line());
    const r = await ingest(TASK, attemptId, t.reader);
    expect(r.bumped).toBe("transcript_shrunk");
    expect(r.generation).toBe(2);
  });

  it("换代时还没有完整行:游标照样提交,不会每轮重复换代", async () => {
    const t = fakeTranscript();
    const attemptId = freshAttempt();
    t.set(lines(2));
    await ingest(TASK, attemptId, t.reader);

    t.set('{"type":"assistant"');
    const r = await ingest(TASK, attemptId, t.reader);
    expect(r).toMatchObject({ generation: 2, events: 0, bumped: "transcript_shrunk" });
    const idx = await loadObsIndex(BUCKET, TASK, attemptId);
    expect(idx!.generation).toBe(2);
    expect(idx!.offset_bytes).toBe(0);

    // 下一轮同一份内容:必须还是 2 代,而不是又 +1
    expect((await ingest(TASK, attemptId, t.reader)).generation).toBe(2);
  });

  it("前缀指纹比长度更可靠:替换成「不短于偏移但更短」的文件也算换代", async () => {
    const t = fakeTranscript();
    const attemptId = freshAttempt();
    t.set(lines(2));
    await ingest(TASK, attemptId, t.reader);

    // 第一次靠「变短」抓到
    t.set('{"type":"assistant"');
    expect((await ingest(TASK, attemptId, t.reader)).bumped).toBe("transcript_shrunk");

    // 第二次文件比新偏移长、却比取样前缀短:只有前缀指纹能抓到
    t.set('{"typ');
    const r = await ingest(TASK, attemptId, t.reader);
    expect(r.bumped).toBe("transcript_replaced");
    expect(r.generation).toBe(3);
    const idx = await loadObsIndex(BUCKET, TASK, attemptId);
    expect(idx!.generation).toBe(3);
    expect(idx!.offset_bytes).toBe(0);
  });

  it("同代不重不漏:换代后旧代的事件仍按原顺序读得到", async () => {
    const attemptId = freshAttempt();
    const t1 = fakeTranscript();
    t1.set(lines(2));
    await ingest(TASK, attemptId, t1.reader);
    const t2 = fakeTranscript();
    t2.set(lines(1));
    await ingest(TASK, attemptId, t2.reader);

    const { events } = await readAll(TASK, attemptId);
    expect(events.map((e) => e.generation)).toEqual([1, 1, 2]);
    expect(events.map((e) => e.kind)).toEqual(["assistant", "assistant", "assistant"]);
  });
});

describe("段滚动与 index", () => {
  it("450 条 → 200/200/50 三段,index 记录每段首末 seq 与条数", async () => {
    const attemptId = freshAttempt();
    const t = fakeTranscript();
    t.set(lines(450));
    const r = await ingest(TASK, attemptId, t.reader);
    expect(r.segments_written).toEqual([
      obsSegmentKey(TASK, attemptId, 1, 1),
      obsSegmentKey(TASK, attemptId, 1, 2),
      obsSegmentKey(TASK, attemptId, 1, 3),
    ]);

    const idx = await loadObsIndex(BUCKET, TASK, attemptId);
    expect(idx!.event_count).toBe(450);
    expect(idx!.max_seq).toBe(450);
    expect(idx!.segments.map((s) => s.count)).toEqual([200, 200, 50]);
    expect(idx!.segments.map((s) => [s.first_seq, s.last_seq])).toEqual([
      [1, 200],
      [201, 400],
      [401, 450],
    ]);
    expect(idx!.v).toBe(1);
    expect(idx!.task_id).toBe(TASK);
    expect(idx!.attempt_id).toBe(attemptId);
  });

  it("开放段写满前同 key 增长,写满后即封盘不再重写", async () => {
    const attemptId = freshAttempt();
    const t = fakeTranscript();
    const { bucket, puts } = recordingBucket(BUCKET);
    const seg = (n: number) => obsSegmentKey(TASK, attemptId, 1, n);
    const jsonlPuts = () => puts.filter((k) => k.endsWith(".jsonl"));

    t.set(lines(3));
    await ingest(TASK, attemptId, t.reader, bucket);
    expect(jsonlPuts()).toEqual([seg(1)]);

    // 第 1 段没写满 → 同 key 重写(内容只增不减):R2 没有 append,这已是能做到的下限
    t.append(lines(2));
    await ingest(TASK, attemptId, t.reader, bucket);
    expect(await segmentBody(seg(1))).toHaveLength(5);
    expect(jsonlPuts()).toEqual([seg(1), seg(1)]);

    t.append(lines(OBS_SEGMENT_EVENTS - 5));
    await ingest(TASK, attemptId, t.reader, bucket);
    expect(jsonlPuts()).toEqual([seg(1), seg(1), seg(1)]);
    const sealed = await segmentBody(seg(1));
    expect(sealed).toHaveLength(OBS_SEGMENT_EVENTS);

    // 满段之后的新事件只进新段:第 1 段既不再被 put,内容也不变
    t.append(lines(4));
    await ingest(TASK, attemptId, t.reader, bucket);
    expect(jsonlPuts()).toEqual([seg(1), seg(1), seg(1), seg(2)]);
    expect(await segmentBody(seg(1))).toEqual(sealed);

    const idx = await loadObsIndex(BUCKET, TASK, attemptId);
    expect(idx!.segments.map((s) => s.count)).toEqual([OBS_SEGMENT_EVENTS, 4]);
    expect(idx!.max_seq).toBe(OBS_SEGMENT_EVENTS + 4);
    const all = (await readAll(TASK, attemptId)).events;
    expect(all.map((e) => e.seq)).toEqual(
      Array.from({ length: OBS_SEGMENT_EVENTS + 4 }, (_, i) => i + 1),
    );
  });

  it("每 attempt 一份 index.json,段文件按 g<gen>-seg<N>.jsonl 命名", async () => {
    const attemptId = freshAttempt();
    const t = fakeTranscript();
    t.set(line());
    await ingest(TASK, attemptId, t.reader);
    expect(await loadObsIndex(BUCKET, TASK, attemptId)).not.toBeNull();
    expect((await BUCKET.get(obsSegmentKey(TASK, attemptId, 1, 1)))!.key).toBe(
      `obs/${TASK}/${attemptId}/g1-seg1.jsonl`,
    );
    expect((await BUCKET.get(obsIndexPath(TASK, attemptId)))!.key).toBe(
      `obs/${TASK}/${attemptId}/index.json`,
    );
  });

  it("读坏掉的 index 即抛,不当成「还没有」而覆盖旧段", async () => {
    const attemptId = freshAttempt();
    const t = fakeTranscript();
    t.set(line());
    await ingest(TASK, attemptId, t.reader);
    await BUCKET.put(obsIndexPath(TASK, attemptId), '{"v":1,"segments":"nope"}');
    await expect(loadObsIndex(BUCKET, TASK, attemptId)).rejects.toThrow(/obs_index_malformed/);
    // 摄取侧因此整轮跳过:旧段文件一个字节都没被改写
    const r = await ingestObsBestEffort(env, { taskId: TASK, attemptId, reader: t.reader });
    expect(r).toBeNull();
    expect((await BUCKET.get(obsSegmentKey(TASK, attemptId, 1, 1)))!.key).toBeTruthy();
  });

  it("index 的游标与段清单不一致时拒写(换代不串号的最后防线)", async () => {
    const attemptId = freshAttempt();
    const t = fakeTranscript();
    t.set(line());
    await ingest(TASK, attemptId, t.reader);
    const idx = (await loadObsIndex(BUCKET, TASK, attemptId))!;
    await BUCKET.put(obsIndexPath(TASK, attemptId), JSON.stringify({ ...idx, max_seq: 99 } as ObsIndexV1));
    t.append(line());
    const r = await ingestObsBestEffort(env, { taskId: TASK, attemptId, reader: t.reader });
    expect(r).toBeNull();
    // 原段文件没被动过
    expect(await segmentBody(obsSegmentKey(TASK, attemptId, 1, 1))).toHaveLength(1);
  });
});

describe("摄取失败不杀 poll 相", () => {
  it("读文件抛错 → 记 stderr 返回 null,游标停在原地等下一轮", async () => {
    const attemptId = freshAttempt();
    const boom: ObsTranscriptReader = {
      async readFile() {
        throw new Error("FileNotFoundError: /tmp/longrun-stdout");
      },
    };
    expect(await ingestObsBestEffort(env, { taskId: TASK, attemptId, reader: boom })).toBeNull();
    expect(await loadObsIndex(BUCKET, TASK, attemptId)).toBeNull();

    // 下一轮文件出现:从第 1 条开始,不欠账
    const t = fakeTranscript();
    t.set(lines(2));
    expect(await ingestObsBestEffort(env, { taskId: TASK, attemptId, reader: t.reader })).toMatchObject({
      events: 2,
      generation: 1,
    });
  });
});
