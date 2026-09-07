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
import { apiGet, apiPost, ApiError } from "./api";
import {
  archivedTasksSchema,
  candidateViewSchema,
  loginResultSchema,
  sessionSchema,
  taskEventsPageSchema,
  taskEvidenceSchema,
  taskSnapshotSchema,
  type ArchivedTasks,
  type CandidateView,
  type LoginResult,
  type SessionView,
  type TaskEventsPage,
  type TaskEvidence,
  type TaskSnapshot,
} from "./schema";
import type { TaskStateValue } from "./view";

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

/**
 * 归档任务列表的端点路径。角标(w2b)与列表页(w3)共用这一份字面量 ——
 * 两处各写一遍,迟早有一处少掉 `/api` 前缀,而那正是 §2 分区表最怕的那类漂移。
 */
const ADMIN_TASKS_PATH = "/api/admin/tasks";

export function awaitingApprovalQueryOptions() {
  return queryOptions({
    queryKey: APPROVALS_KEY,
    queryFn: () =>
      apiGet(
        `${ADMIN_TASKS_PATH}?state=${AWAITING_APPROVAL_STATE}&limit=${AWAITING_APPROVAL_LIMIT}`,
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
 * `/` 任务列表(w3)的查询。
 *
 * 三条与角标同源的纪律,加两条只有列表才会踩的:
 * - **key 含 state**:换过滤条件就是换一份缓存。少了这一位,筛 BLOCKED 会直接读到 DONE
 *   那一份缓存里的行 —— 那是「筛了但没筛」,比慢更糟。
 *   `rejected`(URL 上被拒收的原值)**不进** key:两个不同的坏链接指向的是同一份「全部」,
 *   各算一份缓存就等于按输入字符串给同一数据开分号(钉在 test/web-tasks-page.test.ts)。
 * - **不复用角标那一条 key**:两者的生命周期不同 —— 角标挂在壳上跨页常驻,列表只在 `/`
 *   存在。合并成一条会让其中一方的 staleTime 说了算。共同前缀 `["admin","tasks"]` 保住,
 *   要整体清的时候一次清得掉。
 * - **30s refetchInterval**(§5 给这一页定的节拍,角标抄的就是它)。这是一页轮询而不是
 *   实时:数据源是归档表,不是事件流(增量流不进 Query 缓存,§4)。
 * - `retry: false`:与 session 查询同一条理由 —— 401 不会因为重试变 200,而失败文案
 *   (`lib/tasks-page.ts` 的 `tasksFailureText`)本来就说得出四种失败,早三秒说比转圈好。
 */
export const ADMIN_TASKS_KEY = ["admin", "tasks"] as const;

/**
 * 列表的读取上限 = 服务端 `parseAdminLimit` 的上限 200(再大直接 400)。
 * 与角标同一个数不是巧合,是同一条边界;两处各写一遍迟早一个是 500。
 */
export const TASKS_LIST_LIMIT = 200;

export function adminTasksQueryKey(state: TaskStateValue | null) {
  return [...ADMIN_TASKS_KEY, "list", state ?? "all"] as const;
}

/**
 * 实际请求的 URL。`state` 为 `null` 时**一个 `state=` 都不带** ——
 * 服务端对 `state=""` 回 400(空串不在状态机取值里),所以「全部」必须是缺键,不能是空值。
 */
export function adminTasksUrl(state: TaskStateValue | null): string {
  const query = state === null ? `limit=${TASKS_LIST_LIMIT}` : `state=${state}&limit=${TASKS_LIST_LIMIT}`;
  return `${ADMIN_TASKS_PATH}?${query}`;
}

/**
 * 一次列表读取。与 `readSession` 同一条理由单独抽出来:注入点是一个函数而不是 QueryClient,
 * 于是 test/web-tasks-page.test.ts 可以直接调它并断言真正发出去的 URL(不带 state 那一支
 * 只能这样测出来 —— 那是「全部」与「400」的分界)。
 */
export function fetchAdminTasks(state: TaskStateValue | null): Promise<ArchivedTasks> {
  return apiGet(adminTasksUrl(state), archivedTasksSchema);
}

export function adminTasksQueryOptions(state: TaskStateValue | null) {
  return queryOptions({
    queryKey: adminTasksQueryKey(state),
    queryFn: () => fetchAdminTasks(state),
    refetchInterval: 30_000,
    staleTime: 10_000,
    retry: false,
  });
}

/**
 * `/tasks/$taskId` 详情上半(w4a)的读取。
 *
 * 两条端点各管一件事,分工是这一页的全部结构:
 * - **快照**(`GET /api/tasks/:id`)= TaskSession DO 的权威状态,进 Query 缓存:它是一份
 *   按 key 覆盖的快照,正是 Query 的模型。
 * - **补齐**(`GET /api/tasks/:id/events?after=`)= 同一份 R2 journal 的**增量读法**,
 *   刻意**不进** Query(§4 那条纪律在拉取这一侧同样成立):它的进度是「已读条数」,
 *   缓存一份会随续读点变化的列表等于制造第二个真值来源。接线在
 *   `lib/use-task-timeline.ts`,判据与翻页全在 `lib/task-detail.ts`。
 */
export const TASK_SNAPSHOT_KEY = ["task"] as const;

export function taskSnapshotQueryKey(taskId: string) {
  return [...TASK_SNAPSHOT_KEY, taskId] as const;
}

/**
 * 任务级路径的唯一拼法。`encodeURIComponent` 不是防御性花活:`taskId` 来自 URL 参数,
 * 里面出现 `/` 就会把这条请求送到另一个端点上去(而页面还会拿到一份「合法形状」的答复
 * 去渲染另一个任务)。id 的**合法性**本身仍归服务端判(`TASK_ID_RE`,畸形即 404)。
 */
export function taskPath(taskId: string): string {
  return `/api/tasks/${encodeURIComponent(taskId)}`;
}

export function taskSnapshotUrl(taskId: string): string {
  return taskPath(taskId);
}

/**
 * SSE 的 URL。**这一条路径字面量是 §2 分区表在前端一侧的落点**:worker 侧那份由
 * test/api-prefix.test.ts 钉住以 `/api/` 开头,这里这一份由 test/web-task-detail.test.ts
 * 拿真 worker 打出 200 + text/event-stream 钉住。两边都断了才算两边都不漂。
 */
export function taskStreamUrl(taskId: string): string {
  return `${taskPath(taskId)}/events/stream`;
}

export function fetchTaskSnapshot(taskId: string): Promise<TaskSnapshot> {
  return apiGet(taskSnapshotUrl(taskId), taskSnapshotSchema);
}

/**
 * 任务快照的查询。
 *
 * - **没有 `refetchInterval`**:这一页的实时性是**推**来的(§4:SSE 是这一页的当前数据源),
 *   再挂一个轮询节拍就是给同一个问题第二个答案 —— 而 w2b 给角标与列表定过的那条纪律
 *   (「两套刷新率必然互相矛盾」)在这里同样成立。推进快照的时机只有一个,而且是事件驱动的:
 *   收到 `end` 帧(它只证明「已非 RUNNING」,精确终态必须由这条端点回答)。
 * - `retry: false`:与列表同一条理由 —— 401 不会因为重试变 200,而失败文案本来就说得出
 *   四种失败,早一点说比转圈好。
 * - `staleTime` 30s:同一任务被来回导航(列表 → 详情 → 列表 → 详情)时不必每次重读 DO,
 *   但也别更久:头部那个 state 是操作员判断「要不要动手」的依据。
 */
export function taskSnapshotQueryOptions(taskId: string) {
  return queryOptions({
    queryKey: taskSnapshotQueryKey(taskId),
    queryFn: () => fetchTaskSnapshot(taskId),
    staleTime: 30_000,
    retry: false,
  });
}

/**
 * 补齐一页的条数。取服务端 `DEFAULT_OBS_LIMIT` 同一档(500):上限是 2000,再大它回 400,
 * 而一次补齐要拉的是「流没送到的那一段」,不是一整份 journal。
 */
export const TASK_EVENTS_PAGE_LIMIT = 500;

/**
 * 一次补齐读。`after` 是**扁平流里已读的条数**,不是事件的 `seq` ——
 * 判据与理由逐字照 `src/index.ts` 的 `parseObsAfter` 注释(seq 只在 attempt/generation
 * 内单调,拿它当跨 attempt 游标会静默漏读)。
 * `after=0` 与「不带 after」同义(服务端缺省 0);空值 `?after=` 服务端判非法回 400,
 * 所以这里绝不允许把空串或不确定的数拼上去 —— 见 `lib/task-detail.ts` 的 runEventsPull。
 */
export function taskEventsUrl(taskId: string, after: number): string {
  return `${taskPath(taskId)}/events?after=${after}&limit=${TASK_EVENTS_PAGE_LIMIT}`;
}

export function fetchTaskEvents(taskId: string, after: number): Promise<TaskEventsPage> {
  return apiGet(taskEventsUrl(taskId, after), taskEventsPageSchema);
}

/**
 * `/tasks/$taskId` 下半三块(w4b)的读法。与快照同一个派生点(taskPath),key 各自独立:
 * 三块的失败互不拖累(坏帧纪律在取数侧的同一条),合并 key 会把一方的失败判死另两块。
 * `staleTime` 与快照同档(30s),**没有** `refetchInterval`:这三块的实时性同样来自
 * 事件驱动的快照失效(end 帧 → invalidate 快照),不给这一页加第四个节拍。
 */

export function taskEvidenceQueryKey(taskId: string) {
  return [...TASK_SNAPSHOT_KEY, taskId, "evidence"] as const;
}

export function taskEvidenceUrl(taskId: string): string {
  return `${taskPath(taskId)}/evidence`;
}

export function fetchTaskEvidence(taskId: string): Promise<TaskEvidence> {
  return apiGet(taskEvidenceUrl(taskId), taskEvidenceSchema);
}

export function taskEvidenceQueryOptions(taskId: string) {
  return queryOptions({
    queryKey: taskEvidenceQueryKey(taskId),
    queryFn: () => fetchTaskEvidence(taskId),
    staleTime: 30_000,
    retry: false,
  });
}

export function candidateQueryKey(taskId: string) {
  return [...TASK_SNAPSHOT_KEY, taskId, "candidate"] as const;
}

export function candidateUrl(taskId: string): string {
  return `${taskPath(taskId)}/candidate`;
}

export function fetchCandidateView(taskId: string): Promise<CandidateView> {
  return apiGet(candidateUrl(taskId), candidateViewSchema);
}

export function candidateQueryOptions(taskId: string) {
  return queryOptions({
    queryKey: candidateQueryKey(taskId),
    queryFn: () => fetchCandidateView(taskId),
    staleTime: 30_000,
    retry: false,
  });
}

export function candidatePatchUrl(taskId: string): string {
  return `${taskPath(taskId)}/candidate?format=patch`;
}

/** 裸读的答复:status + 原始 body。怎么解释是 lib/task-deliverables.ts 的事。 */
export interface RawResponse {
  readonly status: number;
  readonly body: string;
}

/**
 * patch 正文是 text/plain:apiRequest 的介质检查会把它判成 shape 失败(api.ts 规矩 3),
 * 所以这是全 queries.ts 唯一一条绕过它的读法 —— 拿回原始字节,判定交给
 * `judgePatchResponse`(纯函数可测)。网络层异常照 apiRequest 同一条口径包成
 * ApiError network;abort 原样上抛。错误体(JSON)与 200 体(字节流)两种介质都按
 * 文本读,「能不能解」由判定层处理。
 */
export async function fetchCandidatePatchRaw(
  taskId: string,
  signal?: AbortSignal,
): Promise<RawResponse> {
  let res: Response;
  try {
    res = await fetch(candidatePatchUrl(taskId), {
      headers: { accept: "text/plain" },
      credentials: "same-origin",
      signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiError({ kind: "network" }, candidatePatchUrl(taskId));
  }
  const body = await res.text().catch(() => "");
  return { status: res.status, body };
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
