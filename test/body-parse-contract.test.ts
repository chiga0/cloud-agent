import { beforeAll, describe, expect, it } from "vitest";
import { createExecutionContext, env } from "cloudflare:test";
import worker from "../src/index";
import { invalidBodyResponse, parseJsonBody } from "../src/http/body";
import type { TaskSession } from "../src/control/session";
import { applyMigrations } from "./d1";
import indexRaw from "../src/index.ts?raw";

/**
 * c18:POST body 解析失败面统一(prod 实测,部署 c471b145)。
 *
 * 缺陷本体:`POST /api/tasks` 与 `POST /api/tasks/:id/approve` 收到空 body 或坏 JSON 时
 * 走的是裸的 `Request#json()` 解析,抛出后没人接,平台答 **500 error code 1101**(4/4 复现);
 * 而 `POST /api/session/login` 同样三种输入从来稳定 401。也就是说:**同一个失败面在三个端点上
 * 给了三种答案**,其中两种还是 5xx。
 *
 * 本文件钉三件事,每件各有一个「不钉就会怎样」的理由:
 *
 * 1. **失败形状**(create/approve 的 400 `invalid_body` 与 login 的 401 `invalid_credentials`)。
 *    断言一律落在**值**上(status 数字 + `error.type` 字符串),不落文案 —— 本项目已两次因
 *    「匹配报错文字」让变异存活。detail 只钉「存在且是非空字符串」这一条事实:它的内容是给
 *    人看的,钉死它等于给下一棒留一条改不掉的字符串。
 * 2. **不可区分性**(login):空 body / 坏 JSON / 不是对象 / 缺 token / token 错,响应体必须
 *    **逐字节相同**(用例做法:把所有输入的实际应答收进 Set,size 必须是 1)。多一个字段、
 *    多一种 detail 都是「这台部署收不收 body」的探测面(docs/product.md §3)。
 * 3. **纪律可执行**(源码层):src/ 内除 `src/http/body.ts` 外不得有任何读请求体的写法,
 *    且分发表上每个带 `req` 的 POST handler 都必须经 `parseJsonBody` —— 新增端点漏走即红。
 *    扫描走 `import.meta.glob` 的构建期内联:手抄文件清单会漏掉将来新增的文件,而「漏掉」正是
 *    这类纪律测试唯一危险的失效模式。
 *
 * 反向护栏(第 4 组用例):解析成功但字段缺失/非法,**必须**仍走各端点原有的校验分支,
 * 类型名与状态码一条都不许被 `invalid_body` 吞掉。
 */

const BASE = "https://example.com";
const TOKEN = env.WORKER_API_TOKEN;

interface ErrorBody {
  error?: { type?: string; detail?: string } & Record<string, unknown>;
}

async function post(
  path: string,
  rawBody: string | undefined,
  opts: { bearer?: boolean; contentType?: string | null } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.bearer !== false) headers.authorization = `Bearer ${TOKEN}`;
  if (opts.contentType !== null) headers["content-type"] = opts.contentType ?? "application/json";
  return worker.fetch(
    new Request(`${BASE}${path}`, { method: "POST", headers, body: rawBody }),
    env,
    createExecutionContext(),
  );
}

const ns = () => env.TASK_SESSION as DurableObjectNamespace<TaskSession>;

/** RUNNING 且无证据的任务:够让 approve 走到 DO 的校验分支,以证明 body 已被接受。 */
async function seedTask(label: string): Promise<string> {
  const taskId = crypto.randomUUID();
  await ns().get(ns().idFromName(taskId)).createTask({ prompt: label }, taskId);
  return taskId;
}

/**
 * 三种坏输入的展开版。前三条是派单点名的形状(空 body / 坏 JSON / body 不是 JSON 对象),
 * 其余是同一档里的边界:空白 body、截断的 JSON、以及 `[]` 这种「JS 的 typeof 是 object
 * 但不是 JSON 对象」的坑。
 */
const BAD_BODIES: Array<{ label: string; raw: string | undefined }> = [
  { label: "完全不带 body", raw: undefined },
  { label: "空 body", raw: "" },
  { label: "只有空白", raw: "  \n\t " },
  { label: "坏 JSON(prod 复现输入)", raw: "{bad" },
  { label: "截断的 JSON", raw: '{"spec":' },
  { label: "JSON 字符串", raw: '"str"' },
  { label: "JSON 数字", raw: "123" },
  { label: "JSON null", raw: "null" },
  { label: "JSON 数组", raw: "[]" },
];

/** 400 + `{"error":{"type":"invalid_body","detail":…}}` + application/json。逐条落值。 */
async function expectInvalidBody(res: Response, label: string): Promise<void> {
  expect(res.status, `${label} 的状态码`).toBe(400);
  expect(res.headers.get("content-type"), `${label} 的 content-type`).toContain("application/json");
  const body = (await res.json()) as ErrorBody;
  expect(body.error?.type, `${label} 的 error.type`).toBe("invalid_body");
  expect(typeof body.error?.detail, `${label} 必须带 detail`).toBe("string");
  expect((body.error?.detail ?? "").length, `${label} 的 detail 不得为空`).toBeGreaterThan(0);
}

beforeAll(applyMigrations);

describe("parseJsonBody:共享解析函数的四档口径", () => {
  const read = (raw: string | undefined) =>
    parseJsonBody<Record<string, unknown>>(
      new Request(`${BASE}/api/tasks`, { method: "POST", body: raw }),
    );

  it("空 body 与只有空白都是 empty(与 malformed 分开,给两种说法)", async () => {
    expect(await read(undefined)).toHaveProperty("failure", "empty");
    expect(await read("")).toHaveProperty("failure", "empty");
    expect(await read("  \n\t ")).toHaveProperty("failure", "empty");
  });

  it("不是合法 JSON → malformed;读流本身不抛出去", async () => {
    for (const raw of ["{bad", '{"spec":', "not json at all", "{", "[1,"]) {
      expect(await read(raw), raw).toHaveProperty("failure", "malformed");
    }
  });

  it("合法 JSON 但不是 JSON 对象 → not_object(含 null 与数组)", async () => {
    for (const raw of ['"str"', "123", "true", "null", "[]", "[1,2]"]) {
      expect(await read(raw), raw).toHaveProperty("failure", "not_object");
    }
  });

  it("合法对象原样交给调用方:本函数不碰字段(字段级判定在各 handler)", async () => {
    expect(await read("{}")).toEqual({ ok: true, body: {} });
    // 连「spec 类型完全不对」这种形状都放过去 —— 它该由 invalid_spec 那一档回答。
    expect(await read('{"spec":"not-an-object"}')).toEqual({ ok: true, body: { spec: "not-an-object" } });
  });

  it("invalidBodyResponse:三档失败共用一个类型名,各给一条非空 detail", async () => {
    const types: string[] = [];
    for (const failure of ["empty", "malformed", "not_object"] as const) {
      const res = invalidBodyResponse(failure);
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toContain("application/json");
      const body = (await res.json()) as ErrorBody;
      expect(body.error?.type).toBe("invalid_body");
      expect(typeof body.error?.detail).toBe("string");
      expect((body.error?.detail ?? "").length).toBeGreaterThan(0);
      types.push(body.error?.type ?? "");
    }
    // 类型名只有一个:三档失败的区别只在 detail,不在可判定的字段。
    expect(new Set(types)).toEqual(new Set(["invalid_body"]));
  });
});

describe("POST /api/tasks:坏 body → 400 invalid_body,绝不 500", () => {
  for (const { label, raw } of BAD_BODIES) {
    it(`${label} → 400 invalid_body`, async () => {
      await expectInvalidBody(await post("/api/tasks", raw), label);
    });
  }

  it("不带 content-type 也不改变结论(判据是 body 本身,不是头)", async () => {
    await expectInvalidBody(
      await post("/api/tasks", "{bad", { contentType: null }),
      "无 content-type 的坏 JSON",
    );
  });

  it("对照:合法 body 行为原样 → 200 并建出 task + attempt", async () => {
    const res = await post("/api/tasks", JSON.stringify({ spec: { prompt: "c18 control" } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { task_id?: string; attempt_id?: string; workflow?: string };
    expect(typeof body.task_id).toBe("string");
    expect(typeof body.attempt_id).toBe("string");
    expect(typeof body.workflow).toBe("string");
  });
});

describe("POST /api/tasks/:id/approve:坏 body → 400 invalid_body,绝不 500", () => {
  it("逐条坏输入 → 400 invalid_body", async () => {
    const taskId = await seedTask("c18 approve");
    for (const { label, raw } of BAD_BODIES) {
      await expectInvalidBody(await post(`/api/tasks/${taskId}/approve`, raw), label);
    }
  });

  it("坏 body 打在**不存在的** taskId 上仍是 400 invalid_body(形态先于存在性)", async () => {
    await expectInvalidBody(
      await post(`/api/tasks/${crypto.randomUUID()}/approve`, "{bad"),
      "不存在的任务 + 坏 JSON",
    );
  });

  it("对照:合法 decision 进入 DO 的校验分支(不被 invalid_body 吞)", async () => {
    const taskId = await seedTask("c18 approve control");
    const res = await post(
      `/api/tasks/${taskId}/approve`,
      JSON.stringify({ decision: "approve", attempt_id: "att-1", evidence_digest: "d" }),
    );
    const body = (await res.json()) as ErrorBody;
    expect(res.status).toBe(409);
    expect(body.error?.type).toBe("evidence_missing");
  });
});

describe("POST /api/session/login:可观测语义逐字不变", () => {
  /**
   * 这里没有一条用例去问「detail 写了什么」,问的是**所有输入的应答是否同一个东西**。
   * 走共享解析函数时把 parse 失败映射成 invalid_credentials(而不是 invalid_body)是本端点
   * 的硬要求:400/401 之差、或 detail 里一句「body is empty」,都足以把「token 对不对」与
   * 「body 收不收」分开读出来 —— 而 §3 要的恰恰是两者不可分。
   */
  const INPUTS: Array<{ label: string; raw: string | undefined }> = [
    { label: "空 body", raw: "" },
    { label: "坏 JSON", raw: "{bad" },
    { label: "body 不是对象", raw: '"str"' },
    { label: "缺 token 字段", raw: JSON.stringify({ user: "ops" }) },
    { label: "token 非字符串", raw: JSON.stringify({ token: 12345 }) },
    { label: "token 错", raw: JSON.stringify({ token: `${TOKEN}-but-wrong` }) },
  ];

  it("六种输入 → 全部同一个 401,应答体逐字节相同,且不带 cookie", async () => {
    const answers = new Set<string>();
    for (const { label, raw } of INPUTS) {
      const res = await post("/api/session/login", raw, { bearer: false });
      expect(res.status, `${label} 的状态码`).toBe(401);
      expect(res.headers.get("content-type"), `${label} 的 content-type`).toContain("application/json");
      expect(res.headers.get("cache-control"), `${label} 必须 no-store`).toBe("no-store");
      expect(res.headers.get("set-cookie"), `${label} 绝不能发 cookie`).toBeNull();
      const text = await res.text();
      // 值断言:整个 error 对象就是它,不许多一个字段(detail 的有无本身就是可区分信息)。
      expect(JSON.parse(text) as ErrorBody, `${label} 的应答体`).toEqual({
        error: { type: "invalid_credentials" },
      });
      answers.add(`${res.status}|${text}`);
    }
    expect(answers.size, "所有失败输入必须不可区分").toBe(1);
  });

  it("对照:正确 token → 200 {ok:true} 并发 cookie", async () => {
    const res = await post("/api/session/login", JSON.stringify({ token: TOKEN }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("set-cookie")).toContain("__Host-cas=");
  });
});

describe("解析成功后的字段级校验:类型名与状态码一条都不改", () => {
  /** 每条都是「合法 JSON 对象 + 某一处字段问题」→ 必须落回原分支,而不是 invalid_body。 */
  const cases: Array<{ label: string; path: string; raw: string; type: string; status: number }> = [
    { label: "空对象", path: "/api/tasks", raw: "{}", type: "invalid_spec", status: 400 },
    {
      label: "spec 缺 prompt",
      path: "/api/tasks",
      raw: '{"spec":{}}',
      type: "invalid_spec",
      status: 400,
    },
    {
      label: "acceptance 不是数组",
      path: "/api/tasks",
      raw: '{"spec":{"prompt":"c18","acceptance":"no"}}',
      type: "invalid_acceptance",
      status: 400,
    },
    {
      label: "base_sha 畸形",
      path: "/api/tasks",
      raw: '{"spec":{"prompt":"c18","base_sha":"HEAD"}}',
      type: "invalid_base_sha",
      status: 400,
    },
    {
      label: "预算为负",
      path: "/api/tasks",
      raw: '{"spec":{"prompt":"c18"},"budget":{"max_wall_seconds":-5}}',
      type: "invalid_budget",
      status: 400,
    },
    { label: "缺 decision", path: "APPROVE", raw: "{}", type: "invalid_decision", status: 400 },
    {
      label: "decision 不是 approve/reject",
      path: "APPROVE",
      raw: '{"decision":"maybe"}',
      type: "invalid_decision",
      status: 400,
    },
    {
      label: "decision 合法但缺组合证据",
      path: "APPROVE",
      raw: '{"decision":"approve"}',
      type: "evidence_required",
      status: 400,
    },
  ];

  it("逐条落回原有分支", async () => {
    const taskId = await seedTask("c18 field level");
    for (const c of cases) {
      const path = c.path === "APPROVE" ? `/api/tasks/${taskId}/approve` : c.path;
      const res = await post(path, c.raw);
      const body = (await res.json()) as ErrorBody;
      expect(res.status, `${c.label} 的状态码`).toBe(c.status);
      expect(body.error?.type, `${c.label} 的 error.type`).toBe(c.type);
    }
  });

  it("对照:合法 decision 打到不存在的任务 → 仍是 DO 的 404,不是 invalid_body", async () => {
    const res = await post(
      `/api/tasks/${crypto.randomUUID()}/approve`,
      JSON.stringify({ decision: "reject", actor: "human:c18" }),
    );
    const body = (await res.json()) as ErrorBody;
    expect(res.status).toBe(404);
    expect(body.error?.type).toBe("task not found");
  });

  it("对照:未鉴权的坏 body 仍先吃鉴权门的 401(顺序没有被解析改动)", async () => {
    const res = await post("/api/tasks", "{bad", { bearer: false });
    expect(res.status).toBe(401);
    expect(((await res.json()) as ErrorBody).error?.type).toBe("unauthorized");
  });
});

describe("源码纪律:读请求体只有一处,新增 POST 端点漏走共享函数即红", () => {
  /**
   * 构建期内联 src/ 的**全部** .ts 原文。为什么不用静态 import 列表:清单是人抄的,
   * 新增文件不进清单 = 这条防线对新文件永远绿,而「新端点自己裸解析」恰恰是它要拦的事。
   */
  const srcSources = import.meta.glob("../src/**/*.ts", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>;
  const srcFiles = new Map(
    Object.entries(srcSources).map(([path, text]) => [path.replace(/^\.\.\//, ""), text]),
  );
  const SHARED_MODULE = "src/http/body.ts";

  /**
   * 「读**请求体**」的写法:接收者是 req/request(本仓库的命名口径),涵盖 json/text/
   * arrayBuffer/formData 四个出口 —— 只禁 `json()` 的话,改成 `text()` + JSON.parse
   * 就绕过了。R2 的 `obj.json()` / `manifestObj.json()` 不在此列(那读的是对象存储)。
   */
  const BODY_READ =
    /(^|[^\w$])(?:req|request|ctx\.req|event\.request)\s*\.\s*(?:json|text|arrayBuffer|formData)\s*\(/g;

  /**
   * 只看代码行。注释不参与扫描的代价写在 `src/http/body.ts` 顶部:文档里提这件事要用
   * `Request#json()` 记法,写全 `req.json(` 会被这条纪律当违规拦下 —— 报错会说清该改哪。
   */
  function codeLines(text: string): string[] {
    return text.split("\n").filter((line) => {
      const trimmed = line.trim();
      return !(trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*"));
    });
  }

  function bodyReads(text: string): string[] {
    return codeLines(text).filter((line) => {
      BODY_READ.lastIndex = 0;
      return BODY_READ.test(line);
    });
  }

  it("扫描不是空跑:src/ 的每个模块都真被内联进来了", () => {
    expect(srcFiles.size).toBeGreaterThanOrEqual(20);
    for (const [path, text] of srcFiles) expect(text.length, path).toBeGreaterThan(0);
    // glob 与静态 ?raw 必须是同一份字节(否则「扫到了」这句话没有内容)。
    expect(srcFiles.get("src/index.ts")).toBe(indexRaw);
    expect(srcFiles.has(SHARED_MODULE)).toBe(true);
  });

  it("src/ 内除共享模块外没有任何裸读请求体", () => {
    const offenders: string[] = [];
    for (const [path, text] of srcFiles) {
      if (path === SHARED_MODULE) continue;
      for (const line of bodyReads(text)) offenders.push(`${path}: ${line.trim()}`);
    }
    expect(offenders, "请求体一律经 parseJsonBody(src/http/body.ts)").toEqual([]);
  });

  it("共享模块自己只剩一个读点,且读的是 text(能区分空 body 与坏 JSON)", () => {
    const reads = bodyReads(srcFiles.get(SHARED_MODULE) ?? "");
    expect(reads.length, "读请求体的写法在共享模块内也只能有一处").toBe(1);
    expect(reads[0]).toContain("req.text(");
  });

  it("分发清单:每个按 POST 分发且收到 req 的 handler 都必须调用 parseJsonBody", () => {
    /**
     * 从分发器里把 POST 分支连 handler 名与实参一起抽出来。要求「分支数 == `req.method ===
     * "POST"` 的出现次数」是这条用例的自校对:哪天有人把分支写成扫描认不出的形状,这里就红,
     * 而不是安静地少查一个端点。
     */
    const dispatch = /\(\s*[^()]*req\.method === "POST"[^()]*\)\s*\{?\s*(?:return\s+)?(handle\w+)\s*\(\s*([^()]*)\)/g;
    const conditions = (indexRaw.match(/req\.method === "POST"/g) ?? []).length;
    const branches = [...indexRaw.matchAll(dispatch)];
    expect(branches.length, "POST 分支数与条件数不一致:扫描器跟不上分发改写了").toBe(conditions);

    const bodyHandlers = branches
      .filter(([, , args]) => /(^|[^\w$])req([^\w$]|$)/.test(args))
      .map(([, name]) => name);
    // 三个已知端点必须在清单里(空清单会让下面那个循环变成空跑)。
    for (const name of ["handleSessionLogin", "handleCreateTask", "handleApprove"]) {
      expect(bodyHandlers, `POST 分发里找不到 ${name}:用例的扫描器跟不上分发改写了`).toContain(name);
    }

    for (const name of bodyHandlers) {
      const start = indexRaw.indexOf(`function ${name}(`);
      expect(start, `找不到 handler ${name}`).toBeGreaterThan(-1);
      const end = indexRaw.indexOf("\n}", start);
      const body = indexRaw.slice(start, end < 0 ? indexRaw.length : end);
      // 允许泛型实参(`parseJsonBody<T>(req)`),所以判据是「调用名后面紧跟 < 或 (」。
      expect(
        /(?:^|[^\w$.])parseJsonBody\s*[<(]/.test(body),
        `${name} 必须经 parseJsonBody 读 body`,
      ).toBe(true);
    }
  });

  it("三个端点的失败映射:create/approve 用 invalid_body,login 不许用", () => {
    const handlerOf = (name: string): string => {
      const start = indexRaw.indexOf(`function ${name}(`);
      const end = indexRaw.indexOf("\n}", start);
      return indexRaw.slice(start, end < 0 ? indexRaw.length : end);
    };
    for (const name of ["handleCreateTask", "handleApprove"]) {
      expect(
        /(?:^|[^\w$.])invalidBodyResponse\s*\(/.test(handlerOf(name)),
        `${name} 必须用 invalidBodyResponse 答解析失败`,
      ).toBe(true);
    }
    // login 的映射必须是 invalid_credentials:漏了这一句就是 §3 的探测面回来了。
    expect(handlerOf("handleSessionLogin")).not.toContain("invalidBodyResponse");
    expect(handlerOf("handleSessionLogin")).toContain("invalid_credentials");
  });
});
