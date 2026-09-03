import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createExecutionContext, env } from "cloudflare:test";
import worker from "../src/index";
import { sha256Hex } from "../src/audit/evidence";
import type { TaskState } from "../src/types";
import { applyMigrations } from "./d1";
import readme from "../README.md?raw";

/**
 * GET /admin/events —— 归档事件流(hash chain)的读模型投影。
 *
 * 用例直接对 D1 `events` 表建模(不经过 DO),因为该端点承诺的数据源只有这张表。
 * 端点的立身之本是「客户端拿到返回的字节就能自己把链验一遍」,所以夹具按
 * `appendEvent` 的口径造链 —— canonical = `JSON.stringify({task_id, kind, payload})`
 * 写进 `payload` 列,digest = `sha256Hex((prev ?? "GENESIS") + canonical)`,用的正是
 * 实现里 chain-check 的同一个 `sha256Hex`(单一 hash 权威,不另写一份)。这样
 * 「重放一遍 chain-check」才是在测端点,而不是在测夹具的自洽。
 *
 * 四条硬要求各有对应用例:canonical 逐字返回(不解析/不重新序列化)、digest 可
 * 独立重算且 prev 链接自洽、游标分页走完不重不漏且末页为 null、journal 不携带
 * `proxy_token`。再加只读快照与文档不漂移。
 */

const TOKEN = env.WORKER_API_TOKEN;

interface ArchivedEvent {
  seq: number;
  kind: string;
  digest: string;
  prev_digest: string | null;
  created_at: string;
  canonical: string;
}

interface EventsBody {
  events: ArchivedEvent[];
  next_cursor: string | null;
}

interface ErrorBody {
  error: { type: string; detail?: string };
}

/** 端点承诺的事件字段:多一个是越权,少一个是回放缺料。 */
const PROJECTED_FIELDS = ["canonical", "created_at", "digest", "kind", "prev_digest", "seq"];

/** 真实出现过的 kind(取自 session.ts 的 appendEvent 调用),让夹具像一份真 journal。 */
const REAL_KINDS = [
  "task.created",
  "attempt.created",
  "base.frozen",
  "task.transition",
  "result.captured",
  "evidence.pinned",
  "review.completed",
  "decision.recorded",
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

const getEvents = (query = "", token: string | null = TOKEN) =>
  request(`/admin/events${query}`, token);

async function getJson<T>(query: string): Promise<{ status: number; body: T }> {
  const res = await getEvents(query);
  return { status: res.status, body: (await res.json()) as T };
}

/** 唯一且可字典序排序的 created_at:序号越大越新。 */
function stamp(n: number): string {
  return new Date(Date.UTC(2026, 7, 1, 0, 0, 0) + n * 60_000).toISOString();
}

let clock = 0;
const nextStamp = () => stamp(++clock);

async function seedTask(over: { state?: TaskState } = {}): Promise<string> {
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
      nextStamp(),
      "2026-08-20T00:00:00.000Z",
    )
    .run();
  return id;
}

async function seedAttemptWithProxyToken(taskId: string, proxyToken: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO attempts (id, task_id, role, state, idempotency_key, proxy_token, tokens_used," +
      " max_model_tokens, max_wall_seconds, workflow_instance_id, created_at, finished_at)" +
      " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      id,
      taskId,
      "writer",
      "SUCCEEDED",
      `${id}:attempt:1`,
      proxyToken,
      1234,
      100_000,
      600,
      null,
      nextStamp(),
      "2026-08-20T00:05:00.000Z",
    )
    .run();
  return id;
}

interface SeedEventSpec {
  kind: string;
  payload: unknown;
  /**
   * 直接指定 `payload` 列原文。用途是掺进「parse→stringify 会变样」的行:
   * 纯 JSON.stringify 出来的 canonical 再解析再序列化是自身,那种夹具测不出
   * 「实现把 canonical 加工过」—— 必须有几行原文经不起加工。
   */
  raw?: string;
}

function manySpecs(n: number): SeedEventSpec[] {
  return Array.from({ length: n }, (_, i) => ({
    kind: REAL_KINDS[i % REAL_KINDS.length],
    payload: { attempt_id: `attempt-${i + 1}`, note: `第 ${i + 1} 条` },
  }));
}

/** 一份按 appendEvent 的形状写、但空白/数字格式/转义都不规整的原文。 */
function messyCanonical(taskId: string, kind: string, n: number): string {
  return (
    `{   "task_id" : "${taskId}" ,  "kind":"${kind}",` +
    `"payload":{"zeta":null,"n":1e21,"frac":0.30000000000000004,` +
    `"note":"第 ${n} 条 \\"熔断\\" \\\\ 转义 \\u65e5\\u672c","empty":{}}  }`
  );
}

/**
 * 按 appendEvent 的口径种一条 hash chain:seq 从 1 连续递增,prev 指向上一条 digest,
 * 首条 prev_digest 为 null。返回值即端点应当原样吐出的投影,用例直接拿它当期望值。
 */
async function seedChain(
  taskId: string,
  specs: SeedEventSpec[],
  stampFor: (seq: number) => string = () => nextStamp(),
): Promise<ArchivedEvent[]> {
  const rows: ArchivedEvent[] = [];
  let prev: string | null = null;
  for (const [i, spec] of specs.entries()) {
    const canonical = spec.raw ?? JSON.stringify({ task_id: taskId, kind: spec.kind, payload: spec.payload });
    const digest = await sha256Hex((prev ?? "GENESIS") + canonical);
    rows.push({
      seq: i + 1,
      kind: spec.kind,
      digest,
      prev_digest: prev,
      created_at: stampFor(i + 1),
      canonical,
    });
    prev = digest;
  }
  await env.DB.batch(
    rows.map((e) =>
      env.DB.prepare(
        "INSERT INTO events (id, task_id, kind, payload, digest, prev_digest, seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(crypto.randomUUID(), taskId, e.kind, e.canonical, e.digest, e.prev_digest, e.seq, e.created_at),
    ),
  );
  return rows;
}

/** 把链上每 every 条换成「经不起加工」的原文,让重算 digest 的用例同时钉住逐字返回。 */
function withMessy(taskId: string, specs: SeedEventSpec[], every = 3): SeedEventSpec[] {
  return specs.map((spec, i) =>
    (i + 1) % every === 0 ? { ...spec, raw: messyCanonical(taskId, spec.kind, i + 1) } : spec,
  );
}

/** 直接指定 `payload` 列原文写一行:用于钉死「canonical 逐字返回」。 */
async function seedRawEvent(
  taskId: string,
  seq: number,
  kind: string,
  canonical: string,
  prev: string | null,
): Promise<ArchivedEvent> {
  const digest = await sha256Hex((prev ?? "GENESIS") + canonical);
  const created_at = nextStamp();
  await env.DB.prepare(
    "INSERT INTO events (id, task_id, kind, payload, digest, prev_digest, seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(crypto.randomUUID(), taskId, kind, canonical, digest, prev, seq, created_at)
    .run();
  return { seq, kind, digest, prev_digest: prev, created_at, canonical };
}

/**
 * 客户端重放 chain-check:只吃端点返回的字段,一次都不碰数据库。
 * prev 链接不自洽或 digest 重算不符即断言失败。
 */
async function replayChain(events: ArchivedEvent[], label = ""): Promise<void> {
  let prev: string | null = null;
  for (const e of events) {
    expect(e.prev_digest, `${label}seq=${e.seq} 的 prev_digest 应指向前一条`).toBe(prev);
    expect(
      await sha256Hex((prev ?? "GENESIS") + e.canonical),
      `${label}seq=${e.seq} 的 digest 应能由返回的 canonical 独立重算`,
    ).toBe(e.digest);
    prev = e.digest;
  }
}

/** 沿 next_cursor 走完所有页;不收敛就断言失败(而不是把测试吊死)。 */
async function walkPages(
  taskId: string,
  limit: number,
  maxPages = 40,
): Promise<{ events: ArchivedEvent[]; pages: EventsBody[] }> {
  const events: ArchivedEvent[] = [];
  const pages: EventsBody[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const res = await getEvents(
      `?task_id=${taskId}&limit=${limit}${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as EventsBody;
    expect(body.events.length, `第 ${page + 1} 页不应为空页`).toBeGreaterThan(0);
    pages.push(body);
    events.push(...body.events);
    if (body.next_cursor === null) return { events, pages };
    expect(body.next_cursor, "游标必须推进").not.toBe(cursor);
    cursor = body.next_cursor;
  }
  throw new Error(`走完 ${maxPages} 页仍未收敛到 next_cursor=null`);
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

async function countEvents(taskId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ?")
    .bind(taskId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * 从文档正文抽出承诺的事件字段清单(`{"events":[{...}]}`)。落地页与 README 用同一
 * 形状书写,所以两份文档与实际返回可以三方对表 —— 文档漂移就会被钉住。
 */
function documentedEventFields(doc: string, where: string): string[] {
  const match = /"events":\[\{([^}]*)\}\]/.exec(doc);
  expect(match, `${where} 应登记 {"events":[{...}]} 的字段清单`).not.toBeNull();
  return match![1]
    .split(",")
    .map((field) => field.trim())
    .filter((field) => field.length > 0)
    .sort();
}

/** 两处文档都必须如实交代的几件事。 */
const HONESTY_PHRASES = [
  "已归档(终态)任务的事件",
  "看不到仍在 DO 中运行、尚未归档的在途事件",
  "必填",
  "逐字",
  "独立重算",
  'sha256Hex((prev_digest ?? "GENESIS") + canonical)',
  "proxy_token",
  "绝不携带",
  "next_cursor",
  "seq",
  "升序",
];

// 迁移含不可重复执行的 ALTER TABLE:整个文件应用一次,而不是每个 suite 一次
beforeAll(applyMigrations);

describe("GET /admin/events", () => {
  beforeEach(async () => {
    clock = 0;
    await env.DB.prepare("DELETE FROM decisions").run();
    await env.DB.prepare("DELETE FROM events").run();
    await env.DB.prepare("DELETE FROM attempts").run();
    await env.DB.prepare("DELETE FROM tasks").run();
  });

  describe("投影与顺序", () => {
    it("按 seq 升序返回,字段恰为承诺的那 6 个,next_cursor 无后续时为 null", async () => {
      const taskId = await seedTask();
      const expected = await seedChain(taskId, manySpecs(3));

      const res = await getEvents(`?task_id=${taskId}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as EventsBody;
      expect(Object.keys(body).sort()).toEqual(["events", "next_cursor"]);
      expect(body.events).toEqual(expected);
      expect(body.next_cursor).toBeNull();
      expect(body.events.map((e) => e.seq)).toEqual([1, 2, 3]);
      expect(Object.keys(body.events[0]).sort()).toEqual(PROJECTED_FIELDS);
    });

    it("分页脊线是 seq:created_at 倒着种,回放顺序仍是 seq 升序", async () => {
      const taskId = await seedTask();
      const expected = await seedChain(taskId, manySpecs(3), (seq) => stamp(1000 - seq));
      // 夹具确实是按 seq 倒着发时间戳 —— 否则这条测试什么也证明不了
      expect(expected.map((e) => e.created_at)).toEqual([stamp(999), stamp(998), stamp(997)]);

      const { status, body } = await getJson<EventsBody>(`?task_id=${taskId}`);
      expect(status).toBe(200);
      expect(body.events.map((e) => e.seq)).toEqual([1, 2, 3]);
      expect(body.events).toEqual(expected);
      // created_at 与 seq 反序且互不相同:ORDER BY created_at 的实现会在这里露馅
      const created = expected.map((e) => e.created_at);
      expect(new Set(created).size).toBe(3);
      expect(created).toEqual([...created].sort().reverse());
    });

    it("只返回该 task 的事件:同库别的 task 一条不漏进来", async () => {
      const mine = await seedTask();
      const theirs = await seedTask();
      const expected = await seedChain(mine, manySpecs(2));
      await seedChain(theirs, manySpecs(5));

      const { status, body } = await getJson<EventsBody>(`?task_id=${mine}`);
      expect(status).toBe(200);
      expect(body.events).toEqual(expected);
      expect(body.events.length).toBe(2);
      // 不串台的旁证:另一个 task 的条数与 kind 序列没混进来
      expect(body.events.map((e) => e.seq)).not.toEqual([1, 2, 3, 4, 5]);
    });

    it("canonical 是 D1 payload 列的逐字原文:不解析、不改写、不重新序列化", async () => {
      const taskId = await seedTask();
      // 一份 JSON 解析后再序列化必定会变样的原文:键序、空白、数字格式、转义都动不得
      const raw = messyCanonical(taskId, "gate.no_progress", 1);
      expect(
        JSON.stringify(JSON.parse(raw)),
        "夹具本身必须经不起一轮 parse→stringify",
      ).not.toBe(raw);
      const expected = await seedRawEvent(taskId, 1, "gate.no_progress", raw, null);

      const { status, body } = await getJson<EventsBody>(`?task_id=${taskId}`);
      expect(status).toBe(200);
      expect(body.events).toHaveLength(1);
      expect(body.events[0].canonical).toBe(raw);
      expect(body.events[0]).toEqual(expected);
      // 逐字返回的直接结果:客户端仍能由这段原文重算出 digest
      expect(await sha256Hex(`GENESIS${raw}`)).toBe(body.events[0].digest);
    });

    it("kind 清单不在端点侧收紧:任意 appendEvent 写过的 kind 都原样回放", async () => {
      const taskId = await seedTask();
      const specs = REAL_KINDS.map((kind) => ({ kind, payload: { probe: kind } }));
      const expected = await seedChain(taskId, specs);

      const { body } = await getJson<EventsBody>(`?task_id=${taskId}`);
      expect(body.events.map((e) => e.kind)).toEqual(REAL_KINDS);
      expect(body.events).toEqual(expected);
      // canonical 里内层 payload 也是原文的一部分:不解析就不会丢字段
      expect(body.events[0].canonical).toContain('"probe":"task.created"');
    });
  });

  describe("自校验(客户端重放 chain-check)", () => {
    it("逐条用返回的 canonical + prev_digest 重算 digest 相等,且 prev 链接自洽", async () => {
      const taskId = await seedTask();
      await seedChain(taskId, withMessy(taskId, manySpecs(6)));

      const { status, body } = await getJson<EventsBody>(`?task_id=${taskId}`);
      expect(status).toBe(200);
      expect(body.events).toHaveLength(6);
      expect(body.events[0].prev_digest).toBeNull();
      await replayChain(body.events);
    });

    it("跨页重放同样自洽:游标翻页不破坏 prev 链接", async () => {
      const taskId = await seedTask();
      const expected = await seedChain(taskId, withMessy(taskId, manySpecs(7)));

      const { events, pages } = await walkPages(taskId, 3);
      expect(pages).toHaveLength(3);
      expect(events).toEqual(expected);
      expect(events[0].prev_digest).toBeNull();
      await replayChain(events, "跨页 ");
    });

    it("与 GET /admin/chain-check 同口径:服务端说没断,客户端也说没断", async () => {
      const taskId = await seedTask();
      await seedChain(taskId, withMessy(taskId, manySpecs(4)));

      const check = await request("/admin/chain-check");
      expect(check.status).toBe(200);
      expect(await check.json()).toEqual({ checked: 1, broken: 0, brokenTasks: [] });

      const { body } = await getJson<EventsBody>(`?task_id=${taskId}`);
      await replayChain(body.events, "重放 ");
    });

    it("链被篡改时重放必定失败:改一字节 canonical 就断(测的是断言本身有效)", async () => {
      const taskId = await seedTask();
      const expected = await seedChain(taskId, manySpecs(2));
      const { body } = await getJson<EventsBody>(`?task_id=${taskId}`);
      const tampered = body.events.map((e, i) =>
        i === 1 ? { ...e, canonical: e.canonical.replace("第 2 条", "第 9 条") } : e,
      );
      expect(tampered).not.toEqual(expected);
      await expect(replayChain(tampered)).rejects.toThrow(/digest/);
    });
  });

  describe("游标分页", () => {
    it("limit 截断并给出下一页游标;沿 next_cursor 走完不重不漏", async () => {
      const taskId = await seedTask();
      const expected = await seedChain(taskId, withMessy(taskId, manySpecs(55), 5));

      const { events, pages } = await walkPages(taskId, 20);
      expect(pages.map((p) => p.events.length)).toEqual([20, 20, 15]);
      expect(events.map((e) => e.seq)).toEqual(expected.map((e) => e.seq));
      expect(new Set(events.map((e) => e.digest)).size).toBe(55); // 无重复
      expect(events).toEqual(expected); // 并集 == 全量,且按 seq 升序
      expect(pages.at(-1)!.next_cursor).toBeNull(); // 末页 null
      for (const [i, page] of pages.entries()) {
        if (i < pages.length - 1) expect(page.next_cursor, `第 ${i + 1} 页应有后续`).not.toBeNull();
      }
    });

    it("恰好取满 limit 而后面没有行时,next_cursor 即为 null(不给指向空页的游标)", async () => {
      const taskId = await seedTask();
      await seedChain(taskId, manySpecs(4));

      const { status, body } = await getJson<EventsBody>(`?task_id=${taskId}&limit=4`);
      expect(status).toBe(200);
      expect(body.events).toHaveLength(4);
      expect(body.next_cursor).toBeNull();
    });

    it("limit=1 也能一页一页走到头", async () => {
      const taskId = await seedTask();
      const expected = await seedChain(taskId, manySpecs(3));

      const { events, pages } = await walkPages(taskId, 1);
      expect(pages).toHaveLength(3);
      expect(events).toEqual(expected);
    });

    it("游标不透明:不是裸 seq,且可直接放进 query string", async () => {
      const taskId = await seedTask();
      await seedChain(taskId, manySpecs(6));

      const first = await getJson<EventsBody>(`?task_id=${taskId}&limit=2`);
      const cursor = first.body.next_cursor!;
      const lastSeq = first.body.events.at(-1)!.seq;
      expect(cursor, "游标不该就是裸 seq").not.toBe(String(lastSeq));
      expect(/^[0-9a-zA-Z_-]+$/.test(cursor), "游标须 URL 安全,不能含 + / =").toBe(true);
      // 裸 seq 不是合法游标:编码方式属于实现,客户端只能原样回传 next_cursor
      for (const bare of ["2", "0", "3", String(lastSeq)]) {
        const { status, body } = await getJson<ErrorBody>(`?task_id=${taskId}&limit=2&cursor=${bare}`);
        expect(status, `cursor=${bare} 应被拒绝`).toBe(400);
        expect(body.error.type).toBe("invalid_cursor");
      }
    });

    it("garbage cursor 一律 400:非法 base64、空串、超长串、能解码但内容不对", async () => {
      const taskId = await seedTask();
      await seedChain(taskId, manySpecs(3));

      const garbage = [
        "!!!",
        "",
        "   ",
        "not-a-cursor",
        "A".repeat(500),
        "Z".repeat(5000),
        btoa("seq:2"), // 合法 base64,但没有游标前缀
        btoa("evt1:abc"), // 前缀对但位置不是数字
        btoa("evt1:-2"),
        btoa("evt1:2.5"),
        btoa("evt1:"),
        `${btoa("evt1:2")}zz`, // 尾部掺垃圾
      ];
      for (const cursor of garbage) {
        const { status, body } = await getJson<ErrorBody>(
          `?task_id=${taskId}&cursor=${encodeURIComponent(cursor)}`,
        );
        expect(status, `cursor=${JSON.stringify(cursor.slice(0, 24))} 应被拒绝`).toBe(400);
        expect(body.error.type).toBe("invalid_cursor");
      }
    });

    it("翻页结果可直接重算:每页首条的 prev_digest 等于上页末条的 digest", async () => {
      const taskId = await seedTask();
      await seedChain(taskId, manySpecs(9));

      const { pages } = await walkPages(taskId, 2);
      for (let i = 1; i < pages.length; i++) {
        expect(pages[i].events[0].prev_digest).toBe(pages[i - 1].events.at(-1)!.digest);
      }
      expect(pages[0].events[0].prev_digest).toBeNull();
    });
  });

  describe("参数校验", () => {
    it("?task_id 必填:省略即 400(/admin/attempts 里可选,这里不行)", async () => {
      await seedChain(await seedTask(), manySpecs(2));

      for (const query of ["", "?limit=5", "?cursor=abc"]) {
        const { status, body } = await getJson<ErrorBody>(query);
        expect(status, `省略 task_id(${JSON.stringify(query)}) 应被拒绝`).toBe(400);
        expect(body.error.type).toBe("invalid_task_id");
      }
      // 对照:同一套夹具下 /admin/attempts 不带 task_id 是合法的
      const attempts = await request("/admin/attempts?limit=5");
      expect(attempts.status).toBe(200);
      await attempts.arrayBuffer();
    });

    it("?task_id 的格式口径与 /tasks/:id 路由一致(36 字符 [0-9a-f-])", async () => {
      for (const ok of ["0".repeat(36), crypto.randomUUID(), "a".repeat(36)]) {
        const res = await getEvents(`?task_id=${ok}`);
        expect(res.status, `task_id=${ok} 应被接受`).toBe(200);
        const body = (await res.json()) as EventsBody;
        expect(body).toEqual({ events: [], next_cursor: null });
      }
    });

    it("task_id 畸形一律 400:大小写不符、空串、长度不符、注入探针", async () => {
      const taskId = await seedTask();
      await seedChain(taskId, manySpecs(2));

      for (const bad of [
        "",
        " ",
        "0".repeat(35),
        "0".repeat(37),
        crypto.randomUUID().toUpperCase(),
        "g".repeat(36),
        "/tasks/1",
        "1=1",
        "' OR 1=1 --",
        `${taskId}'; DROP TABLE events; --`,
        `${taskId}%27`,
        "undefined",
      ]) {
        const { status, body } = await getJson<ErrorBody>(`?task_id=${encodeURIComponent(bad)}`);
        expect(status, `task_id=${JSON.stringify(bad)} 应被拒绝`).toBe(400);
        expect(body.error.type).toBe("invalid_task_id");
      }
      // 探针不能把事件捞出来:畸形值一条都不返回,表里一行不少
      expect(await countEvents(taskId)).toBe(2);
    });

    it("limit 缺省 50、上限 200 可用,与 /admin/tasks、/admin/attempts 同一份规则", async () => {
      const taskId = await seedTask();
      await seedChain(taskId, manySpecs(120));

      expect((await getJson<EventsBody>(`?task_id=${taskId}`)).body.events).toHaveLength(50);
      expect((await getJson<EventsBody>(`?task_id=${taskId}`)).body.next_cursor).not.toBeNull();
      expect((await getJson<EventsBody>(`?task_id=${taskId}&limit=200`)).body.events).toHaveLength(120);
      expect((await getJson<EventsBody>(`?task_id=${taskId}&limit=1`)).body.events).toHaveLength(1);

      // 与 /admin/tasks 同一份规则:连 400 的 detail 措辞都不允许分叉
      const mine = (await getJson<ErrorBody>(`?task_id=${taskId}&limit=0`)).body.error.detail;
      const shared = (await (await request("/admin/tasks?limit=0")).json() as ErrorBody).error.detail;
      expect(mine).toBe(shared);
      expect(mine).toBe("limit must be an integer within [1, 200]");
    });

    it("limit 非数字或越出 [1,200] 返回 400", async () => {
      const taskId = await seedTask();
      await seedChain(taskId, manySpecs(2));

      // " 5" 不在这个清单里:共用的 parseAdminLimit 走 Number(),空白包裹的数字按既
      // 有口径放行 —— 那是 /admin/tasks、/admin/attempts 同样的行为,这里不另立规则。
      for (const limit of ["0", "-0", "-1", "201", "abc", "1.5", "", "1e400", "200.0.1"]) {
        const { status, body } = await getJson<ErrorBody>(`?task_id=${taskId}&limit=${encodeURIComponent(limit)}`);
        expect(status, `limit=${JSON.stringify(limit)} 应被拒绝`).toBe(400);
        expect(body.error.type).toBe("invalid_limit");
      }
    });

    it("task_id 先于 limit/cursor 校验:全畸形也只报 task_id", async () => {
      const { status, body } = await getJson<ErrorBody>("?limit=9999&cursor=!!!");
      expect(status).toBe(400);
      expect(body.error.type).toBe("invalid_task_id");
    });
  });

  describe("安全与只读", () => {
    it("journal 不携带凭据:同 task 有非空 proxy_token 的 attempt,响应正文里查无此值", async () => {
      const taskId = await seedTask();
      const proxyToken = "srv-once-proxy-token-4d7f1b0c8e2953a6";
      const attemptId = await seedAttemptWithProxyToken(taskId, proxyToken);
      // 事件载荷里出现 attempt_id:复盘要有的东西一样不少,但凭据不进事件链
      await seedChain(taskId, [
        { kind: "attempt.created", payload: { attempt_id: attemptId, role: "writer" } },
        { kind: "evidence.pinned", payload: { attempt_id: attemptId, manifest_key: "evidence/x.json" } },
        { kind: "decision.recorded", payload: { attempt_id: attemptId, decision: "approve" } },
      ]);

      for (const query of [`?task_id=${taskId}`, `?task_id=${taskId}&limit=1`]) {
        const res = await getEvents(query);
        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).not.toContain(proxyToken);
        expect(text).not.toContain("proxy_token");
        expect(JSON.parse(text) as EventsBody).toMatchObject({ events: expect.any(Array) });
      }

      // 凭据确实在库里 —— 证明是「journal 按构造不含」,而不是 seed 没写进去
      const raw = await env.DB.prepare("SELECT proxy_token FROM attempts WHERE id = ?")
        .bind(attemptId)
        .first<{ proxy_token: string }>();
      expect(raw?.proxy_token).toBe(proxyToken);
      const withToken = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM events WHERE payload LIKE ?",
      )
        .bind(`%${proxyToken}%`)
        .first<{ n: number }>();
      expect(withToken?.n).toBe(0);
    });

    it("只读:GET 不改动 tasks/attempts/decisions/events 任何一行", async () => {
      const taskId = await seedTask({ state: "BLOCKED" });
      await seedChain(taskId, manySpecs(3));
      const before = await snapshot();
      // 游标从实际响应里取,不硬编码编码方式
      const paged = await getJson<EventsBody>(`?task_id=${taskId}&limit=2`);
      const cursor = paged.body.next_cursor!;

      for (const query of [
        `?task_id=${taskId}`,
        `?task_id=${taskId}&limit=2`,
        `?task_id=${taskId}&limit=2&cursor=${encodeURIComponent(cursor)}`,
        `?task_id=${crypto.randomUUID()}`,
      ]) {
        const res = await getEvents(query);
        expect(res.status, query).toBe(200);
        await res.arrayBuffer();
      }
      // 畸形参数同样不能留下痕迹
      for (const query of [`?task_id=${encodeURIComponent("' OR 1=1 --")}`, "?limit=0", `?task_id=${taskId}&cursor=!!!`]) {
        const res = await getEvents(query);
        expect(res.status, query).toBe(400);
        await res.arrayBuffer();
      }
      // 读投影不消费状态:同一页重复请求得到同样的字节
      const repeat = await getJson<EventsBody>(`?task_id=${taskId}&limit=2`);
      expect(repeat.body).toEqual(paged.body);

      expect(await snapshot()).toEqual(before);
    });

    it("鉴权与 GET /admin/tasks、/admin/attempts、/admin/chain-check 走同一条 checkApiToken 路径", async () => {
      const taskId = await seedTask();
      await seedChain(taskId, manySpecs(2));
      expect(TOKEN).toBeTruthy();

      for (const path of ["/admin/events", "/admin/tasks", "/admin/attempts", "/admin/chain-check"]) {
        expect((await request(path, null)).status, `${path} 缺 token 应 401`).toBe(401);
        expect((await request(path, "wrong-token")).status, `${path} 错 token 应 401`).toBe(401);
      }
      // 鉴权先于参数校验:缺 task_id 也不是 400,而是 401
      const unauthed = await request("/admin/events", null);
      expect(unauthed.status).toBe(401);
      expect((await unauthed.json() as { error: { type: string } }).error.type).toBe("unauthorized");
    });

    it("task_id 合法但没有 events:空列表 + null,不是 404", async () => {
      const empty = await seedTask();
      await seedChain(await seedTask(), manySpecs(3));

      for (const query of [`?task_id=${empty}`, `?task_id=${empty}&limit=1`]) {
        const { status, body } = await getJson<EventsBody>(query);
        expect(status).toBe(200);
        expect(body).toEqual({ events: [], next_cursor: null });
      }
      // 合法格式的 UUID 但整个库里没这个 task:同样是空视图
      const ghost = (await getJson<EventsBody>(`?task_id=${crypto.randomUUID()}`)).body;
      expect(ghost).toEqual({ events: [], next_cursor: null });
    });
  });

  describe("文档登记", () => {
    it("落地页登记该端点,字段清单与实际返回一致,描述不粉饰", async () => {
      const taskId = await seedTask();
      await seedChain(taskId, manySpecs(2));
      const live = await getJson<EventsBody>(`?task_id=${taskId}`);

      const html = await (await request("/")).text();
      expect(html).toContain("<dt>GET /admin/events</dt>");
      expect(documentedEventFields(html, "落地页")).toEqual(PROJECTED_FIELDS);
      expect(Object.keys(live.body.events[0]).sort()).toEqual(PROJECTED_FIELDS);
      for (const phrase of HONESTY_PHRASES) {
        expect(html, `落地页应写明「${phrase}」`).toContain(phrase);
      }
      // 漏掉「实时状态另看 /tasks/:id」,读者就会把归档视图当实时看板
      expect(html).toContain("实时状态看 <code>GET /tasks/:id</code>");
    });

    it("README 登记该端点,字段清单与落地页、实际返回三方对齐", async () => {
      const taskId = await seedTask();
      await seedChain(taskId, manySpecs(2));
      const live = await getJson<EventsBody>(`?task_id=${taskId}`);

      expect(readme).toContain("GET /admin/events");
      expect(readme).toContain("/admin/events?task_id=<task_id>");
      expect(documentedEventFields(readme, "README")).toEqual(PROJECTED_FIELDS);
      expect(documentedEventFields(readme, "README")).toEqual(
        documentedEventFields(await (await request("/")).text(), "落地页"),
      );
      expect(Object.keys(live.body.events[0]).sort()).toEqual(documentedEventFields(readme, "README"));
      for (const phrase of HONESTY_PHRASES) {
        expect(readme, `README 应写明「${phrase}」`).toContain(phrase);
      }
      // README 承诺的必填与默认值不能被实现悄悄改掉
      expect(readme).toContain("默认 50,上限 200");
      expect(readme).toContain("不解析、不重新序列化");
    });
  });
});

/**
 * GET /admin/chain-check(c11b 第 3 条)—— 完整性监控补口径。
 *
 * 全局模式的数据源是 `SELECT DISTINCT task_id FROM events`,只看已归档的 D1 行。
 * prod 事故里它返回 checked=79 / broken=0,而当时正有一条任务每 30 秒空转一次归档失败:
 * **未归档的任务对它完全不可见**,重号的链它也看不出来(只校验 prev_digest 与 digest)。
 * 这里钉三条:
 * - `:seq` —— seq 严格递增且唯一(5489dc8a 的形态:seq 4/5 各重号 5 次);
 * - `:state` —— D1 状态行已终态,而链尾最后一条可判定的 task.transition 不是它;
 * - `?task_id=` 对账模式 —— 同时读 DO 链与 D1 行,三态输出。
 *
 * 夹具全部复用本文件既有的 seedTask / seedChain(同一份 sha256Hex 口径),不新建 DO fixture。
 */
describe("GET /admin/chain-check", () => {
  beforeEach(async () => {
    clock = 0;
    await env.DB.prepare("DELETE FROM decisions").run();
    await env.DB.prepare("DELETE FROM events").run();
    await env.DB.prepare("DELETE FROM attempts").run();
    await env.DB.prepare("DELETE FROM tasks").run();
  });

  interface CheckBody {
    checked: number;
    broken: number;
    brokenTasks: string[];
  }
  interface ReconcileBody {
    task_id: string;
    mode: string;
    result: "consistent" | "not_archived" | "diverged";
    task_state: string;
    archived: boolean;
    do_events: number;
    d1_events: number;
    do_tail_digest: string | null;
    d1_tail_digest: string | null;
    broken: number;
    brokenTasks: string[];
  }
  interface ErrorBody {
    error: { type: string; detail?: string };
  }

  async function globalCheck(): Promise<CheckBody> {
    const res = await request("/admin/chain-check");
    expect(res.status).toBe(200);
    return (await res.json()) as CheckBody;
  }

  async function reconcile(taskId: string): Promise<{ status: number; body: ReconcileBody | ErrorBody }> {
    const res = await request(`/admin/chain-check?task_id=${taskId}`);
    return { status: res.status, body: (await res.json()) as ReconcileBody | ErrorBody };
  }

  describe(":seq 破口", () => {
    /**
     * 重号行在真库里被 migrations/0003 的 `idx_events_task_seq` UNIQUE 挡着,
     * 所以这条判据要能用例化,必须先摘掉那个索引。**去重与建回留给调用方在用例断言之后
     * 做**(返回清理函数):索引在有重号行时建不回来,而当场去重等于把被测的那份数据抹掉。
     * 判据本身防的正是「索引没生效/被绕过/手工改过数据」这几种形态。
     */
    async function dupSeq(taskId: string, seq: number, copies: number): Promise<() => Promise<void>> {
      const row = await env.DB.prepare(
        "SELECT kind, payload, digest, prev_digest, created_at FROM events WHERE task_id = ? AND seq = ?",
      )
        .bind(taskId, seq)
        .first<{ kind: string; payload: string; digest: string; prev_digest: string | null; created_at: string }>();
      if (!row) throw new Error(`夹具缺 seq=${seq} 的行`);
      await env.DB.prepare("DROP INDEX idx_events_task_seq").run();
      await env.DB.batch(
        Array.from({ length: copies }, () =>
          env.DB.prepare(
            "INSERT INTO events (id, task_id, kind, payload, digest, prev_digest, seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          ).bind(
            crypto.randomUUID(),
            taskId,
            row.kind,
            row.payload,
            row.digest,
            row.prev_digest,
            seq,
            row.created_at,
          ),
        ),
      );
      return async () => {
        await env.DB
          .prepare("DELETE FROM events WHERE rowid NOT IN (SELECT MIN(rowid) FROM events GROUP BY task_id, seq)")
          .run();
        await env.DB.prepare("CREATE UNIQUE INDEX idx_events_task_seq ON events(task_id, seq)").run();
      };
    }

    it("正向:seq 重号 5 次 ⇒ 恰好一条 :seq 破口,且不被 :prev 顶掉", async () => {
      const taskId = await seedTask({ state: "BLOCKED" });
      const rows = await seedChain(taskId, [
        { kind: "task.created", payload: { spec_digest: "a" } },
        { kind: "attempt.created", payload: { attempt_id: "at-1" } },
        { kind: "task.transition", payload: { to: "RUNNING", actor: "agent:w" } },
        { kind: "attempt.blocked", payload: { attempt_id: "at-1" } },
        { kind: "task.transition", payload: { to: "BLOCKED", actor: "system:alarm" } },
      ]);
      const restore = await dupSeq(taskId, 4, 5);
      try {
        const body = await globalCheck();
        expect(body.brokenTasks).toContain(`${taskId}:4:seq`);
        // 5 份复制 ⇒ 5 次违反,但同一个 (task,seq) 只登记一条:重号不该挤掉别的任务的破口。
        expect(body.brokenTasks.filter((t) => t.endsWith(":seq"))).toHaveLength(1);
        expect(body.broken).toBe(1);
        // 尾行仍然接得上 ⇒ 这两条判据互不遮蔽;链尾的终态转换也没被 :seq 连带误伤。
        expect(rows[rows.length - 1].seq).toBe(5);
        expect(body.brokenTasks.some((t) => t.endsWith(":prev") || t.endsWith(":digest"))).toBe(false);
        expect(body.brokenTasks.some((t) => t.endsWith(":state"))).toBe(false);
      } finally {
        await restore();
      }
    });

    it("反向:seq 连续无重号的链不报 :seq", async () => {
      const taskId = await seedTask({ state: "BLOCKED" });
      await seedChain(taskId, [
        { kind: "task.created", payload: { spec_digest: "a" } },
        { kind: "task.transition", payload: { to: "RUNNING", actor: "agent:w" } },
        { kind: "task.transition", payload: { to: "BLOCKED", actor: "system:alarm" } },
      ]);

      const body = await globalCheck();
      expect(body).toEqual({ checked: 1, broken: 0, brokenTasks: [] });
    });
  });

  describe(":state 破口", () => {
    it("正向:D1 状态行是 BLOCKED,链尾最后一条转换停在 RUNNING", async () => {
      const taskId = await seedTask({ state: "BLOCKED" });
      const rows = await seedChain(taskId, [
        { kind: "task.created", payload: { spec_digest: "a" } },
        { kind: "attempt.created", payload: { attempt_id: "at-1" } },
        { kind: "task.transition", payload: { to: "RUNNING", actor: "agent:w" } },
        { kind: "result.captured", payload: { attempt_id: "at-1" } },
      ]);

      const body = await globalCheck();
      // 标记格式与 :prev / :digest 同族,seq 取链尾那条。
      expect(body.brokenTasks).toEqual([`${taskId}:${rows[rows.length - 1].seq}:state`]);
      expect(body.broken).toBe(1);
    });

    it("反向:链尾的终态转换与状态行一致 ⇒ 不报", async () => {
      const taskId = await seedTask({ state: "DONE" });
      await seedChain(taskId, [
        { kind: "task.created", payload: { spec_digest: "a" } },
        { kind: "task.transition", payload: { to: "RUNNING", actor: "agent:w" } },
        { kind: "decision.recorded", payload: { decision: "approve" } },
        { kind: "task.transition", payload: { to: "DONE", actor: "human:ops" } },
      ]);

      expect(await globalCheck()).toEqual({ checked: 1, broken: 0, brokenTasks: [] });
    });

    it("非终态任务不判(状态机汇点之外没有「链尾该是什么」这回事)", async () => {
      const taskId = await seedTask({ state: "AWAITING_APPROVAL" });
      await seedChain(taskId, [
        { kind: "task.created", payload: { spec_digest: "a" } },
        { kind: "task.transition", payload: { to: "RUNNING", actor: "agent:w" } },
      ]);

      expect(await globalCheck()).toEqual({ checked: 1, broken: 0, brokenTasks: [] });
    });
  });

  /**
   * 对账模式。DO 侧用 name-based id 取实例(与 /tasks/:id 同一路径),
   * 归档走真实写路径(reportExecution → archiveWithRetry),这样两侧的记录
   * 都是产品代码产出的,不是夹具拼出来的。
   */
  describe("对账模式 ?task_id=", () => {
    async function doTask(taskId: string) {
      const stub = env.TASK_SESSION.get(env.TASK_SESSION.idFromName(taskId));
      await stub.createTask({ prompt: "reconcile" }, taskId);
      return stub;
    }

    /** createTask + 一次 writer 失败回报 ⇒ 链进终态、archive 真的落到 D1。 */
    async function archivedDoTask(): Promise<{ taskId: string; doEvents: number }> {
      const taskId = crypto.randomUUID();
      const stub = await doTask(taskId);
      const { attempt_id } = await stub.startAttempt({
        role: "writer",
        idempotency_key: `${taskId}:attempt:1`,
        max_model_tokens: 10_000,
        max_wall_seconds: 600,
      });
      const res = await stub.reportExecution({
        attempt_id,
        exit_code: -1,
        error: "internal workflow error",
      });
      expect(res.ok).toBe(true);
      const snap = await stub.getSnapshot();
      return { taskId, doEvents: snap!.events.length };
    }

    it("DO 有链而 D1 零行 ⇒ not_archived;同一条任务在全局模式下完全隐身", async () => {
      const taskId = crypto.randomUUID();
      await doTask(taskId);

      const { status, body } = await reconcile(taskId);
      expect(status).toBe(200);
      const r = body as ReconcileBody;
      expect(r.mode).toBe("reconcile");
      expect(r.result).toBe("not_archived");
      expect(r.d1_events).toBe(0);
      expect(r.do_events).toBeGreaterThan(0);
      expect(r.archived).toBe(false);
      // 这一行就是「监控为什么当年看不见它」:全局模式连 checked 都不加。
      expect(await globalCheck()).toEqual({ checked: 0, broken: 0, brokenTasks: [] });
    });

    it("归档落地后两侧逐条对上 ⇒ consistent", async () => {
      const { taskId, doEvents } = await archivedDoTask();

      const r = (await reconcile(taskId).then((x) => x.body)) as ReconcileBody;
      expect(r.result).toBe("consistent");
      expect(r.d1_events).toBe(doEvents);
      expect(r.do_tail_digest).not.toBeNull();
      expect(r.d1_tail_digest).toBe(r.do_tail_digest);
      expect(r.broken).toBe(0);
    });

    it("diverged(D1 少一行):行数不等即为分歧,不降级成 not_archived", async () => {
      const { taskId } = await archivedDoTask();
      await env.DB.prepare("DELETE FROM events WHERE task_id = ? AND seq = 1").bind(taskId).run();

      const r = (await reconcile(taskId).then((x) => x.body)) as ReconcileBody;
      expect(r.result).toBe("diverged");
      expect(r.d1_events).toBe(r.do_events - 1);
    });

    it("diverged(等长但尾 digest 被改):行数对上挡不住内容分歧", async () => {
      const { taskId } = await archivedDoTask();
      await env.DB.prepare(
        "UPDATE events SET digest = ? WHERE task_id = ? AND seq = (SELECT MAX(seq) FROM events WHERE task_id = ?)",
      )
        .bind("0".repeat(64), taskId, taskId)
        .run();

      const r = (await reconcile(taskId).then((x) => x.body)) as ReconcileBody;
      expect(r.result).toBe("diverged");
      expect(r.d1_events).toBe(r.do_events);
      expect(r.d1_tail_digest).not.toBe(r.do_tail_digest);
      // 三态说的是「两份记录的关系」,破口口径仍然一并给出。
      expect(r.brokenTasks.some((t) => t.endsWith(":digest"))).toBe(true);
    });

    it("旧实现静默忽略的 ?task_id= 现在必须真的回答它:畸形 400、无 DO 记录 404", async () => {
      const malformed = await request("/admin/chain-check?task_id=nope");
      expect(malformed.status).toBe(400);
      expect(((await malformed.json()) as ErrorBody).error.type).toBe("invalid_task_id");

      const unknown = await reconcile(crypto.randomUUID());
      expect(unknown.status).toBe(404);
      expect(((unknown.body) as ErrorBody).error.type).toBe("task_not_found");

      // 全局模式不带 task_id 时形状一字不变(不与对账模式共用字段)。
      expect(Object.keys(await globalCheck()).sort()).toEqual(["broken", "brokenTasks", "checked"]);
    });
  });
});
