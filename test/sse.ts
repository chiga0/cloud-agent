import type { AgentEventV1 } from "../src/obs/events";

/**
 * SSE 帧解析(测试侧)。刻意只做「按空行分帧 + 取字段」这点事:
 * 真解析器要处理的重连、UTF-8 分片、retry: 等都不在本期契约里。
 *
 * 分片边界处理是必要的:一个 enqueue 不一定正好是一帧,而 TextDecoder 的流式解码
 * 决定多字节字符被切开时也不会坏。
 */

const decoder = new TextDecoder();

/** 事件身份:跨「流的帧」与「/events 的 JSON」比对同一条事件用得上。 */
export const ident = (e: AgentEventV1) => `${e.attempt_id.slice(0, 8)}/${e.generation}/${e.seq}`;

export interface SseFrame {
  raw: string;
  /** null = 该帧没有 id 行(注释帧即如此) */
  id: number | null;
  event: string | null;
  data: string | null;
  /** 注释行(`: ping` 之类) */
  comment: boolean;
}

export function parseFrame(raw: string): SseFrame {
  let id: number | null = null;
  let event: string | null = null;
  const data: string[] = [];
  let comment = false;
  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) {
      comment = true;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const field = line.slice(0, colon);
    const value = line.slice(colon + 1).replace(/^ /, "");
    if (field === "id") id = Number(value);
    else if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  return { raw, id, event, data: data.length > 0 ? data.join("\n") : null, comment };
}

export class SseReader {
  private buf = "";
  private readonly frames: string[] = [];
  private closed = false;

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  private feed(chunk: Uint8Array): void {
    this.buf += decoder.decode(chunk, { stream: true });
    const parts = this.buf.split("\n\n");
    this.buf = parts.pop() ?? "";
    this.frames.push(...parts.filter((p) => p.length > 0));
  }

  /** 下一帧;流已关闭且无残留 → null。 */
  async next(): Promise<SseFrame | null> {
    while (this.frames.length === 0) {
      if (this.closed) return null;
      const { value, done } = await this.reader.read();
      if (value && value.byteLength > 0) this.feed(value);
      if (done) {
        this.closed = true;
        if (this.buf.length > 0) {
          this.frames.push(this.buf);
          this.buf = "";
        }
        break;
      }
    }
    const raw = this.frames.shift();
    return raw === undefined ? null : parseFrame(raw);
  }

  async take(n: number): Promise<SseFrame[]> {
    const out: SseFrame[] = [];
    for (let i = 0; i < n; i++) {
      const frame = await this.next();
      if (frame === null) break;
      out.push(frame);
    }
    return out;
  }

  /** 读到流关闭为止(终态任务的流会自己收尾,所以这条不需要真等)。 */
  async drain(): Promise<SseFrame[]> {
    const out: SseFrame[] = [];
    for (;;) {
      const frame = await this.next();
      if (frame === null) break;
      out.push(frame);
    }
    return out;
  }

  /** 事件帧的 id 序列(排除 end 帧与注释帧):位置游标口径的直接证据。 */
  static eventIds(frames: SseFrame[]): number[] {
    return frames.filter((f) => f.event === "agent").map((f) => f.id!);
  }

  static events(frames: SseFrame[]): AgentEventV1[] {
    return frames
      .filter((f) => f.event === "agent")
      .map((f) => JSON.parse(f.data!) as AgentEventV1);
  }

  /** 客户端断开。**每个打开过 200 流的用例都必须调用**:泵只有看到 cancel 才会收敛。 */
  async cancel(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.reader.cancel();
  }
}
