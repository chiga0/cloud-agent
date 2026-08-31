import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import type { TaskSession } from "../src/control/session";

/**
 * TaskSession DO 并发测试。
 *
 * 背景:DO 的 input gate 不保护 RPC,多个并发 RPC 在同一 isolate 内
 * 于 await 边界交错。loadAll → 变更 → saveAll 若无
 * blockConcurrencyWhile 保护,并发 createTask 会各自读到空状态并各写
 * 一条 task.created(事件链双份 = 修复前该测试应为红)。
 */

const ns = () => env.TASK_SESSION as DurableObjectNamespace<TaskSession>;

function chainIntact(events: Array<{ prev_digest: string | null; digest: string }>): void {
  for (let i = 1; i < events.length; i++) {
    expect(events[i].prev_digest).toBe(events[i - 1].digest);
  }
}

describe("TaskSession DO 并发", () => {
  it("并发 createTask 恰好产生 1 条 task.created", async () => {
    const taskId = crypto.randomUUID();
    const stub = ns().get(ns().newUniqueId());
    const spec = { prompt: "concurrency: createTask" };

    const results = await Promise.all(
      Array.from({ length: 8 }, () => stub.createTask(spec, taskId)),
    );

    expect(new Set(results.map((r) => r.spec_digest)).size).toBe(1);
    const snap = await stub.getSnapshot();
    expect(snap).not.toBeNull();
    expect(snap!.task.id).toBe(taskId);
    expect(snap!.events.filter((e) => e.kind === "task.created")).toHaveLength(1);
    chainIntact(snap!.events);
  });

  it("createTask 与并发 getSnapshot 无撕裂读", async () => {
    const taskId = crypto.randomUUID();
    const stub = ns().get(ns().newUniqueId());

    const writes = Promise.all(
      Array.from({ length: 4 }, () => stub.createTask({ prompt: "tear test" }, taskId)),
    );
    const reads = Promise.all(
      Array.from({ length: 20 }, () => stub.getSnapshot()),
    );
    await writes;
    const snaps = await reads;

    for (const snap of snaps) {
      if (!snap) continue;
      expect(snap.task.state).toBe("PENDING");
      expect(snap.events.filter((e) => e.kind === "task.created")).toHaveLength(1);
      chainIntact(snap.events);
    }
    const final = await stub.getSnapshot();
    expect(final!.events.filter((e) => e.kind === "task.created")).toHaveLength(1);
  });

  it("并发 startAttempt(同幂等键)恰好创建 1 个 attempt", async (ctx) => {
    const taskId = crypto.randomUUID();
    const stub = ns().get(ns().newUniqueId());
    await stub.createTask({ prompt: "concurrency: startAttempt" }, taskId);

    const key = `${taskId}:attempt:1`;
    let results: Array<{ attempt_id: string; workflow_instance_id: string | null }>;
    try {
      results = await Promise.all(
        Array.from({ length: 5 }, () =>
          stub.startAttempt({
            role: "writer",
            idempotency_key: key,
            max_model_tokens: 1000,
            max_wall_seconds: 60,
          }),
        ),
      );
    } catch (err) {
      // miniflare 不支持 workflows 绑定时跳过(计划预案)
      if (String(err).match(/workflow|not supported|unknown binding|unrecognized/i)) {
        return ctx.skip();
      }
      throw err;
    }

    expect(new Set(results.map((r) => r.attempt_id)).size).toBe(1);
    const snap = await stub.getSnapshot();
    expect(snap!.attempts).toHaveLength(1);
    expect(snap!.task.state).toBe("RUNNING");
    chainIntact(snap!.events);
  });
});
