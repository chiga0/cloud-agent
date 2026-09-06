/**
 * Query 工厂(w2b 服务端状态层的唯一出口)。
 *
 * 用 `queryOptions()` 而不是就地写对象:它把 queryKey 与 queryFn 的返回类型一起推导出来,
 * 于是 `useQuery(sessionQueryOptions())` 的数据是 `SessionView | undefined` 而不是 `unknown`。
 * 更实际的一条:key 只有一份定义处 —— loader 的 `ensureQueryData`、壳上的 `useQuery`、
 * 登录后的 `invalidateQueries` 三处必须打同一个 key,各写一遍字面量迟早拼错一个词,
 * 而拼错的表现为「预取白做了」(静默地多一次往返),不是报错。
 *
 * 这里只放**已经在跑的后端端点**(§5 的数据源列)。w3–w6 的查询由那一棒各自新增:
 * 现在多写一条就是给还没接的后端编一个投影 —— 而前端是投影这件事由后端权威说了算。
 */

import { queryOptions } from "@tanstack/react-query";
import { apiGet, apiPost } from "./api";
import {
  archivedTasksSchema,
  loginResultSchema,
  sessionSchema,
  type ArchivedTasks,
  type LoginResult,
  type SessionView,
} from "./schema";

/** 会话查询的 key。guard 的 ensureQueryData 与壳上的状态位共用它。 */
export const SESSION_KEY = ["session", "me"] as const;

/**
 * `GET /api/session/me`。
 *
 * - `retry: false`:重试三次只会把登录页推迟三秒,而 401 恰恰是**最不该重试**的答复
 *   (重试不会让它变成 200,只会让 guard 晚点跳)。非 401 的失败同样不重试:壳上的状态位
 *   会立刻如实显示「会话状态未知」,比转圈转 7 秒诚实。
 * - `staleTime` 取 60s 而不是 0:同一秒内「guard 探测 + 壳渲染 + 手动刷新」会打三次 /me,
 *   而会话寿命是 6 小时 —— 一分钟内的重复读没有任何新信息。
 *   它**不能**更大:壳上那一位显示的是剩余时长,缓存 5 分钟就等于说谎 5 分钟。
 */
export function sessionQueryOptions() {
  return queryOptions({
    queryKey: SESSION_KEY,
    queryFn: readSession,
    retry: false,
    staleTime: 60_000,
  });
}

/**
 * Approvals 角标的数据源:`GET /api/admin/tasks?state=AWAITING_APPROVAL`。
 *
 * 为什么用现成端点而不是要一个小计数字段(§5 的「零后端改动」纪律):这个端点已经支持
 * `?state=` 精确过滤,而审批积压的量级本来就是个位数到几十。
 * `limit` 取服务端上限 200(再大它返 400):超过 200 条时角标显示「200+」而不是假装知道总数 ——
 * `count` 是本次返回条数、受 limit 截断,拿它当总数是**读错口径**,那种错比少显示一个数更糟。
 */
export const AWAITING_APPROVAL_LIMIT = 200;
export const AWAITING_APPROVAL_STATE = "AWAITING_APPROVAL";
export const APPROVALS_KEY = ["admin", "tasks", AWAITING_APPROVAL_STATE] as const;

export function awaitingApprovalQueryOptions() {
  return queryOptions({
    queryKey: APPROVALS_KEY,
    queryFn: () =>
      apiGet(
        `/api/admin/tasks?state=${AWAITING_APPROVAL_STATE}&limit=${AWAITING_APPROVAL_LIMIT}`,
        archivedTasksSchema,
      ),
    // 30s:§5 给任务列表定的节拍。角标是那一页的摘要,两套刷新率必然出现「角标 0 而列表有货」
    // —— 观测面互相矛盾时,人会不再相信任何一面。
    refetchInterval: 30_000,
    staleTime: 10_000,
    retry: false,
  });
}

/**
 * 角标文本。返回 `null` = **不显示角标**,两种情况都归到这里,而且含义不同:
 * - 数据还没到:显示「0」是在替一个还没读到的数撒谎。
 * - 确实一条也没有:角标的语义是「有货要处理」,不是计数器 —— 0 的时候它就该消失
 *   (常驻一个灰色的 0 会让人眼里的「有角标/没角标」退化成一个要去读的表格,而角标的
 *   全部价值在于不读就能看见)。
 * 达到 limit 时显示「200+」:`count` 受 limit 截断,拿它当总数是读错口径。
 */
export function awaitingBadgeLabel(tasks: ArchivedTasks | undefined): string | null {
  if (!tasks) return null;
  if (tasks.count <= 0) return null;
  if (tasks.count >= AWAITING_APPROVAL_LIMIT) return `${AWAITING_APPROVAL_LIMIT}+`;
  return String(tasks.count);
}

/**
 * 登录:`POST /api/session/login`。
 *
 * 成功返回的 `{ok:true}` 里没有任何值得缓存的东西(cookie 在 Set-Cookie 上,HttpOnly 读不到),
 * 所以这里用裸 mutation 语义而不写 queryOptions —— 组件用 useMutation 包它。
 * token 只在这一次请求的 body 里出现,**绝不**写进 localStorage / URL / query key:
 * 会话 cookie 是 HttpOnly 的,正是为了让前端脚本(包括我们自己的)拿不到凭据。
 */
export function loginMutationFn(token: string): Promise<LoginResult> {
  return apiPost("/api/session/login", loginResultSchema, { token });
}

/** 登出:幂等,恒 200。失败不影响处置(见 AuthedLayout 的登出按钮注释)。 */
export function logoutMutationFn(): Promise<LoginResult> {
  return apiPost("/api/session/logout", loginResultSchema, {});
}

/**
 * 会话探针的读法(guard 与壳共用)。返回 `SessionView`,失败抛 ApiError。
 * 单独抽出来是为了让 `probeSession` 的注入点是函数而不是 QueryClient —— 纯判定的测试
 * 不需要造一个 QueryClient,只需要一个会抛的 promise。
 */
export function readSession(): Promise<SessionView> {
  return apiGet("/api/session/me", sessionSchema);
}
