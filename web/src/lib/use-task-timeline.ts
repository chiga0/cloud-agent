/**
 * `/tasks/$taskId` 时间线的接线(w4a 交付 ②③④)。
 *
 * 这一层**只做接线**,一个判据都不写:停滞三色、坏帧计数、readyState 双文案在
 * `lib/stream-protocol.ts`(w2b 交付,由 test/web-stream-protocol.test.ts 与 worker 侧权威
 * 逐值比对),补齐的触发条件、翻页终止、合并与文案在 `lib/task-detail.ts`(由
 * test/web-task-detail.test.ts 真跑函数钉)。这里如果冒出一句 `if (seconds > 90)` 或一个
 * `"agent"` 字面量,那些钉子就管不到它了 —— 复制协议字面量是派单里明令禁止的那件事。
 *
 * ## 两个通道、一条时间线
 *
 * ```
 * SSE(useEventStream:全站唯一开 EventSource 的地方)──┐
 *                                                    ├─ mergeTimeline ─ 渲染
 * GET /api/tasks/:id/events?after=(本页一页一页翻)────┘
 * ```
 *
 * 四条实现选择值得单独说明:
 *
 * 1. **补齐的进度是本页的局部状态,不进 Query 缓存**。它是「已读条数」而不是一份列表:进了
 *    Query 就有了两份真相(缓存里的列表 + 续读点),而 §4 把事件流挡在 Query 外面的理由
 *    在拉这一侧同样成立 —— 它也是增量流,不是快照。
 * 2. **一次只跑一个补齐循环**(`runningRef`)。触发点 `start` 是从 `pull` 算出来的,而循环
 *    每翻一页都改 `pull`,于是 `start` 跟着变 —— 不加这道闩,effect 会在翻页途中重挂载,
 *    两个循环各读各的位置,页面拿到两份交错的前缀。这不是假想的复杂度:「依赖里放了自己
 *    要改的状态」就是这个形状。
 * 3. **补齐状态按 taskId 归主(`owner`)而不是靠 effect 清**。换任务时如果只靠 effect 里
 *    `setPull(INITIAL)`,那么在 taskId 已经变了、state 还是旧的那一帧里,`start` 会算出
 *    一个**上一个任务的覆盖率**并拿去给新任务发请求 —— 表现是新任务的时间线从中间开始,
 *    而「从中间开始」在这个页面上的意思恰恰是「前面那段我看不见」。派生而不是清理,
 *    这类时序就没有窗口。
 * 4. **手动补齐是一个动作,不是一个判据**。流 CLOSED 且已翻尽时,页面不会自动再拉(那是
 *    第三个节拍,§4 没给这一页);想知道「现在有没有新的」只能由人按下去。
 *
 * `enabled=false`(任务快照 404 或根本没读出来)时**两件事都不做**:不开流、不补齐。
 * 对一个服务端已经回答「没有这个任务」的 id 再开一条流,得到的 404 会以
 * `readyState=CLOSED` 的形态被解释成「会话失效」—— 那是把「id 不存在」说成「你没登录」。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { taskStreamUrl } from "./queries";
import {
  INITIAL_PULL,
  mergeTimeline,
  pullStartAfter,
  runEventsPull,
  streamFramesOf,
  type PullState,
  type TimelineEntry,
} from "./task-detail";
import { useEventStream, type EventStreamState } from "./use-event-stream";
import { taskStallView } from "./stream-protocol";

export interface TaskTimeline {
  /** 两个通道合并后的时间线(位置可信的补齐段在前,流的增量段在后)。 */
  readonly entries: TimelineEntry[];
  /** 补齐通道的状态:覆盖率、请求数、坏形状计数、unreadable attempts、失败文案。 */
  readonly pull: PullState;
  /** 手动再补一次:从当前覆盖率续读新的一段。 */
  readonly pullAgain: () => void;
  /** 流通道原样交出:stall / counts / connection / ended / endEvents 全在这里。 */
  readonly stream: EventStreamState;
  /** 本页实际使用的流路径(`null` = 没开)。给「数据源」说明行用,不参与任何判定。 */
  readonly streamPath: string | null;
  /** 流侧位置口径(已消费帧数,含坏帧):与 `?after=` 同一个单位。 */
  readonly streamFrames: number;
}

/** 补齐状态与它属于哪个任务绑在一起(`owner` 那一条理由见文件头第 3 条)。 */
interface PullBox {
  readonly owner: string;
  readonly state: PullState;
}

export function useTaskTimeline(taskId: string, enabled: boolean): TaskTimeline {
  const streamPath = enabled ? taskStreamUrl(taskId) : null;
  // 停滞三色显式指到 taskStallView(product.md §5 的 90/300「无新事件」口径):
  // 缺省的 stallView 是监督器那对 900/180(/live 口径),两个判据的分工见 stream-protocol.ts。
  const stream = useEventStream(streamPath, taskStallView);
  const [box, setBox] = useState<PullBox>({ owner: taskId, state: INITIAL_PULL });
  const pull = box.owner === taskId ? box.state : INITIAL_PULL;
  const runningRef = useRef(false);
  const [manualRun, setManualRun] = useState(0);
  const manualSeenRef = useRef(0);

  const manual = manualRun !== manualSeenRef.current;
  const streamFrames = streamFramesOf(stream.counts);
  const start = pullStartAfter({
    streaming: streamPath !== null,
    connected: stream.connection === null,
    badFrames: stream.counts.bad,
    streamFrames,
    ended: stream.ended,
    endEvents: stream.endEvents,
    pull,
    manual,
  });
  // effect 的依赖用这个**布尔**而不是 `start` 那个数字:补齐循环每翻一页都会提交新的
  // `pulled`,于是 `start` 跟着变 —— 把它放进依赖,effect 会在翻页途中重挂载自己,
  // 两个循环各读各的位置,页面拿到两份交错的前缀(文件头第 2 条)。
  const needsPull = start !== null;

  useEffect(() => {
    if (!needsPull || runningRef.current) return;
    let cancelled = false;
    const from = start;
    runningRef.current = true;
    manualSeenRef.current = manualRun;
    const commit = (next: PullState) => {
      if (!cancelled) setBox({ owner: taskId, state: next });
    };
    const release = () => {
      runningRef.current = false;
    };
    void runEventsPull(taskId, from, pull, commit).then(release, release);
    return () => {
      cancelled = true;
      runningRef.current = false;
    };
  }, [taskId, manualRun, needsPull]);

  const pullAgain = useCallback(() => setManualRun((value) => value + 1), []);

  const entries = useMemo(
    () => mergeTimeline(pull.items, stream.events),
    [pull.items, stream.events],
  );

  return {
    entries,
    pull,
    pullAgain,
    stream,
    streamPath,
    streamFrames,
  };
}
