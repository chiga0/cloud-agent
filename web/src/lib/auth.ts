/**
 * 会话面(docs/product.md §3 的前端那一半 + §5 的 /login 与 guard 两条)。
 *
 * 全部是**纯函数**:输入凭据/错误/路径,输出判定与文案。路由与组件只负责把它们接到
 * TanStack 的钩子上。这么切的理由不是「分层好看」,而是本仓的测试跑在 Workers 运行时里
 * (无 DOM、无 jsdom):判定留在纯函数里才钉得住 —— 而这三条判定恰恰是全站最容易
 * 「只在浏览器里坏」的地方,不能只靠部署后肉眼冒烟。
 *
 * 三条判定的分量各不相当,逐条说清:
 *
 * 1. **只有 401 才跳登录**(probeSession)。`shape`/`network`/`http` 都说明不了「你没登录」:
 *    把网络抖动当成会话过期,用户会站在登录页上反复贴同一个正确的 token,而真正坏的是
 *    那条没被 run_worker_first 盖住的 API(§7 头号风险的形状就是 200 + HTML)。
 *    非 401 一律放行到壳里,由壳上的会话状态位如实说「读不到」。
 * 2. **登录失败只有一种文案**(loginFailureCopy)。token 错、服务端没配 token、网络不通、
 *    响应形状不对 —— 全部同一句话。§5 的原话是「不泄露探测面」:每多一个分支,
 *    /login 就多一个可白嫖的 oracle(「这台部署配了 token 吗」),而它是**门前**的端点,
 *    没有鉴权也没有速率限制兜着。可调试性由服务端日志承担。
 * 3. **`?next=` 只认本仓路由形状**(isInternalNextPath)。开放重定向是登录页的经典缺陷:
 *    `next=https://evil.example/` 或者 `next=//evil.example/` 都会被浏览器当成
 *    「登录后就该去的地方」,而我们的站点是操作员登录后的第一眼 —— 拿它给钓鱼背书,
 *    代价不是「样式坏了」。白名单而不是「排除明显恶意」:后者是黑名单,迟早被绕。
 */

import { apiFailureKind, isUnauthorized } from "./api";
import type { LoginSearch } from "./schema";

/** 未登录时唯一去处。值与 router.tsx 的 /login 路由同一条路径。 */
export const LOGIN_PATH = "/login";

/** 登录成功后的缺省落点(任务列表,内容由 w3 接入)。 */
export const HOME_PATH = "/";

/**
 * 本仓在用的客户端路由形状(docs/product.md §5 的页面清单)。
 * `/tasks/*` 这一段刻意放宽到 `[0-9a-f-]{36}`:与服务端 `/api/tasks/:id` 的路径段正则同一条,
 * 于是「next 指向一个畸形任务 id」与「直接导航到畸形 id」得到同一个 not_found,不新增判据。
 */
const INTERNAL_NEXT_PATTERNS: readonly RegExp[] = [
  /^\/$/,
  /^\/approvals$/,
  /^\/audit$/,
  /^\/tasks\/[0-9a-f-]{36}$/,
];

/**
 * `next` 是否是**站内**路径。
 *
 * 三条硬规矩,缺一条就有绕过的口子:
 * - 必须单斜杠开头 → 挡掉 `javascript:`/`data:`/绝对 URL(它们不以 `/` 开头)。
 * - 第二个字符不能是 `/` 或 `\` → 挡掉协议相对 URL `//evil.example/`,
 *   浏览器会把它解析成 `https://evil.example/`(这一条是最常被忘的)。
 * - 必须整体匹配上表白名单 → 挡掉任何还没实现的形状。
 */
export function isInternalNextPath(value: string): boolean {
  if (!value.startsWith("/") || value.length < 2) return value === "/";
  if (value[1] === "/" || value[1] === "\\") return false;
  return INTERNAL_NEXT_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * 登录后该去哪儿:合法 `next` 原样,其余一律回首页。
 * 输入直接取路由校验后的 search(`LoginSearch`),不重新读 URL —— 读第二遍就绕过了 zod 那一层。
 */
export function loginTargetPath(search: LoginSearch): string {
  const next = search.next;
  if (typeof next !== "string") return HOME_PATH;
  return isInternalNextPath(next) ? next : HOME_PATH;
}

/** guard 的三种结论。`unreachable` 不是错误码,是「前端此刻不知道」—— 二者对用户不该同形。 */
export type SessionProbe =
  | { readonly status: "authenticated" }
  | { readonly status: "unauthenticated" }
  /** 门那头的东西读不到(network/shape/http)。reason 是 ApiFailure 的 kind,只进日志与状态位。 */
  | { readonly status: "unreachable"; readonly reason: string };

/**
 * 一次「读 /api/session/me 的失败」该怎么解释。**同步**函数,因为 guard 与壳上的状态位
 * 拿到的是同一个 Query 的同一个错误对象,而两者必须说同一句话:
 * - 401 → `unauthenticated`(唯一的「跳登录」判据);
 * - 其余 → `unreachable(kind)`(可能是网络、可能是 §7 那条 200 + HTML)。
 *
 * 单独导出而不只藏在 probeSession 里:壳渲染时错误已经在手上,再 await 一次是多余的仪式。
 */
export function probeSessionFromError(err: unknown): SessionProbe {
  if (isUnauthorized(err)) return { status: "unauthenticated" };
  return { status: "unreachable", reason: apiFailureKind(err) ?? "unknown" };
}

/**
 * 探一次会话。`ensure` 是 `queryClient.ensureQueryData(sessionQueryOptions())` 的注入点:
 * 走 Query 而不是裸 fetch,guard 与壳上的状态位因此共用同一次请求与同一份缓存
 * (loader 里 ensureQueryData 的预取红利正在这 —— 导航与渲染各打一次 /me 是两倍延迟)。
 *
 * 只 catch 不 rethrow:结论用值表达,调用方(路由)决定 `throw redirect(...)`。
 */
export async function probeSession(ensure: () => Promise<unknown>): Promise<SessionProbe> {
  try {
    await ensure();
    return { status: "authenticated" };
  } catch (err) {
    return probeSessionFromError(err);
  }
}

/**
 * 登录失败的唯一文案(§5:不区分「token 错」与「网络错」)。
 *
 * 「只有一句」是机制而不是风格:四种 kind 全部映射到同一个字符串常量,任何人改其中一个分支
 * 都会让 test/web-data-layer.test.ts 的「四支逐字相等」红掉 —— 那种改动的代价应该是写测试,
 * 而不是顺手多写一个 `if`。
 *
 * 服务端对 token 错/没配 token/body 畸形本来就一律回同一个 401 invalid_credentials,
 * 这一条是把同样的纪律延伸到**浏览器可见的那一层**。
 */
export const LOGIN_FAILURE_TEXT = "登录失败:请核对 token 后重试。";

/** 四种失败种类 → 同一句话。新增第五种时这张表必须跟着加一条,否则类型就不对。 */
const LOGIN_FAILURE_COPY: Record<NonNullable<ReturnType<typeof apiFailureKind>>, string> = {
  unauthorized: LOGIN_FAILURE_TEXT,
  http: LOGIN_FAILURE_TEXT,
  network: LOGIN_FAILURE_TEXT,
  shape: LOGIN_FAILURE_TEXT,
};

/** 未知异常(不是 ApiError 的那一小撮:JSON.stringify 抛、事件回调里的 bug)同文案同处置。 */
export function loginFailureCopy(err: unknown): string {
  const kind = apiFailureKind(err);
  return kind === null ? LOGIN_FAILURE_TEXT : LOGIN_FAILURE_COPY[kind];
}

/** token 空/全空格不发请求:那是输入错误,与「服务端答复」不是一类,不该共用同一句谎。 */
export const LOGIN_EMPTY_TOKEN_TEXT = "请先粘贴 token。";

export function isUsableToken(value: string): boolean {
  return value.trim().length > 0;
}

/**
 * 会话状态位的文本(壳右上角)。
 *
 * 三种输入三种话:探到、探不到、正在探。**没有**「已登录」这种说法 —— 这个前端的用户
 * 就是操作员本人,单租户无「谁」可言(docs/product.md 不变量),这一位回答的是
 * 「凭据还成立吗、什么时候到期」,不是身份。
 */
export type SessionIndicator = { readonly text: string; readonly tone: "ok" | "warn" | "err" | "" };

export function sessionIndicator(
  probe: SessionProbe,
  fetching: boolean,
  expiresAtIso: string | null,
  nowMs: number,
): SessionIndicator {
  if (fetching) return { text: "会话校验中", tone: "" };
  if (probe.status === "unreachable") {
    return { text: `会话状态未知(${probe.reason})`, tone: "err" };
  }
  if (probe.status === "unauthenticated") return { text: "未登录", tone: "err" };
  if (typeof expiresAtIso !== "string") return { text: "会话有效", tone: "ok" };
  const expiryMs = Date.parse(expiresAtIso);
  if (!Number.isFinite(expiryMs)) return { text: "会话有效", tone: "ok" };
  const remainSec = Math.floor((expiryMs - nowMs) / 1000);
  // 剩余时间用「时+分」而不是 ISO 串:这一位要回答的是「我还要不要急着把手上的活收尾」,
  // 不是「哪一秒到期」。跨设备时区/本地钟偏差在这里不影响结论,因为我们显示差值。
  if (remainSec <= 0) return { text: "会话已过期", tone: "err" };
  if (remainSec < 300) return { text: `会话剩余 ${Math.ceil(remainSec / 60)} 分钟`, tone: "warn" };
  const hours = Math.floor(remainSec / 3600);
  const minutes = Math.floor((remainSec % 3600) / 60);
  return {
    text: `会话剩余 ${hours}h${minutes.toString().padStart(2, "0")}m`,
    tone: "ok",
  };
}
