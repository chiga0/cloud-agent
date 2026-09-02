/**
 * Observation 层的存储:R2 段文件 journal。
 *
 * 布局(`obs/` 前缀复用现有 ARTIFACTS 桶,不新增绑定):
 *   obs/<task_id>/<attempt_id>/g<generation>-seg<N>.jsonl   每段定长 OBS_SEGMENT_EVENTS 条
 *   obs/<task_id>/<attempt_id>/index.json                   每 attempt 一份:段清单 + 摄取游标
 *
 * 为什么不进 D1、不建 hash chain:这一层非权威(见 src/obs/events.ts 顶部)。D1 行存
 * 要为每条事件付一次写事务,而 30s 一轮的旁路摄取根本不该和权威写路径抢资源;
 * hash chain 的价值是「防篡改」,观测事件的价值是「现在在干什么」—— 后者要的是
 * 读得到、读得快,不是可核验。
 *
 * 「append-only」在 R2 上的诚实实现:R2 没有 append 原语,所以一段在**写满之前**
 * 是同一 key 的重写(内容只增不减,已可见事件的字节不变),写满后即永不再动。
 * index.json 是提交点:段先写、index 后写,中途崩溃只会让下一轮重写同一批段,
 * 不会产生重号也不会产生空洞。
 */

import { sha256Hex } from "../audit/evidence";
import type { AgentEventV1 } from "./events";

export const OBS_JOURNAL_PREFIX = "obs";
/** 每段事件数。200 条 ≈ 一次长任务几十轮的产出;段太大读端点要整段拉,太小对象数暴涨。 */
export const OBS_SEGMENT_EVENTS = 200;
export const OBS_INDEX_FILE = "index.json";
export const OBS_INDEX_V = 1;

export interface ObsSegmentRef {
  /** 段号(1 起,代内递增) */
  seg: number;
  generation: number;
  key: string;
  first_seq: number;
  last_seq: number;
  count: number;
}

/** index.json 的当前代游标。跨代的段只留在 segments 里,游标只描述当前代。 */
export interface ObsIndexV1 {
  v: 1;
  task_id: string;
  attempt_id: string;
  generation: number;
  /** 当前代已消费的 transcript 字节数:只按完整行推进 */
  offset_bytes: number;
  /** 当前代的已存最大 seq(= 该代的条数起点);换代后重新从 1 起 */
  max_seq: number;
  /** 当前代已落段的事件条数 */
  event_count: number;
  /** transcript 前缀指纹的取样长度与摘要:识别「文件被替换/截断」= 换代 */
  head_len: number;
  head_digest: string;
  segments: ObsSegmentRef[];
  created_at: string;
  updated_at: string;
}

export function obsAttemptPrefix(taskId: string, attemptId: string): string {
  return `${OBS_JOURNAL_PREFIX}/${taskId}/${attemptId}`;
}

export function obsIndexPath(taskId: string, attemptId: string): string {
  return `${obsAttemptPrefix(taskId, attemptId)}/${OBS_INDEX_FILE}`;
}

export function obsSegmentKey(
  taskId: string,
  attemptId: string,
  generation: number,
  seg: number,
): string {
  return `${obsAttemptPrefix(taskId, attemptId)}/g${generation}-seg${seg}.jsonl`;
}

function isSegmentRef(value: unknown): value is ObsSegmentRef {
  const r = value as ObsSegmentRef | null;
  return !!(
    r &&
    typeof r.key === "string" &&
    typeof r.seg === "number" &&
    typeof r.generation === "number" &&
    typeof r.first_seq === "number" &&
    typeof r.last_seq === "number" &&
    typeof r.count === "number"
  );
}

/**
 * 读 index.json。缺文件 → null(还没摄取过);**形状不对即抛**而不是当 null:
 * 把一个读不懂的 index 当「没有」会让下一轮从 seg1/seq1 起重写,正好覆盖掉已经
 * 存在的那批段 —— 静默丢观测。抛出去由摄取侧记 stderr、跳本轮。
 */
export async function loadObsIndex(
  bucket: R2Bucket,
  taskId: string,
  attemptId: string,
): Promise<ObsIndexV1 | null> {
  const obj = await bucket.get(obsIndexPath(taskId, attemptId));
  if (!obj) return null;
  const parsed = (await obj.json()) as unknown;
  const idx = parsed as ObsIndexV1 | null;
  if (
    !idx ||
    idx.v !== OBS_INDEX_V ||
    idx.task_id !== taskId ||
    idx.attempt_id !== attemptId ||
    typeof idx.generation !== "number" ||
    typeof idx.offset_bytes !== "number" ||
    typeof idx.max_seq !== "number" ||
    !Array.isArray(idx.segments) ||
    !idx.segments.every(isSegmentRef)
  ) {
    throw new Error(`obs_index_malformed task=${taskId} attempt=${attemptId}`);
  }
  return idx;
}

function encodeJsonl(events: AgentEventV1[]): string {
  return `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;
}

/** 段文件逐行解析;坏行跳过而非抛 —— 一段里坏一行不该让整条读端点 500。 */
function decodeJsonl(body: string): AgentEventV1[] {
  const out: AgentEventV1[] = [];
  for (const line of body.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const evt = JSON.parse(line) as AgentEventV1;
      if (evt && typeof evt === "object" && typeof evt.seq === "number") out.push(evt);
    } catch {
      console.warn(`obs_segment_line_unparseable ${line.slice(0, 80)}`);
    }
  }
  return out;
}

async function readSegment(bucket: R2Bucket, key: string): Promise<string> {
  const obj = await bucket.get(key);
  if (!obj) throw new Error(`obs_segment_missing key=${key}`);
  return obj.text();
}

/** 段的落盘顺序:代升序、段号升序 —— 读端点的有序返回直接依赖这个次序。 */
function segmentOrder(a: ObsSegmentRef, b: ObsSegmentRef): number {
  return a.generation !== b.generation ? a.generation - b.generation : a.seg - b.seg;
}

/** 某代已写满/未满各段的最后 seq;该代无段即 0。 */
function lastSeqOf(segments: readonly ObsSegmentRef[], generation: number): number {
  const inGen = segments.filter((s) => s.generation === generation);
  return inGen.length > 0 ? inGen[inGen.length - 1].last_seq : 0;
}

/** 游标 → index 对象(段清单是唯一的条数真源,max_seq/event_count 都从它派生)。 */
function buildIndex(
  taskId: string,
  attemptId: string,
  prev: ObsIndexV1 | null,
  cursor: ObsRoundCursor,
  segments: ObsSegmentRef[],
  now: string,
): ObsIndexV1 {
  return {
    v: OBS_INDEX_V,
    task_id: taskId,
    attempt_id: attemptId,
    generation: cursor.generation,
    offset_bytes: cursor.offset_bytes,
    max_seq: lastSeqOf(segments, cursor.generation),
    event_count: segments
      .filter((s) => s.generation === cursor.generation)
      .reduce((n, s) => n + s.count, 0),
    head_len: cursor.head_len,
    head_digest: cursor.head_digest,
    segments: segments.slice().sort(segmentOrder),
    created_at: prev?.created_at ?? now,
    updated_at: now,
  };
}

async function putIndex(
  bucket: R2Bucket,
  index: ObsIndexV1,
): Promise<ObsIndexV1> {
  await bucket.put(obsIndexPath(index.task_id, index.attempt_id), JSON.stringify(index, null, 2), {
    customMetadata: {
      task_id: index.task_id,
      attempt_id: index.attempt_id,
      generation: String(index.generation),
      max_seq: String(index.max_seq),
      event_count: String(index.event_count),
    },
  });
  return index;
}

export interface ObsRoundCursor {
  generation: number;
  offset_bytes: number;
  head_len: number;
  head_digest: string;
}

/**
 * 提交一轮摄取:先把事件滚进段文件,最后写 index(提交点)。
 *
 * 事件必须与 args.prev 的游标自洽(seq 从 max_seq+1 起、generation 与游标同代)。
 * 这条自洽检查不是防御性装饰 —— 它是「换代不串号」的唯一防线:一旦上面算游标的
 * 规则和这里的写入对不上,后果是同一代里出现两段重叠 seq,读端点按 seq 分页就会
 * 静默重放或漏读。宁可抛。
 */
export async function commitObsRound(
  bucket: R2Bucket,
  args: {
    taskId: string;
    attemptId: string;
    events: AgentEventV1[];
    cursor: ObsRoundCursor;
    prev: ObsIndexV1 | null;
    now: string;
  },
): Promise<{ index: ObsIndexV1; written: string[] }> {
  const { taskId, attemptId, events, cursor, prev } = args;
  if (events.length === 0) throw new Error("obs_commit_empty");

  // 深拷一份段引用:下面要就地改开放段的 count/last_seq,不能把调用方手上的 prev 一起改了
  const segments = (prev?.segments ?? []).map((s) => ({ ...s })).sort(segmentOrder);
  const sameGen = segments.filter((s) => s.generation === cursor.generation);
  const otherGen = segments.filter((s) => s.generation !== cursor.generation);

  let expectFirst = 1;
  if (prev && cursor.generation === prev.generation) {
    const bySegments = lastSeqOf(prev.segments, cursor.generation);
    // index 的游标字段与段清单各说各话 = 上一次提交半途而废或被外部改动。
    // 这里绝不选一个「看起来对」的值继续写:那会把新事件写进重叠的 seq 区间。
    if (prev.max_seq !== bySegments) {
      throw new Error(
        `obs_index_inconsistent task=${taskId} attempt=${attemptId} ` +
          `max_seq=${prev.max_seq} segments=${bySegments}`,
      );
    }
    expectFirst = bySegments + 1;
  }
  if (events[0].seq !== expectFirst) {
    throw new Error(
      `obs_commit_seq_discontinuity task=${taskId} attempt=${attemptId} ` +
        `generation=${cursor.generation} first=${events[0].seq} expected=${expectFirst}`,
    );
  }
  for (const evt of events) {
    if (evt.generation !== cursor.generation || evt.task_id !== taskId || evt.attempt_id !== attemptId) {
      throw new Error(`obs_commit_envelope_mismatch task=${taskId} attempt=${attemptId} seq=${evt.seq}`);
    }
  }

  const written: string[] = [];
  const pending = events.slice();

  // 1) 先填满当代那个未写满的开放段(读回已可见的事件,追加增量,同 key 重写)
  const open = sameGen[sameGen.length - 1];
  if (open && open.count < OBS_SEGMENT_EVENTS) {
    const existing = decodeJsonl(await readSegment(bucket, open.key));
    if (existing.length !== open.count) {
      throw new Error(
        `obs_segment_count_drift key=${open.key} index=${open.count} body=${existing.length}`,
      );
    }
    if (existing.length > 0 && existing[existing.length - 1].seq + 1 !== pending[0].seq) {
      throw new Error(`obs_segment_seq_discontinuity key=${open.key}`);
    }
    const room = OBS_SEGMENT_EVENTS - existing.length;
    const take = pending.splice(0, Math.min(room, pending.length));
    if (take.length > 0) {
      const body = encodeJsonl(existing.concat(take));
      await bucket.put(open.key, body, {
        customMetadata: {
          task_id: taskId,
          attempt_id: attemptId,
          generation: String(cursor.generation),
          first_seq: String(existing[0]?.seq ?? take[0].seq),
          last_seq: String(take[take.length - 1].seq),
          count: String(existing.length + take.length),
        },
      });
      written.push(open.key);
      open.count = existing.length + take.length;
      open.last_seq = take[take.length - 1].seq;
    }
  }

  // 2) 剩下的按定长开新段(含末尾未满的一段:未满也要落盘,否则本轮事件不可见)
  while (pending.length > 0) {
    const take = pending.splice(0, OBS_SEGMENT_EVENTS);
    const seg = (sameGen[sameGen.length - 1]?.seg ?? 0) + 1;
    const key = obsSegmentKey(taskId, attemptId, cursor.generation, seg);
    await bucket.put(key, encodeJsonl(take), {
      customMetadata: {
        task_id: taskId,
        attempt_id: attemptId,
        generation: String(cursor.generation),
        first_seq: String(take[0].seq),
        last_seq: String(take[take.length - 1].seq),
        count: String(take.length),
      },
    });
    written.push(key);
    sameGen.push({
      seg,
      generation: cursor.generation,
      key,
      first_seq: take[0].seq,
      last_seq: take[take.length - 1].seq,
      count: take.length,
    });
  }

  const index = await putIndex(
    bucket,
    buildIndex(taskId, attemptId, prev, cursor, otherGen.concat(sameGen), args.now),
  );
  return { index, written };
}

/**
 * 按序读出某 attempt 的全部事件(代升序 → 段升序 → 段内 seq 升序)。
 * `skip` 是「跳过前 N 条」:整段能跳过的直接不下载,读端点的 after 分页靠它。
 */
export async function readObsAttemptEvents(
  bucket: R2Bucket,
  taskId: string,
  attemptId: string,
  skip = 0,
): Promise<{ events: AgentEventV1[]; total: number }> {
  const index = await loadObsIndex(bucket, taskId, attemptId);
  if (!index) return { events: [], total: 0 };
  const segments = index.segments.slice().sort(segmentOrder);
  const total = segments.reduce((n, s) => n + s.count, 0);

  // 先用段清单(每段条数是 index 里的承诺)定位 after 落在哪一段,整段能跳过的不下载
  let start = segments.length;
  let drop = 0;
  for (let i = 0, acc = 0; i < segments.length; i++) {
    if (skip < acc + segments[i].count) {
      start = i;
      drop = skip - acc;
      break;
    }
    acc += segments[i].count;
  }

  const events: AgentEventV1[] = [];
  for (let i = start; i < segments.length; i++) {
    const parsed = decodeJsonl(await readSegment(bucket, segments[i].key));
    events.push(...(i === start ? parsed.slice(drop) : parsed));
  }
  return { events, total };
}

/** transcript 前缀指纹的取样长度:4 KiB 够住 init 行的 session/模型/凭据形状。 */
export const OBS_HEAD_BYTES = 4096;

/** 字节切片 → sha256。先 slice() 拿独立 ArrayBuffer 再交给 crypto:传视图会撞上
 * workerd 类型里 SharedArrayBuffer 那一支的赋值限制,复制 4 KiB 比加个 cast 便宜且诚实。 */
async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  return sha256Hex(bytes.slice().buffer);
}

export async function obsHeadFingerprint(
  bytes: Uint8Array,
  len: number,
): Promise<{ head_len: number; head_digest: string }> {
  const take = Math.min(len, bytes.byteLength);
  return { head_len: take, head_digest: await sha256HexBytes(bytes.subarray(0, take)) };
}

/**
 * 只推进游标、不写事件:换代被检出但新代还没有完整行可摄取时的落盘。
 *
 * 不落这一步就会每轮都重新判定成换代 —— generation 每 30s 加一,段文件命名跟着涨,
 * 读端点看到的是一串空代。游标本身就是「读到哪了」这一层的唯一状态,必须提交。
 */
export async function commitObsCursor(
  bucket: R2Bucket,
  args: { taskId: string; attemptId: string; prev: ObsIndexV1 | null; cursor: ObsRoundCursor; now: string },
): Promise<ObsIndexV1> {
  const { taskId, attemptId, prev, cursor } = args;
  const segments = (prev?.segments ?? []).map((s) => ({ ...s })).sort(segmentOrder);
  return putIndex(bucket, buildIndex(taskId, attemptId, prev, cursor, segments, args.now));
}
