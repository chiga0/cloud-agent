import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createExecutionContext, env } from "cloudflare:test";
import worker from "../src/index";
import { TASK_TRANSITIONS } from "../src/control/statemachine";
import type { TaskState } from "../src/types";
import { applyMigrations } from "./d1";

/**
 * GET /admin/tasks —— 归档任务列表的读模型投影。
 *
 * 这个端点的意义就是「D1 里已经归档的那份事实」,所以用例直接对 `tasks` 表
 * 建模(不经过 DO):状态集必须与权威转换表一致、limit 边界要挡住、一次 GET
 * 不能改动任何行。合法状态用例如非遍历 TASK_TRANSITIONS 的键,就测不出
 * 「实现里偷偷硬编码了另一份清单」这类回归。
 */

const TOKEN = env.WORKER_API_TOKEN;

interface ArchivedTask {
  id: string;
  state: string;
  created_at: string;
  updated_at: string;
  version: number;
}

interface TasksBody {
  tasks: ArchivedTask[];
  count: number;
}

interface ErrorBody {
  error: { type: string; detail?: string };
}

async function request(path: string, token: string | null = TOKEN): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return worker.fetch(
    new Request(`https://example.com${path}`, { headers }),
    env,
    createExecutionContext(),
  );
}

const getTasks = (query = "", token: string | null = TOKEN) =>
  request(`/admin/tasks${query}`, token);

async function getJson<T>(query: string): Promise<{ status: number; body: T }> {
  const res = await getTasks(query);
  return { status: res.status, body: (await res.json()) as T };
}

async function seedTask(over: {
  state: TaskState;
  version?: number;
  updated_at?: string;
  created_at?: string;
}): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO tasks (id, spec, spec_digest, state, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      id,
      JSON.stringify({ prompt: `seed ${id}` }),
      "0".repeat(64),
      over.state,
      over.version ?? 1,
      over.created_at ?? "2026-08-01T00:00:00.000Z",
      over.updated_at ?? "2026-08-20T00:00:00.000Z",
    )
    .run();
  return id;
}

async function tableSnapshot(): Promise<Array<{ id: string; state: string; version: number }>> {
  const rows = await env.DB.prepare("SELECT id, state, version FROM tasks ORDER BY id")
    .all<{ id: string; state: string; version: number }>();
  return rows.results;
}

// 迁移含不可重复执行的 ALTER TABLE:整个文件应用一次,而不是每个 suite 一次
beforeAll(applyMigrations);

describe("GET /admin/tasks", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM tasks").run();
  });

  it("无参数返回全部归档任务,按 updated_at 降序", async () => {
    const oldest = await seedTask({ state: "DONE", updated_at: "2026-08-10T00:00:00.000Z" });
    const newest = await seedTask({ state: "BLOCKED", version: 7, updated_at: "2026-08-30T00:00:00.000Z" });
    const middle = await seedTask({ state: "REJECTED", updated_at: "2026-08-20T00:00:00.000Z" });

    const { status, body } = await getJson<TasksBody>("");
    expect(status).toBe(200);
    expect(body.count).toBe(3);
    expect(body.tasks.map((t) => t.id)).toEqual([newest, middle, oldest]);

    // 投影字段就是承诺的那几个,不外泄 spec / spec_digest 等归档细节
    expect(Object.keys(body.tasks[0]).sort()).toEqual([
      "created_at",
      "id",
      "state",
      "updated_at",
      "version",
    ]);
    expect(body.tasks.find((t) => t.id === newest)).toMatchObject({
      state: "BLOCKED",
      version: 7,
      created_at: "2026-08-01T00:00:00.000Z",
    });
  });

  it("?state 精确过滤命中的行", async () => {
    const hit = await seedTask({ state: "DONE" });
    await seedTask({ state: "BLOCKED" });
    await seedTask({ state: "REJECTED" });

    const { status, body } = await getJson<TasksBody>("?state=DONE");
    expect(status).toBe(200);
    expect(body.count).toBe(1);
    expect(body.tasks.map((t) => t.id)).toEqual([hit]);
  });

  it("?state 过滤不命中时返回空列表而不是 404", async () => {
    await seedTask({ state: "DONE" });

    const { status, body } = await getJson<TasksBody>("?state=BLOCKED");
    expect(status).toBe(200);
    expect(body).toEqual({ tasks: [], count: 0 });
  });

  it("合法状态集合与 TASK_TRANSITIONS 的键一致,不另立清单", async () => {
    const states = Object.keys(TASK_TRANSITIONS);
    expect(states.length).toBeGreaterThan(0);
    for (const state of states) {
      const res = await getTasks(`?state=${state}`);
      expect(res.status, `state=${state} 应被接受`).toBe(200);
    }
  });

  it("非法 state 返回 400(精确匹配,大小写不符即非法)", async () => {
    await seedTask({ state: "DONE" });
    for (const state of ["NOT_A_STATE", "done", "", "RUNNING;", "PENDING,DONE", "' OR 1=1 --"]) {
      const { status, body } = await getJson<ErrorBody>(`?state=${encodeURIComponent(state)}`);
      expect(status, `state=${JSON.stringify(state)} 应被拒绝`).toBe(400);
      expect(body.error.type).toBe("invalid_state");
    }
    // 非法值只能被拒,不能进了查询:表里的行一处不少
    expect(await tableSnapshot()).toHaveLength(1);
  });

  it("?limit 生效且 count 是实际返回条数", async () => {
    for (const day of ["01", "02", "03"]) {
      await seedTask({ state: "DONE", updated_at: `2026-08-${day}T00:00:00.000Z` });
    }

    const { status, body } = await getJson<TasksBody>("?limit=2");
    expect(status).toBe(200);
    expect(body.count).toBe(2);
    expect(body.tasks.map((t) => t.updated_at)).toEqual([
      "2026-08-03T00:00:00.000Z",
      "2026-08-02T00:00:00.000Z",
    ]);
  });

  it("limit 缺省 50,上限 200 可用", async () => {
    for (let i = 0; i < 51; i++) {
      await seedTask({ state: "DONE", updated_at: `2026-07-01T00:00:${String(i).padStart(2, "0")}.000Z` });
    }

    expect((await getJson<TasksBody>("")).body.count).toBe(50);
    expect((await getJson<TasksBody>("?limit=200")).body.count).toBe(51);
  });

  it("limit 非数字或越出 [1,200] 返回 400", async () => {
    await seedTask({ state: "DONE" });
    for (const limit of ["0", "-1", "201", "abc", "1.5", "", "1e400"]) {
      const { status, body } = await getJson<ErrorBody>(`?limit=${encodeURIComponent(limit)}`);
      expect(status, `limit=${JSON.stringify(limit)} 应被拒绝`).toBe(400);
      expect(body.error.type).toBe("invalid_limit");
    }
  });

  it("鉴权与 GET /admin/chain-check 走同一条 checkApiToken 路径", async () => {
    expect(TOKEN).toBeTruthy();
    for (const path of ["/admin/tasks", "/admin/chain-check"]) {
      expect((await request(path, null)).status, `${path} 缺 token 应 401`).toBe(401);
      expect((await request(path, "wrong-token")).status, `${path} 错 token 应 401`).toBe(401);
    }
  });

  it("只读:GET 不改动 tasks 表", async () => {
    await seedTask({ state: "AWAITING_APPROVAL", version: 4 });
    await seedTask({ state: "DONE", version: 9 });
    const before = await tableSnapshot();

    await getTasks("");
    await getTasks("?state=DONE&limit=1");

    expect(await tableSnapshot()).toEqual(before);
  });

  it("落地页登记该端点,并如实说明它只是归档视图", async () => {
    const res = await request("/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<dt>GET /admin/tasks</dt>");
    // 端点列表里漏掉「不含未归档任务」这句,读者就会把复盘视图当实时看板
    expect(html).toContain("不含仍在 DO 中运行、尚未归档的任务");
  });
});
