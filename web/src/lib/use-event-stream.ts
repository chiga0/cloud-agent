/**
 * `EventSource` 的 React 封装(w2b 交付 ④)。
 *
 * 这一层刻意薄到只剩三件事:**开一条流、把帧交给纯协议层、把结果塞进 state**。
 * 全部判定(停滞三色、坏帧计数、readyState 双文案、end 停表)在 stream-protocol.ts 里,
 * 那里可测;这里的正确性只能浏览器实测(⚠️ 需浏览器实测:单测环境没有 EventSource,
 * 而「浏览器真的按这张表派发 error/open 事件」正是 c9b 化 42s 并排探针才换来的结论)。
 *
 * 三条值得单独说明的实现选择:
 *
 * 1. **不走 React Query**。事件流是增量流不是快照(§4):一帧只带来一个新事件,
 *    要缓存就得在前端拼出全量列表,那份列表与续传点(Last-Event-ID)从此是两套真相。
 *    断线重连交给 EventSource:帧 id 与 `GET /events?after=` 同口径(§9.6 不变量 1),
 *    浏览器自己会把最后看到的 id 回传,既不重发也不漏读,前端一行续传代码都不该写。
 * 2. **秒表只驱动重画,不参与计时**。`nowMs` 每秒进一次 state,而停滞时长是
 *    `nowMs - clock.lastAnyMs`。hidden tab 里浏览器把 interval 压到一分钟一次甚至冻结,
 *    回来时算的是真实差值而不是「被压掉的那 59 次 +59 秒」(c9b 实测过的坑,§4 明写)。
 *    计时累加器(每次 tick `sec += 1`)是这条纪律唯一会做错的地方,所以这里不存在累加器。
 * 3. **时钟与重连数放 ref 不放 state**。它们是「事件到达」的副产品,不参与渲染判定
 *    (渲染读的是 `stallView` 的输出),放 state 会让每帧触发两次重排;
 *    而放 ref 的风险(改了不重画)由「同一批帧必然同时 setState(events/counts)」抵消。
 *
 * `path` 传 null 表示不开流(任务已终态、或页面还没拿到 id):返回空快照,不建连接。
 */

import { useEffect, useMemo, useRef, useState } from "react";

import {
  SSE_AGENT_EVENT,
  SSE_END_EVENT,
  createStallClock,
  advanceStallClock,
  parseStreamFrame,
  stallView,
  streamCountsText,
  streamErrorView,
  STREAM_CONNECTED_TEXT,
  type StallClock,
  type StallView,
  type StreamConnView,
  type StreamCounts,
  type StreamEventView,
} from "./stream-protocol";

/** 停滞三色的判据函数形状:hook 只管喂时钟,选哪套判据由调用方钉死。 */
export type StallViewFn = (clock: StallClock, nowMs: number, ended: boolean) => StallView;

/**
 * 时间线的内存上限。长跑 attempt 实测 450+ 条且仍在涨(c9b),而页面可能挂一整天:
 * 无上限的数组在观测页上是真实的内存故障。保留**最新**的 N 条 —— 停滞判据靠时间源不靠
 * 历史,截断不影响它;要看全文有 `GET /api/tasks/:id/events`。
 */
export const STREAM_EVENT_BUFFER_LIMIT = 1000;

export interface EventStreamState {
  readonly events: StreamEventView[];
  readonly counts: StreamCounts;
  readonly countsText: string;
  readonly stall: ReturnType<typeof stallView>;
  /** null = 连接正常(没有未恢复的 error)。非 null 时的文案即 §5 要求的那两种分支。 */
  readonly connection: StreamConnView | null;
  readonly connectionText: string;
  readonly ended: boolean;
  /** end 帧带来的续传点(已读条数)。null = 还没收到 end 帧或它读不懂。 */
  readonly endEvents: number | null;
  readonly unreadableAttempts: string[];
}

const EMPTY_COUNTS: StreamCounts = { seen: 0, bad: 0, reconnects: 0 };

export function useEventStream(path: string | null, stallOf: StallViewFn = stallView): EventStreamState {
  const [events, setEvents] = useState<StreamEventView[]>([]);
  const [counts, setCounts] = useState<StreamCounts>(EMPTY_COUNTS);
  const [connection, setConnection] = useState<StreamConnView | null>(null);
  const [ended, setEnded] = useState<{ value: boolean; events: number | null; unreadable: string[] }>(
    { value: false, events: null, unreadable: [] },
  );
  // 秒针:只决定重画频率。见文件头第 2 条。
  const [nowMs, setNowMs] = useState(() => Date.now());
  const clockRef = useRef<StallClock>(createStallClock(Date.now()));
  const reconnectsRef = useRef(0);
  // ended 的镜像:事件处理器(onerror)是 effect 闭包,state 快照对它永远停在创建时刻,
  // end 的翻转必须走 ref 才可见(2026-09-07 prod:闭包快照让终态页每 ~3s 白计一次重连)。
  const endedRef = useRef(false);

  useEffect(() => {
    if (path === null) return;
    // 一条新的流 = 一套全新的时间源。沿用上一任务的时钟会让「停滞 400s」跨任务漂移,
    // 那个数字比没有数字更危险。
    clockRef.current = createStallClock(Date.now());
    reconnectsRef.current = 0;
    endedRef.current = false;
    setEvents([]);
    setCounts(EMPTY_COUNTS);
    setConnection(null);
    setEnded({ value: false, events: null, unreadable: [] });
    setNowMs(Date.now());

    // withCredentials:同源本来就带 cookie,写出来是为了让「这条流的鉴权靠什么」在代码里可见。
    // §3 的最大红利(EventSource 自动携带 same-origin cookie)就落在这一个参数上。
    const es = new EventSource(path, { withCredentials: true });

    const accept = (frameEvent: string) => (e: MessageEvent) => {
      const frame = parseStreamFrame(frameEvent, typeof e.data === "string" ? e.data : "");
      const now = Date.now();
      if (frame.kind === "bad") {
        // 计数并继续。绝不让单条坏帧停更整页 —— 停更的表现与「任务悬挂」在页面上长得一样,
        // 而那正是这个页面唯一要回答的问题。
        setCounts((prev) => ({ ...prev, bad: prev.bad + 1 }));
        return;
      }
      if (frame.kind === "end") {
        // end 帧只证明「已非 RUNNING」(泵的唯一终止条件),给不出精确终态:
        // 权威终态要读 GET /api/tasks/:id。这里如实标注,不猜。
        // 翻转必须先同步进 ref:onerror 在 effect 闭包里,state 快照对它不可见。
        endedRef.current = true;
        setEnded({ value: true, events: frame.events, unreadable: frame.unreadable });
        // end 即 close:终止条件已到,浏览器对已收尾的流仍会按标准静默重试
        // (2026-09-07 实测终态页每 ~3s 一次 /events),不留这条无意义负载。
        es.close();
        return;
      }
      clockRef.current = advanceStallClock(clockRef.current, frame, now);
      setCounts((prev) => ({ ...prev, seen: prev.seen + 1 }));
      setEvents((prev) => {
        const next = prev.length >= STREAM_EVENT_BUFFER_LIMIT
          ? prev.slice(prev.length - STREAM_EVENT_BUFFER_LIMIT + 1)
          : prev.slice();
        next.push(frame.event);
        return next;
      });
    };

    es.addEventListener(SSE_AGENT_EVENT, accept(SSE_AGENT_EVENT));
    es.addEventListener(SSE_END_EVENT, accept(SSE_END_EVENT));
    // 未带 event: 的匿名 data 帧也收下,别静默丢(丢一类帧会让计数行替它撒谎)。
    es.onmessage = accept("message");

    es.onopen = () => {
      // 重连成功必须清掉错误文案:否则一次已恢复的断连会永远挂在「正在自动重连」上,
      // 而那时页面看起来仍然「有问题」,操作员会继续等一个不会来的坏消息。
      setConnection(null);
    };

    es.onerror = () => {
      // 裁决在 streamErrorView(判据可测);ended 喂 ref 的最新值 —— 闭包里的 state
      // 快照永远是 false,那会让 end 后服务端关流的每一次报错都被计成「正在重连」。
      const view = streamErrorView(endedRef.current, es.readyState, reconnectsRef.current + 1);
      if (view === null) return;
      if (view.reconnecting) {
        // 只有浏览器真会重连时才记这一次 —— 否则「重连 N 次」本身是第二处谎。
        reconnectsRef.current += 1;
        setCounts((prev) => ({ ...prev, reconnects: reconnectsRef.current }));
      }
      setConnection(view);
    };

    return () => {
      es.close();
    };
    // path 是唯一依赖:ended / events 之类的变化不该重开一条流(那会丢时间线),
    // 只有「换一条流」才需要重建。事件处理器要读「最新」ended 的地方一律走
    // endedRef(ref 是唯一能穿过闭包快照的通道),不许读 state 快照。
  }, [path]);

  useEffect(() => {
    if (path === null || ended.value) return;
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [path, ended.value]);

  const stall = useMemo(
    () => stallOf(clockRef.current, nowMs, ended.value),
    // clockRef 是 ref:它的变化由 events/counts 的那次 setState 带进渲染,
    // 这里显式列上依赖,让「帧到了必须重算」成为可读的事实。stallOf 是调用方
    // 传入的具名纯函数,引用恒稳定,列上是声明不是补救。
    [nowMs, ended.value, events, counts, stallOf],
  );

  return {
    events,
    counts,
    countsText: streamCountsText(counts),
    stall,
    connection,
    connectionText: connection === null ? STREAM_CONNECTED_TEXT : connection.text,
    ended: ended.value,
    endEvents: ended.events,
    unreadableAttempts: ended.unreadable,
  };
}
