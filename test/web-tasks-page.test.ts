import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionContext, env } from "cloudflare:test";

import worker from "../src/index";
import workerIndexRaw from "../src/index.ts?raw";
import routerRaw from "../web/src/router.tsx?raw";
import { TASK_TRANSITIONS } from "../src/control/statemachine";
import { applyMigrations } from "./d1";
import { ApiError } from "../web/src/lib/api";
import {
  adminTasksQueryKey,
  adminTasksQueryOptions,
  adminTasksUrl,
  AWAITING_APPROVAL_LIMIT,
  APPROVALS_KEY,
  fetchAdminTasks,
  TASKS_LIST_LIMIT,
} from "../web/src/lib/queries";
import { archivedTasksSchema, tasksSearchSchema } from "../web/src/lib/schema";
import {
  parseTasksFilter,
  STATE_FILTER_OPTIONS,
  TASK_ID_VISIBLE_CHARS,
  tasksEmptyText,
  tasksFailureText,
  tasksFilterFallbackCopy,
  tasksReadNote,
  truncateTaskId,
} from "../web/src/lib/tasks-page";
import { stateTone, TASK_STATE_VALUES } from "../web/src/lib/view";

/**
 * 任务列表页(w3)的判定层。
 *
 * 与 test/web-data-layer.test.ts 同一套打法:这一页**有判断力的部分**全是纯函数
 * (Workers 运行时里没有 DOM,组件那一半只能由源码钉子 + 浏览器冒烟覆盖,分工写在那里)。
 * 这里钉的是五类事实,按会坏成什么样排:
 *
 * 1. **绝不对服务端说一个它认不得的串**。state 过滤器是操作员可编辑、可分享的 URL 输入,
 *    而 `handleAdminTasks` 对不认识的 state 直接 400。所以「任意脏输入 → 合法值或干脆不带」
 *    这一条必须逐值跑,而不是只跑几个例子(下面那批 nasty 输入全是真实会出现在链接里的形状)。
 * 2. **count 的口径**。`count` 是本次返回条数,不是总数;这句话有好几种被写歪的方式
 *    (「共 N 条」、「总计」、「页码」),逐条反向钉住。
 * 3. **失败 ≠ 空**。四种失败种类四种说法,而且都不能长得像「没有任务」。
 * 4. **过滤器取值与配色同源**。`TASK_STATE_VALUES` 是前端抄的一份副本,
 *    与 `src/control/statemachine.ts` 逐值比对 —— 这份测试是它存在的唯一前提
 *    (与 test/web-stream-protocol.test.ts 对 worker 常量做的事同一种)。
 * 5. **与真端点对表**(最后那组):前四类都是「我们自己怎么说」,那一组直接起 worker,
 *    把这一页可能发出去的每一个 URL 都真打一遍 —— 抄本漂了的时候,红在这里而不是在 prod。
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── 1. 状态清单:与 worker 权威对表 ───────────────────────────────────────────

describe("state 取值集与 worker 权威同源", () => {
  it("TASK_STATE_VALUES 与 TASK_TRANSITIONS 的键集逐值相同(不缺、不多、不重)", () => {
    const authoritative = Object.keys(TASK_TRANSITIONS);
    expect([...TASK_STATE_VALUES].sort()).toEqual([...authoritative].sort());
    expect(new Set(TASK_STATE_VALUES).size).toBe(TASK_STATE_VALUES.length);
    expect(TASK_STATE_VALUES.length).toBe(authoritative.length);
  });

  it("每个合法 state 都有配色(未知值才落中性)", () => {
    for (const state of TASK_STATE_VALUES) {
      expect(stateTone(state), state).not.toBe("");
    }
    expect(stateTone("NOT_A_STATE")).toBe("");
  });

  it("下拉里除「全部」之外的每一项都被 tasksSearchSchema 接受,且服务端也认得", () => {
    const options = STATE_FILTER_OPTIONS.filter((option) => option.value !== "");
    expect(options.map((option) => option.value)).toEqual([...TASK_STATE_VALUES]);
    for (const option of options) {
      expect(tasksSearchSchema.safeParse({ state: option.value }).success, option.value).toBe(true);
      expect(TASK_TRANSITIONS).toHaveProperty(option.value);
    }
  });
});

// ── 2. parseTasksFilter:回落 + 钉住 ─────────────────────────────────────────

describe("parseTasksFilter:合法值原样、非法值回落并把原值钉住", () => {
  it("七种合法取值在三种输入形状下都生效", () => {
    for (const state of TASK_STATE_VALUES) {
      expect(parseTasksFilter({ state }), state).toEqual({ state, rejected: null });
      expect(parseTasksFilter(new URLSearchParams(`state=${state}`)), state).toEqual({
        state,
        rejected: null,
      });
      expect(parseTasksFilter(`?state=${state}`), state).toEqual({ state, rejected: null });
    }
  });

  it("没写 state / 写空串 = 「全部」,且不算被拒收(下拉清除后就是空串)", () => {
    expect(parseTasksFilter({})).toEqual({ state: null, rejected: null });
    expect(parseTasksFilter({ state: "" })).toEqual({ state: null, rejected: null });
    expect(parseTasksFilter(new URLSearchParams("state="))).toEqual({
      state: null,
      rejected: null,
    });
    expect(parseTasksFilter("?other=1")).toEqual({ state: null, rejected: null });
  });

  it("非法值退回「全部」,原值被钉住可照抄(逐例都是真实会出现在链接里的形状)", () => {
    const cases: Array<[unknown, string]> = [
      [{ state: "DONEE" }, "DONEE"],
      [{ state: "done" }, "done"], // 大小写:服务端是精确匹配
      [{ state: " RUNNING" }, " RUNNING"], // 前导空格不会被 trim 成合法值
      [{ state: "RUNNING;BLOCKED" }, "RUNNING;BLOCKED"], // 想拿一个参数筛两个状态
      [{ state: "42" }, "42"],
      [{ state: ["DONE", "BLOCKED"] }, "DONE,BLOCKED"], // 重复键
      [{ state: null }, "(形状不合)"],
    ];
    for (const [input, expected] of cases) {
      const filter = parseTasksFilter(input);
      expect(filter.state, JSON.stringify(input)).toBeNull();
      expect(filter.rejected, JSON.stringify(input)).toBe(expected);
    }
  });

  it("非字符串的垃圾输入不抛、也不发明过滤器", () => {
    for (const raw of [null, undefined, 42, "not-an-object", "", "state", [], { state: {} }]) {
      expect(() => parseTasksFilter(raw)).not.toThrow();
      expect(parseTasksFilter(raw).state).toBeNull();
    }
  });

  /**
   * 这一条是本文件最要紧的一条:`state` 只能是「不带」或「七个合法值之一」。
   * 只要成立,`/api/admin/tasks` 就不可能因为过滤器返回 400 `invalid_state` ——
   * 门在客户端关上,而不是把猜测的串转给服务端去拒。
   */
  it("任意输入的产物永远可以直接进 URL(服务端 state 白名单同一条判据)", () => {
    const nasty: unknown[] = [
      {},
      { state: "" },
      { state: "DROP TABLE tasks" },
      { state: "%27%20OR%201=1" },
      { state: "DONE " },
      { state: "done" },
      { state: true },
      { state: ["DONE", "DONE"] },
      { state: { $ne: null } },
      "state=DONE&state=x",
      new URLSearchParams("state=done&state=blocked"),
      new URLSearchParams(""),
    ];
    for (const raw of nasty) {
      const { state } = parseTasksFilter(raw);
      const ok = state === null || (TASK_STATE_VALUES as readonly string[]).includes(state);
      expect(ok, JSON.stringify(raw)).toBe(true);
      // 非法输入的结论是「回落」,不是「部分采纳」:绝不能剩一个非 null 的 state
      if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
        const v = (raw as { state?: unknown }).state;
        if (typeof v !== "string" || !(TASK_STATE_VALUES as readonly string[]).includes(v)) {
          expect(state, JSON.stringify(raw)).toBeNull();
        }
      }
    }
  });

  it("被拒收时页面说的话含原值、含「全部」,并说明地址栏为什么不动", () => {
    const copy = tasksFilterFallbackCopy("DONEE");
    expect(copy).toContain("DONEE");
    expect(copy).toContain("全部");
    expect(copy).toContain("地址栏");
  });
});

// ── 3. URL 与 query key ──────────────────────────────────────────────────────

describe("请求 URL:limit 用满服务端上限,「全部」不带 state", () => {
  it("不带过滤时 URL 里没有 state= 空值(服务端对 state=\"\" 回 400)", () => {
    expect(adminTasksUrl(null)).toBe(`/api/admin/tasks?limit=${TASKS_LIST_LIMIT}`);
    expect(adminTasksUrl(null)).not.toContain("state=");
  });

  it("带过滤时 state 在前、limit 在后,与 README 示例同一条形状", () => {
    expect(adminTasksUrl("DONE")).toBe(`/api/admin/tasks?state=DONE&limit=${TASKS_LIST_LIMIT}`);
  });

  /** 客户端常量与服务端上限对表:`tasksReadNote` 那句「已到服务端上限」靠这条才为真。 */
  it("TASKS_LIST_LIMIT 恰是服务端 parseAdminLimit 的上限", () => {
    const declared = /const MAX_ADMIN_LIMIT = (\d+)/.exec(workerIndexRaw);
    expect(declared, "src/index.ts 里找不到 MAX_ADMIN_LIMIT,口径已漂").not.toBeNull();
    expect(TASKS_LIST_LIMIT).toBe(Number(declared![1]));
    expect(AWAITING_APPROVAL_LIMIT).toBe(TASKS_LIST_LIMIT);
  });
});

describe("query key / 节拍", () => {
  it("key 含 state:两个过滤条件是两份缓存", () => {
    expect(adminTasksQueryKey(null)).toEqual(["admin", "tasks", "list", "all"]);
    expect(adminTasksQueryKey("DONE")).toEqual(["admin", "tasks", "list", "DONE"]);
    expect(adminTasksQueryKey("DONE")).not.toEqual(adminTasksQueryKey("BLOCKED"));
  });

  /** 两个不同的坏链接指向的是同一份「全部」:被拒的值不进 key,否则同一数据按输入串开分号。 */
  it("被拒收的原值不影响 key", () => {
    expect(parseTasksFilter("?state=BAD1").state).toBe(parseTasksFilter("?state=BAD2").state);
    expect(adminTasksQueryKey(parseTasksFilter("?state=BAD1").state)).toEqual(
      adminTasksQueryKey(parseTasksFilter("?state=BAD2").state),
    );
  });

  it("列表 key 不与 Approvals 角标共用,但共享前缀可整体清", () => {
    expect(adminTasksQueryKey("AWAITING_APPROVAL")).not.toEqual([...APPROVALS_KEY]);
    expect(adminTasksQueryKey("DONE").slice(0, 2)).toEqual(["admin", "tasks"]);
    expect(APPROVALS_KEY.slice(0, 2)).toEqual(["admin", "tasks"]);
  });

  it("30s 重读、失败不重试、刚读过的不立刻再读(§5 的节拍)", () => {
    const options = adminTasksQueryOptions("DONE");
    expect(options.refetchInterval).toBe(30_000);
    expect(options.retry).toBe(false);
    expect(options.staleTime).toBe(10_000);
  });
});

describe("取数真的打在那条 URL 上", () => {
  function stubJson(payload: unknown): string[] {
    const paths: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        paths.push(String(input));
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    return paths;
  }

  const body = {
    tasks: [
      {
        id: "0f4c1a2b-3d4e-5f60-7182-93a4b5c6d7e8",
        state: "BLOCKED",
        created_at: "2026-09-05T09:00:00.000Z",
        updated_at: "2026-09-05T10:00:00.000Z",
        version: 7,
      },
    ],
    count: 1,
  };

  it("queryFn 读的是过滤后的 URL,并把响应交给 schema", async () => {
    const paths = stubJson(body);
    const tasks = await fetchAdminTasks("BLOCKED");
    expect(paths).toEqual(["/api/admin/tasks?state=BLOCKED&limit=200"]);
    expect(tasks.count).toBe(1);
    expect(tasks.tasks[0]?.version).toBe(7);
  });

  it("「全部」这一支不带 state", async () => {
    const paths = stubJson({ tasks: [], count: 0 });
    await fetchAdminTasks(null);
    expect(paths).toEqual(["/api/admin/tasks?limit=200"]);
  });
});

// ── 4. count 的口径 ──────────────────────────────────────────────────────────

describe("tasksReadNote:count 是本次条数,不是总数", () => {
  it("还没读到答复时不出声(不预先说 0)", () => {
    expect(tasksReadNote(undefined)).toBeNull();
  });

  it("未读满 → 说得出「本次读取 N 条」与该条件已读完", () => {
    const note = tasksReadNote({ tasks: [], count: 7 });
    expect(note).toContain("本次读取 7 条");
    expect(note).toContain(`limit=${TASKS_LIST_LIMIT}`);
    expect(note).toContain("已全部读到");
  });

  it("读满上限 → 明说读满了、没有游标、不放「加载更多」", () => {
    const note = tasksReadNote({ tasks: [], count: TASKS_LIST_LIMIT });
    expect(note).toContain("已到服务端上限");
    expect(note).toContain("游标");
    expect(note).toContain("加载更多");
  });

  it("两种口径都不许出现「共 N 条/总计」这类总数断言,也不许出现页码", () => {
    for (const count of [0, 1, 7, TASKS_LIST_LIMIT]) {
      const note = tasksReadNote({ tasks: [], count }) ?? "";
      expect(note, String(count)).not.toMatch(/共\s*[\d{]/);
      expect(note, String(count)).not.toMatch(/总计|总条数|第\s*\d+\s*页/);
    }
  });

  it("0 条读起来仍是「读到了 0 条」而不是「没读到」", () => {
    expect(tasksReadNote({ tasks: [], count: 0 })).toContain("本次读取 0 条");
  });
});

describe("空态与失败态是两句话", () => {
  it("无过滤的空态说清「归档表里没有」并指向实时口径", () => {
    const text = tasksEmptyText(null);
    expect(text).toContain("归档");
    expect(text).toContain("GET /api/tasks/:id");
  });

  it("带过滤的空态点名那个 state,并拒绝把「没读到」说成「平台里没有」", () => {
    const text = tasksEmptyText("BLOCKED");
    expect(text).toContain("BLOCKED");
    expect(text).toContain("不等于");
  });

  it("上一次读失败时,空表格里那句必须换话(空与断连在肉眼里同形)", () => {
    expect(tasksEmptyText("BLOCKED", true)).not.toBe(tasksEmptyText("BLOCKED"));
    expect(tasksEmptyText(null, true)).toContain("失败");
  });

  it("四种失败种类四种说法,而且都不说「没有任务」这种双关", () => {
    const texts = [
      tasksFailureText(new ApiError({ kind: "unauthorized", status: 401 }, "/api/admin/tasks")),
      tasksFailureText(
        new ApiError({ kind: "http", status: 400, errorType: "invalid_state" }, "/api/admin/tasks"),
      ),
      tasksFailureText(new ApiError({ kind: "network" }, "/api/admin/tasks")),
      tasksFailureText(
        new ApiError({ kind: "shape", status: 200, detail: "期望 application/json" }, "/x"),
      ),
    ];
    expect(new Set(texts).size).toBe(4);
    expect(texts[0]).toContain("重新登录");
    expect(texts[1]).toContain("400");
    expect(texts[1]).toContain("invalid_state");
    expect(texts[2]).toContain("不是「没有任务」");
    // §7 头号风险的落点:200 + HTML 必须被说成源配错的样子,而不是「服务端拒绝」
    expect(texts[3]).toContain("run_worker_first");
  });

  it("http 无 errorType 时不括一个 null 出来", () => {
    const text = tasksFailureText(
      new ApiError({ kind: "http", status: 500, errorType: null }, "/api/admin/tasks"),
    );
    expect(text).toContain("500");
    expect(text).not.toContain("null");
  });

  it("不是 ApiError 的意外异常不冒充服务端答复", () => {
    const text = tasksFailureText(new Error("bug"));
    expect(text).toContain("页面这边");
    expect(text).not.toMatch(/服务端答复|status|\d{3}/);
  });
});

// ── 5. id 列 ─────────────────────────────────────────────────────────────────

describe("truncateTaskId:截断的是排版,不是信息", () => {
  const id = "0f4c1a2b-3d4e-5f60-7182-93a4b5c6d7e8";

  it("显示首段,完整值留在 full(页面把它放进 title 与提示)", () => {
    const { shown, full } = truncateTaskId(id);
    expect(shown).toBe(`${id.slice(0, TASK_ID_VISIBLE_CHARS)}…`);
    expect(shown.length).toBe(TASK_ID_VISIBLE_CHARS + 1);
    expect(full).toBe(id);
    expect(shown).not.toContain("-3d4e");
  });

  it("短于截断宽度的值原样返回,不追加省略号", () => {
    expect(truncateTaskId("abc")).toEqual({ shown: "abc", full: "abc" });
    const exact = "12345678";
    expect(truncateTaskId(exact)).toEqual({ shown: exact, full: exact });
  });
});

// ── 6. 与真服务端对表 ────────────────────────────────────────────────────────

/**
 * 前面几组钉的是「我们这一页怎么说」,这一组钉的是「服务端答不答应」。
 *
 * 为什么值得真起一个 worker 而不是只跑纯函数:`state` 那份值域是从 `TASK_TRANSITIONS` 抄来的
 * **副本**,而 `handleAdminTasks` 对不认识的串直接回 400。抄错一个字母的表现不是红屏,
 * 是「某个筛选条件永远报 400」,而那正是这一页最不该有的形状(「门在客户端就关上」这整条论证
 * 都依赖副本没漂)。只有拿真端点跑一遍才看得见。
 *
 * 顺带钉四件平时只能靠读源码相信的事:
 * - `archivedTasksSchema` 是 `handleAdminTasks` 响应的**合法转写**(不是编出来的契约);
 * - `count === tasks.length` —— 页面上那句「本次读取 N 条」的全部依据;
 * - 空值 `state=` 与越界的 `limit=` 确实会被拒 —— 这两条成立,`adminTasksUrl` 里
 *   「『全部』必须缺键」与「limit 取服务端上限」才不是修辞而是必要条件。
 * - 最后一条是**对照组**:上面那些 200 不是空跑,这条端点确实会因为一个字母的差别回 400。
 */
describe("与真服务端对表:这一页发出去的每个 URL 都答 200", () => {
  beforeAll(applyMigrations);

  const TOKEN = env.WORKER_API_TOKEN;

  async function getArchivedTasks(path: string): Promise<Response> {
    return worker.fetch(
      new Request(`https://example.com${path}`, { headers: { authorization: `Bearer ${TOKEN}` } }),
      env,
      createExecutionContext(),
    );
  }

  async function seedOneOfEachState(): Promise<void> {
    await env.DB.prepare("DELETE FROM tasks").run();
    for (const [index, state] of TASK_STATE_VALUES.entries()) {
      await env.DB.prepare(
        "INSERT INTO tasks (id, spec, spec_digest, state, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
        .bind(
          crypto.randomUUID(),
          JSON.stringify({ prompt: `seed ${state}` }),
          "0".repeat(64),
          state,
          index + 1,
          "2026-09-01T00:00:00.000Z",
          `2026-09-${String(index + 2).padStart(2, "0")}T00:00:00.000Z`,
        )
        .run();
    }
  }

  beforeEach(seedOneOfEachState);

  it("七个合法 state 与「不带 state」两种 URL 全部 200,且形状与 count 口径成立", async () => {
    for (const state of [null, ...TASK_STATE_VALUES] as const) {
      const res = await getArchivedTasks(adminTasksUrl(state));
      expect(res.status, String(state)).toBe(200);
      const parsed = archivedTasksSchema.safeParse(await res.json());
      expect(parsed.success, String(state)).toBe(true);
      if (!parsed.success) continue;
      const body = parsed.data;
      // 页面那句话的唯一依据:count 就是这一次返回的行数
      expect(body.count, String(state)).toBe(body.tasks.length);
      expect(body.count).toBeLessThanOrEqual(TASKS_LIST_LIMIT);
      expect(body.tasks.every((row) => state === null || row.state === state), String(state)).toBe(
        true,
      );
      // 合法值必须筛得动:全都 200 但恒空,同样是这一页的谎
      expect(body.tasks.length > 0, `合法状态 ${String(state)} 应命中 seeded 行`).toBe(true);
    }
  });

  it("脏输入经 parseTasksFilter 之后,产物的 URL 也一律 200(门真的关上了)", async () => {
    for (const raw of [
      "?state=RUNNIG",
      "?state=done",
      "?state= RUNNING",
      "?state=DROP%20TABLE%20tasks",
      "?state=DONE&state=BLOCKED",
      "?state=42",
      "?state=",
      "",
    ]) {
      const res = await getArchivedTasks(adminTasksUrl(parseTasksFilter(raw).state));
      expect(res.status, raw).toBe(200);
    }
  });

  it("反向对照:绕过 zod 直接把错串拼进 URL 就是 400 invalid_state", async () => {
    const res = await getArchivedTasks("/api/admin/tasks?state=RUNNIG&limit=200");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { type?: string } };
    expect(body.error?.type).toBe("invalid_state");
  });

  it("反向对照:state 空值与超限 limit 都会被拒", async () => {
    const emptyState = await getArchivedTasks("/api/admin/tasks?state=&limit=200");
    expect(emptyState.status).toBe(400);
    const overLimit = await getArchivedTasks("/api/admin/tasks?limit=201");
    expect(overLimit.status).toBe(400);
    const errorType = ((await overLimit.json()) as { error?: { type?: string } }).error?.type;
    expect(errorType).toBe("invalid_limit");
  });
});

// ── 7. 路由接线:validateSearch 必须恒回写 state 键 ──────────────────────────

describe("validateSearch 接线:恒回写 state 键(TanStack raw+validated 合并陷阱)", () => {
  // 组件那一半没有 DOM 可测(文件头分工),而这正是 2026-09-06 prod 实测抓到的洞:
  // 校验器对非法/空 state 返回裸 {} 时,TanStack 按 `{ ...原始, ...校验输出 }` 合并出
  // match.search,URL 上的坏值原样流进 useSearch、被原样发到服务端 → 400(invalid_state),
  // 页面口供(「按全部读取」)与实际行为(带坏值读取失败)分家。
  // 单测起不了浏览器,这枚钉子读源码形状,让这处接线在 review 阶段就红。
  it("validateSearch 恒回写 state(null → undefined),不得在无过滤分支返回裸 {}", () => {
    const start = routerRaw.indexOf("validateSearch: (search): TasksSearch");
    const end = routerRaw.indexOf("const taskDetailRoute");
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const body = routerRaw.slice(start, end);
    expect(body).toContain("return { state: filter.state ?? undefined };");
    expect(body).not.toContain("=== null ? {}");
  });
});
