import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import type { TaskSession } from "../src/control/session";
import { handleQueue, type ReportMessage } from "../src/exec/queue";
import { applyMigrations } from "./d1";

/**
 * 队列 → 权威的路由 hop。
 *
 * 这段代码是 §13.8 那个 prod 事故的修法本身:workflow/queue 侧不能按名字
 * 找 DO(name-based id 会解析到幽灵实例),必须用消息里携带的 `session_id`
 * 走 `idFromString`。之前只有 `reportArgsFrom` 的字段映射有单测,真正的
 * 投递入口 `handleQueue` 一次都没跑过 —— 也就是说「回报能不能找到那份
 * 权威状态」这件事完全靠 prod 观察,改坏了本地不会红。
 */

const ns = () => env.TASK_SESSION as DurableObjectNamespace<TaskSession>;

type Delivery = { acked: number; retried: number };

async function deliver(
  body: ReportMessage | Record<string, unknown>,
): Promise<Delivery> {
  const out: Delivery = { acked: 0, retried: 0 };
  const msg = {
    body,
    ack: () => {
      out.acked += 1;
    },
    retry: () => {
      out.retried += 1;
    },
    id: "msg-1",
    timestamp: new Date(),
    attempts: 1,
  };
  await handleQueue(
    { messages: [msg], ackAll: () => {}, retryAll: () => {}, metadata: {} } as never,
    env,
  );
  return out;
}

function execReport(attempt_id: string, over: Partial<ReportMessage> = {}): ReportMessage {
  return {
    schema_version: 1,
    type: "exec-report",
    task_id: "",
    session_id: "",
    attempt_id,
    exit_code: 0,
    ...over,
  };
}

describe("handleQueue → TaskSession 路由", () => {
  beforeAll(applyMigrations);

  it("exec-report 按 session_id 投递到正确实例并驱动状态机", async () => {
    const id = ns().newUniqueId();
    const stub = ns().get(id);
    const task_id = crypto.randomUUID();
    await stub.createTask({ prompt: "queue routing" } as never, task_id);
    const { attempt_id } = await stub.startAttempt({
      role: "writer",
      idempotency_key: crypto.randomUUID(),
      max_model_tokens: 1000,
      max_wall_seconds: 60,
    });

    const delivered = await deliver(
      execReport(attempt_id, {
        task_id,
        session_id: id.toString(),
        manifest_key: `manifests/task/w/${attempt_id}.json`,
        manifest_digest: "d-1",
        result_text: "已完成",
        tokens: 42,
      }),
    );

    expect(delivered).toEqual({ acked: 1, retried: 0 });
    const snap = (await stub.getSnapshot())!;
    expect(snap.events.map((e) => e.kind)).toContain("attempt.exec_finished");
    expect(snap.attempts[0].state).toBe("SUCCEEDED");
    expect(snap.task.state).toBe("AWAITING_APPROVAL"); // 等审批,不进终态
    expect(snap.attempts.find((a) => a.id === attempt_id)!.tokens_used).toBe(42);
  });

  // 守的是「查不到就不写、不 retry、不兜底猜第二个口径」。name-based 路由回归由
  // 上面那条正向投递用例抓(变异实验:改成 idFromName 后这条依然绿,因为错误目标
  // 同样落进空实例)。
  it("session_id 指向从未创建过的实例:ack 且不落到任何真实任务上", async () => {
    const real = ns().get(ns().newUniqueId());
    const realTask = crypto.randomUUID();
    await real.createTask({ prompt: "must stay untouched" } as never, realTask);
    const { attempt_id } = await real.startAttempt({
      role: "writer",
      idempotency_key: crypto.randomUUID(),
      max_model_tokens: 1000,
      max_wall_seconds: 60,
    });
    const before = (await real.getSnapshot())!.events.length;

    const delivered = await deliver(
      execReport(attempt_id, {
        task_id: realTask,
        session_id: ns().newUniqueId().toString(), // 幽灵实例:id 合法但没有任务
      }),
    );

    expect(delivered).toEqual({ acked: 1, retried: 0 });
    const snap = (await real.getSnapshot())!;
    expect(snap.events).toHaveLength(before);
    expect(snap.task.state).toBe("RUNNING");
  });

  it("workflow 自身抛错时的 exit_code=-1 回报:attempt 与任务一起 BLOCKED", async () => {
    const id = ns().newUniqueId();
    const stub = ns().get(id);
    const task_id = crypto.randomUUID();
    await stub.createTask({ prompt: "workflow crashed" } as never, task_id);
    const { attempt_id } = await stub.startAttempt({
      role: "writer",
      idempotency_key: crypto.randomUUID(),
      max_model_tokens: 1000,
      max_wall_seconds: 60,
    });

    await deliver(
      execReport(attempt_id, {
        task_id,
        session_id: id.toString(),
        exit_code: -1,
        error: "TypeError: Cannot read properties of undefined (reading 'idFromName')",
      }),
    );

    const snap = (await stub.getSnapshot())!;
    expect(snap.task.state).toBe("BLOCKED");
    expect(snap.attempts[0].state).toBe("BLOCKED");
    const blocked = snap.events.filter((e) => e.kind === "attempt.blocked");
    expect(blocked).toHaveLength(1);
    expect(JSON.parse(blocked[0].payload).error).toContain("idFromName");
  });

  it("review-request 重投同一 idempotency_key 只起一个 reviewer attempt", async () => {
    const id = ns().newUniqueId();
    const stub = ns().get(id);
    const task_id = crypto.randomUUID();
    await stub.createTask({ prompt: "review fanout" } as never, task_id);
    // 先让 writer 成功到待审批,才有 review 的语义前置
    const { attempt_id } = await stub.startAttempt({
      role: "writer",
      idempotency_key: crypto.randomUUID(),
      max_model_tokens: 1000,
      max_wall_seconds: 60,
    });
    await deliver(
      execReport(attempt_id, {
        task_id,
        session_id: id.toString(),
        manifest_key: "manifests/task/w/x.json",
        manifest_digest: "wd",
        result_text: "done",
      }),
    );

    const key = `${task_id}:review:1`;
    const req = {
      schema_version: 1,
      type: "review-request",
      task_id,
      session_id: id.toString(),
      spec: { prompt: "review fanout" },
      idempotency_key: key,
    };
    const first = await deliver(req);
    const redelivery = await deliver(req);

    expect(first).toEqual({ acked: 1, retried: 0 });
    expect(redelivery).toEqual({ acked: 1, retried: 0 });
    const snap = (await stub.getSnapshot())!;
    expect(snap.attempts.filter((a) => a.role === "reviewer")).toHaveLength(1);
  });

  it("未知消息类型直接 ack,不进 retry 死循环", async () => {
    const delivered = await deliver({ type: "something-new" });
    expect(delivered).toEqual({ acked: 1, retried: 0 });
  });
});
