/**
 * Observation 层的写路径:poll 相的 transcript 增量摄取。
 *
 * 每轮只做一件事 —— 从**已存游标**起读 transcript 的新增字节,按行产事件,落 R2 段文件。
 * 三条硬约束决定了这里的全部形状:
 *
 * 1. 游标存在 journal 的 index.json 里,不在 workflow 的 step 返回值里。
 *    durable 重放会让同一个 attempt_id 上的 poll 被多次执行(step 重试 / isolate 驱逐后
 *    从 checkpoint 续跑),携带式的游标在重放下必然滞后 → 重发旧事件。从已存状态续读,
 *    同一批字节喂两次就是第二次 0 条。
 * 2. 字节偏移只按**完整行**推进。尾部半行留在原地等下一轮拼齐;顺带这也躲开了
 *    UTF-8 多字节字符被从中间切断的问题(那只能发生在未终止的最后一行里)。
 * 3. 摄取失败不杀 poll 相。观测层是旁路:读文件错、解析错、R2 抖一下,都只记 stderr
 *    跳过本轮,下一轮从已存游标重试。把 attempt 弄成 BLOCKED 是权威层的事。
 */

import { LONGRUN_STDOUT } from "../exec/longrun";
import type { Env } from "../types";
import { obsSecretValues, toAgentEventV1, type AgentEventV1 } from "./events";
import {
  OBS_HEAD_BYTES,
  commitObsCursor,
  commitObsRound,
  loadObsIndex,
  obsHeadFingerprint,
  type ObsIndexV1,
  type ObsRoundCursor,
} from "./journal";

/** 结构上窄化到「能读文件」,与 longrun.ts 的 LongRunSandbox 同一手法:真实 Sandbox 天然满足。 */
export interface ObsTranscriptReader {
  readFile(path: string): Promise<{ content: string }>;
}

export interface ObsIngestResult {
  generation: number;
  /** 已消费的 transcript 字节(完整行) */
  offset_bytes: number;
  max_seq: number;
  events: number;
  /** 留在原地等下一轮拼齐的尾行字节数 */
  tail_held_bytes: number;
  segments_written: string[];
  /** 换代原因(未换代为 null):悬挂取证时要能看出为什么编号重开 */
  bumped: string | null;
}

const LF = 0x0a;
const DECODER = new TextDecoder("utf-8", { fatal: false });
const ENCODER = new TextEncoder();

/**
 * 从 from 起切出「完整行」窗口。返回的 consumed_bytes 是推进量,包含行内空行
 * (空行也占了字节,只是不产事件 —— 不把它计入推进量的话,偏移会永远追不上文件)。
 */
export function takeCompleteLines(
  bytes: Uint8Array,
  from: number,
): { lines: string[]; consumed_bytes: number; tail_bytes: number } {
  const start = Math.min(Math.max(from, 0), bytes.byteLength);
  const window = bytes.subarray(start);
  let lastLf = -1;
  for (let i = window.byteLength - 1; i >= 0; i--) {
    if (window[i] === LF) {
      lastLf = i;
      break;
    }
  }
  if (lastLf === -1) {
    return { lines: [], consumed_bytes: 0, tail_bytes: window.byteLength };
  }
  const complete = window.subarray(0, lastLf + 1);
  const lines = DECODER
    .decode(complete)
    .split("\n")
    .filter((l) => l.trim().length > 0);
  return {
    lines,
    consumed_bytes: complete.byteLength,
    tail_bytes: window.byteLength - complete.byteLength,
  };
}

export interface ObsCursorDecision {
  cursor: ObsRoundCursor;
  /** 换代起点:重放复用同一 attempt_id 时,新轮次开新代,seq 从 1 重开 */
  bumped: string | null;
  max_seq: number;
}

/**
 * 定游标:复用当代续读,还是换代开新段。
 *
 * 换代的判据只有「旧字节偏移已经失去意义」这一种事实,两种表现:
 * - transcript 比游标短:文件被截断(longrun.sh 的 `>` 重定向在重新启动时就会清零);
 * - 前缀指纹变了:文件被整体替换成另一轮执行的输出。
 * 其它情形(含「同一批字节喂第二次」)一律复用当代 —— 这就是幂等本身。
 */
export async function resolveObsCursor(
  prev: ObsIndexV1 | null,
  bytes: Uint8Array,
): Promise<ObsCursorDecision> {
  if (!prev) {
    const head = await obsHeadFingerprint(bytes, OBS_HEAD_BYTES);
    return { cursor: { generation: 1, offset_bytes: 0, ...head }, bumped: null, max_seq: 0 };
  }
  const size = bytes.byteLength;
  let bumped: string | null = null;
  if (size < prev.offset_bytes) {
    bumped = "transcript_shrunk";
  } else if (prev.head_len > 0) {
    const probe = await obsHeadFingerprint(bytes, prev.head_len);
    // probe 取不满 prev.head_len 字节 ⇒ 文件比本代开始时还短:append-only 前提下不可能
    // 出现,等同「被替换」(这一支抓的是「被换成一个更短但仍不短于偏移」的文件)
    if (probe.head_len !== prev.head_len || probe.head_digest !== prev.head_digest) {
      bumped = "transcript_replaced";
    }
  }
  if (bumped) {
    const head = await obsHeadFingerprint(bytes, OBS_HEAD_BYTES);
    return {
      cursor: { generation: prev.generation + 1, offset_bytes: 0, ...head },
      bumped,
      max_seq: 0,
    };
  }
  return {
    cursor: {
      generation: prev.generation,
      offset_bytes: prev.offset_bytes,
      head_len: prev.head_len,
      head_digest: prev.head_digest,
    },
    bumped: null,
    max_seq: prev.max_seq,
  };
}

/**
 * 一轮增量摄取。调用方(workflow 的 poll step)不需要携带任何游标:状态全在 journal 里。
 * 无新增完整行时不落任何写 —— 30s 一次的空轮询不该把 R2 刷满小对象。
 */
export async function ingestTranscript(args: {
  bucket: R2Bucket;
  reader: ObsTranscriptReader;
  taskId: string;
  attemptId: string;
  path?: string;
  secrets?: readonly string[];
  /** 摄取时刻的提供者,测试钉用 */
  now?: () => string;
}): Promise<ObsIngestResult> {
  const path = args.path ?? LONGRUN_STDOUT;
  const now = args.now?.() ?? new Date().toISOString();
  const prev = await loadObsIndex(args.bucket, args.taskId, args.attemptId);
  const content = (await args.reader.readFile(path)).content;
  const bytes = ENCODER.encode(content);

  const { cursor, bumped, max_seq } = await resolveObsCursor(prev, bytes);
  const window = takeCompleteLines(bytes, cursor.offset_bytes);

  if (window.lines.length === 0) {
    // 检测到换代但还没有完整行:游标也得提交,否则下一轮又判成换代
    if (bumped) {
      await commitObsCursor(args.bucket, {
        taskId: args.taskId,
        attemptId: args.attemptId,
        prev,
        cursor,
        now,
      });
    }
    return {
      generation: cursor.generation,
      offset_bytes: cursor.offset_bytes,
      max_seq,
      events: 0,
      tail_held_bytes: window.tail_bytes,
      segments_written: [],
      bumped,
    };
  }

  const events: AgentEventV1[] = window.lines.map((line, i) =>
    toAgentEventV1({
      taskId: args.taskId,
      attemptId: args.attemptId,
      generation: cursor.generation,
      seq: max_seq + i + 1,
      ts: now,
      line,
      secrets: args.secrets,
    }),
  );
  const nextCursor: ObsRoundCursor = {
    ...cursor,
    offset_bytes: cursor.offset_bytes + window.consumed_bytes,
  };
  const { index, written } = await commitObsRound(args.bucket, {
    taskId: args.taskId,
    attemptId: args.attemptId,
    events,
    cursor: nextCursor,
    prev,
    now,
  });

  if (bumped) {
    console.warn(
      `obs_generation_bump task=${args.taskId} attempt=${args.attemptId} ` +
        `reason=${bumped} generation=${cursor.generation} offset_reset_to=${nextCursor.offset_bytes}`,
    );
  }
  console.info(
    `obs_ingest task=${args.taskId} attempt=${args.attemptId} g=${index.generation} ` +
      `events=${events.length} seq_to=${index.max_seq} offset=${index.offset_bytes} ` +
      `tail=${window.tail_bytes} segments=${written.length}`,
  );
  return {
    generation: index.generation,
    offset_bytes: index.offset_bytes,
    max_seq: index.max_seq,
    events: events.length,
    tail_held_bytes: window.tail_bytes,
    segments_written: written,
    bumped,
  };
}

/**
 * workflow 侧的入口:永不抛。
 *
 * 记的是 stderr(console.warn 在 workerd 里进 worker 日志),不是把异常上抛 ——
 * poll 相抛出来会走 step 重试,重试耗尽整个 attempt 变 BLOCKED。观测层出任何
 * 问题都不该改变任务结论,这是它作为旁路的底线。
 */
export async function ingestObsBestEffort(
  env: Env,
  args: { taskId: string; attemptId: string; reader: ObsTranscriptReader },
): Promise<ObsIngestResult | null> {
  try {
    return await ingestTranscript({
      bucket: env.ARTIFACTS,
      reader: args.reader,
      taskId: args.taskId,
      attemptId: args.attemptId,
      secrets: obsSecretValues(env),
    });
  } catch (err) {
    console.warn(
      `obs_ingest_failed task=${args.taskId} attempt=${args.attemptId} ` +
        `err=${String(err).slice(0, 300)} action=skip_round_retry_next`,
    );
    return null;
  }
}
