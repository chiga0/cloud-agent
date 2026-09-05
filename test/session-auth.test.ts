import { beforeAll, describe, expect, it } from "vitest";
import { createExecutionContext, env } from "cloudflare:test";
import worker from "../src/index";
import {
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
  constantTimeEqual,
  mintSessionCookieValue,
  sessionCookieExpiryMs,
  verifySessionCookieValue,
} from "../src/auth/session";
import type { TaskSession } from "../src/control/session";
import { applyMigrations } from "./d1";

/**
 * w1b 会话基座核(docs/product.md §3)的钉子测试。三件事各钉一头:
 *
 * 1. **Bearer 零回归**是 w1b 的第一验收(§7):land.mjs 的落地通道是 `Bearer` + **不带
 *    Origin**(scripts/land.mjs 的 headers 只有 authorization/accept),所以 Origin 兜底
 *    一旦漏了「只管 cookie 鉴权」这个限定,断的是交付通道本身。下面的用例逐条按 land.mjs
 *    的真实请求形状打,而不是按「浏览器会怎么发」打。
 * 2. **Set-Cookie 逐属性**:`__Host-` 前缀的三条硬性要求(Secure / Path=/ / 无 Domain)
 *    由浏览器强制执行,写错的表现不是报错而是**静默丢 cookie** —— 登录 200、下一秒 401,
 *    且只在真实浏览器里可见。所以这里把属性拆成表逐条断言,把「需要浏览器实测」的项
 *    压到零。
 * 3. **失败面形状**:未鉴权一律一个 401,不区分「没有 token 字段」「JSON 畸形」「token
 *    错」「服务端未配 token」—— 每多一个可区分的响应就多一个探测面。
 */

const BASE = "https://example.com";
const SAME_ORIGIN = BASE;
const TOKEN = env.WORKER_API_TOKEN;

interface ErrorBody {
  error?: { type?: string; detail?: string };
}

interface CallInit {
  method?: string;
  /** undefined = 用真 token;null = 不带 authorization 头;字符串 = 带该值。 */
  bearer?: string | null;
  cookie?: string | null;
  /** undefined/null = 不带 Origin 头;字符串 = 带该值。 */
  origin?: string | null;
  body?: unknown;
  rawBody?: string;
  overrides?: Partial<typeof env>;
}

async function call(path: string, init: CallInit = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (init.bearer !== null) headers.authorization = `Bearer ${init.bearer ?? TOKEN}`;
  if (init.cookie !== undefined && init.cookie !== null) {
    headers.cookie = `${SESSION_COOKIE_NAME}=${init.cookie}`;
  }
  if (init.origin) headers.origin = init.origin;
  const body = init.rawBody ?? (init.body === undefined ? undefined : JSON.stringify(init.body));
  return worker.fetch(
    new Request(`${BASE}${path}`, {
      method: init.method ?? "GET",
      headers,
      body,
    }),
    { ...env, ...(init.overrides ?? {}) } as typeof env,
    createExecutionContext(),
  );
}

/** 只读一个端点:它经 D1,所以能区分「过门」(200)与「没过门」(401)。 */
const PROTECTED_GET = "/api/admin/tasks";
/** 只写一个端点:不带 spec 就是 400 invalid_spec —— 拿到 400 即证明已过鉴权门与 CSRF 门。 */
const PROTECTED_POST = "/api/tasks";

/** Set-Cookie 拆成 name/value + 属性表(属性名小写,布尔属性值为 null)。 */
function parseSetCookie(
  header: string | null,
): { name: string; value: string; attributes: Map<string, string | null> } | null {
  if (header === null) return null;
  const [nameValue, ...rest] = header.split(";");
  const eq = nameValue.indexOf("=");
  if (eq < 0) return null;
  const attributes = new Map<string, string | null>();
  for (const attr of rest) {
    const pair = attr.trim();
    if (pair.length === 0) continue;
    const idx = pair.indexOf("=");
    if (idx < 0) attributes.set(pair.toLowerCase(), null);
    else attributes.set(pair.slice(0, idx).trim().toLowerCase(), pair.slice(idx + 1).trim());
  }
  return { name: nameValue.slice(0, eq), value: nameValue.slice(eq + 1), attributes };
}

const ns = () => env.TASK_SESSION as DurableObjectNamespace<TaskSession>;

/** 建一个 RUNNING 任务(不经 workflow,不起沙箱),只为让 /live 有真实的 task 可渲染。 */
async function seedTask(): Promise<string> {
  const taskId = crypto.randomUUID();
  await ns().get(ns().idFromName(taskId)).createTask({ prompt: "session auth" }, taskId);
  return taskId;
}

beforeAll(applyMigrations);

describe("POST /api/session/login:发 cookie", () => {
  it("正确 token → 200,Set-Cookie 逐属性齐备且 __Host- 合规", async () => {
    const res = await call("/api/session/login", { method: "POST", body: { token: TOKEN } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok?: boolean }).ok).toBe(true);

    const cookie = parseSetCookie(res.headers.get("set-cookie"));
    expect(cookie, "登录成功必须发一条 Set-Cookie").not.toBeNull();
    const { name, value, attributes } = cookie!;

    // 名字:必须带 __Host- 前缀(防子域混淆),且就是 §3 钉死的那个。
    expect(name).toBe(SESSION_COOKIE_NAME);
    expect(name.startsWith("__Host-")).toBe(true);
    // 值的形状 = `<b64url(payload)>.<b64url(sig)>`:两段、点分隔、字符集内无 padding。
    expect(value).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

    // 四件套逐属性断言。任何一条缺失都不会让请求报错,只会让浏览器静默丢 cookie。
    expect(attributes.has("httponly"), "HttpOnly 必须在").toBe(true);
    expect(attributes.has("secure"), "Secure 必须在(__Host- 的硬要求)").toBe(true);
    expect(attributes.get("samesite")).toBe("Strict");
    expect(attributes.get("path")).toBe("/");
    expect(attributes.get("max-age")).toBe(String(SESSION_MAX_AGE_SECONDS));
    // Domain 必须**不出现**:带 Domain= 的 __Host- cookie 会被浏览器整条丢掉。
    expect(attributes.has("domain"), "__Host- 不允许 Domain 属性").toBe(false);
    // 只有这一条 cookie:不夹带别的凭据(未来的 logout 清 cookie 是另一棒的形状)。
    expect((res.headers.get("set-cookie") ?? "").split(SESSION_COOKIE_NAME + "=")).toHaveLength(2);
  });

  it("Max-Age 与 payload 里的 exp 同源:两个数说的必须是同一件事", async () => {
    const res = await call("/api/session/login", { method: "POST", body: { token: TOKEN } });
    const cookie = parseSetCookie(res.headers.get("set-cookie"))!;
    const maxAge = Number(cookie.attributes.get("max-age"));
    const exp = sessionCookieExpiryMs(cookie.value);
    expect(exp, "payload 必须可解码且带 exp").not.toBeNull();
    const remainingSec = (exp! - Date.now()) / 1000;
    // 允许秒级抖动,但不允许两个数各说一套(先到期的是说谎的那个)
    expect(remainingSec).toBeGreaterThan(maxAge - 10);
    expect(remainingSec).toBeLessThanOrEqual(maxAge);
  });

  it("失败面只有一个形状:不区分缺字段/非字符串/畸形 JSON/空 body/token 错", async () => {
    const failures: Array<{ label: string; init: CallInit }> = [
      { label: "token 错", init: { body: { token: `${TOKEN}-but-wrong` } } },
      { label: "token 空串", init: { body: { token: "" } } },
      { label: "缺 token 字段", init: { body: { user: "ops" } } },
      { label: "token 非字符串", init: { body: { token: 12345 } } },
      { label: "body 不是对象", init: { rawBody: JSON.stringify(TOKEN) } },
      { label: "JSON 畸形", init: { rawBody: "{token:" } },
      { label: "空 body", init: { rawBody: "" } },
      { label: "服务端未配 token", init: { body: { token: TOKEN }, overrides: { WORKER_API_TOKEN: "" } } },
    ];
    for (const { label, init } of failures) {
      const res = await call("/api/session/login", { method: "POST", ...init });
      expect(res.status, `${label} 必须 401`).toBe(401);
      expect(((await res.json()) as ErrorBody).error?.type, `${label} 的响应形状必须不可区分}`).toBe(
        "invalid_credentials",
      );
      expect(res.headers.get("set-cookie"), `${label} 绝不能发 cookie`).toBeNull();
    }
  });

  it("未配 WORKER_API_TOKEN 时 fail-closed:连登录都答 401,不发任何凭据", async () => {
    const res = await call("/api/session/login", {
      method: "POST",
      body: { token: "whatever" },
      overrides: { WORKER_API_TOKEN: "" },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("GET /api/session/login 不进登录分支:照样落在鉴权门之后", async () => {
    const res = await call("/api/session/login", { bearer: null });
    expect(res.status).toBe(401);
    expect(((await res.json()) as ErrorBody).error?.type).toBe("unauthorized");

    // 带 Bearer 时它穿过了门,但 GET 没有对应分发 → 全局 404。登录只有 POST 一条门。
    const got = await call("/api/session/login");
    expect(got.status).toBe(404);
    expect(((await got.json()) as ErrorBody).error?.type).toBe("not_found");
  });

  it("旧路径不留兼容层:POST /session/login(不带 /api)→ 404 not_found", async () => {
    const res = await call("/session/login", { method: "POST", body: { token: TOKEN } });
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrorBody).error?.type).toBe("not_found");
  });
});

describe("checkApiToken:Bearer 优先(land.mjs 零回归 = w1b 第一验收)", () => {
  it("Bearer 打只读端点照常 200,不带 Origin、不带 cookie", async () => {
    const res = await call(PROTECTED_GET);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { count?: number }).count).toBeTypeOf("number");
  });

  it("Bearer 打写端点不受 Origin 检查影响:照 land.mjs 的真实形状(无 Origin)与跨站 Origin 两种", async () => {
    // land.mjs 发的就是这个形状:只有 authorization + accept,没有 Origin。
    const noOrigin = await call(PROTECTED_POST, { method: "POST", body: { nope: true } });
    expect(noOrigin.status).toBe(400); // invalid_spec = 已过门,只是 spec 不合法
    expect(((await noOrigin.json()) as ErrorBody).error?.type).toBe("invalid_spec");

    // 服务端 CLI 本来就可能在任何源下发出;要求同源等于要求它演浏览器。
    const crossOrigin = await call(PROTECTED_POST, {
      method: "POST",
      body: { nope: true },
      origin: "https://evil.example",
    });
    expect(crossOrigin.status).toBe(400);
  });

  it("错 token 仍是那一条 401 unauthorized(不是登录端点的 invalid_credentials)", async () => {
    for (const bearer of ["wrong-token", ""]) {
      const res = await call(PROTECTED_GET, { bearer });
      expect(res.status).toBe(401);
      expect(((await res.json()) as ErrorBody).error?.type).toBe("unauthorized");
    }
  });

  it("两条凭据互相独立:错 Bearer 不撤销一个有效会话,有效 Bearer 也不被垃圾 cookie 拖垮", async () => {
    const good = await mintSessionCookieValue(TOKEN, Date.now());
    const badBearer = await call(PROTECTED_GET, { bearer: "wrong-token", cookie: good });
    expect(badBearer.status).toBe(200);

    const badCookie = await call(PROTECTED_GET, { cookie: "not-a-session.forge" });
    expect(badCookie.status).toBe(200);
  });

  it("未配 WORKER_API_TOKEN 时全门 fail-closed:Bearer 与 cookie 都不成立", async () => {
    const good = await mintSessionCookieValue(TOKEN, Date.now());
    for (const init of [{ bearer: TOKEN }, { bearer: null, cookie: good }] as CallInit[]) {
      const res = await call(PROTECTED_GET, { ...init, overrides: { WORKER_API_TOKEN: "" } });
      expect(res.status).toBe(401);
    }
  });

  it("会话凭据跟着 token 一起失效:换 token = 全量撤销(§3 的撤销模型)", async () => {
    const cookie = await mintSessionCookieValue(TOKEN, Date.now());
    expect((await call(PROTECTED_GET, { bearer: null, cookie })).status).toBe(200);
    const rotated = await call(PROTECTED_GET, {
      bearer: null,
      cookie,
      overrides: { WORKER_API_TOKEN: `${TOKEN}-rotated` },
    });
    expect(rotated.status).toBe(401);
  });
});

describe("checkApiToken:会话 cookie 兜底(浏览器那条路)", () => {
  it("登录拿到的 cookie 单独即可过门(不带 authorization)", async () => {
    const login = await call("/api/session/login", { method: "POST", body: { token: TOKEN } });
    const cookie = parseSetCookie(login.headers.get("set-cookie"))!.value;
    const res = await call(PROTECTED_GET, { bearer: null, cookie });
    expect(res.status).toBe(200);
  });

  it("最大红利:cookie 可直达 /live 页面(它带的就是事件流的凭据)", async () => {
    const taskId = await seedTask();
    const cookie = await mintSessionCookieValue(TOKEN, Date.now());
    const res = await call(`/live/${taskId}`, { bearer: null, cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("签名/载荷/pass 三种伪造一律 401 unauthorized", async () => {
    const valid = await mintSessionCookieValue(TOKEN, Date.now());
    const [payload, sig] = valid.split(".");
    const forgedExpiry = `${b64url(`{"exp":${Date.now() + 3600_000}}`)}.${sig}`;
    const forgedSig = `${payload}.${b64url("x".repeat(32))}`;
    const otherSecret = await mintSessionCookieValue("a-different-token", Date.now());
    const expired = await mintSessionCookieValue(TOKEN, Date.now() - (SESSION_MAX_AGE_SECONDS + 5) * 1000);

    const attacks: Array<[string, string]> = [
      ["延长 exp 但沿用旧签名", forgedExpiry],
      ["换掉签名", forgedSig],
      ["别的 secret 铸的合法 cookie", otherSecret],
      ["签名有效但已过期", expired],
      ["只有 payload 没有签名", payload],
      ["空值", ""],
      ["三个段", `${payload}.${sig}.${sig}`],
      ["字符集外", `${payload}!!.${sig}`],
      ["超长垃圾", `${payload}.${"A".repeat(300)}`],
    ];
    for (const [label, value] of attacks) {
      const res = await call(PROTECTED_GET, { bearer: null, cookie: value });
      expect(res.status, `${label} 必须 401`).toBe(401);
      expect(((await res.json()) as ErrorBody).error?.type, `${label} 不能变成别的错误`).toBe(
        "unauthorized",
      );
    }
  });
});

describe("CSRF:cookie 鉴权的非 GET 必须同源 Origin", () => {
  const cookieOf = () => mintSessionCookieValue(TOKEN, Date.now());

  it("无 Origin / 跨站 / 不透明源 → 403 invalid_origin", async () => {
    const cookie = await cookieOf();
    for (const origin of [null, "https://evil.example", "null", "not a url", `${SAME_ORIGIN}.evil`]) {
      const res = await call(PROTECTED_POST, {
        method: "POST",
        bearer: null,
        cookie,
        origin,
        body: { nope: true },
      });
      expect(res.status, `Origin=${String(origin)} 必须被拒`).toBe(403);
      expect(((await res.json()) as ErrorBody).error?.type).toBe("invalid_origin");
    }
  });

  it("同源 Origin → 过 CSRF 门(剩下的 400 是业务校验,不是鉴权)", async () => {
    const cookie = await cookieOf();
    const res = await call(PROTECTED_POST, {
      method: "POST",
      bearer: null,
      cookie,
      origin: SAME_ORIGIN,
      body: { nope: true },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorBody).error?.type).toBe("invalid_spec");
  });

  it("GET 一律免检:EventSource/页面导航不带 Origin 也要能用", async () => {
    const cookie = await cookieOf();
    expect((await call(PROTECTED_GET, { bearer: null, cookie })).status).toBe(200);
    const taskId = await seedTask();
    const stream = await call(`/api/tasks/${taskId}/events/stream`, { bearer: null, cookie });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    await stream.body?.cancel().catch(() => undefined);
  });

  it("未鉴权的非 GET 照旧是 401,不是 403(Origin 门在凭据门之后)", async () => {
    const res = await call(PROTECTED_POST, { method: "POST", bearer: null, body: { nope: true } });
    expect(res.status).toBe(401);
    expect(((await res.json()) as ErrorBody).error?.type).toBe("unauthorized");
  });
});

describe("src/auth/session 原语", () => {
  it("constantTimeEqual:等值/不等/长度差都不误判", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("", "")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("abc", "xbc")).toBe(false);
    // 非 ASCII:比较的是 UTF-8 字节,不能因代理对而错位
    expect(constantTimeEqual("运维", "运维")).toBe(true);
    expect(constantTimeEqual("运维", "运维 ")).toBe(false);
  });

  it("verifySessionCookieValue 对 exp 取严格大于(过期那一瞬即无效)", async () => {
    const now = Date.now();
    const cookie = await mintSessionCookieValue(TOKEN, now - SESSION_MAX_AGE_SECONDS * 1000);
    expect(await verifySessionCookieValue(cookie, TOKEN, now)).toBe(false); // exp === now
    expect(await verifySessionCookieValue(cookie, TOKEN, now - 1)).toBe(true); // 还剩 1ms
  });

  it("铸/验往返 25 次全过,且其中至少一条签名含 URL-safe 字符", async () => {
    // 为什么要有这条:workerd 的 `atob` 只认标准 base64 字母表,不认 `-`/`_`。少一次字母表
    // 替换时,校验会**按签名里有没有这两个字符随机失败**(32 字节签名约 2/3 概率命中),
    // 表现为「同一份 cookie 时好时坏」—— 单靠一次往返测不出,故固定次数往返 + 显式要求
    // 样本里出现过 `-`/`_`。样本由 nowMs 逐毫秒推进确定生成,不靠运气。
    let sawUrlSafe = 0;
    const t0 = Date.now();
    for (let i = 0; i < 25; i++) {
      const value = await mintSessionCookieValue(TOKEN, t0 + i);
      const sig = value.split(".")[1];
      if (/[-_]/.test(sig)) sawUrlSafe++;
      expect(await verifySessionCookieValue(value, TOKEN, t0 + i + 1000), `第 ${i} 条应验过`).toBe(true);
    }
    expect(sawUrlSafe, "样本没覆盖到 URL-safe 字母,这条钉子失效了").toBeGreaterThan(0);
  });

  it("key 错配即验不过:同一份 payload 换 secret 不复用", async () => {
    const cookie = await mintSessionCookieValue(TOKEN, Date.now());
    expect(await verifySessionCookieValue(cookie, `${TOKEN}x`, Date.now())).toBe(false);
    expect(await verifySessionCookieValue(cookie, TOKEN, Date.now())).toBe(true);
  });

  it("sessionCookieExpiryMs 只读不判:畸形一律 null,不抛", () => {
    expect(sessionCookieExpiryMs("")).toBeNull();
    expect(sessionCookieExpiryMs("nope")).toBeNull();
    expect(sessionCookieExpiryMs("!!!.sig")).toBeNull();
  });
});

/** 测试侧的 b64url(不带 padding):用来造合法的假 payload。 */
function b64url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
