/**
 * w1b 会话基座(docs/product.md §3)—— 浏览器侧的**无状态** HMAC 会话凭据。
 *
 * 命名提醒:这里与 `src/control/session.ts` 没有关系,只是撞名。那个 TaskSession DO 是任务
 * 的权威状态(单写者、可变更、有状态机);本文件零存储 —— 一条自签名的 cookie 就是会话本身,
 * 校验只看「签名对不对 + 有没有过期」。因此:
 * - **不新增 secret**:HMAC key 就是 `WORKER_API_TOKEN` 本身。换 token 即全量撤销所有会话,
 *   与「单 token 操作员」的既有运维模型同构;代价是会话撤销粒度只能是「全量」,这是定稿的取舍。
 * - **不落库**:D1/DO/R2 任何一处存了它,撤销就得依赖那张表,而本文件的全部意义是不依赖。
 *
 * cookie 值格式 `<b64url(payload)>.<b64url(HMAC-SHA256(key, payload 字面串))>`:签名覆盖的
 * 是 payload 的**字面串**而不是解码后的 JSON 字节 —— 否则校验端得把对象重新序列化才能比,
 * 而 JSON 的键序/数字格式没有唯一写法,两条本来等价的 cookie 会互相打不上。
 *
 * CSRF 的四件套里本文件负责两件:cookie 属性(Secure/HttpOnly/SameSite=Strict/Path=/,见
 * `sessionSetCookieHeader`)与 Origin 同源判定(`isSameOrigin`)。SameSite=Strict 是主防,
 * Origin 检查是兜底,两者都对 cookie 鉴权的**非 GET**生效;Bearer 一条都不受影响 ——
 * land.mjs 的落地通道不带 Origin 头,断它等于断粮(docs/product.md §7)。
 *
 * 原语全部取 Workers 自带的 WebCrypto 与 `atob`/`btoa`,不引任何运行时依赖。
 */

const TEXT_ENCODER = new TextEncoder();

/**
 * `__Host-` 前缀的硬性要求(Secure + Path=/ + 无 Domain)由浏览器强制,不合规的 cookie
 * 会被静默丢弃 —— 也就是说写错的表现是「登录成功但下一秒 401」,而不是任何一条错误日志。
 * 名字与属性因此一起钉在这里,并由 test/session-auth.test.ts 逐属性断言。
 */
export const SESSION_COOKIE_NAME = "__Host-cas";

/** 会话寿命(秒)。与 cookie 的 Max-Age 同源:两个数不一致时,先到期的是说谎的那个。 */
export const SESSION_MAX_AGE_SECONDS = 21600;

/**
 * payload ≈ `{"exp":1789000000000}`(b64url 后 26 字符)+ 分隔符 + 签名(b64url 后 43 字符)
 * = 70 字符量级。设一个宽而不松的上界,只为让畸形输入在进 HMAC 之前就被拒,
 * 而不是给远端一个可以任意放大的字符串去签/验。
 */
const MAX_COOKIE_VALUE_CHARS = 256;

const B64URL_RE = /^[A-Za-z0-9_-]+$/;

function b64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * 严格解码:字符集外的任何输入返回 null,而不是抛或产出半个字节串。
 *
 * 先换回标准字母表再 `atob`:workerd 的 `atob` 是 WHATWG 的严格 base64,**不接受** URL-safe
 * 的 `-`/`_`(直接抛 InvalidCharacterError)。少了这两步替换,一条随机 HMAC 签名里约 2/3
 * 概率含 `-`/`_` → 校验随机失败,表现是「同一份凭据时好时坏」,比全都失败更难查。
 */
function b64UrlDecode(text: string): Uint8Array | null {
  if (!B64URL_RE.test(text)) return null;
  let binary: string;
  try {
    const standard = text.replace(/-/g, "+").replace(/_/g, "/");
    binary = atob(standard + "=".repeat((4 - (standard.length % 4)) % 4));
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * 定长比较:不提前 return,长度差也折进同一个 `diff` 累加器。
 * 残留的时长侧信道只有「两串的最大长度」这一项 —— 那对 token 而言是可接受的
 * (公开可猜的是长度不是内容),而早退出的逐字节比较会把「前 N 字节猜对了」直接暴露成时延。
 */
function constantTimeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

/** 字符串版定长比较(登录端点拿它比 WORKER_API_TOKEN)。 */
export function constantTimeEqual(a: string, b: string): boolean {
  return constantTimeEqualBytes(TEXT_ENCODER.encode(a), TEXT_ENCODER.encode(b));
}

async function hmacBytes(secret: string, payload: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    TEXT_ENCODER.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, TEXT_ENCODER.encode(payload));
  return new Uint8Array(signature);
}

/** 铸一条会话 cookie 的值。`nowMs` 显式传入而不是读 `Date.now()`:过期分支才可测。 */
export async function mintSessionCookieValue(secret: string, nowMs: number): Promise<string> {
  const payload = b64UrlEncode(
    TEXT_ENCODER.encode(JSON.stringify({ exp: nowMs + SESSION_MAX_AGE_SECONDS * 1000 })),
  );
  const sig = b64UrlEncode(await hmacBytes(secret, payload));
  return `${payload}.${sig}`;
}

/**
 * 验一条会话 cookie:签名有效 **且** 未过期才算数。任何一步不过 → false,调用方按未鉴权处理。
 *
 * 顺序是有意的:先验签再解析 payload。未签名的 JSON 是攻击者任意可控的输入,
 * 在它上面做任何判断(哪怕是「读一个数字比大小」)都是在给不可信数据投票的机会。
 */
export async function verifySessionCookieValue(
  value: string,
  secret: string,
  nowMs: number,
): Promise<boolean> {
  if (value.length === 0 || value.length > MAX_COOKIE_VALUE_CHARS) return false;
  const parts = value.split(".");
  if (parts.length !== 2) return false;
  const [payload, sig] = parts;
  if (!B64URL_RE.test(payload) || !B64URL_RE.test(sig)) return false;

  const providedSig = b64UrlDecode(sig);
  if (providedSig === null) return false;
  if (!constantTimeEqualBytes(providedSig, await hmacBytes(secret, payload))) return false;

  const payloadBytes = b64UrlDecode(payload);
  if (payloadBytes === null) return false;
  let parsed: unknown;
  try {
    // fatal:非 UTF-8 直接落进 catch。签名已经验过,这里再严格一遍只为「畸形即无会话」。
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes));
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  const exp = (parsed as { exp?: unknown }).exp;
  if (typeof exp !== "number" || !Number.isSafeInteger(exp) || exp <= 0) return false;
  return exp > nowMs;
}

/** 会话 cookie 的 `exp`(毫秒)。仅在值可解码且形状合法时返回,否则 null —— 不用于鉴权判定。 */
export function sessionCookieExpiryMs(value: string): number | null {
  const payload = value.split(".")[0];
  if (!payload || !B64URL_RE.test(payload)) return null;
  const bytes = b64UrlDecode(payload);
  if (bytes === null) return null;
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as {
      exp?: unknown;
    };
    return typeof parsed.exp === "number" && Number.isSafeInteger(parsed.exp) ? parsed.exp : null;
  } catch {
    return null;
  }
}

/**
 * 完整的 Set-Cookie 串。属性顺序与 docs/product.md §3 逐字一致,一个都不多一个都不能少:
 * 没有 `Domain=` 是 `__Host-` 的硬要求(带 Domain 即不合规,浏览器直接丢这条 cookie);
 * `Path=/` 同理(必须是根);`Secure` 不能省(`wrangler dev` 的 http://localhost 属可信上下文,
 * 因此本地也发得出去、收得回来)。Max-Age 与 payload 里的 exp 同源同值,浏览器据此自己清 cookie。
 */
export function sessionSetCookieHeader(value: string): string {
  return (
    `${SESSION_COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/;` +
    ` Max-Age=${SESSION_MAX_AGE_SECONDS}`
  );
}

/** 从请求里取会话 cookie 值;没有则 null。只认 `__Host-cas`,不做前缀/子串匹配。 */
export function readSessionCookie(req: Request): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    if (pair.slice(0, eq).trim() !== SESSION_COOKIE_NAME) continue;
    return pair.slice(eq + 1).trim() || null;
  }
  return null;
}

/**
 * `Origin` 头是否与请求自己的源一致。缺失即 false(fail-closed):浏览器对**任何**非 GET
 * 跨源/同源请求都恒发 Origin(含 form 提交的 POST),所以「带 cookie 的非 GET 却没有 Origin」
 * 只可能是非浏览器客户端伪造 —— 那样的客户端本该用 Bearer,这里没有为它开口的理由。
 * `null`/`undefined` 这类不透明源(sandboxed iframe、file://)同样落 false。
 */
export function isSameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(req.url).origin;
  } catch {
    return false;
  }
}
