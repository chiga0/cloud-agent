import { describe, expect, it } from "vitest";
import { createExecutionContext, env } from "cloudflare:test";
import worker from "../src/index";
import {
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
  mintSessionCookieValue,
} from "../src/auth/session";

/**
 * w1b 会话外围(登出 + bootstrap 探针)的钉子测试。核心那条门(Bearer 优先 / cookie 兜底 /
 * CSRF 两层)由 test/session-auth.test.ts 钉,本文件只钉它两端的两条:
 * `POST /api/session/logout` 与 `GET /api/session/me`(docs/product.md §3 的会话三端点之
 * 后两条)。三件事各钉一头:
 *
 * 1. **清 cookie 的「同形状」**:浏览器定位要覆盖哪条 cookie,判据是「同名 + Path + Domain」,
 *    不是「谁发的」。登出那份只要属性漂一点,它就是对另一条 cookie 说话的 —— 响应 200、
 *    无警告、页面上的 cookie 原地不动。所以除了逐属性断言,还要与登录的那条**比字节序列**
 *    (见「与登录同形状」用例):这一条才是防漂移的真钉子。
 * 2. **幂等且不泄露**:任何输入形状都得到**同一个** 200(响应与请求带了什么无关)。
 *    「无 cookie 时 401、有 cookie 时 200」看着更像正规鉴权,但那正是会话存在性的 oracle,
 *    而登出根本没有需要区分的两种失败 —— 服务端零状态,没什么可失败的。
 * 3. **探针不是凭据分发点**:/me 的响应必须既不含 token 也不含 cookie 值,且**绝不发
 *    Set-Cookie**(发 cookie 的出口按 §3 只有 /login 一条;多一条就多一个可被利用的铸凭据点)。
 *
 * 本文件的用例全部不落 D1、不起 DO:三条会话端点里,门前两条不碰存储,/me 只到鉴权门为止。
 */

const BASE = "https://example.com";
const TOKEN = env.WORKER_API_TOKEN;

interface ErrorBody {
  error?: { type?: string };
}

interface MeBody {
  authenticated?: unknown;
  credential?: unknown;
  expires_at?: unknown;
  [k: string]: unknown;
}

interface CallInit {
  method?: string;
  /** undefined = 用真 token;null = 不带 authorization 头;字符串 = 带该值。 */
  bearer?: string | null;
  /** undefined = 不带 cookie 头;null = 带一条**空的** Cookie 头;字符串 = 带该值。 */
  cookie?: string | null;
  /** undefined/null = 不带 Origin 头;字符串 = 带该值。 */
  origin?: string | null;
  body?: unknown;
  overrides?: Partial<typeof env>;
}

async function call(path: string, init: CallInit = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (init.bearer !== null) headers.authorization = `Bearer ${init.bearer ?? TOKEN}`;
  if (init.cookie !== undefined) {
    headers.cookie = init.cookie === null ? "" : `${SESSION_COOKIE_NAME}=${init.cookie}`;
  }
  if (init.origin) headers.origin = init.origin;
  return worker.fetch(
    new Request(`${BASE}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
    { ...env, ...(init.overrides ?? {}) } as typeof env,
    createExecutionContext(),
  );
}

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

/**
 * 一条 Set-Cookie 的**属性字面序列**(去掉 name=value 与 Max-Age)。
 * 用它比两份属性表更能抓漂移:属性表看不出顺序变化,而「同形状」判的是浏览器实际读到的串。
 */
function attrSequence(header: string): string[] {
  return header
    .split(";")
    .slice(1)
    .map((s) => s.trim())
    .filter((s) => !/^max-age/i.test(s));
}

const LOGOUT = "/api/session/logout";
const ME = "/api/session/me";

describe("POST /api/session/logout:清 cookie", () => {
  it("200 + 过期 Set-Cookie:同名、空值、Max-Age=0、四件套齐备且无 Domain", async () => {
    const res = await call(LOGOUT, { method: "POST" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok?: boolean }).ok).toBe(true);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const header = res.headers.get("set-cookie");
    const cookie = parseSetCookie(header);
    expect(cookie, "登出必须发一条 Set-Cookie").not.toBeNull();
    const { name, value, attributes } = cookie!;

    expect(name).toBe(SESSION_COOKIE_NAME);
    expect(name.startsWith("__Host-")).toBe(true);
    // 值必须是**空串**:RFC 6265 的删除形状是「同名 + 空值 + Max-Age=0」。
    // 留个占位值(如 "0"、"logout")就是往 cookie jar 里写一条新会话形状的垃圾。
    expect(value).toBe("");
    expect(attributes.get("max-age")).toBe("0");
    expect(attributes.has("httponly"), "HttpOnly 必须在").toBe(true);
    expect(attributes.has("secure"), "Secure 必须在(__Host- 的硬要求)").toBe(true);
    expect(attributes.get("samesite")).toBe("Strict");
    expect(attributes.get("path")).toBe("/");
    expect(attributes.has("domain"), "__Host- 不允许 Domain 属性").toBe(false);
    // 只清这一条:不夹带别的 cookie,也不夹带第二份同名字符串。
    expect((header ?? "").split(SESSION_COOKIE_NAME + "=")).toHaveLength(2);
  });

  it("与登录同形状:除值与 Max-Age 外,属性字面序列逐字符相同(防漂移的真钉子)", async () => {
    const login = await call("/api/session/login", { method: "POST", body: { token: TOKEN } });
    const loginHeader = login.headers.get("set-cookie");
    const logoutHeader = (await call(LOGOUT, { method: "POST" })).headers.get("set-cookie");
    expect(loginHeader, "登录必须发 cookie").not.toBeNull();
    expect(logoutHeader, "登出必须发 cookie").not.toBeNull();

    const a = parseSetCookie(loginHeader)!;
    const b = parseSetCookie(logoutHeader)!;
    expect(b.name).toBe(a.name);
    // 顺序、拼写、一个多一个少都会在这里红 —— 属性表看不出顺序,字面序列看得出。
    expect(attrSequence(logoutHeader!)).toEqual(attrSequence(loginHeader!));
    // 唯一允许差别的两项:值(登录有、登出空)与 Max-Age(登录 21600、登出 0)。
    expect(a.value.length, "登录那条必须带值").toBeGreaterThan(0);
    expect(b.value).toBe("");
    expect(a.attributes.get("max-age")).toBe(String(SESSION_MAX_AGE_SECONDS));
    expect(b.attributes.get("max-age")).toBe("0");
  });

  it("幂等且不泄露会话存在性:五种输入形状得到逐字节相同的响应", async () => {
    const expired = await mintSessionCookieValue(TOKEN, Date.now() - (SESSION_MAX_AGE_SECONDS + 5) * 1000);
    const shapes: Array<[string, CallInit]> = [
      ["合法会话", { method: "POST", bearer: null, cookie: await mintSessionCookieValue(TOKEN, Date.now()) }],
      ["已过期会话", { method: "POST", bearer: null, cookie: expired }],
      ["伪造签名", { method: "POST", bearer: null, cookie: "AAAA.BBBB" }],
      ["别的 secret 铸的合法 cookie", { method: "POST", bearer: null, cookie: await mintSessionCookieValue("a-different-token", Date.now()) }],
      ["不带 cookie 头", { method: "POST", bearer: null }],
      ["空的 Cookie 头", { method: "POST", bearer: null, cookie: null }],
      ["Bearer 客户端", { method: "POST" }],
      ["服务端未配 token", { method: "POST", bearer: null, overrides: { WORKER_API_TOKEN: "" } }],
    ];
    let baseline: { status: number; body: string; setCookie: string | null } | null = null;
    for (const [label, init] of shapes) {
      const res = await call(LOGOUT, init);
      const body = await res.text();
      const snapshot = { status: res.status, body, setCookie: res.headers.get("set-cookie") };
      expect(snapshot.status, `${label} 必须 200`).toBe(200);
      expect(JSON.parse(snapshot.body)).toEqual({ ok: true });
      if (baseline === null) baseline = snapshot;
      else
        expect(snapshot, `${label} 的响应必须与「合法会话」那一形状不可区分`).toEqual(baseline);
    }
  });

  it("Origin 不参与判定:跨站也拿同一个 200(强制登出在协议上不可拒 —— 已登记的取舍)", async () => {
    // 不是遗漏而是定稿:在登出上要求同源,「无 cookie 的幂等成功」就不成立了(curl 不带 Origin)。
    // 后果面服务端零状态,见 handleSessionLogout 上方注释与 docs/architecture.md §10.5。
    for (const origin of [null, "https://evil.example", "null", `${BASE}.evil`]) {
      const res = await call(LOGOUT, { method: "POST", bearer: null, origin });
      expect(res.status, `Origin=${String(origin)} 下登出照样成功`).toBe(200);
      expect(parseSetCookie(res.headers.get("set-cookie"))!.attributes.get("max-age")).toBe("0");
    }
  });

  it("只有 POST 一条门:GET 落全局 404 not_found;旧路径不留兼容层", async () => {
    const get = await call(LOGOUT);
    expect(get.status).toBe(404);
    expect(((await get.json()) as ErrorBody).error?.type).toBe("not_found");

    const old = await call("/session/logout", { method: "POST" });
    expect(old.status).toBe(404);
    expect(((await old.json()) as ErrorBody).error?.type).toBe("not_found");
  });

  it("登出后旧 cookie 仍能过门:零存储会话的撤销粒度是客户端,不是服务端", async () => {
    // 这条钉的是**边界**而不是缺陷:能撤销一份被抄走的 cookie 的手段只有换 WORKER_API_TOKEN。
    // 若哪天有人给会话加了服务端记录,这条会红 —— 那时它该被改,而不是被删。
    const cookie = await mintSessionCookieValue(TOKEN, Date.now());
    await call(LOGOUT, { method: "POST", bearer: null, cookie });
    const after = await call(ME, { bearer: null, cookie });
    expect(after.status).toBe(200);
    expect(((await after.json()) as MeBody).credential).toBe("cookie");
  });
});

describe("GET /api/session/me:SPA bootstrap 探针", () => {
  it("未鉴权与既有 401 逐字节同形状:形状来自全局门,不是本端点的复刻", async () => {
    const me = await call(ME, { bearer: null });
    const other = await call("/api/admin/tasks", { bearer: null });
    expect(me.status).toBe(401);
    expect(other.status).toBe(401);
    const meText = await me.text();
    // 逐字节相同 = 同一个 `unauthorized()` 产物,而不是本端点自己复刻的一份。
    expect(meText).toBe(await other.text());
    expect((JSON.parse(meText) as ErrorBody).error?.type).toBe("unauthorized");
    expect(me.headers.get("content-type")).toBe(other.headers.get("content-type"));
  });

  it("坏凭据一律同一个 401:过期会话 / 伪造签名 / 别的 secret / 错 Bearer / 未配 token", async () => {
    const attacks: Array<[string, CallInit]> = [
      ["过期会话", { bearer: null, cookie: await mintSessionCookieValue(TOKEN, Date.now() - (SESSION_MAX_AGE_SECONDS + 5) * 1000) }],
      ["伪造签名", { bearer: null, cookie: "AAAA.BBBB" }],
      ["别的 secret 铸的合法 cookie", { bearer: null, cookie: await mintSessionCookieValue("a-different-token", Date.now()) }],
      ["错 Bearer", { bearer: "wrong-token" }],
      ["不带 authorization", { bearer: null }],
      ["服务端未配 token", { bearer: TOKEN, overrides: { WORKER_API_TOKEN: "" } }],
    ];
    for (const [label, init] of attacks) {
      const res = await call(ME, init);
      expect(res.status, `${label} 必须 401`).toBe(401);
      expect(((await res.json()) as ErrorBody).error?.type, `${label} 不能变成别的错误`).toBe(
        "unauthorized",
      );
    }
  });

  it("会话 cookie → 200:键集恰为三件,credential=cookie 且 expires_at 跟着 payload 的 exp", async () => {
    const cookie = await mintSessionCookieValue(TOKEN, Date.now());
    const res = await call(ME, { bearer: null, cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toContain("application/json");

    const body = (await res.json()) as MeBody;
    expect(Object.keys(body).sort()).toEqual(["authenticated", "credential", "expires_at"]);
    expect(body.authenticated).toBe(true);
    expect(body.credential).toBe("cookie");

    const expiresAt = body.expires_at;
    expect(typeof expiresAt).toBe("string");
    const skewSec = (new Date(expiresAt as string).getTime() - Date.now()) / 1000;
    // 与 payload 的 exp 同源(允许秒级抖动),且与 cookie 的 Max-Age 说的是同一件事。
    expect(skewSec).toBeGreaterThan(SESSION_MAX_AGE_SECONDS - 10);
    expect(skewSec).toBeLessThanOrEqual(SESSION_MAX_AGE_SECONDS);
  });

  it("Bearer → 200 且 expires_at=null;顺手带的合法 cookie 不被报出(过关的不是它)", async () => {
    const cookie = await mintSessionCookieValue(TOKEN, Date.now());
    const plain = await call(ME);
    expect(plain.status).toBe(200);
    expect(Object.keys((await plain.json()) as MeBody).sort()).toEqual([
      "authenticated",
      "credential",
      "expires_at",
    ]);

    const both = await call(ME, { cookie });
    expect(both.status).toBe(200);
    const body = (await both.json()) as MeBody;
    // Bearer 优先是 §3 的定序,这里连响应都不能把它说漏。
    expect(body.credential).toBe("bearer");
    expect(body.expires_at).toBeNull();
  });

  it("不含任何凭据材料:token 值、cookie 原值、签名段都不出现,且绝不发 Set-Cookie", async () => {
    const cookie = await mintSessionCookieValue(TOKEN, Date.now());
    const res = await call(ME, { bearer: null, cookie });
    const text = await res.text();
    expect(res.headers.get("set-cookie"), "/me 绝不是第二个发凭据的出口").toBeNull();
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(cookie);
    expect(text).not.toContain(cookie.split(".")[1]); // 签名段单独出现也算泄露
    expect(text).not.toContain(SESSION_COOKIE_NAME);

    const viaBearer = await call(ME, { cookie });
    const bearerText = await viaBearer.text();
    expect(bearerText).not.toContain(TOKEN);
    expect(bearerText).not.toContain(cookie);
  });

  it("GET 免 CSRF:不带 Origin 的 cookie 请求照样 200(SPA 与 EventSource 同侧)", async () => {
    const cookie = await mintSessionCookieValue(TOKEN, Date.now());
    const noOrigin = await call(ME, { bearer: null, cookie });
    expect(noOrigin.status).toBe(200);
    const crossOrigin = await call(ME, { bearer: null, cookie, origin: "https://evil.example" });
    expect(crossOrigin.status).toBe(200);
  });

  it("只有 GET 一条门:POST 落 404 not_found(过了门也没有分发);旧路径不留兼容层", async () => {
    const post = await call(ME, { method: "POST" });
    expect(post.status).toBe(404);
    expect(((await post.json()) as ErrorBody).error?.type).toBe("not_found");

    // 未鉴权的 POST 先到门:401 而不是 404 —— 门的顺序不因新增分支而变。
    const unauthed = await call(ME, { method: "POST", bearer: null });
    expect(unauthed.status).toBe(401);
    expect(((await unauthed.json()) as ErrorBody).error?.type).toBe("unauthorized");

    // 旧路径也在门后:无凭据先吃 401,带凭据才落到「没有分发」的 404。
    const oldUnauthed = await call("/session/me", { bearer: null });
    expect(oldUnauthed.status).toBe(401);
    const oldWithToken = await call("/session/me");
    expect(oldWithToken.status).toBe(404);
    expect(((await oldWithToken.json()) as ErrorBody).error?.type).toBe("not_found");
  });
});
