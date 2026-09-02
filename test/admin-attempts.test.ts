import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createExecutionContext, env } from "cloudflare:test";
import worker from "../src/index";
import { ATTEMPT_ROLES, type AttemptRole, type TaskState } from "../src/types";
import { ATTEMPT_STATES, type AttemptState } from "../src/control/session";
import { applyMigrations } from "./d1";

/**
 * GET /admin/attempts —— 归档 attempt 列表的读模型投影。
 *
 * 用例直接对 D1 `attempts` 表建模(不经过 DO),因为该端点承诺的数据源就只有这张表。
 * 三条硬要求各有对应用例:合法取值来自权威导出 ATTEMPT_ROLES / ATTEMPT_STATES
 * (实现里偷偷硬编码第二份清单就会被钉住)、`proxy_token` 与 `idempotency_key`
 * 绝不进投影、一次 GET 不得改动 tasks/attempts/decisions/events 任何一行。
 */

const TOKEN = env.WORKER_API_TOKEN;

interface ArchivedAttempt {
  id: string;
  task_id: string;
  role: string;
  state: string;
  tokens_used: number;
  input_tokens: number | null;
  cache_read_tokens: number | null;
  output_tokens: number | null;
  cost_weighted_tokens: number | null;
  max_model_tokens: number;
  max_wall_seconds: number;
  workflow_instance_id: string | null;
  created_at: string;
  finished_at: string | null;
}

interface AttemptsBody {
  attempts: ArchivedAttempt[];
  count: number;
}

interface ErrorBody {
  error: { type: string; detail?: string };
}

/** 端点承诺的投影字段:多一个就是泄露,少一个就是复盘缺料。必须严格升序(与被测的 sort 同序)。 */
const PROJECTED_FIELDS = [
  "cache_read_tokens",
  "cost_weighted_tokens",
  "created_at",
  "finished_at",
  "id",
  "input_tokens",
  "max_model_tokens",
  "max_wall_seconds",
  "output_tokens",
  "role",
  "state",
  "task_id",
  "tokens_used",
  "workflow_instance_id",
];

async function request(path: string, token: string | null = TOKEN): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return worker.fetch(
    new Request(`https://example.com${path}`, { headers }),
    env,
    createExecutionContext(),
  );
}

const getAttempts = (query = "", token: string | null = TOKEN) =>
  request(`/admin/attempts${query}`, token);

async function getJson<T>(query: string): Promise<{ status: number; body: T }> {
  const res = await getAttempts(query);
  return { status: res.status, body: (await res.json()) as T };
}

/** 唯一且可字典序排序的 created_at:序号越大越新。 */
function stamp(n: number): string {
  return new Date(Date.UTC(2026, 7, 1, 0, 0, 0) + n * 60_000).toISOString();
}

let clock = 0;
const nextStamp = () => stamp(++clock);

async function seedTask(over: { state?: TaskState; created_at?: string } = {}): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO tasks (id, spec, spec_digest, state, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      id,
      JSON.stringify({ prompt: `seed ${id}` }),
      "0".repeat(64),
      over.state ?? "DONE",
      1,
      over.created_at ?? nextStamp(),
      "2026-08-20T00:00:00.000Z",
    )
    .run();
  return id;
}

async function seedAttempt(over: {
  task_id?: string;
  role?: AttemptRole;
  state?: AttemptState;
  created_at?: string;
  finished_at?: string | null;
  tokens_used?: number;
  /** 用量四元组与成本加权值;省略即按「当时未记录」落 NULL */
  ledger?: {
    input_tokens?: number | null;
    cache_read_tokens?: number | null;
    output_tokens?: number | null;
    cost_weighted_tokens?: number | null;
  };
  proxy_token?: string | null;
  idempotency_key?: string;
  workflow_instance_id?: string | null;
} = {}): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO attempts (id, task_id, role, state, idempotency_key, proxy_token, tokens_used," +
      " input_tokens, cache_read_tokens, output_tokens, cost_weighted_tokens," +
      " max_model_tokens, max_wall_seconds, workflow_instance_id, created_at, finished_at)" +
      " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      id,
      over.task_id ?? (await seedTask()),
      over.role ?? "writer",
      over.state ?? "SUCCEEDED",
      over.idempotency_key ?? `${id}:attempt:${clock}`,
      over.proxy_token === undefined ? null : over.proxy_token,
      over.tokens_used ?? 1234,
      over.ledger?.input_tokens ?? null,
      over.ledger?.cache_read_tokens ?? null,
      over.ledger?.output_tokens ?? null,
      over.ledger?.cost_weighted_tokens ?? null,
      100_000,
      600,
      over.workflow_instance_id === undefined ? null : over.workflow_instance_id,
      over.created_at ?? nextStamp(),
      over.finished_at === undefined ? "2026-08-20T00:05:00.000Z" : over.finished_at,
    )
    .run();
  return id;
}

/** 四张表的全量快照:只读断言的前后对比口径。 */
async function snapshot(): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const table of ["tasks", "attempts", "decisions", "events"]) {
    const rows = await env.DB.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
    out[table] = rows.results;
  }
  return out;
}

async function countRows(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

// 迁移含不可重复执行的 ALTER TABLE:整个文件应用一次,而不是每个 suite 一次
beforeAll(applyMigrations);

describe("GET /admin/attempts", () => {
  beforeEach(async () => {
    clock = 0;
    await env.DB.prepare("DELETE FROM decisions").run();
    await env.DB.prepare("DELETE FROM events").run();
    await env.DB.prepare("DELETE FROM attempts").run();
    await env.DB.prepare("DELETE FROM tasks").run();
  });

  it("无参数返回全部归档 attempt,按 created_at 降序,字段恰为承诺的那 14 个", async () => {
    const oldest = await seedAttempt({ role: "writer", created_at: stamp(10) });
    const newest = await seedAttempt({ role: "verifier", created_at: stamp(30), tokens_used: 77 });
    const middle = await seedAttempt({ role: "reviewer", created_at: stamp(20) });

    const { status, body } = await getJson<AttemptsBody>("");
    expect(status).toBe(200);
    expect(body.count).toBe(3);
    expect(body.attempts.map((a) => a.id)).toEqual([newest, middle, oldest]);
    expect(Object.keys(body.attempts[0]).sort()).toEqual(PROJECTED_FIELDS);

    const hit = body.attempts.find((a) => a.id === newest);
    expect(hit).toMatchObject({
      role: "verifier",
      state: "SUCCEEDED",
      tokens_used: 77,
      max_model_tokens: 100_000,
      max_wall_seconds: 600,
      created_at: stamp(30),
      finished_at: "2026-08-20T00:05:00.000Z",
    });
  });

  it("复盘字段可为空:未回报的 finished_at / 无 workflow 实例如实给 null", async () => {
    const taskId = await seedTask();
    const id = await seedAttempt({
      task_id: taskId,
      state: "RUNNING",
      finished_at: null,
      workflow_instance_id: null,
    });

    const { status, body } = await getJson<AttemptsBody>(`?task_id=${taskId}`);
    expect(status).toBe(200);
    expect(body.attempts.map((a) => a.id)).toEqual([id]);
    expect(body.attempts[0].state).toBe("RUNNING");
    expect(body.attempts[0].finished_at).toBeNull();
    expect(body.attempts[0].workflow_instance_id).toBeNull();
  });

  /**
   * 成本口径的落地处:r11 实测 total 6,949,711 里 96.9% 是最便宜的隐式缓存命中,
   * 只透出 total 会把这条记成「史上最贵的 attempt」。四元组与加权值必须与 total
   * 并列可见,而「当时未记录」的行只能是 NULL —— 补 0 就是在编造事实。
   */
  it("台账四元组与成本加权值进投影;未记录的历史行是 NULL 而不是 0", async () => {
    const taskId = await seedTask();
    const recorded = await seedAttempt({
      task_id: taskId,
      tokens_used: 6_949_711,
      ledger: {
        input_tokens: 6_886_340,
        cache_read_tokens: 6_733_762,
        output_tokens: 63_371,
        cost_weighted_tokens: 1_562_701,
      },
    });
    const legacy = await seedAttempt({ task_id: taskId, tokens_used: 500 });

    const { status, body } = await getJson<AttemptsBody>(`?task_id=${taskId}`);
    expect(status).toBe(200);

    const hit = body.attempts.find((a) => a.id === recorded)!;
    expect(hit).toMatchObject({
      tokens_used: 6_949_711,
      input_tokens: 6_886_340,
      cache_read_tokens: 6_733_762,
      output_tokens: 63_371,
      cost_weighted_tokens: 1_562_701,
    });
    expect(hit.cost_weighted_tokens!).toBeLessThan(hit.tokens_used / 4);
    // 拆分自洽:fresh 部分 + output 就是加权值里折扣外的项
    expect(hit.input_tokens! + hit.output_tokens! - hit.cache_read_tokens!).toBe(215_949);

    const old = body.attempts.find((a) => a.id === legacy)!;
    expect(old.tokens_used).toBe(500);
    expect([
      old.input_tokens,
      old.cache_read_tokens,
      old.output_tokens,
      old.cost_weighted_tokens,
    ]).toEqual([null, null, null, null]);
  });

  it("?task_id 精确过滤命中的行,不命中返回空列表而不是 404", async () => {
    const mine = await seedTask();
    const theirs = await seedTask();
    const hit = await seedAttempt({ task_id: mine });
    await seedAttempt({ task_id: theirs });

    const { status, body } = await getJson<AttemptsBody>(`?task_id=${mine}`);
    expect(status).toBe(200);
    expect(body.count).toBe(1);
    expect(body.attempts).toEqual([expect.objectContaining({ id: hit, task_id: mine })]);

    // 表里有数据但过滤不命中 ≠ 端点不存在
    const empty = await getJson<AttemptsBody>(`?task_id=${theirs}&role=reviewer`);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ attempts: [], count: 0 });
  });

  it("?role 精确过滤命中的行,不命中返回空列表", async () => {
    const taskId = await seedTask();
    await seedAttempt({ task_id: taskId, role: "writer" });
    await seedAttempt({ task_id: taskId, role: "verifier" });
    const reviewed = await seedAttempt({ task_id: taskId, role: "reviewer" });

    const { status, body } = await getJson<AttemptsBody>("?role=reviewer");
    expect(status).toBe(200);
    expect(body.count).toBe(1);
    expect(body.attempts.map((a) => a.id)).toEqual([reviewed]);

    const none = await getJson<AttemptsBody>(`?role=writer&task_id=${await seedTask()}`);
    expect(none.status).toBe(200);
    expect(none.body).toEqual({ attempts: [], count: 0 });
  });

  it("?state 精确过滤命中的行,不命中返回空列表", async () => {
    const taskId = await seedTask();
    await seedAttempt({ task_id: taskId, state: "SUCCEEDED" });
    const failed = await seedAttempt({ task_id: taskId, state: "FAILED" });
    await seedAttempt({ task_id: taskId, state: "BLOCKED" });

    const { status, body } = await getJson<AttemptsBody>("?state=FAILED");
    expect(status).toBe(200);
    expect(body.attempts.map((a) => a.id)).toEqual([failed]);

    const none = await getJson<AttemptsBody>("?state=RUNNING");
    expect(none.status).toBe(200);
    expect(none.body).toEqual({ attempts: [], count: 0 });
  });

  it("过滤器可组合,语义为 AND", async () => {
    const taskId = await seedTask();
    const target = await seedAttempt({ task_id: taskId, role: "writer", state: "FAILED" });
    // 三条都不该在同时 ?task_id&role&state 的结果里出现
    await seedAttempt({ task_id: taskId, role: "writer", state: "SUCCEEDED" });
    await seedAttempt({ task_id: taskId, role: "reviewer", state: "FAILED" });
    await seedAttempt({ task_id: await seedTask(), role: "writer", state: "FAILED" });

    const { status, body } = await getJson<AttemptsBody>(
      `?task_id=${taskId}&role=writer&state=FAILED`,
    );
    expect(status).toBe(200);
    expect(body.count).toBe(1);
    expect(body.attempts.map((a) => a.id)).toEqual([target]);
  });

  it("合法 role/state 取值即权威导出,400 提示同源于该声明", async () => {
    expect(ATTEMPT_ROLES.length).toBeGreaterThan(0);
    expect(ATTEMPT_STATES.length).toBeGreaterThan(0);

    for (const role of ATTEMPT_ROLES) {
      const res = await getAttempts(`?role=${role}`);
      expect(res.status, `role=${role} 应被接受`).toBe(200);
      await res.arrayBuffer();
    }
    for (const state of ATTEMPT_STATES) {
      const res = await getAttempts(`?state=${state}`);
      expect(res.status, `state=${state} 应被接受`).toBe(200);
      await res.arrayBuffer();
    }

    // detail 由权威清单生成:实现里换成第二份硬编码清单就会被这条钉住
    const roleErr = (await getJson<ErrorBody>("?role=__nope__")).body;
    expect(roleErr.error.detail).toBe(`role must be one of ${ATTEMPT_ROLES.join(", ")}`);
    const stateErr = (await getJson<ErrorBody>("?state=__nope__")).body;
    expect(stateErr.error.detail).toBe(`state must be one of ${ATTEMPT_STATES.join(", ")}`);
  });

  it("非法 role/state 返回 400(大小写不符、空串、注入探针一律拒绝)", async () => {
    const taskId = await seedTask();
    await seedAttempt({ task_id: taskId, role: "writer", state: "FAILED" });
    await seedAttempt({ task_id: taskId, role: "verifier", state: "SUCCEEDED" });
    await seedAttempt({ task_id: taskId, role: "reviewer", state: "BLOCKED" });

    for (const role of ["WRITER", "Writer", "", " writer", "author", "' OR 1=1 --"]) {
      const { status, body } = await getJson<ErrorBody>(`?role=${encodeURIComponent(role)}`);
      expect(status, `role=${JSON.stringify(role)} 应被拒绝`).toBe(400);
      expect(body.error.type).toBe("invalid_role");
    }
    // attempt 状态与 task 状态是两套口径:借用 task 的状态同样非法
    for (const state of ["running", "Succeeded", "", "DONE", "AWAITING_APPROVAL", "' OR 1=1 --"]) {
      const { status, body } = await getJson<ErrorBody>(`?state=${encodeURIComponent(state)}`);
      expect(status, `state=${JSON.stringify(state)} 应被拒绝`).toBe(400);
      expect(body.error.type).toBe("invalid_state");
    }
    // 非法值只能被拒,不能进了查询:表里的行一处不少
    expect(await countRows("attempts")).toBe(3);
  });

  it("?task_id 的格式口径与 /tasks/:id 路由一致(36 字符 [0-9a-f-])", async () => {
    // 与路由同一字符类:36 位小写 hex/连字符即合法,不做多余的 "能不能 parse 成 UUID" 收紧
    for (const ok of ["0".repeat(36), crypto.randomUUID(), "a".repeat(36)]) {
      const res = await getAttempts(`?task_id=${ok}`);
      expect(res.status, `task_id=${ok} 应被接受`).toBe(200);
      await res.arrayBuffer();
    }
    for (const bad of [
      "",
      "0".repeat(35),
      "0".repeat(37),
      crypto.randomUUID().toUpperCase(),
      "g".repeat(36),
      "/tasks/1",
      "' OR 1=1 --",
      "1=1",
    ]) {
      const { status, body } = await getJson<ErrorBody>(`?task_id=${encodeURIComponent(bad)}`);
      expect(status, `task_id=${JSON.stringify(bad)} 应被拒绝`).toBe(400);
      expect(body.error.type).toBe("invalid_task_id");
    }
  });

  it("?limit 生效且 count 是截断后的条数", async () => {
    const taskId = await seedTask();
    for (const n of [1, 2, 3]) {
      await seedAttempt({ task_id: taskId, created_at: stamp(n) });
    }

    const { status, body } = await getJson<AttemptsBody>("?limit=2");
    expect(status).toBe(200);
    expect(body.count).toBe(2);
    expect(body.attempts.map((a) => a.created_at)).toEqual([stamp(3), stamp(2)]);
  });

  it("limit 缺省 50,上限 200 可用", async () => {
    const taskId = await seedTask();
    for (let i = 1; i <= 51; i++) {
      await seedAttempt({ task_id: taskId, created_at: stamp(i) });
    }

    expect((await getJson<AttemptsBody>("")).body.count).toBe(50);
    expect((await getJson<AttemptsBody>("?limit=200")).body.count).toBe(51);
    expect((await getJson<AttemptsBody>("?limit=1")).body.count).toBe(1);
  });

  it("limit 非数字或越出 [1,200] 返回 400", async () => {
    await seedAttempt();
    for (const limit of ["0", "-1", "201", "abc", "1.5", "", "1e400", "200.0.1"]) {
      const { status, body } = await getJson<ErrorBody>(`?limit=${encodeURIComponent(limit)}`);
      expect(status, `limit=${JSON.stringify(limit)} 应被拒绝`).toBe(400);
      expect(body.error.type).toBe("invalid_limit");
    }
  });

  it("安全投影:带非空 proxy_token 的 attempt 不泄露凭据,idempotency_key 也不进投影", async () => {
    const taskId = await seedTask();
    const proxyToken = "srv-once-proxy-token-9f2c41d0b7e54a86";
    const idempotencyKey = `${taskId}:attempt:1`;
    const id = await seedAttempt({
      task_id: taskId,
      proxy_token: proxyToken,
      idempotency_key: idempotencyKey,
    });

    const res = await getAttempts("");
    const text = await res.text();
    expect(res.status).toBe(200);
    // 断言的是响应正文原文:字段名与值都不能出现
    expect(text).not.toContain(proxyToken);
    expect(text).not.toContain("proxy_token");
    expect(text).not.toContain(idempotencyKey);
    expect(text).not.toContain("idempotency_key");

    const body = JSON.parse(text) as AttemptsBody;
    expect(body.count).toBe(1);
    expect(Object.keys(body.attempts[0]).sort()).toEqual(PROJECTED_FIELDS);

    // 凭据仍在库里 —— 证明是投影剥掉,而不是 seed 没写进去
    const raw = await env.DB.prepare("SELECT proxy_token, idempotency_key FROM attempts WHERE id = ?")
      .bind(id)
      .first<{ proxy_token: string; idempotency_key: string }>();
    expect(raw?.proxy_token).toBe(proxyToken);
    expect(raw?.idempotency_key).toBe(idempotencyKey);
  });

  it("鉴权与 GET /admin/tasks、GET /admin/chain-check 走同一条 checkApiToken 路径", async () => {
    expect(TOKEN).toBeTruthy();
    for (const path of ["/admin/attempts", "/admin/tasks", "/admin/chain-check"]) {
      expect((await request(path, null)).status, `${path} 缺 token 应 401`).toBe(401);
      expect((await request(path, "wrong-token")).status, `${path} 错 token 应 401`).toBe(401);
    }
  });

  it("只读:GET 不改动 tasks/attempts/decisions/events 任何一行", async () => {
    const taskId = await seedTask({ state: "BLOCKED" });
    const attemptId = await seedAttempt({ task_id: taskId, role: "writer", state: "FAILED" });
    await env.DB.prepare(
      "INSERT INTO decisions (id, task_id, attempt_id, actor, decision, evidence_digest, fencing_token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(crypto.randomUUID(), taskId, attemptId, "human:api", "reject", "d".repeat(64), 4, nextStamp())
      .run();
    await env.DB.prepare(
      "INSERT INTO events (id, task_id, kind, payload, digest, prev_digest, seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(crypto.randomUUID(), taskId, "attempt.finished", "{}", "e".repeat(64), null, 1, nextStamp())
      .run();
    const before = await snapshot();

    for (const query of ["", "?role=writer", `?task_id=${taskId}&state=FAILED&limit=1`]) {
      const res = await getAttempts(query);
      expect(res.status, query).toBe(200);
      await res.arrayBuffer();
    }
    // 畸形参数同样不能留下痕迹
    const probe = await getJson<ErrorBody>(`?task_id=${encodeURIComponent("' OR 1=1 --")}`);
    expect(probe.status).toBe(400);
    expect(probe.body.error.type).toBe("invalid_task_id");

    expect(await snapshot()).toEqual(before);
  });

  it("落地页登记该端点,并如实说明归档视图与凭据不外泄", async () => {
    const res = await request("/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<dt>GET /admin/attempts</dt>");
    // 漏掉这句,读者就会把复盘视图当实时看板
    expect(html).toContain("不含尚未归档的在途 attempt");
    expect(html).toContain("数据源仅为 D1 归档的 <code>attempts</code> 表");
    // 诚实性:文档里点名 proxy_token 不下发,且枚举的合法取值与权威声明一致
    expect(html).toContain("proxy_token");
    expect(html).toContain("绝不下发");
    expect(html).toContain(ATTEMPT_ROLES.join("/"));
    expect(html).toContain(ATTEMPT_STATES.join("/"));
  });
});
