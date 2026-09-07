/**
 * `/` 任务列表页(w3)的全部纯判定。
 *
 * 为什么单开一份而不是写进 `.tsx`:本仓的测试跑在 Workers 运行时里(无 DOM、无 jsdom),
 * 这一页**全部有判断力的部分**都是纯函数 —— URL 上那个串算不算合法 state、count 该怎么说、
 * 失败该说哪句话、id 截到哪一刀。留在 `.tsx` 里的那些(下拉的 onChange、表格实例的装配)
 * 只能由源码钉子 + 部署后浏览器冒烟覆盖,分工与 w2b 各页一致。
 *
 * ## 这一页读的是什么(所有文案的地基,别绕过去)
 *
 * `GET /api/admin/tasks`(`src/index.ts` 的 `handleAdminTasks`)是一份 **SQL 读投影**:
 *
 * ```sql
 * SELECT id, state, created_at, updated_at, version FROM tasks [WHERE state = ?]
 * ORDER BY updated_at DESC LIMIT ?
 * ```
 *
 * 三条后果,逐条决定了下面的文案:
 *
 * 1. **`count` 是本次返回的条数,不是表里的总匹配数** —— 服务端源码里就是
 *    `count: rows.results.length`,旁边那句注释写着「不是表里的总匹配数」。
 *    于是这一页永远不写「共 N 条」:`tasksReadNote` 只能说「本次读取 N 条」,
 *    外加一条真实可推的结论 —— 没读满 `limit` 就说明该条件下的行确实已读完。
 * 2. **没有游标、没有 offset、没有 total** —— 响应体里只有 `{tasks, count}` 两个键。
 *    「加载更多」与「页码」都需要的东西这里没有:没有可续读的位点(LIMIT 只能从头扫),
 *    也没有总数可以算页数。所以这一页**不放**任何翻页控件,读满上限时由文案说出读满了
 *    (`docs/product.md` §5 那行旧文案里的「游标『加载更多』」已按此作废,见同节的 w3 注记)。
 * 3. **数据源只有 D1 归档表** —— 归档只在任务进终态时发生,所以这里看不到仍在 DO 里跑的任务。
 *    它是复盘视图,不是实时看板(实时状态是 `GET /api/tasks/:id`,w4 那一页)。
 *    同一条理由也作废了旧文案里的「RUNNING 置顶」:这一页拿不到 RUNNING 的行。
 *
 * 把这三条写在这里而不是散在组件里,是因为它们互相咬合:一个「看起来人畜无害」的
 * `共 {count} 条` 就同时违反第 1 条与第 2 条,而那种改动在页面上比删一段逻辑更讨人喜欢。
 */

import { ApiError } from "./api";
import { TASKS_LIST_LIMIT } from "./queries";
import { tasksSearchSchema, type ArchivedTasks } from "./schema";
import { TASK_STATE_VALUES, type TaskStateValue } from "./view";

/** 校验后的过滤器结论。 */
export interface TasksFilter {
  /** 生效的过滤(`null` = 不带 state 参数)。送进服务端的只有这一个值,所以非法串不可能变成 400。 */
  readonly state: TaskStateValue | null;
  /**
   * URL 上写了、但被拒收的原值(`null` = 没写过 state,或写了空串)。
   *
   * 拒收之后**不**把地址栏改掉:那个串是操作员从别处贴过来的,留着才可核对;
   * 但页面必须说出「生效的是全部,而你写的那个没生效」—— 见 `tasksFilterFallbackCopy`。
   * 悄悄回退而不吭声,表现就是「我明明筛了 BLOCKED,为什么 DONE 也在里面」。
   */
  readonly rejected: string | null;
}

/**
 * 把 URL 输入解析成过滤器。接受 `URLSearchParams`、原始 query 串、Record 与任意垃圾。
 *
 * 两步 zod(先形状、再值域)而不是一步 `safeParse`:`tasksSearchSchema.safeParse({state:"X"})`
 * 整体失败时那个 "X" 就没了,而这一页要的恰恰是「把它钉在屏幕上」。值域的判定仍然完全
 * 交给 schema —— 这一份代码里没有第二处 `includes(...)` 清单。
 */
export function parseTasksFilter(raw: URLSearchParams | string | Record<string, unknown> | unknown): TasksFilter {
  const value = rawStateValue(raw);
  if (value === undefined) return { state: null, rejected: null };
  // 空串 = 「全部」:下拉框清除后就是这个值,与不写 state 同义,不是错误,所以不钉。
  if (value === "") return { state: null, rejected: null };
  const parsed = tasksSearchSchema.safeParse({ state: value });
  if (parsed.success && parsed.data.state !== undefined) return { state: parsed.data.state, rejected: null };
  return { state: null, rejected: rawStateText(value) };
}

/** 从三种输入里取 state 那一位(取不到键 = undefined;`state=` 空值 = "";重复键 = 数组)。 */
function rawStateValue(raw: URLSearchParams | string | Record<string, unknown> | unknown): unknown {
  if (raw instanceof URLSearchParams) return pickState(raw);
  if (typeof raw === "string") return pickState(new URLSearchParams(raw));
  if (typeof raw === "object" && raw !== null) return (raw as Record<string, unknown>).state;
  return undefined;
}

/**
 * 一个 query 串里 `state` 那一位。
 *
 * 重复键**不**取第一个:`?state=DONE&state=x` 里取 DONE 就是「部分采纳」——
 * 同一条链接经由另一条输入形状(TanStack 解出来的数组)进同一个函数时却会被拒收,
 * 两份结论迟早分家。数组交给 rawStateText 整串钉在提示上。
 */
function pickState(params: URLSearchParams): unknown {
  const all = params.getAll("state");
  if (all.length === 0) return undefined;
  return all.length === 1 ? all[0] : all;
}

/**
 * 被拒收的原值怎么写给人看。
 * 重复键(`?state=A&state=B`)与数组形状在这里收成一行可照抄的串,而不是显示 `[object Object]`
 * —— 那串东西出现在提示里,操作员会以为是页面自己坏了。
 */
function rawStateText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => String(item)).join(",");
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return "(形状不合)";
}

/** 过滤器下拉的一项:`value` 是服务端认得的串("" = 全部),`label` 只给人看。 */
export interface StateFilterOption {
  readonly value: string;
  readonly label: string;
}

/**
 * 下拉的取值 = `""`(全部)+ `TASK_STATE_VALUES` 全集,顺序照状态机的推进顺序。
 *
 * 不提供「本页觉得没用的状态」黑名单:合法与否只有服务端那一份判据,前端替它删项
 * 就是在自己的副本上另立权威 —— 而归档写路径将来若变了(比如 w5 让待审批也归档),
 * 被删掉的那一项会静默筛不出东西。读不到的原因由文案负责(`tasksEmptyText`)。
 */
export const STATE_FILTER_OPTIONS: readonly StateFilterOption[] = [
  { value: "", label: "全部" },
  ...TASK_STATE_VALUES.map((state) => ({ value: state, label: state })),
];

/** 被拒收的 state:页面上怎么说。含「地址栏为什么还是原样」。 */
export function tasksFilterFallbackCopy(rejected: string): string {
  return (
    `URL 里的 state=${rejected} 不是合法取值,本次按「全部」读取。` +
    `地址栏保留原值不动(便于核对贴过来的链接),改过滤条件即覆盖它;合法取值见 state 下拉。`
  );
}

/**
 * count 那句话。**唯一**允许出现条数的出口,措辞由 §5 的诚实口径直接决定:
 * 未读满 → 该条件下的行确实读完了(这是从 `LIMIT n` 的语义**推得出**的结论,不是猜的);
 * 读满 → 只说读满了,不承诺后面还有什么。
 */
export function tasksReadNote(tasks: ArchivedTasks | undefined): string | null {
  if (tasks === undefined) return null;
  if (tasks.count >= TASKS_LIST_LIMIT) {
    return (
      `本次读取 ${tasks.count} 条,已到服务端上限 limit=${TASKS_LIST_LIMIT}:后面是否还有没有读到的行,` +
      `这一页不知道,也没有可续读的游标 —— 所以这里不放「加载更多」。要缩范围请用 state 过滤。`
    );
  }
  return `本次读取 ${tasks.count} 条(未到 limit=${TASKS_LIST_LIMIT},该过滤条件下的归档行已全部读到)。`;
}

/**
 * 空态文案。与失败态必须分得开:「确实没有」与「没读到」是两个结论。
 *
 * `failed = true` 那一支不是修辞:react-query 失败时**留着**上一次的数据(有数据就不显示空态),
 * 但一旦上次是 0 行、这次失败,表格里那格空态就会被读成「筛出来是空的」——
 * 而真实情况是「这一页现在什么都不知道」。空表格与断连在肉眼里有同一张脸,所以这里必须换话。
 */
export function tasksEmptyText(state: TaskStateValue | null, failed = false): string {
  if (failed) return "上一次读取失败了(原因见上),所以「没有行」这个结论此刻不成立。";
  if (state === null) {
    return "归档表里一行都没有:还没有任务走到终态并归档。仍在运行的任务不会出现在这一页(实时状态看 GET /api/tasks/:id)。";
  }
  return `state=${state} 的归档行:本次一条都没读到。这一页只读 D1 归档投影,没读到不等于平台里没有这种状态的任务。`;
}

/** 不是 ApiError 的意外异常(组件里的 bug、React 自己抛的):不许伪装成服务端答复。 */
export const TASKS_FAILURE_UNEXPECTED = "任务列表没读出来:页面这边出了意外错误,不是服务端的答复。";

/**
 * 失败文案:四种失败种类四种说法。
 *
 * 与 /login 恰好相反 —— 那里「不区分」是因为它是**门前**的端点,每种分支都是白嫖的 oracle
 * (docs/product.md §5)。这一页在门内,读的人是操作员本人,分岔只会省他一次抓包:
 * - `shape` 直接指 §7 头号风险(`run_worker_first` 漏列 → API 被 SPA 兜底吞成 HTML);
 * - `network` 明说「这不是没有任务」,否则空表格与断连在肉眼里有同一张脸;
 * - `http` 带 status 与服务端的 `error.type`(`invalid_state` 之类一旦出现就说明门被绕过了,
 *   那必须是这一页最显眼的字,而不是被咽进一个通用文案里)。
 * 逐条都有代价:文案更长。换来的是故障当场可归因。
 */
export function tasksFailureText(err: unknown): string {
  if (!(err instanceof ApiError)) return TASKS_FAILURE_UNEXPECTED;
  const failure = err.failure;
  switch (failure.kind) {
    case "unauthorized":
      return "会话已失效:这一页读不到数据。重新登录后再试(顶栏右侧那一位会显示会话状态)。";
    case "http":
      return `服务端答复 ${failure.status}${failure.errorType === null ? "" : `(${failure.errorType})`}:任务列表没读出来。`;
    case "network":
      return "请求没有送达:服务不可达或网络中断。这不是「没有任务」。";
    case "shape":
      return `响应不是可读的 JSON(${failure.detail}):先查 wrangler 的 run_worker_first 是否盖住了 /api/*。`;
  }
}

/**
 * 数据源说明里指向详情页的那半句。页面括号里的**时态**也是投影的一部分:
 * 2026-09-07 操作员浏览器走查抓到旧文案仍写「详情页由 w4 接入」,而详情页已由 w4a
 * 上线 —— 将来时假话与假数据一样会让人不再相信这一页。钉在 test/web-tasks-page.test.ts。
 */
export function taskDetailNote(): string {
  return "详情页 /tasks/<taskId> 已上线(w4a)";
}

/** id 列的截断宽度:UUID 的首段(8 个 hex)足以肉眼区分,剩下的靠 title。 */
export const TASK_ID_VISIBLE_CHARS = 8;

/**
 * id 列的显示值。`full` 必须回到 DOM(`title`),否则「筛到一行、想拿 id 去 curl」这条
 * 主路径就断了 —— 截断是排版手段,不是信息的删除。
 */
export function truncateTaskId(id: string): { shown: string; full: string } {
  if (id.length <= TASK_ID_VISIBLE_CHARS) return { shown: id, full: id };
  return { shown: `${id.slice(0, TASK_ID_VISIBLE_CHARS)}…`, full: id };
}
