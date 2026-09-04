/**
 * Observation 层的流式读路径:SSE 投影(`GET /api/tasks/:id/events/stream`)。
 *
 * 定位(四层可观测架构第④层的**上半**):**投影,非权威**。这里一个字节都不写 ——
 * 权威仍是 TaskSession DO 的 hash chain,本模块只把 journal 里已落盘的事件按位置
 * 游标推给客户端。下半(Live UI)是下一期:本期不产任何 HTML、不挂 `/live` 路由。
 *
 * 这条端点存在的理由:读端点 `GET /events` 单次上限 2000 条(MAX_OBS_LIMIT),而一次
 * 40 分钟的长跑实测 450+ 条且仍在涨 —— 靠分页全量重放来「看现在在干什么」,每轮都要
 * 付整段下载的代价。流式投影每次只读增量,把成本从 O(total) 降到 O(new)。
 *
 * 三条不能妥协的不变量(下一棒的 docs 与 Live UI 直接依赖它们):
 *
 * 1. **帧 id = 该帧之后已读的事件条数**(全 attempt 扁平序上的 1-based 位置),与
 *    `GET /events` 的 `after`(= 已读条数)**完全同一口径**,`end` 帧的 id 也同口径。
 *    为什么必须同源:SSE 客户端(浏览器 EventSource 按标准)会把最后看到的 `id` 原样
 *    回传成 `Last-Event-ID`,而服务端把这个值当**已读条数**消耗。两套口径的话断线续传
 *    就会静默重放或漏读 —— 那不是「有点吵」,是「同一事件出现两次、另一次永远看不到」。
 *    为什么不是 0-based 索引:索引 p 之后已读条数是 p+1,拿索引当 `after` 会让位置 p
 *    那条被重发一次;最糟的是第一帧 `id: 0`,浏览器重连时 `Last-Event-ID: 0` = 「一条
 *    没读过」= **从头全量重放**。所以缺省回放 N 条 → id 依次 1..N,`end` 帧 id = 总条数。
 *    这条口径的可执行证据在 test/obs-stream-api.test.ts 的「往返自洽」用例里。
 *
 * 2. **绝不把连接挂进 TaskSession DO**。TaskSession 是 `blockConcurrencyWhile` 的重度
 *    单写者:一条长连接若驻留在 DO 里,就会挤占权威写路径的并发(架构定稿明确禁令)。
 *    所以泵跑在普通 worker handler 的 ReadableStream 上,每轮只做**短读** `getSnapshot()`
 *    —— 禁令针对的是「连接挂进 DO」,不是「周期性地短暂读一下 DO」。
 *
 * 3. **cancel 必须让泵彻底收敛**:既清掉定时器,也 settle 等待中的那一拍。只 clearTimeout
 *    的话 fire 回调永不执行 → 泵那个 `await` 永不 settle → 每次客户端断开漏一个悬挂的
 *    异步帧。workerd 按 IoContext 追踪未完成的异步工作,teardown 时判定 hung 并取消整个
 *    请求(实测:`jsg.Error: The Workers runtime canceled this request because it detected
 *    that your Worker's code had hung`),后果是**验证器连测试 summary 都打不出来**。
 *    本地套件全绿完全看不出来 —— 这是仓内反模式 17(「本地绿 ≠ 执行面能跑」)的镜像:
 *    本地绿也 ≠ 验证器能跑完。头号的验收钉,见 `createObsStreamWaiter` 与其测试。
 */

import type { AgentEventV1 } from "./events";

/** 帧 id 与位置游标的关系就写在这行注释上:id 是**该帧之后已读的条数**,不是索引。 */
export const OBS_SSE_EVENT = "agent";
export const OBS_SSE_END_EVENT = "end";
/** end/data 的形状版本,与 AgentEventV1 的 `v` 各自独立演进。 */
export const OBS_SSE_FRAME_V = 1;

/**
 * 尾读节拍 3s。它**不是**新数据的来源(journal 由 poll 相一轮一拍推进,实测中位轮次 33s),
 * 只决定「事件落地后多久被流看见」。取 3s 而不是 30s:让尾部延迟由摄取周期主导,而不是由
 * 本端点的轮询节拍主导。测试靠注入 `schedule` 驱动,不真等。
 *
 * c10b 起这条流的「无帧」换了含义,读的人要知道:空轮也有一条心跳 ⇒ 未跳过的每一轮至少
 * 一帧,所以「长时间无帧」不再等于「模型没产字」,而是收窄成「摄取这一路自己没动」。它仍
 * 只是粗筛 —— 轮次会被跳过(轮次分布与阈值推导只有一份权威口径,见
 * `docs/architecture.md` §9.8;此处不复述数字,免得两处各自过期),按帧到达判停滞会误报。
 */
export const OBS_SSE_TAIL_INTERVAL_MS = 3000;

/** 保活注释行:一轮无新事件时发出去,让代理链与客户端都知道连接还活着。 */
export const OBS_SSE_PING_FRAME = ": ping\n\n";

/** 只有 RUNNING 才是「还在往前流」;其余取值(BLOCKED、AWAITING_APPROVAL、各终态)一律收尾。 */
const OBS_RUNNING_STATE = "RUNNING";

export interface ObsStreamTimer {
  cancel(): void;
}

/** 任务快照里本模块用到的两样东西。刻意窄:流不需要 events/预算,只要清单与状态。 */
export interface ObsStreamSnapshot {
  state: string;
  /** attempt id,**按创建序** —— 扁平序与 `GET /events` 同源,位置游标才能同口径。 */
  attemptIds: string[];
}

export interface ObsAttemptPage {
  events: AgentEventV1[];
  total: number;
}

/**
 * 全部副作用经 deps 注入(沿用 scripts/land-gate.mjs 的风格):真实的
 * `getSnapshot`/`readObsAttemptEvents`/`setTimeout` 由 src/index.ts 装配,测试注入假件。
 * 特别是 `schedule`:测试要能把「等一拍」变成「立刻推进」,也要能模拟「cancel 之后
 * fire 永不来」这一种真实断开形状。
 */
export interface ObsStreamDeps {
  readSnapshot(taskId: string): Promise<ObsStreamSnapshot | null>;
  readAttemptEvents(taskId: string, attemptId: string, skip: number): Promise<ObsAttemptPage>;
  schedule(ms: number, fire: () => void): ObsStreamTimer;
  tailIntervalMs: number;
  /** 降级必须出声(与 events 端点同一处置);真实装配 = console.warn。 */
  warn(message: string): void;
}

/** 一条等待中的尾读节拍。`cancel()` 之后 `promise` **必须** settle —— 见文件头不变量 3。 */
export interface ObsStreamWaiter {
  readonly promise: Promise<void>;
  cancel(): void;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: ((value: void | PromiseLike<void>) => void) | null = null;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve: () => resolve?.(undefined) };
}

/**
 * 「等一拍」= 挂一个定时器 + 一个可被 cancel 立刻了结的 promise。
 *
 * 为什么单独抽出来并导出:上一轮把这一拍直接写成 `await new Promise(resolve => { timer =
 * schedule(..., resolve) })`,而 `stop()` 只做 `timer.cancel()`。cancel 之后 fire 永不
 * 执行,`resolve` 也就永不被调用 —— 泵的 async 帧**永久悬挂**在那个 await 上,每次客户端
 * 断开漏一个。抽成结构之后这条不变量能被单测直接钉住(假 schedule 的 cancel 不触发 fire,
 * 断言 promise 仍 settle),而不是靠读代码保证。
 */
export function createObsStreamWaiter(
  deps: Pick<ObsStreamDeps, "schedule" | "tailIntervalMs">,
): ObsStreamWaiter {
  const tick = deferred();
  let cancelled = false;
  const timer = deps.schedule(deps.tailIntervalMs, () => {
    if (cancelled) return;
    tick.resolve();
  });
  return {
    promise: tick.promise,
    cancel() {
      if (cancelled) return;
      cancelled = true;
      timer.cancel();
      // 关键的一行:不等 fire 来,自己 settle。泵因此立刻回到 `while (!stopped)` 判定。
      tick.resolve();
    },
  };
}

/** 一条连接的可变投影状态。位置游标是**唯一**对外承诺的进度,per-attempt 游标不持有。 */
export interface ObsStreamSession {
  /** 已推送的事件条数 = 下一帧的 id。起点 = 客户端声明的 `Last-Event-ID`(缺省 0)。 */
  position: number;
  /** 本轮及最近一轮读不到的 attempt:进 end 帧,与 events 端点的 unreadable_attempts 同义。 */
  unreadable: Set<string>;
}

/** 大声失败:起始位置畸形是调用方(装配层)的 bug,不该退化成「从头全量重放」。 */
export function createObsStreamSession(lastEventId = 0): ObsStreamSession {
  if (!Number.isSafeInteger(lastEventId) || lastEventId < 0) {
    throw new Error(`obs_stream_bad_start_position ${String(lastEventId)}`);
  }
  return { position: lastEventId, unreadable: new Set<string>() };
}

/**
 * `data:` 必须是**单行**:一个裸换行会把一条事件切成两帧、把后续行当新帧解析,
 * 那是 SSE 注入。JSON.stringify 已经把换行与回车转义成两字符序列,注入这条路天然
 * 封死;剩下 U+2028/U+2029 —— 它们对 JSON 合法、对 SSE 的分行规则也非法,但不少
 * 语言的分句函数(如 Python 的 splitlines)会当换行处理,而 payload 里装的正是
 * agent 的任意自由文本。显式转义,让「一帧一个 data 行」对任何客户端都成立。
 */
function sseData(value: unknown): string {
  return JSON.stringify(value)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** 一条事件 = `id` + `event: agent` + `data`(AgentEventV1 原文)+ 空行。 */
export function obsSseEventFrame(id: number, event: AgentEventV1): string {
  return `id: ${id}\nevent: ${OBS_SSE_EVENT}\ndata: ${sseData(event)}\n\n`;
}

/**
 * 终止帧:`event: end`,id = 当前扁平总条数 —— 与最后一个事件帧的 id **同口径**(不变量 1)。
 * 客户端拿它当续传点再连,正好接在最后读过的那条之后,不重发也不漏读。
 */
export function obsSseEndFrame(taskId: string, session: ObsStreamSession): string {
  return (
    `id: ${session.position}\nevent: ${OBS_SSE_END_EVENT}\ndata: ` +
    `${sseData({
      v: OBS_SSE_FRAME_V,
      task_id: taskId,
      events: session.position,
      unreadable_attempts: [...session.unreadable].sort(),
    })}\n\n`
  );
}

export interface ObsStreamStepResult {
  newEvents: number;
  running: boolean;
}

/**
 * 单步循环体(导出以便测试直接驱动,不必真等 3s):读一次快照 → 按创建序对每个
 * attempt 做**游标差分**读 journal → 推新增事件。
 *
 * 差分算法刻意与 `handleGetTaskEvents` 的 `after` 分配逐字相同(累计 `before`、
 * `skip = max(0, position - before)`),因为「位置游标」只有一个实现才算真正同口径:
 * 两处各写一份,迟早有一处漂移,而漂移的表现是断线续传静默重放/漏读。
 * 某 attempt 读不到 → 记 warn、列进 unreadable、**继续**,不杀流(与 events 端点的
 * `unreadable_attempts` 降级一致)。位置因此以「本轮读到的 attempt 清单」为准:某个
 * attempt 从不可读翻转为可读会让扁平位置重排 —— events 端点同口径同表现,不是本端点
 * 新增的偏差(实际也不会发生:index 坏了只会被下一轮摄取重写)。
 *
 * 先读快照、后读 journal:这样「快照已非 RUNNING」与「本轮 journal 增量已推完」在同一轮
 * 里同时成立,终止判定不需要再多等一拍确认。
 */
export async function obsStreamStep(
  deps: ObsStreamDeps,
  taskId: string,
  session: ObsStreamSession,
  emit: (frame: string) => void,
): Promise<ObsStreamStepResult> {
  const snap = await deps.readSnapshot(taskId);
  // 快照读不到(任务被删/DO 不可用)时没有任何可信的前进依据:收尾,让客户端重连拿 404。
  if (!snap) return { newEvents: 0, running: false };

  let newEvents = 0;
  let before = 0;
  for (const attemptId of snap.attemptIds) {
    let page: ObsAttemptPage;
    try {
      page = await deps.readAttemptEvents(taskId, attemptId, Math.max(0, session.position - before));
    } catch (err) {
      deps.warn(
        `obs_stream_attempt_unreadable task=${taskId} attempt=${attemptId} err=${String(err).slice(0, 300)}`,
      );
      session.unreadable.add(attemptId);
      continue;
    }
    session.unreadable.delete(attemptId);
    for (const event of page.events) {
      session.position += 1;
      newEvents += 1;
      emit(obsSseEventFrame(session.position, event));
    }
    before += page.total;
  }
  return { newEvents, running: snap.state === OBS_RUNNING_STATE };
}

export interface ObsStreamHandle {
  response: Response;
  /**
   * 泵已退出(推到终态收尾,或客户端断开后收敛)。存在的唯一意义就是把不变量 3 变成
   * 可断言的东西:测试 cancel 掉 body 之后 `settled` 必须 settle,否则就是又漏了一帧。
   */
  readonly settled: Promise<void>;
  /** 幂等地叫停泵。`response` 的 body 被客户端 cancel 时自动调用。 */
  stop(): void;
}

/**
 * 组装 SSE 响应:普通 worker handler 上的 ReadableStream(不变量 2 —— 不进 DO),
 * 泵在 `start()` 里自转,节拍由 `createObsStreamWaiter` 决定。
 *
 * 队列刻意不设上限:每轮产出受 journal 增量约束(30s 一轮、单轮条数有限),而消费方
 * 是一个总在读的浏览器。真正的上限是「任务终态即收尾」,不是缓冲区大小。
 */
export function obsStreamResponse(
  taskId: string,
  deps: ObsStreamDeps,
  session: ObsStreamSession,
): ObsStreamHandle {
  const encoder = new TextEncoder();
  const pumpDone = deferred();
  let stopped = false;
  let pending: ObsStreamWaiter | null = null;

  function stop(): void {
    if (stopped) return;
    stopped = true;
    const waiter = pending;
    pending = null;
    // 不只是 clearTimeout:那一拍的 promise 也必须 settle(不变量 3)。
    waiter?.cancel();
  }

  async function pump(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    try {
      while (!stopped) {
        const step = await obsStreamStep(deps, taskId, session, (frame) => {
          if (!stopped) controller.enqueue(encoder.encode(frame));
        });
        if (stopped) return;
        if (!step.running) {
          controller.enqueue(encoder.encode(obsSseEndFrame(taskId, session)));
          controller.close();
          return;
        }
        if (step.newEvents === 0) controller.enqueue(encoder.encode(OBS_SSE_PING_FRAME));
        const waiter = createObsStreamWaiter(deps);
        pending = waiter;
        await waiter.promise;
        if (pending === waiter) pending = null;
      }
    } catch (err) {
      // 大声失败,然后关流:让客户端的 EventSource 按标准带 Last-Event-ID 重连。
      deps.warn(`obs_stream_pump_failed task=${taskId} err=${String(err).slice(0, 300)}`);
      try {
        controller.close();
      } catch {
        // 断开与收尾的竞态:控制器已被 cancel 时 close 会抛 —— 那正是我们要的结果。
      }
    } finally {
      pending = null;
      pumpDone.resolve();
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      void pump(controller);
    },
    cancel() {
      stop();
    },
  });

  return {
    response: new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        // 不缓存、不代理缓冲:一条被中间盒攒住的 SSE 与没有 SSE 等价。
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
      },
    }),
    get settled() {
      return pumpDone.promise;
    },
    stop,
  };
}

/**
 * `Last-Event-ID` 的校验:缺省(header 不在)= 0 = 从流头回放全部已有事件。
 *
 * header 出现了但值为空 **不是**「缺省」—— 与 `parseObsAfter` 对 `?after=` 的判法同理:
 * 把空值当 0 会让一次写错的续传从头重放整条流。非法 → 400 `invalid_last_event_id`,
 * 风格与 events 端点的 `invalid_after` 一致。
 *
 * 比 `Number(raw)` 更严:只接受十进制数字串。`Number` 会把 `0x10` 读成 16、`1e3` 读成
 * 1000 —— 一个续传游标被悄悄换算是**漏读**(位置 16 之前的全部事件被跳过),而这条路径
 * 上没有任何东西会发现。超出安全整数的同样拒绝(它必然读不出真实位置)。
 */
export function parseObsLastEventId(raw: string | null): { value: number; error: string | null } {
  if (raw === null) return { value: 0, error: null };
  const text = raw.trim();
  if (!/^\d+$/.test(text)) {
    return { value: 0, error: "last-event-id must be a non-negative integer" };
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) {
    return { value: 0, error: "last-event-id is beyond the readable range" };
  }
  return { value: parsed, error: null };
}
