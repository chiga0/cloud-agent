import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { Fragment, useEffect } from "react";

import { PagePlaceholder } from "../components/PagePlaceholder";
import { StatusBadge } from "../components/StatusBadge";
import { taskSnapshotQueryKey, taskSnapshotQueryOptions } from "../lib/queries";
import type { TaskSnapshot } from "../lib/schema";
import {
  attemptRowView,
  baselineFacts,
  budgetFacts,
  connectionBadge,
  detailFailureText,
  endFrameLine,
  isTaskNotFound,
  pullNote,
  pullPlanUrl,
  snapshotReadNote,
  stateDisplay,
  streamEnabledFor,
  timelineEmptyText,
  timelineRowView,
  type FactRow,
} from "../lib/task-detail";
import { STREAM_CONNECTED_TEXT, STREAM_ENDED_TEXT } from "../lib/stream-protocol";
import { useTaskTimeline } from "../lib/use-task-timeline";
import { stateTone } from "../lib/view";

/**
 * `/tasks/$taskId` 上半(w4a 交付 ①②③④;§5 那一行的前两块)。
 *
 * 范围:头部状态区 + attempts + 事件时间线 + 停滞/坏帧韧性 + 断线双恢复源。
 * result / evidence / candidate 三块与 `/live` 的退役**顺延 w4b**,本文件末尾那两块
 * 占位件写明了将读的数据源 —— 提前填上它们等于在没有验收边界的地方做投影。
 *
 * 这一份文件里**没有任何判据**:数字、阈值、状态→色、kind→徽章、四种失败各说哪句话、
 * 补齐该不该跑,全部在 `lib/task-detail.ts` 与 `lib/stream-protocol.ts`(w3 的教训:
 * 凡参与取数/判定的值出自纯函数,`.tsx` 只接线)。为什么这么切:测试跑在 Workers 运行时里,
 * 没有 DOM 也没有 `EventSource`,判据留在组件里就钉不住 —— 而这些判据逐条都对应
 * c9b/c9c 在浏览器里踩过的一次误报或漏报。
 *
 * 需浏览器实测(单测覆盖不到,§7 的口径):真实 `EventSource` 按 `STREAM_CONN_RULES` 派发
 * error/open 的形状、时间线在 1000 条上限下的滚动、窄屏下 attempts 六列的横向溢出。
 */

/** 头部说明行里那份「这一页读什么」的一句话。数据源写出来,操作员才知道该去核对什么。 */
const SNAPSHOT_SOURCE = "GET /api/tasks/:id";

export function TaskDetailPage() {
  // 路由参数按名解出(w2b 的占位件验过这件事:参数确实解得出来,而不是被 SPA fallback 兜成一页 HTML)。
  const { taskId } = useParams({ from: "/_auth/tasks/$taskId" });
  const queryClient = useQueryClient();
  const snapshot = useQuery(taskSnapshotQueryOptions(taskId));

  // 取数判据全部出自纯函数:这里只是把三个原始布尔交给它们。
  const notFound = isTaskNotFound(snapshot.error);
  const settled = snapshot.data !== undefined || snapshot.isError;
  const streaming = streamEnabledFor(settled, notFound);
  const timeline = useTaskTimeline(taskId, streaming);
  const { stream, pull } = timeline;

  const ended = stream.ended;
  useEffect(() => {
    // `end` 帧只证明「已非 RUNNING」,精确终态由这条端点回答 —— 所以收尾的那一刻必须重读快照。
    // 这是这一页唯一推进头部的节拍来源:它是事件驱动的,不是又一个轮询(理由见 lib/queries.ts)。
    if (!ended) return;
    void queryClient.invalidateQueries({ queryKey: taskSnapshotQueryKey(taskId) });
  }, [ended, queryClient, taskId]);

  const task = snapshot.data?.task;
  const display = stateDisplay(task?.state ?? null, ended);
  const conn = connectionBadge(
    stream.connection,
    ended,
    STREAM_CONNECTED_TEXT,
    STREAM_ENDED_TEXT,
  );
  const budget = budgetFacts(snapshot.data ?? null);
  const failure = snapshot.isError ? detailFailureText(snapshot.error) : null;

  return (
    <div className="ca-stack">
      <section className="ca-card ca-stack">
        <div className="ca-cluster">
          <h1 className="ca-text-md">
            任务 <code>{taskId}</code>
          </h1>
          <span className="ca-badge">w4a</span>
          <StatusBadge tone={stateTone(display.state)}>{display.state}</StatusBadge>
          <span className="ca-muted ca-text-xs">
            {snapshotReadNote(snapshot.dataUpdatedAt || null, task?.state ?? null)}
          </span>
          <button
            type="button"
            className="ca-btn ca-ml-auto"
            onClick={() => void snapshot.refetch()}
            disabled={snapshot.isFetching}
            title="重读一次 TaskSession 的只读快照(时间线的实时性靠流,不靠这个按钮)"
          >
            {snapshot.isFetching ? "读取中" : "重新读取快照"}
          </button>
        </div>
        <p className="ca-muted ca-text-xs">
          数据源 <code>{SNAPSHOT_SOURCE}</code> —— 它是 TaskSession DO 的只读快照
          (<code>getSnapshot()</code>),不是 D1 归档投影:任务仍在 <code>RUNNING</code>
          期间这里照样有内容。state 的权威只有这一个,本页是投影。
        </p>
        {failure === null ? null : <p className="ca-error-text">{failure}</p>}
        {display.known ? null : (
          <p className="ca-muted ca-text-xs">
            上面那枚徽章不着色:精确 state 本次没读到。已知的只有「流已结束 = 任务已离开
            RUNNING」这一件(它来自 SSE 的 end 帧,给不出具体终态)。
          </p>
        )}
        {task === undefined ? null : (
          <>
            <FactBlock title="基线与 digest" rows={baselineFacts(task)} />
            <FactBlock title="预算与用量" rows={budget.rows} note={budget.boundary} />
            <AttemptTable snapshot={snapshot.data ?? null} />
          </>
        )}
      </section>

      <section className="ca-card ca-stack">
        <div className="ca-cluster">
          <h2 className="ca-text-md">事件时间线</h2>
          <StatusBadge tone={stream.stall.tone}>{stream.stall.text}</StatusBadge>
          <StatusBadge tone={conn.tone}>{conn.text}</StatusBadge>
          {conn.reauth ? (
            // 401 之后唯一有用的动作。`next` 回指本页:`isInternalNextPath` 认这条站内路径,
            // 所以重新登录会回到**这个任务**而不是被丢回列表 —— 操作员本来就是来看它的。
            <Link to="/login" search={{ next: `/tasks/${taskId}` }}>去重新登录</Link>
          ) : null}
          <span className="ca-muted ca-text-xs">{stream.countsText}</span>
          <button
            type="button"
            className="ca-btn ca-ml-auto"
            onClick={timeline.pullAgain}
            title="用拉取端点续读一段(after = 补齐已覆盖的条数)。流已 CLOSED 而不再自动重连时,这是唯一的续读出口。"
          >
            手动补齐
          </button>
        </div>
        <p className="ca-muted ca-text-xs">
          两条恢复源:推是 <code>{timeline.streamPath ?? "(未开流)"}</code>(原生
          <code>EventSource</code>,断线由浏览器带 <code>Last-Event-ID</code> 自动重连);
          拉是 <code>GET /api/tasks/:id/events?after=</code> —— 那个 after 说的是
          <strong>扁平流里已读的条数</strong>,不是事件的 <code>seq</code>(seq 只在
          attempt/generation 内单调,拿它当跨 attempt 的续读点会静默漏读:判据见
          <code>src/index.ts</code> 的 <code>parseObsAfter</code> 注释)。停滞三色走
          <code>taskStallView</code>:判据是「无新事件」,阈值与文案在
          <code>lib/stream-protocol.ts</code>(权威 = product.md §5,本页不自带数字);
          同文件里监督器那套 <code>stallView</code> 是 <code>/live</code> 的口径,两者是
          两套判据,本页把前者显式传给了 hook。
        </p>
        <p className="ca-muted ca-text-xs">{pullNote(pull, streaming)}</p>
        <p className="ca-muted ca-text-xs">
          下一次补齐会读 <code>{pullPlanUrl(taskId, pull)}</code>
          {" —— "}位置游标只由补齐通道自己记账,与流报到的帧数各自独立(两把尺互相核对,不互相覆盖)。
        </p>
        {ended ? (
          <p className="ca-muted ca-text-xs">{endFrameLine(STREAM_ENDED_TEXT, stream.endEvents)}</p>
        ) : null}
        {stream.unreadableAttempts.length > 0 ? (
          <p className="ca-error-text">
            这些 attempt 的 journal 读不到:<code>{stream.unreadableAttempts.join(", ")}</code>
            —— 流没有因此停下,但这一页看到的是不完整的视图。
          </p>
        ) : null}
        {timeline.entries.length === 0 ? (
          <p className="ca-muted">
            {timelineEmptyText(pull, timeline.streamFrames, notFound || snapshot.isError)}
          </p>
        ) : (
          <ol className="ca-timeline">
            {timeline.entries.map((entry) => {
              const row = timelineRowView(entry);
              return (
                <li key={entry.key} className="ca-cluster">
                  <span className="ca-num ca-muted ca-text-xs" title="补齐段 = 扁平流里的位置;流段 = 只按到达序接在后面">
                    {row.positionLabel}
                  </span>
                  <span className="ca-num ca-text-xs">#{entry.seq}</span>
                  <span className={row.badgeClass}>{entry.kind}</span>
                  <span className="ca-muted ca-text-xs">{entry.ts}</span>
                  <span>{row.text}</span>
                  {row.note === "" ? null : <span className="ca-dim ca-text-xs">{row.note}</span>}
                  {row.extra === "" ? null : <span className="ca-muted ca-text-xs">{row.extra}</span>}
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <PagePlaceholder
        title="result / evidence / candidate"
        wave="w4b"
        sources={[
          "GET /api/tasks/:id/result",
          "GET /api/tasks/:id/evidence",
          "GET /api/tasks/:id/candidate",
        ]}
      >
        <p className="ca-muted ca-text-xs">
          先说清这一块占位的范围:上面两块(头部状态区 + 事件时间线)已经由 w4a 落地,
          <strong>缺的是这一页的下半三块</strong>,连同 <code>/live/:taskId</code> 的退役
          (按 §5:退役的是那个页面与路由,SSE 数据端点保留)一起顺延给 w4b。
          将读的口径已经写清:<code>result_text</code> 其实已经在这页读到的快照里
          (<code>task.result_text</code>),只是按 §5 的分区它属于 result 区;
          <code>evidence</code> 与 <code>candidate</code> 是两条独立端点 ——
          后者的 <code>?format=patch</code> 会在下发前重算字节 sha256(不一致即
          <code>integrity_error</code>),那一棒要把它连同 <code>warnings</code>
          一起如实带出来。本棒 <code>src/</code> 禁动,所以这三块的读法也不在这里先建。
        </p>
      </PagePlaceholder>
    </div>
  );
}

/**
 * 一块「标签 → 值」。
 *
 * `absent` 的行仍要渲染出来而不是被滤掉:`—` 说的是「这一页读不到这个字段」,
 * 而把它滤掉等于让操作员以为这一栏没有意义(与 null ≠ 0 同一条纪律)。
 * 完整值一律进 `title`:截断是排版手段,不是信息的删除。
 *
 * 两列靠 `.ca-kv` 的 grid 自动落位(标签/值成对出现),所以这里**不**给每行包一层 div ——
 * 包一层就把两列打回各自成列了。
 */
function FactBlock({
  title,
  rows,
  note = "",
}: {
  title: string;
  rows: readonly FactRow[];
  note?: string;
}) {
  return (
    <div className="ca-stack">
      <span className="ca-label">{title}</span>
      <div className="ca-kv">
        {rows.map((row) => (
          <Fragment key={row.label}>
            <span className="ca-muted">{row.label}</span>
            <span className={row.absent ? "ca-dim" : "ca-num"} title={row.note}>
              {row.value}
            </span>
          </Fragment>
        ))}
      </div>
      {note === "" ? null : <p className="ca-muted ca-text-xs">{note}</p>}
    </div>
  );
}

/**
 * attempts 表。
 *
 * 列 = §5 点名的三件事(role / 终态 / 时间)再加用量与时长。**不加排序**:服务端给的就是
 * 创建序,而创建序在这份数据里是语义本身(返工轮的因果链按它排),本地重排等于造一个
 * 服务端没有的顺序。终态不着色的理由写在 `lib/task-detail.ts` 的 `attemptRowView` 上。
 */
function AttemptTable({ snapshot }: { snapshot: TaskSnapshot | null }) {
  if (snapshot === null) return null;
  return (
    <div className="ca-stack">
      <span className="ca-label">attempts({snapshot.attempts.length} 轮,服务端数组序 = 创建序)</span>
      <table className="ca-table">
        <thead>
          <tr>
            <th>role</th>
            <th>state</th>
            <th>tokens_used</th>
            <th>created_at</th>
            <th>finished_at</th>
            <th>时长</th>
          </tr>
        </thead>
        <tbody>
          {snapshot.attempts.map((attempt) => {
            const row = attemptRowView(attempt);
            return (
              <tr key={row.id}>
                <td title={`attempt id:${row.id}`}>
                  <code>{row.shortId}…</code> {row.role}
                </td>
                <td>
                  <span className="ca-badge">{row.state}</span>
                </td>
                <td className="ca-num">{row.tokens}</td>
                <td className="ca-text-xs">{row.created}</td>
                <td className="ca-text-xs">{row.finished}</td>
                <td className="ca-num ca-text-xs">{row.duration}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
