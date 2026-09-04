import { beforeAll, describe, expect, it, vi } from "vitest";
import { createExecutionContext, env } from "cloudflare:test";
import worker from "../src/index";
import type { TaskSession } from "../src/control/session";
import {
  BUDGET_CLAMP_EVENT_KIND,
  BUDGET_CLAMP_REASONS,
  EXPORT_ALLOWANCE_SECONDS,
  FALLBACK_MAX_WALL_SECONDS,
  MAX_SAFE_WALL_MINUTES,
  QWEN_DEADLINE_GRACE_SECONDS,
  budgetClampPayload,
  resolveBudget,
  validateMaxWallSeconds,
  type BudgetClampReason,
} from "../src/control/budget";
import { WALL_GRACE_SECONDS, attemptDeadline } from "../src/control/statemachine";
import { applyMigrations } from "./d1";

/**
 * 预算口径的钉子:一个数字进来,四个时钟出去,而「用户请求的时长」与「writer 实际
 * 拿到的时长」分叉时必须在权威链上留痕。
 *
 * 三类历史缺陷对应三组用例:
 * 1. 同一规则三份独立副本(入口缺省 / deriveWriterBudget / qwenDeadlineSeconds 各写
 *    一份 `?? "3600"`)→ 用「投影与 resolveBudget 同源」钉住;
 * 2. 夹钳静默(3600s 预算 ⇒ 25m 墙钟,链上无痕)→ 正向必须落 budget.clamped,
 *    未夹钳必须**不**落(反例同表);
 * 3. 入口零校验(负数/0/小数/字符串/NaN 都能落进 TaskRecord 并排出过去的 alarm)
 *    → 400 invalid_budget,带原因。
 */

const TOKEN = env.WORKER_API_TOKEN;
/** 测试环境的墙钟缺省(wrangler.test.jsonc)。 */
const ENV_DEFAULT_SECONDS = Number(env.DEFAULT_MAX_WALL_SECONDS);

/** 手工拼 body:有些非法形状(JSON 数字字面量 1e999 → Infinity)经不了 JSON.stringify 这道。 */
async function postRaw(rawBody: string): Promise<{ status: number; body: any }> {
  const res = await worker.fetch(
    new Request("https://example.com/api/tasks", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: rawBody,
    }),
    env,
    createExecutionContext(),
  );
  return { status: res.status, body: (await res.json()) as any };
}

function taskBody(budgetJson: string): string {
  return `{"spec":{"prompt":"budget honesty"},"budget":{"max_wall_seconds":${budgetJson}}}`;
}

const ns = () => env.TASK_SESSION as DurableObjectNamespace<TaskSession>;

async function newWriterTask(maxWallSeconds: number) {
  const taskId = crypto.randomUUID();
  const stub = ns().get(ns().idFromName(taskId));
  await stub.createTask({ prompt: `budget clamp ${maxWallSeconds}` }, taskId);
  const { attempt_id } = await stub.startAttempt({
    role: "writer",
    idempotency_key: `${taskId}:attempt:1`,
    max_model_tokens: 1000,
    max_wall_seconds: maxWallSeconds,
  });
  const snap = (await stub.getSnapshot())!;
  const events = (snap.events as Array<{ kind: string; payload: string; seq: number }>).filter(
    (e) => e.kind === BUDGET_CLAMP_EVENT_KIND,
  );
  return { attemptId: attempt_id, events, snap };
}

function clampPayloadOf(
  events: Array<{ payload: string }>,
  attemptId: string,
): Record<string, unknown> | null {
  for (const e of events) {
    const p = JSON.parse(e.payload) as Record<string, unknown>;
    if (p.attempt_id === attemptId) return p;
  }
  return null;
}

beforeAll(applyMigrations);

describe("validateMaxWallSeconds:非法预算一律拒绝", () => {
  // 负向五类(负数/0/小数/字符串/NaN)+ 三类同族扩展。NaN 无法用 JSON 表达
  // (序列化即 null),但它能经内部调用点进来,所以在校验器这一层直接钉。
  const invalid: Array<{ name: string; value: unknown }> = [
    { name: "负数", value: -60 },
    { name: "零", value: 0 },
    { name: "小数", value: 1.5 },
    { name: "字符串", value: "1800" },
    { name: "NaN", value: Number.NaN },
    { name: "Infinity", value: Number.POSITIVE_INFINITY },
    { name: "布尔", value: true },
    { name: "对象", value: {} },
  ];
  for (const c of invalid) {
    it(`${c.name} → 拒绝且带原因`, () => {
      const detail = validateMaxWallSeconds(c.value);
      expect(detail, String(c.value)).toBeTypeOf("string");
      expect(detail!.length).toBeGreaterThan(0);
    });
  }

  const valid: Array<{ name: string; value: unknown }> = [
    { name: "未给(undefined)", value: undefined },
    { name: "显式 null(= 未给)", value: null },
    { name: "正整数", value: 1800 },
    { name: "1 秒", value: 1 },
  ];
  for (const c of valid) {
    it(`${c.name} → 通过`, () => {
      expect(validateMaxWallSeconds(c.value)).toBeNull();
    });
  }
});

describe("POST /api/tasks:非法预算 fail-closed 400", () => {
  const cases: Array<{ name: string; json: string }> = [
    { name: "负数", json: "-60" },
    { name: "零", json: "0" },
    { name: "小数", json: "1.5" },
    { name: "字符串", json: '"1800"' },
    { name: "非有限(1e999 → Infinity)", json: "1e999" },
  ];
  for (const c of cases) {
    it(`${c.name} → 400 invalid_budget`, async () => {
      const { status, body } = await postRaw(taskBody(c.json));
      expect(status).toBe(400);
      expect(body.error.type).toBe("invalid_budget");
      expect(body.error.detail).toBeTypeOf("string");
    });
  }

  it("被拒的请求不建任务(没有 attempt,也就没有排在过去的 alarm)", async () => {
    const raw = '{"spec":{"prompt":"never created","acceptance":["aaaaaaaaaa"]},' +
      '"budget":{"max_wall_seconds":-1}}';
    const { status, body } = await postRaw(raw);
    expect(status).toBe(400);
    expect(body.task_id).toBeUndefined();
  });

  it("合法预算原样成为用户契约:DO 兜底按 1800s 排,链上另有 25m 的夹钳留痕", async () => {
    const { status, body } = await postRaw(taskBody("1800"));
    expect(status).toBe(200);
    const stub = ns().get(ns().idFromName(body.task_id));
    const snap = (await stub.getSnapshot())!;
    const record = snap.attempts.find((a) => a.id === body.attempt_id)!;
    // 用户契约那一侧:alarm = claim + 请求预算 + 宽限(夹钳不改它)。
    expect(await stub.peekScheduledAlarm()).toBe(
      Date.parse(record.created_at) + (1800 + WALL_GRACE_SECONDS) * 1000,
    );
    // writer 能力那一侧:同一个 attempt 的链里必须写着「实际只给 25 分钟」。
    const clamp = clampPayloadOf(
      (snap.events as Array<{ kind: string; payload: string }>).filter(
        (e) => e.kind === BUDGET_CLAMP_EVENT_KIND,
      ),
      body.attempt_id,
    );
    expect(clamp).toMatchObject({
      requested_seconds: 1800,
      writer_wall_minutes: MAX_SAFE_WALL_MINUTES,
      clamp_reason: "writer_wall_ceiling",
    });
  });

  it("未给预算 → 环境缺省(缺省规则只有 resolveBudget 一份),且不产生夹钳事件", async () => {
    const { status, body } = await postRaw('{"spec":{"prompt":"default budget"}}');
    expect(status).toBe(200);
    const stub = ns().get(ns().idFromName(body.task_id));
    const snap = (await stub.getSnapshot())!;
    const record = snap.attempts.find((a) => a.id === body.attempt_id)!;
    expect(await stub.peekScheduledAlarm()).toBe(
      Date.parse(record.created_at) + (ENV_DEFAULT_SECONDS + WALL_GRACE_SECONDS) * 1000,
    );
    expect(
      (snap.events as Array<{ kind: string }>).filter((e) => e.kind === BUDGET_CLAMP_EVENT_KIND),
    ).toHaveLength(0);
  });
});

describe("resolveBudget:一次解析,四个时钟同源", () => {
  interface Row {
    name: string;
    budget: number | undefined;
    env: Record<string, string>;
    budgetSeconds: number;
    wallMinutes: number;
    ceilingMinutes: number;
    maxSessionTurns: number;
    deadlineSeconds: number;
    clamp: BudgetClampReason | null;
  }
  const rows: Row[] = [
    {
      name: "1800s + 上限 40(wrangler.jsonc 的生产口径)= 28 分钟",
      budget: 1800,
      env: { MAX_WRITER_WALL_MINUTES: "40" },
      budgetSeconds: 1800,
      wallMinutes: 28,
      ceilingMinutes: 40,
      maxSessionTurns: 224,
      deadlineSeconds: 1740,
      clamp: null,
    },
    {
      name: "1800s 无覆盖 → 撞平台安全上限 25(请求 30m,writer 实得 25m)",
      budget: 1800,
      env: {},
      budgetSeconds: 1800,
      wallMinutes: 25,
      ceilingMinutes: MAX_SAFE_WALL_MINUTES,
      maxSessionTurns: 200,
      deadlineSeconds: 1680,
      clamp: "writer_wall_ceiling",
    },
    {
      name: "2400s(C2-r6 那次推出 38m 撞 workerd ~29:48 悬挂墙)",
      budget: 2400,
      env: {},
      budgetSeconds: 2400,
      wallMinutes: 25,
      ceilingMinutes: MAX_SAFE_WALL_MINUTES,
      maxSessionTurns: 200,
      deadlineSeconds: 1680,
      clamp: "writer_wall_ceiling",
    },
    {
      name: "刚好等于上限(1620s → 25m)不算夹钳",
      budget: 1620,
      env: {},
      budgetSeconds: 1620,
      wallMinutes: 25,
      ceilingMinutes: 25,
      maxSessionTurns: 200,
      deadlineSeconds: 1560,
      clamp: null,
    },
    {
      name: "测试环境缺省 600s:预算 - 60s 那一支绑住到期线",
      budget: undefined,
      env: { DEFAULT_MAX_WALL_SECONDS: "600" },
      budgetSeconds: 600,
      wallMinutes: 8,
      ceilingMinutes: 25,
      maxSessionTurns: 64,
      deadlineSeconds: 540,
      clamp: null,
    },
    {
      name: "60s 预算:扣完导出余量不足 1 分钟 → 下限抬到 1m 并留痕",
      budget: 60,
      env: {},
      budgetSeconds: 60,
      wallMinutes: 1,
      ceilingMinutes: 25,
      maxSessionTurns: 40,
      deadlineSeconds: 60,
      clamp: "minimum_wall",
    },
    {
      name: "MAX_WRITER_WALL_MINUTES 非法 → 回落 25(可选 + 回落)",
      budget: 2400,
      env: { MAX_WRITER_WALL_MINUTES: "abc" },
      budgetSeconds: 2400,
      wallMinutes: 25,
      ceilingMinutes: 25,
      maxSessionTurns: 200,
      deadlineSeconds: 1680,
      clamp: "writer_wall_ceiling",
    },
    {
      name: "DEFAULT_MAX_WALL_SECONDS 非法 → 回落硬缺省(不再是 NaN 一路烂进命令行)",
      budget: undefined,
      env: { DEFAULT_MAX_WALL_SECONDS: "abc" },
      budgetSeconds: FALLBACK_MAX_WALL_SECONDS,
      wallMinutes: MAX_SAFE_WALL_MINUTES,
      ceilingMinutes: 25,
      maxSessionTurns: 200,
      deadlineSeconds: 1680,
      clamp: "writer_wall_ceiling",
    },
  ];

  for (const r of rows) {
    it(r.name, () => {
      expect(resolveBudget(r.budget, r.env)).toEqual({
        budgetSeconds: r.budgetSeconds,
        wallMinutes: r.wallMinutes,
        ceilingMinutes: r.ceilingMinutes,
        maxSessionTurns: r.maxSessionTurns,
        deadlineSeconds: r.deadlineSeconds,
        clamp: r.clamp,
      });
    });
  }

  it("投影与权威同源:deriveWriterBudget / qwenDeadlineSeconds / qwenCommand 不许各算一遍", async () => {
    const { deriveWriterBudget, qwenCommand, qwenDeadlineSeconds } = await import(
      "../src/exec/sandbox"
    );
    for (const r of rows) {
      const b = resolveBudget(r.budget, r.env);
      expect(deriveWriterBudget(r.budget, r.env)).toEqual({
        wallMinutes: b.wallMinutes,
        maxSessionTurns: b.maxSessionTurns,
      });
      expect(qwenDeadlineSeconds(r.budget, r.env)).toBe(b.deadlineSeconds);
      expect(qwenCommand(r.budget, r.env)).toContain(`--max-wall-time ${b.wallMinutes}m`);
      expect(qwenCommand(r.budget, r.env)).toContain(`--max-session-turns ${b.maxSessionTurns}`);
    }
  });

  it("非法的环境缺省会 warn 留痕(而不是静默修正)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(resolveBudget(undefined, { DEFAULT_MAX_WALL_SECONDS: "0" }).budgetSeconds).toBe(
        FALLBACK_MAX_WALL_SECONDS,
      );
      expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
        "budget_default_invalid",
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("缺配(不给 DEFAULT_MAX_WALL_SECONDS)静默用硬缺省,不 warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(resolveBudget(undefined, {}).budgetSeconds).toBe(FALLBACK_MAX_WALL_SECONDS);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("三个时钟的相对关系(契约,不随重构漂移)", () => {
  const budgets = [1, 59, 60, 120, 121, 600, 1620, 1800, 2400, 3600, 7200];
  for (const b of budgets) {
    it(`qwen 墙钟 ≤ poll 到期 < DO attemptDeadline(预算 ${b}s)`, () => {
      const r = resolveBudget(b, {});
      const createdMs = Date.UTC(2026, 8, 4, 0, 0, 0);
      const created = new Date(createdMs).toISOString();
      const deadlineMs = attemptDeadline({ created_at: created, max_wall_seconds: r.budgetSeconds });
      // 1) writer 墙钟不超过 poll 到期线:兜底晚于 qwen 自己的干净退出。
      expect(r.wallMinutes * 60).toBeLessThanOrEqual(r.deadlineSeconds);
      // 2) poll 到期永远早于 DO alarm:带证据的回报赶在兜底击杀之前(Fix C 的全部意义)。
      expect(createdMs + r.deadlineSeconds * 1000).toBeLessThan(deadlineMs);
      // 3) 导出余量确实从预算里扣过。minimum_wall 那一支例外:它是把不足 1 分钟的
      //    预算**抬**到 1 分钟,墙钟因此可以大于「预算 - 余量」(这正是它被记为夹钳的原因)。
      if (r.clamp !== "minimum_wall") {
        expect(r.wallMinutes * 60).toBeLessThanOrEqual(r.budgetSeconds - EXPORT_ALLOWANCE_SECONDS);
      }
      // 4) alarm 仍按任务预算排 —— 夹钳不悄悄缩小用户契约。
      expect(deadlineMs - createdMs).toBe((r.budgetSeconds + WALL_GRACE_SECONDS) * 1000);
      expect(r.deadlineSeconds).toBeGreaterThanOrEqual(60);
    });
  }

  it("被夹钳的 3600s:writer 拿 25m,到期线是墙钟 + 180s,DO alarm 仍在 3600s + 宽限", () => {
    const r = resolveBudget(3600, {});
    expect(r.wallMinutes).toBe(MAX_SAFE_WALL_MINUTES);
    expect(r.deadlineSeconds).toBe(MAX_SAFE_WALL_MINUTES * 60 + QWEN_DEADLINE_GRACE_SECONDS);
    const created = new Date(Date.UTC(2026, 8, 4)).toISOString();
    expect(
      attemptDeadline({ created_at: created, max_wall_seconds: r.budgetSeconds }) -
        Date.parse(created),
    ).toBe((3600 + WALL_GRACE_SECONDS) * 1000);
  });
});

describe("budget.clamped:夹钳在权威链上留痕", () => {
  it("正例:1800s 预算在无覆盖的环境里只拿到 25 分钟 → 事件说清楚了", async () => {
    const { attemptId, events } = await newWriterTask(1800);
    expect(events).toHaveLength(1);
    const payload = clampPayloadOf(events, attemptId)!;
    expect(payload).toEqual({
      attempt_id: attemptId,
      requested_seconds: 1800,
      writer_wall_minutes: 25,
      ceiling_minutes: MAX_SAFE_WALL_MINUTES,
      clamp_reason: "writer_wall_ceiling",
    });
    expect(BUDGET_CLAMP_REASONS).toContain(payload.clamp_reason as BudgetClampReason);
  });

  it("正例:极小预算走 minimum_wall", async () => {
    const { attemptId, events } = await newWriterTask(60);
    const payload = clampPayloadOf(events, attemptId)!;
    expect(payload.clamp_reason).toBe("minimum_wall");
    expect(payload.writer_wall_minutes).toBe(1);
    expect(payload.requested_seconds).toBe(60);
  });

  it("反例:预算 600s(测试缺省)不产生事件 —— 没有「本无事却报一声」的噪声", async () => {
    const { events } = await newWriterTask(ENV_DEFAULT_SECONDS);
    expect(events).toHaveLength(0);
  });

  it("反例:reviewer 拿同样的预算不产生事件(夹钳约束的是 writer 的沙箱墙钟)", async () => {
    const taskId = crypto.randomUUID();
    const stub = ns().get(ns().idFromName(taskId));
    await stub.createTask({ prompt: "reviewer budget" }, taskId);
    await stub.startAttempt({
      role: "reviewer",
      idempotency_key: `${taskId}:review:1`,
      max_model_tokens: 1000,
      max_wall_seconds: 2400,
    });
    const snap = (await stub.getSnapshot())!;
    const events = (snap.events as Array<{ kind: string }>).filter(
      (e) => e.kind === BUDGET_CLAMP_EVENT_KIND,
    );
    expect(events).toHaveLength(0);
  });

  it("payload 卫生:只有标识符、数值与枚举,没有自由文本通道(与 c10b 心跳同纪律)", async () => {
    const { attemptId, events } = await newWriterTask(2400);
    const payload = clampPayloadOf(events, attemptId)!;
    expect(Object.keys(payload).sort()).toEqual([
      "attempt_id",
      "ceiling_minutes",
      "clamp_reason",
      "requested_seconds",
      "writer_wall_minutes",
    ]);
    for (const [key, value] of Object.entries(payload)) {
      if (key === "attempt_id") {
        expect(value).toBe(attemptId);
        continue;
      }
      if (key === "clamp_reason") {
        expect(BUDGET_CLAMP_REASONS).toContain(value as BudgetClampReason);
        continue;
      }
      expect(typeof value).toBe("number");
      expect(Number.isFinite(value as number)).toBe(true);
    }
  });

  it("事件紧跟本 attempt 的 attempt.created,链不断", async () => {
    const { attemptId, snap } = await newWriterTask(2400);
    const events = snap.events as Array<{
      kind: string;
      payload: string;
      prev_digest: string | null;
      digest: string;
    }>;
    const created = events.findIndex(
      (e) =>
        e.kind === "attempt.created" &&
        (JSON.parse(e.payload) as { attempt_id: string }).attempt_id === attemptId,
    );
    expect(created).toBeGreaterThanOrEqual(0);
    expect(events[created + 1].kind).toBe(BUDGET_CLAMP_EVENT_KIND);
    for (let i = 1; i < events.length; i++) {
      expect(events[i].prev_digest).toBe(events[i - 1].digest);
    }
  });

  it("未夹钳时 budgetClampPayload 返回 null(没有事件,而不是一条说没事的事件)", () => {
    expect(budgetClampPayload("a", resolveBudget(600, {}))).toBeNull();
    expect(budgetClampPayload("a", resolveBudget(2400, {}))).not.toBeNull();
  });
});
