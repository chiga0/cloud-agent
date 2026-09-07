/**
 * 响应契约与 search 参数的运行时校验(w2b,zod 的两个用武之地)。
 *
 * 这里只放**形状**,不放业务判定:哪些 state 算异常、停滞多久算红,权威在
 * `src/control/statemachine.ts` 与 `src/supervisor/detect.ts`(§1 的不变量:前端是投影)。
 *
 * 每条 schema 都是对 `src/index.ts` 里那个 handler 的**转写**,不是发明。字段清单以
 * 服务端为准,少写一个字段无所谓(`.object` 默认剥掉未知键),多写一个字段就是假契约 ——
 * 那条 `required` 字段后端从来没有发过,页面会整页红在解析上。故每份 schema 上方注明出处。
 *
 * `id` 用 `z.string()` 而不是 UUID 正则:前端不复核后端已经复核过的东西
 * (`TASK_ID_RE` 在入口就挡了畸形 id),在这里再钉一遍只会多一处要同步的真相。
 */

import { z } from "zod";

import { TASK_STATE_VALUES } from "./view";

/** GET /api/session/me(src/index.ts `handleSessionMe`)。`expires_at` 仅 cookie 凭据时有值。 */
export const sessionSchema = z.object({
  authenticated: z.literal(true),
  credential: z.enum(["bearer", "cookie"]),
  expires_at: z.string().nullable(),
});
export type SessionView = z.infer<typeof sessionSchema>;

/**
 * POST /api/session/login 与 /logout 共用的成功答复(登录失败一律 401,由客户端归成
 * unauthorized;登出则无条件幂等恒 200 —— 两个端点答的是同一个形状)。
 */
export const loginResultSchema = z.object({ ok: z.literal(true) });
export type LoginResult = z.infer<typeof loginResultSchema>;

/**
 * GET /api/admin/tasks(src/index.ts `handleAdminTasks`)。
 * `count` 是**本次返回条数**(受 limit 截断),不是总匹配数 —— 服务端注释与 README 同口径。
 * 状态用 `z.string()` 而不是枚举:状态机的取值集权威在 worker 侧,前端枚举一份迟早少一个;
 * 未知状态照样渲染,只是落到中性徽章(见 lib/view.ts 的 `stateTone`)。
 */
export const archivedTaskSchema = z.object({
  id: z.string(),
  state: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  version: z.number(),
});
export const archivedTasksSchema = z.object({
  tasks: z.array(archivedTaskSchema),
  count: z.number(),
});
export type ArchivedTask = z.infer<typeof archivedTaskSchema>;
export type ArchivedTasks = z.infer<typeof archivedTasksSchema>;

/**
 * SSE `event: agent` 帧的 data 体 = AgentEventV1 信封(src/obs/events.ts)。
 *
 * `v` 用 `z.number()` 而非 `z.literal(1)`:信封演进时老页面必须先能读懂新帧才继续盯停滞
 * (live.ts 的同一条纪律)。真正必须有的是 `kind: string` —— 它是徽章与心跳判定的唯一依据。
 * `payload` 刻意 `z.unknown()`:它的字段是白名单后的异构对象(按 kind 不同),逐 kind 建 schema
 * 是 w4 时间线的事,现在建了也没人消费。
 */
export const streamEventSchema = z.object({
  v: z.number(),
  task_id: z.string(),
  attempt_id: z.string(),
  generation: z.number(),
  seq: z.number(),
  ts: z.string(),
  kind: z.string(),
  payload: z.unknown(),
});
export type StreamEvent = z.infer<typeof streamEventSchema>;

/**
 * SSE `event: end` 帧的 data 体(src/obs/stream.ts `obsSseEndFrame`)。
 */
export const streamEndSchema = z.object({
  v: z.number(),
  task_id: z.string(),
  events: z.number(),
  unreadable_attempts: z.array(z.string()),
});

/**
 * GET /api/tasks/:id(src/index.ts `handleGetTask` → `TaskSession.getSnapshot()`)。
 *
 * 逐字段照 `src/control/session.ts:1656` 的那个返回类型转写:`{task, attempts[], events[]}`,
 * 其中 `task` 是 `interface TaskRecord` 的展开(`{...s.task}`,**全部**字段都在这条端点上,
 * 包括 `spec` 原文与 `result_text`),`attempts` 是**六列**的 Pick,`events` 是 DO 审计链行
 * (注意 `payload` 在这里是**字符串** —— getSnapshot 里写的是 `JSON.stringify(e.payload)`)。
 *
 * required 的只有五个一定有值可渲染的字段,其余全部 `.optional()`:
 * `TaskRecord` 的注释明写「M8 前的老记录没有 `base` 这个字段」——那是**缺键**而不是 null,
 * 把它写成 required 就是发明一条后端没发过的契约,后果是整个头部红在解析上。
 * 少声明一个字段无所谓(`.object` 剥掉未知键),多声明一个才是假契约。
 * 这份取舍由 test/web-task-detail.test.ts 拿真端点的返回值对表钉住。
 */
export const taskBaseSchema = z.object({
  sha: z.string(),
  /** `BaseSource`:材质化来源(pinned / 默认分支 HEAD / …)。前端不枚举:它只是 title 里的一行字。 */
  source: z.string(),
});

/** `interface CurrentEvidence`:审批绑定与 `/evidence` 的唯一口径。 */
export const currentEvidenceSchema = z.object({
  writer_attempt_id: z.string(),
  writer_manifest_key: z.string(),
  writer_manifest_digest: z.string(),
  verifier_attempt_id: z.string().optional(),
  verifier_manifest_digest: z.string().optional(),
});

export const taskRecordSchema = z.object({
  id: z.string(),
  state: z.string(),
  version: z.number(),
  created_at: z.string(),
  updated_at: z.string(),
  spec: z.string().optional(),
  spec_digest: z.string().optional(),
  result_text: z.string().nullable().optional(),
  next_seq: z.number().optional(),
  archived: z.boolean().optional(),
  pending_review: z.boolean().optional(),
  pending_verify: z.boolean().optional(),
  awaiting_human: z.boolean().optional(),
  review_evidence_mode: z.string().optional(),
  base: taskBaseSchema.nullable().optional(),
  last_candidate_digest: z.string().nullable().optional(),
  current_evidence: currentEvidenceSchema.nullable().optional(),
  archive_retry_step: z.number().optional(),
});
export type TaskRecordView = z.infer<typeof taskRecordSchema>;

/** `getSnapshot()` 的 attempts 那一列集合(六列,不多不少 —— 这条由测试逐字钉)。 */
export const taskAttemptSchema = z.object({
  id: z.string(),
  role: z.string(),
  state: z.string(),
  tokens_used: z.number(),
  created_at: z.string(),
  finished_at: z.string().nullable(),
});
export type TaskAttemptView = z.infer<typeof taskAttemptSchema>;

/** DO 审计链的一行(hash chain 成员,与 `GET /api/admin/events` 的归档投影同源)。 */
export const taskAuditEventSchema = z.object({
  seq: z.number(),
  kind: z.string(),
  payload: z.string(),
  digest: z.string(),
  prev_digest: z.string().nullable(),
  created_at: z.string(),
});

export const taskSnapshotSchema = z.object({
  task: taskRecordSchema,
  attempts: z.array(taskAttemptSchema),
  events: z.array(taskAuditEventSchema),
});
export type TaskSnapshot = z.infer<typeof taskSnapshotSchema>;

/**
 * GET /api/tasks/:id/events(src/index.ts `handleGetTaskEvents`)。
 *
 * 两件事是刻意的,都不是省事:
 *
 * 1. **`events` 是 `z.array(z.unknown())`,不是 `z.array(streamEventSchema)`**。
 *    后者会让**一条**读不懂的事件把**整页**判成 `shape` 失败,而这一页的纪律是「一条坏帧
 *    绝不能停更整页」(§5 的 c9b 清单)。逐条解析交给 `lib/task-detail.ts` 的
 *    `pulledEventAt`,读不懂的计数并跳过,同页其余照收。
 * 2. **`next_cursor` 不声明**。服务端给的是 `next_cursor: more ? after + events.length : null`,
 *    与本页要算的「还有没有更多」是同一个式子(`pullHasMore` = `after + count < total`)。
 *    声明它就得读它,而读一个能由 count/total **推出**的字段等于给同一件事开第二个真值来源;
 *    更要紧的是 `test/web-frontend-contract.test.ts` 把分页那套 API 钉成反向钉子,
 *    这一页用的是位置续读,不需要那个名字。
 */
export const taskEventsPageSchema = z.object({
  task_id: z.string(),
  state: z.string(),
  events: z.array(z.unknown()),
  count: z.number(),
  total: z.number(),
  unreadable_attempts: z.array(z.string()),
});
export type TaskEventsPage = z.infer<typeof taskEventsPageSchema>;

/**
 * search 参数的运行时校验。
 *
 * 这一份是**必须有**的:URL 是用户可编辑输入(也是别人发出去的链接),而路由的 loader 与
 * 组件都按校验后的类型写代码。`validateSearch` 里绝不抛错 —— TanStack 会在**每次导航**上
 * 调它,抛出等于把一个打错的链接变成白屏;非法值一律退回缺省,页面照常渲染。
 * 唯一例外是 `next`:它退回 undefined(= 登录后去 `/`),不照抄非法值,理由见 nav.ts。
 */
export const loginSearchSchema = z.object({
  next: z.string().optional(),
});
export type LoginSearch = z.infer<typeof loginSearchSchema>;

/**
 * `/` 任务列表(w3)的 search 契约:只有 `state` 一条。
 *
 * 值域直接取 `lib/view.ts` 的 `TASK_STATE_VALUES`,与色调表同一个键域(那份注释写了为什么
 * 共用一份)。这条枚举不是装饰:`handleAdminTasks` 对不认识的 state 直接回 400,
 * 而一个能被 URL 决定的 400 就是一个可以被分享出去的坏链接 —— 门在这里关,
 * 而不是把猜测的串转给服务端去拒。
 *
 * `limit` **刻意不是** search 参数:它是本页的读取上限(固定在
 * `lib/queries.ts` 的 `TASKS_LIST_LIMIT`),写进 URL 等于向操作员承诺一个可以自己调大的
 * 读取面,而调过 200 服务端就回 400。服务端也没有游标可读 —— 见 `lib/tasks-page.ts` 顶部。
 */
export const tasksSearchSchema = z.object({
  state: z.enum(TASK_STATE_VALUES).optional(),
});
export type TasksSearch = z.infer<typeof tasksSearchSchema>;

/**
 * 从未知输入里取出**合法**的 search。签名接受 `URLSearchParams` 与 Record 两种:
 * 路由的 `validateSearch` 缺省给我们的是已按 `parseSearchWith` 解开的 Record,
 * 而测试与手写入口可能直接给 searchParams。
 */
export function parseSearch<S extends z.ZodType>(
  schema: S,
  raw: URLSearchParams | Record<string, unknown> | unknown,
): z.output<S> {
  const input =
    raw instanceof URLSearchParams
      ? Object.fromEntries(raw.entries())
      : typeof raw === "object" && raw !== null
        ? (raw as Record<string, unknown>)
        : {};
  const parsed = schema.safeParse(input);
  // 失败退回 `{}` 而不是照抄输入:schema 的 `.optional()`/`.default()` 负责补全缺省,
  // 组件因此永远拿到符合类型的对象,拿不到半条用户手写的键值。
  return (parsed.success ? parsed.data : {}) as z.output<S>;
}
