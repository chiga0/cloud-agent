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

/** SSE `event: end` 帧的 data 体(src/obs/stream.ts `obsSseEndFrame`)。 */
export const streamEndSchema = z.object({
  v: z.number(),
  task_id: z.string(),
  events: z.number(),
  unreadable_attempts: z.array(z.string()),
});

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
