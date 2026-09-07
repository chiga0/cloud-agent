/**
 * `/tasks/$taskId` 上半(w4a)的全部纯判定。
 *
 * 与 `lib/tasks-page.ts` 同一分工:这一页**有判断力的部分**全是可测的纯函数,`.tsx` 与
 * `use-task-timeline.ts` 只留接线。本仓的测试跑在 Workers 运行时里(没有 DOM、没有
 * `EventSource`),留在组件里的那一半只能由源码钉子 + 部署后浏览器冒烟覆盖。
 *
 * ## 这一页读的是什么(每一句话的地基)
 *
 * `GET /api/tasks/:id`(`src/index.ts` 的 `handleGetTask`)是 **TaskSession DO 的只读快照**:
 * `Response.json(await TaskSession.from(env, id).getSnapshot())`,不存在即 404
 * `{error:{type:"not_found"}}`。所以 `lib/schema.ts` 的 `taskSnapshotSchema` 是对那个返回值的
 * **转写**,不是发明 —— 字段清单以 `src/control/session.ts` 的 `getSnapshot()` 与
 * `interface TaskRecord` 为准,逐条都在 `test/web-task-detail.test.ts` 里拿真端点跑过一遍。
 *
 * ## 三条与「头部」有关的硬事实
 *
 * 1. **预算的上限读不到**。`getSnapshot()` 的 attempts 是
 *    `Pick<AttemptRecord, "id"|"role"|"state"|"tokens_used"|"created_at"|"finished_at">`
 *    —— 六列,`max_wall_seconds` 与 `max_model_tokens` **不在这条端点上**。含这两个字段的
 *    读投影只有 `GET /api/admin/attempts`,而它读 D1 终态归档:在跑的任务那里没有行。
 *    于是这一页的「预算」只敢呈现两件有出处的东西:实际用量(`tokens_used` 之和)与
 *    链上留痕的夹钳事件(`budget.clamped`,只在真被夹时才有)。上限缺失由 `budgetFacts`
 *    的 `boundary` 那句话明说,而不是留一个空格让人以为是 0(§1 的不变量:前端是投影,
 *    投影不许补一个服务端没给的数)。
 * 2. **base sha 与 digest 是任务级权威**。`task.base` 是「本任务所有候选共同冻结的基线」,
 *    M8 前的老记录**没有这个字段**(不是 null,是缺键 —— 所以 schema 里它是 optional),
 *    其候选按「基线未固定」对待。`last_candidate_digest` 与 `current_evidence` 同理。
 *    读不到就说「未记录/未固定」,不猜一个。
 * 3. **404 与读取失败是两句话**,而且都不是「这个任务没有内容」。`detailFailureText` 逐条
 *    分开:404 说的是「这个 id 没有对应的任务」,`network`/`shape`/`unauthorized` 各自说
 *    「现在不知道」。空表格与断连在肉眼里有同一张脸(w3 的同一条教训)。
 *
 * ## 两条恢复源怎么互为备份(交付 ④)
 *
 * `src/index.ts` 的 `parseObsAfter` 注释是这个问题的唯一权威:
 * **`after` 是「扁平有序流里已读过的条数」,不是事件自带的 `seq`** —— seq 只在
 * (attempt, generation) 内单调,拿它当跨 attempt 的游标会出现「在 attempt2 上 `after=50`
 * 把 attempt1 的前 50 条之后全部漏掉」的荒谬结果。SSE 的帧 `id` 与这个 `after` 同口径
 * (`src/obs/stream.ts` 不变量 1),所以:
 * - **拉→推**:补齐读到一半断了,浏览器带 `Last-Event-ID` 重连(那一位正是已读条数);
 * - **推→拉**:流断了浏览器不再重连(readyState=CLOSED)、或流上有读不懂的帧留下空洞、
 *   或 `end` 帧报的总条数超出已渲染的覆盖率 —— 这三种形状都由 `GET /events?after=` 补读,
 *   一页一页翻到服务端说没有更多为止(`pullHasMore`)。
 * 两个通道的覆盖率各自记账,合并在 `mergeTimeline` 一处做,**不靠位置对齐**:补齐通道的每条
 * 事件位置 = `after + 下标 + 1`(服务端自己定义的位置),流通道的条目位置 = 「已收帧数」,
 * 而后者在有坏帧时会漂移(哪一帧坏了我们读不出来,所以不知道它占哪个位置)。既然位置不能
 * 全局对齐,合并判据就用内容键(`eventKey`)而不是位置:补齐段整段留下(它是位置最可信的
 * 一条腿),流段里与补齐段同内容的条目丢掉,剩下的按到达序接在后面。
 * 代价要说清:两条**完全同内容**的事件(同 seq、同 ts、同 kind、同 payload)会被并成一条 ——
 * 那种输入在两个 attempt 的同一瞬间摄取同一行文本时才会出现,而计数行 (`streamCountsText`)
 * 仍按两个通道各自的口径如实报数,所以「少一行重复」不会伪装成「少一批事件」。
 */

import { ApiError } from "./api";
import { fetchTaskEvents, taskEventsUrl } from "./queries";
import { streamEventSchema, type TaskEventsPage, type TaskSnapshot } from "./schema";
import { STREAM_EVENT_BUFFER_LIMIT } from "./use-event-stream";
import { kindBadgeClass, summarize, textOf, totalTokensOf, type Tone } from "./view";

/** 事件在时间线上的一行。`position` = 扁平流里的位置(`null` = 只有流通道知道它是「第几条增量」)。 */
export interface TimelineEntry {
  readonly key: string;
  readonly position: number | null;
  readonly seq: number;
  readonly ts: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly source: "pull" | "stream";
}

/** 补齐通道的一段可读事件(位置已按服务端口径算好)。 */
export interface PulledEvent {
  readonly position: number;
  readonly seq: number;
  readonly ts: string;
  readonly kind: string;
  readonly payload: unknown;
}

/**
 * `budget.clamped` 的 kind 名。权威是 `src/control/budget.ts` 的 `BUDGET_CLAMP_EVENT_KIND`
 * (那份在 worker 侧,不能进前端 bundle),这里是一份副本 —— 与 `lib/kinds.ts` 同一套机制:
 * `test/web-task-detail.test.ts` 拿权威逐字比对,改了后端忘了前端就在这里红。
 */
export const BUDGET_CLAMP_KIND = "budget.clamped";

/** 补齐通道的读取状态。全部字段不可变:它是渲染输入,就地改会让「哪一次读改的」查不出来。 */
export interface PullState {
  /** 补齐通道自己覆盖到的条数 = 下一次请求的 `after`。 */
  readonly pulled: number;
  readonly items: readonly PulledEvent[];
  /** 最近一次答复报的总条数(`null` = 还没有答复过)。 */
  readonly total: number | null;
  readonly requests: number;
  /** 补齐通道里读不懂的事件条数(单条坏形状不许报废整页,见 `pulledEventAt`)。 */
  readonly bad: number;
  readonly unreadable: readonly string[];
  /** 服务端说「这一段之后没有了」。 */
  readonly exhausted: boolean;
  /** 失败文案(`null` = 没失败过)。与「没有更多」分开:两种空是不同结论。 */
  readonly failure: string | null;
}

export const INITIAL_PULL: PullState = {
  pulled: 0,
  items: [],
  total: null,
  requests: 0,
  bad: 0,
  unreadable: [],
  exhausted: false,
  failure: null,
};

/**
 * 这一次答复之后还有没有更多。
 *
 * 判据是 `after + count < total`,**不是**「有没有 next_cursor」:服务端给的就是
 * `next_cursor: more ? after + events.length : null`(src/index.ts 的 handleGetTaskEvents),
 * 所以这一个式子与那个字段同值,而前端不必再抄一份字段名当权威。
 */
export function pullHasMore(after: number, page: TaskEventsPage): boolean {
  return after + page.count < page.total;
}

/** 单条事件 → 时间线一行;读不懂返回 `null`(整页不许因为它报废)。 */
export function pulledEventAt(raw: unknown, position: number): PulledEvent | null {
  const parsed = streamEventSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { seq, ts, kind, payload } = parsed.data;
  return { position, seq, ts, kind, payload };
}

/** 把一页补齐结果并进状态(纯函数:同一输入永远得同一状态,所以可逐例测)。 */
export function applyPullPage(state: PullState, page: TaskEventsPage, after: number): PullState {
  const added: PulledEvent[] = [];
  let bad = 0;
  page.events.forEach((raw, index) => {
    const item = pulledEventAt(raw, after + index + 1);
    if (item === null) {
      bad += 1;
      return;
    }
    added.push(item);
  });
  const items = [...state.items, ...added];
  const trimmed = items.length > STREAM_EVENT_BUFFER_LIMIT
    ? items.slice(items.length - STREAM_EVENT_BUFFER_LIMIT)
    : items;
  return {
    pulled: after + page.count,
    items: trimmed,
    total: page.total,
    requests: state.requests + 1,
    bad: state.bad + bad,
    unreadable: page.unreadable_attempts,
    exhausted: !pullHasMore(after, page),
    failure: null,
  };
}

/** 补齐失败后的状态:保留已读到的条目,**只**记一句话。清空时间线是把「读不到」伪装成「没有」。 */
export function pullWithFailure(state: PullState, err: unknown): PullState {
  return { ...state, exhausted: true, failure: pullFailureText(err) };
}

/**
 * 流通道已消费的帧数。坏帧也算:它在扁平流里占一个位置,而我们没有渲染它。
 * 这个数是两条腿共用的位置口径(`?after=` 的续读点与 SSE 帧 `id` 同源,见文件头)。
 */
export function streamFramesOf(counts: { seen: number; bad: number }): number {
  return counts.seen + counts.bad;
}

/** 触发一次补齐的输入(全部来自纯函数的输出或两个通道的计数器)。 */
export interface PullTriggerInput {
  /** 流是否开着(`null` 路径 = 没开:任务不存在时既不连流也不补齐)。 */
  readonly streaming: boolean;
  /** 连接健康 = 没有未恢复的 error。 */
  readonly connected: boolean;
  /** 流上读不懂的帧数:它们的位置是空洞,只有补齐能填。 */
  readonly badFrames: number;
  /**
   * 流已消费的帧数(`streamFramesOf` 算的,含坏帧)。
   * 它唯一的用途是这一条:流自己报「一共 N 条」时,拿它和 N 比,才知道**有没有漏**。
   * 不拿它比就会在每次打开已结束的任务时都重读一遍整份 journal —— 那一次读确实总能
   * 证明「没漏」,但代价是一份完整的事件正文,而换来的结论流已经给过了。
   */
  readonly streamFrames: number;
  readonly ended: boolean;
  /** `end` 帧报的总条数(`null` = 那一帧读不懂)。 */
  readonly endEvents: number | null;
  readonly pull: PullState;
  /**
   * 手动补齐(页面上那个按钮)。为真时**无条件**从当前覆盖率续读 ——
   * 「流没恢复而我又想看一眼有没有新东西」不是一个判据能自动得出的结论,所以它是一个动作。
   * 续读而不是全量重读:`pulled` 之后的那一段才是新内容,已渲染的前缀不必再来一遍。
   */
  readonly manual: boolean;
}

/**
 * 该不该发起一次补齐,以及从哪个位置续读。返回 `null` = 不补齐。
 *
 * 三条触发理由与不触发的形状:
 * - **连接有未恢复的 error**:拉取是另一条腿(§5 的「互为恢复源」)。
 *   它同时覆盖 readyState=CLOSED(401,**永不重连**)与 CONNECTING(浏览器正在重连)两种:
 *   后者补一次也就多一次往返,而「重连期间到底漏没漏」这个问题只有拉能答。
 * - **有坏帧**:空洞的位置补齐能补上(同一份 journal、同一个信封,但补齐是逐条解析,
 *   一条读不懂不影响同页其余)。
 * - **`end` 帧已收而覆盖率不够**:那个 `events` 是服务端手里的总条数,比页面已渲染的多,
 *   就是「我漏了 N 条而页面看起来是完整的」—— 这一条最危险,必须补。
 * - **已翻尽而没有新依据**:不触发。让一个已经读到 `total` 的循环每秒再空转一次请求,
 *   换来的只有「这一页在断线期间确实没漏东西」这一句已经说过的话。
 *   ⚠️ 代价写在 `pullNote` 里而不是被咽掉:翻尽之后若又来了新事件而流仍没恢复,这一页会
 *   停在那一刻。所以那句「已翻尽」带着它成立时的总条数,而页面上留着「重新补齐」这个手动
 *   出口 —— 自动轮询是第三个节拍,§4 没给这一页。
 */
export function pullStartAfter(input: PullTriggerInput): number | null {
  if (!input.streaming) return null;
  const { pull } = input;
  if (input.manual) return pull.pulled;
  // 「漏了多少条」要和**两个通道各自的覆盖率**比,不是只和补齐比:流已经把前段渲染完了,
  // 从 0 再拉一遍只是把同样的正文多下一份。
  const behindEnd =
    input.ended &&
    input.endEvents !== null &&
    Math.max(pull.pulled, input.streamFrames) < input.endEvents;
  const needs = !input.connected || input.badFrames > 0 || behindEnd;
  if (!needs) return null;
  if (pull.exhausted && !behindEnd) return null;
  return pull.pulled;
}

/**
 * 两个通道合并成一条时间线。见文件头「两条恢复源」:补齐段整段保留,流段按内容键去重后续接。
 * 总长度受 `STREAM_EVENT_BUFFER_LIMIT` 约束(保留最新的),与 use-event-stream 同一个上限、
 * 同一个理由:观测页上无上限的数组是真实的内存故障。
 */
export function mergeTimeline(
  pulled: readonly PulledEvent[],
  streamed: ReadonlyArray<{ seq: number; ts: string; kind: string; payload: unknown }>,
): TimelineEntry[] {
  const head: TimelineEntry[] = pulled.map((event) => ({
    key: `p${event.position}`,
    position: event.position,
    seq: event.seq,
    ts: event.ts,
    kind: event.kind,
    payload: event.payload,
    source: "pull" as const,
  }));
  const seen = new Set(head.map((entry) => eventKey(entry)));
  const tail: TimelineEntry[] = [];
  for (const event of streamed) {
    const key = eventKey(event);
    if (seen.has(key)) continue;
    seen.add(key);
    tail.push({
      key: `s${tail.length}`,
      position: null,
      seq: event.seq,
      ts: event.ts,
      kind: event.kind,
      payload: event.payload,
      source: "stream",
    });
  }
  const all = [...head, ...tail];
  return all.length > STREAM_EVENT_BUFFER_LIMIT
    ? all.slice(all.length - STREAM_EVENT_BUFFER_LIMIT)
    : all;
}

/**
 * 内容键:seq + ts + kind + payload 序列化。
 * 不用位置:流通道的位置在有坏帧时会漂移(见文件头)。
 */
export function eventKey(event: { seq: number; ts: string; kind: string; payload: unknown }): string {
  return `${event.seq}\u0000${event.ts}\u0000${event.kind}\u0000${jsonStable(event.payload)}`;
}

function jsonStable(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "(不可序列化)";
  }
}

/** 一行时间线的呈现值:徽章类名、正文、截断注记、kind 专属附注。全部由既有权威算出。 */
export interface TimelineRowView {
  readonly badgeClass: string;
  readonly text: string;
  readonly note: string;
  readonly extra: string;
  readonly positionLabel: string;
}

/**
 * `ca-badge` 与 kind 的描边类名在这里拼成一个完整类名串,而不是在组件里做模板拼接:
 * 配色的唯一出口仍然是 `lib/view.ts` 的 `kindBadgeClass`(未知 kind 落中性徽章),
 * 而 `ca-badge` 是完整字面量 —— 它得让「扫 class 全集」的样式钉子看得见。
 */
export function kindBadgeClassName(kind: string): string {
  const kindClass = kindBadgeClass(kind);
  return kindClass === "" ? "ca-badge" : `ca-badge ${kindClass}`;
}

export function timelineRowView(entry: TimelineEntry): TimelineRowView {
  const summary = summarize(textOf(entry.payload));
  return {
    badgeClass: kindBadgeClassName(entry.kind),
    text: summary.shown,
    note: summary.note,
    extra: eventExtra(entry),
    positionLabel: entry.position === null ? "增量" : String(entry.position),
  };
}

/**
 * kind 专属附注(逐条迁移 c9b 那份实测过的渲染表):`tool_use` 报工具名、`raw` 报原始类型,
 * 两者都来了就用 ` · ` 接;`usage.total_tokens` 是成本台账的可见出口。
 * 只认白名单字段、类型不符就当没有 —— 一个陌生 payload 不该让一行渲染不出来。
 */
function eventExtra(entry: TimelineEntry): string {
  const payload = asRecord(entry.payload);
  const parts: string[] = [];
  const names = payload.tool_names;
  if (entry.kind === "tool_use" && Array.isArray(names)) {
    const listed = names.map((name) => String(name)).join(", ");
    if (listed.length > 0) parts.push(`tools: ${listed}`);
  }
  const rawType = payload.raw_type;
  if (entry.kind === "raw" && typeof rawType === "string" && rawType.length > 0) {
    parts.push(`raw_type: ${rawType}`);
  }
  const tokens = totalTokensOf(entry.payload);
  if (tokens !== null) parts.push(`tokens: ${tokens}`);
  return parts.join(" · ");
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * 时间线上方那句「补齐说了什么」。
 * 一条线把三件事讲完:补读到哪、翻没翻尽、有没有读不到的 attempt —— 缺任何一件都是
 * 「页面看起来完整而其实不完整」,那正是这个端点最不该有的外观。
 */
export function pullNote(pull: PullState, streaming: boolean): string {
  const bits: string[] = [];
  if (pull.items.length > 0) bits.push(`补齐 ${pull.items.length} 条(位置游标 ${pull.pulled})`);
  if (pull.requests > 0) bits.push(`补齐请求 ${pull.requests} 次`);
  if (pull.bad > 0) bits.push(`补齐页中读不懂 ${pull.bad} 条(已跳过,未清空已读到的部分)`);
  if (pull.total !== null) bits.push(`服务端报总条数 ${pull.total}`);
  if (pull.exhausted) {
    bits.push("已翻尽(该位置之后服务端当时没有更多;若之后又来了事件而流仍未恢复,这一页不会自动再补 —— 用「重新补齐」)");
  }
  if (pull.unreadable.length > 0) {
    bits.push(`读不到的 attempt:${pull.unreadable.join(", ")} —— 这一页看到的是不完整的视图`);
  }
  if (pull.failure !== null) bits.push(pull.failure);
  if (bits.length === 0) {
    return streaming
      ? "未使用拉取补齐:SSE 是这一页的当前数据源(断线、坏帧、end 帧覆盖率不足时它会自动接手)。"
      : "未使用拉取补齐。";
  }
  return bits.join(" · ");
}

/**
 * `end` 帧那一句。总条数只有读得懂时才报(报不出数字比不报数字更糟)。
 * 权威终态不在这里猜:`end` 只证明「已非 RUNNING」,精确值见头部那个徽章。
 */
export function endFrameLine(endedText: string, endEvents: number | null): string {
  const count = endEvents === null ? "" : `(共 ${endEvents} 条)`;
  return `${endedText}${count} —— 任务已离开 RUNNING,精确终态见上方 state 徽章`;
}

/** 头部 state 徽章的取值。快照读不到而流已结束时,如实说「非 RUNNING(精确值读不到)」。 */
export interface StateDisplay {
  readonly state: string;
  readonly known: boolean;
}

export function stateDisplay(snapshotState: string | null, ended: boolean): StateDisplay {
  if (snapshotState !== null) return { state: snapshotState, known: true };
  if (ended) return { state: "非 RUNNING(精确值本次读不到)", known: false };
  return { state: "未知(快照未读到)", known: false };
}

/**
 * 该不该开这条流。
 *
 * 判据是「快照已经答复过,而且答的不是『没有这个任务』」,不是「页面已经渲染完了」:
 * 对一个 404 的 id 开流会拿到 404,而 EventSource 把它表现成 `readyState=CLOSED` ——
 * 那句话在 `STREAM_CONN_RULES` 里说的是「最常见原因是会话失效(401)」。把「id 不存在」
 * 说成「你没登录」是这一页最不该有的口供,而它只需要晚开一拍就能避免。
 */
export function streamEnabledFor(settled: boolean, notFound: boolean): boolean {
  return settled && !notFound;
}

/** 连接徽章。三档的优先级:已收尾 > 未恢复的 error > 正常。 */
export interface ConnectionBadge {
  readonly text: string;
  readonly tone: Tone;
  /** 401 那一支唯一有用的动作:页面据此给「去重新登录」这个出口。 */
  readonly reauth: boolean;
}

/**
 * `ended` 排在 error 之前不是疏忽:末帧前夜的最后一次重连抖动会一直挂在「正在自动重连」上,
 * 而那时流已经正常收尾了 —— 那个文案在承诺一件不会再发生的事(与 stream-protocol 里
 * 「一次已恢复的断连不该留在坏消息上」同一条纪律,只是方向相反)。
 * 正常态给 ok:这一页的「连接活着」是操作员最需要的肯定信号,而中性色与「还没开始」同色。
 *
 * `reauth` 只是把 `STREAM_CONN_RULES` 里那一位带过来 —— 判据在协议层(它知道 CLOSED 的
 * 最常见原因是会话失效),页面只做「有没有这个出口」这一件事。
 */
export function connectionBadge(
  error: { text: string; tone: Tone; reauth: boolean } | null,
  ended: boolean,
  connectedText: string,
  endedText: string,
): ConnectionBadge {
  if (ended) return { text: endedText, tone: "", reauth: false };
  if (error !== null) return { text: error.text, tone: error.tone, reauth: error.reauth };
  return { text: connectedText, tone: "ok", reauth: false };
}

/** 一条「标签 + 值」事实。`note` 是给 title/后缀的旁注,`absent` 让页面把它渲成「—」而不是空串。 */
export interface FactRow {
  readonly label: string;
  readonly value: string;
  readonly note: string;
  readonly absent: boolean;
}

function fact(label: string, value: string, note = ""): FactRow {
  return { label, value, note, absent: false };
}

function absentFact(label: string, note: string): FactRow {
  return { label, value: "—", note, absent: true };
}

/** digest/sha 的显示截断:首 12 位足以肉眼区分,完整值必须回到 DOM(`title`)。 */
export const HASH_VISIBLE_CHARS = 12;

export function truncateHash(value: string): { shown: string; full: string } {
  if (value.length <= HASH_VISIBLE_CHARS) return { shown: value, full: value };
  return { shown: `${value.slice(0, HASH_VISIBLE_CHARS)}…`, full: value };
}

/**
 * 基线与 digest 两行。取值口径全部写进 `note`,让操作员不必回代码就知道那个数是干嘛的:
 * - `base.sha` 是本任务所有候选共同冻结的基线(缺键 = M8 前的老记录 = 基线未固定);
 * - `spec_digest` 是审批绑定的核对项;
 * - `last_candidate_digest` 是无进展熔断的比较对象;
 * - `current_evidence.*` 是钉住的当前证据(`/evidence` 与 `/approve` 同口径)。
 */
export function baselineFacts(task: TaskSnapshot["task"]): readonly FactRow[] {
  const base = task.base;
  const rows: FactRow[] = [
    base === undefined || base === null
      ? absentFact("base sha", "缺键或为 null:按「基线未固定」对待(M8 前的老记录就是这个形状)")
      : fact("base sha", truncateHash(base.sha).shown, `完整值 ${base.sha} · source=${base.source}`),
  ];
  rows.push(
    task.spec_digest === undefined
      ? absentFact("spec_digest", "快照里没有这一列")
      : fact("spec_digest", truncateHash(task.spec_digest).shown, `完整值 ${task.spec_digest}`),
    task.last_candidate_digest === null || task.last_candidate_digest === undefined
      ? absentFact("last_candidate_digest", "还没有产出过候选,或该字段未记录(与「候选摘要为空」不是一回事)")
      : fact(
          "last_candidate_digest",
          truncateHash(task.last_candidate_digest).shown,
          `完整值 ${task.last_candidate_digest}`,
        ),
  );
  const evidence = task.current_evidence;
  if (evidence === null || evidence === undefined) {
    rows.push(absentFact("钉住的证据", "current_evidence 为空:还没有一份被钉住的 writer manifest"));
  } else {
    rows.push(
      fact(
        "writer manifest digest",
        truncateHash(evidence.writer_manifest_digest).shown,
        `完整值 ${evidence.writer_manifest_digest} · attempt ${evidence.writer_attempt_id}`,
      ),
    );
    rows.push(
      evidence.verifier_manifest_digest === undefined
        ? absentFact("verifier manifest digest", "这一轮还没有 verifier 证据")
        : fact(
            "verifier manifest digest",
            truncateHash(evidence.verifier_manifest_digest).shown,
            `完整值 ${evidence.verifier_manifest_digest}`,
          ),
    );
  }
  return rows;
}

/** 夹钳事件的可展示字段。`rows > 0` 而数字全 null 的意思是「有留痕但读不懂」,不是「没被夹过」。 */
export interface ClampFacts {
  /** 链上 `budget.clamped` 的条数(一轮一条:一条被夹过两次的链是正常形状)。 */
  readonly rows: number;
  /** 其中解不出 JSON 的条数。 */
  readonly unreadable: number;
  readonly requestedSeconds: number | null;
  readonly writerWallMinutes: number | null;
  readonly ceilingMinutes: number | null;
  readonly reason: string | null;
}

/**
 * 从 DO 审计链里取 `budget.clamped` 的留痕。
 *
 * `snapshot.events[].payload` 是**字符串**(getSnapshot 里 `JSON.stringify(e.payload)`),
 * 所以这里必须自己解 —— 解不出来就计数,绝不抛(一条链上读不懂的 payload
 * 不能让头部消失,那与「一条坏帧停更整页」是同一种故障)。
 * 数字取**最后一条**:夹钳事件按 attempt 追加,最新那条说的才是当前这一轮。
 * 返回 `null` 的语义很窄 —— 「链上一条夹钳事件都没有」,所以只有那种形状才配说「没被夹过」。
 */
export function clampFacts(snapshot: TaskSnapshot | null): ClampFacts | null {
  if (snapshot === null) return null;
  let rows = 0;
  let unreadable = 0;
  let facts: Omit<ClampFacts, "rows" | "unreadable"> = {
    requestedSeconds: null,
    writerWallMinutes: null,
    ceilingMinutes: null,
    reason: null,
  };
  for (const row of snapshot.events) {
    if (row.kind !== BUDGET_CLAMP_KIND) continue;
    rows += 1;
    const payload = decodeJsonObject(row.payload);
    if (payload === null) {
      unreadable += 1;
      continue;
    }
    // 逐条覆盖:循环按链的追加序走,最后一条可读的就是「当前这一轮」的留痕。
    facts = {
      requestedSeconds: finiteNumber(payload.requested_seconds),
      writerWallMinutes: finiteNumber(payload.writer_wall_minutes),
      ceilingMinutes: finiteNumber(payload.ceiling_minutes),
      reason: typeof payload.clamp_reason === "string" ? payload.clamp_reason : null,
    };
  }
  return rows === 0 ? null : { rows, unreadable, ...facts };
}

function decodeJsonObject(text: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * 预算/用量那块。
 *
 * 只有三个数有出处:`tokens_used` 之和(attempts 投影里的第六列)、夹钳事件、行数;
 * 上限不在这条端点上,所以 `boundary` 那句话是这一块的组成部分而不是脚注。
 * 口径提醒照 §7 的成本台账注记写进行内:`tokens_used` 是 raw total,不是成本。
 */
export function budgetFacts(snapshot: TaskSnapshot | null): { rows: FactRow[]; boundary: string } {
  const attempts = snapshot?.attempts ?? [];
  const tokens = attempts.reduce((sum, attempt) => sum + attempt.tokens_used, 0);
  const rows: FactRow[] = [
    fact("attempts 用量合计", String(tokens), "tokens_used 之和(raw total 口径,不是成本:见 README 的 cost_weighted_tokens)"),
    fact("轮次数", String(attempts.length), "attempts 数组序 = 创建序,与 GET /api/tasks/:id 同源"),
  ];
  const clamp = clampFacts(snapshot);
  if (clamp === null) {
    rows.push(absentFact("墙钟夹钳留痕", "链上一条 budget.clamped 都没有:这一轮的预算没有被平台安全上限降过(不等于没夹钳过历史轮)"));
  } else if (clamp.requestedSeconds === null && clamp.unreadable === clamp.rows) {
    rows.push(
      absentFact(
        "墙钟夹钳留痕",
        `链上有 ${clamp.rows} 条 ${BUDGET_CLAMP_KIND} 事件,payload 全都解不出来 —— 「有留痕而读不懂」与「没有留痕」必须两句话`,
      ),
    );
  } else {
    rows.push(
      fact(
        "墙钟夹钳留痕",
        `${clamp.requestedSeconds ?? "?"}s → ${clamp.writerWallMinutes ?? "?"}m(上限 ${clamp.ceilingMinutes ?? "?"}m)`,
        `clamp_reason=${clamp.reason ?? "未记"} · 链上共 ${clamp.rows} 条留痕,取最后一条(按追加序)` +
          (clamp.unreadable > 0 ? ` · 另有 ${clamp.unreadable} 条读不懂` : ""),
      ),
    );
  }
  return { rows, boundary: BUDGET_BOUNDARY };
}

export const BUDGET_BOUNDARY =
  "预算上限读不到:GET /api/tasks/:id 的 attempts 投影只有 id/role/state/tokens_used/created_at/finished_at 六列" +
  "(src/control/session.ts 的 getSnapshot),max_wall_seconds 与 max_model_tokens 不在其中。" +
  `含这两列的读投影是 GET /api/admin/attempts,而它只读 D1 终态归档 —— 在跑的任务那里没有行,所以这里不放一个「看着像上限」的数。`;

/**
 * attempts 一行的呈现值。终态不着色:attempt 状态的取值集权威在
 * `src/control/session.ts` 的 `ATTEMPT_STATES`,前端要么抄一份(那得配防漂钉子与本棒
 * 之外的预算),要么不表态。本棒取后者 —— 头部徽章的配色权威只有一份任务级的,
 * 给返工轮另立一套绿蓝红会把「任务级状态」与「轮次状态」在视觉上焊在一起。
 */
export interface AttemptRowView {
  readonly id: string;
  readonly shortId: string;
  readonly role: string;
  readonly state: string;
  readonly tokens: string;
  readonly created: string;
  readonly finished: string;
  readonly duration: string;
}

export const ATTEMPT_ID_VISIBLE_CHARS = 8;

export function attemptRowView(attempt: TaskSnapshot["attempts"][number]): AttemptRowView {
  const seconds = attemptDurationSeconds(attempt.created_at, attempt.finished_at);
  return {
    id: attempt.id,
    shortId: attempt.id.slice(0, ATTEMPT_ID_VISIBLE_CHARS),
    role: attempt.role,
    state: attempt.state,
    tokens: String(attempt.tokens_used),
    created: attempt.created_at,
    finished: attempt.finished_at ?? "—",
    duration: seconds === null ? "—(仍在进行或时间不可解析)" : `${seconds}s`,
  };
}

/**
 * 轮次时长 = `finished_at - created_at`,两个都是服务端给的 ISO 串。
 * 任一不可解析(或 finished 为 null)返回 `null` 而不是 0:0 是一个**结论**,
 * 而「还没结束」与「跑了 0 秒」不是同一件事(与 lib/view.ts 把 null 与 0 严格分开同一条理由)。
 */
export function attemptDurationSeconds(createdAt: string, finishedAt: string | null): number | null {
  if (finishedAt === null) return null;
  const start = Date.parse(createdAt);
  const end = Date.parse(finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Math.floor((end - start) / 1000);
}

/** 时间线的空态。与失败态分开,而且不许被读成「这个任务没有事件」。 */
export function timelineEmptyText(pull: PullState, streamFrames: number, failedSnapshot: boolean): string {
  if (failedSnapshot) return "任务快照没读出来,所以这条时间线现在既不是空的也不是满的(原因见上)。";
  if (pull.failure !== null) return "补齐没有带回可读的事件(原因见上),流通道目前也还没有事件。";
  if (streamFrames > 0 || pull.items.length > 0) return "已收到帧,但没有一条读得出来 —— 见上面的坏帧计数。";
  return "还没有事件。建流后服务端每拍推增量,首拍会回放全部已有事件;若这个任务从未摄取过任何 transcript,这里就确实是空的(不是没读到)。";
}

/** 快照读失败的文案:四种失败种类 + 404 各有说法,且没有一种被说成「任务没有内容」。 */
export const TASK_DETAIL_UNEXPECTED =
  "任务详情没读出来:页面这边出了意外错误,不是服务端的答复。";

export const TASK_NOT_FOUND_ERROR_TYPE = "not_found";

/** 404 的判据:`handleGetTask` 对不存在的任务只给这一种形状。 */
export function isTaskNotFound(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    err.failure.kind === "http" &&
    err.failure.status === 404 &&
    err.failure.errorType === TASK_NOT_FOUND_ERROR_TYPE
  );
}

export function detailFailureText(err: unknown): string {
  if (isTaskNotFound(err)) {
    return (
      "404 not_found:这个 id 在 TaskSession DO 里没有对应任务。" +
      "要么 id 打错了(路由参数原样显示在标题里,可核对),要么这个环境的 DO 里从没建过它 —— " +
      "它**不是**「任务存在但没有内容」;后者由时间线那一段自己说。"
    );
  }
  if (!(err instanceof ApiError)) return TASK_DETAIL_UNEXPECTED;
  const failure = err.failure;
  switch (failure.kind) {
    case "unauthorized":
      return "会话已失效:这一页读不到任务详情。重新登录后再试(顶栏右侧那一位显示会话状态)。";
    case "http":
      return `服务端答复 ${failure.status}${failure.errorType === null ? "" : `(${failure.errorType})`}:任务详情没读出来。`;
    case "network":
      return "请求没有送达:服务不可达或网络中断。这不是「任务不存在」。";
    case "shape":
      return `响应不是可读的 JSON(${failure.detail}):先查 wrangler 的 run_worker_first 是否盖住了 /api/*。`;
  }
}

/** 补齐通道的失败文案:与快照分开,因为它带着「已读到的部分仍然有效」这半句。 */
export function pullFailureText(err: unknown): string {
  if (!(err instanceof ApiError)) return "补齐请求出错了:页面这边的意外异常,已补读到的条目仍然保留。";
  const failure = err.failure;
  switch (failure.kind) {
    case "unauthorized":
      return "补齐被拒(会话失效):已补读到的条目仍然保留。";
    case "http":
      return `补齐这一页答复 ${failure.status}${failure.errorType === null ? "" : `(${failure.errorType})`}:已补读到的条目仍然保留。`;
    case "network":
      return "补齐请求没有送达:已补读到的条目仍然保留。";
    case "shape":
      return `补齐这一页的形状读不懂(${failure.detail}):整页已跳过,已补读到的条目仍然保留。`;
  }
}

/**
 * 这一页真的发出去的 URL 长什么样(纯函数出口:页面说明行与测试都从这里取,
 * 于是「补齐读的是哪一段」在页面上可读,而不是只有网络面板里看得见)。
 */
export function pullPlanUrl(taskId: string, pull: PullState): string {
  return taskEventsUrl(taskId, pull.pulled);
}

/** 补齐一页的读取器(注入点:测试给它一个假答复即可,不必真起 worker)。 */
export type TaskEventsReader = (taskId: string, after: number) => Promise<TaskEventsPage>;

/**
 * 一页一页翻到「服务端说没有更多」为止(交付 ④的「补齐分页翻尽」)。
 *
 * `after` 每轮加的是**服务端的 count**,不是本页可渲染条数:位置游标说的是「扁平流里已读过的
 * 条数」,读不懂的那几条同样占位置(见文件头与 src/index.ts 的 parseObsAfter 注释)。
 * 失败即停:一个连续失败的循环会打出一个请求风暴,而页面上已经有那句话说明为什么停了。
 */
export async function runEventsPull(
  taskId: string,
  from: number,
  state: PullState,
  onPage: (next: PullState) => void,
  read: TaskEventsReader = fetchTaskEvents,
): Promise<PullState> {
  let current: PullState = { ...state, failure: null, exhausted: false };
  let after = from;
  for (;;) {
    if (!Number.isSafeInteger(after) || after < 0) {
      current = pullWithFailure(current, new Error(`bad after ${String(after)}`));
      onPage(current);
      return current;
    }
    try {
      const page = await read(taskId, after);
      const consumed = after;
      current = applyPullPage(current, page, consumed);
      onPage(current);
      if (current.exhausted) return current;
      after = consumed + page.count;
    } catch (err) {
      current = pullWithFailure(current, err);
      onPage(current);
      return current;
    }
  }
}

/** 头部「读取时刻」那一行。`state === null` = 还没有答复,此时不给时间戳。 */
export function snapshotReadNote(readAtMs: number | null, state: string | null): string {
  if (readAtMs === null || state === null) return "快照还没有读到答复。";
  return `快照读取于 ${new Date(readAtMs).toISOString()}(state 的权威时刻;实时增量看下面的流)。`;
}
