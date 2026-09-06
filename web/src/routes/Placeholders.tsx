import { useParams } from "@tanstack/react-router";

import { PagePlaceholder } from "../components/PagePlaceholder";

/**
 * 还没接入的页面共用的形状说明件(w3 起剩三条)。
 *
 * `/` 任务列表原本也在这里,已由 w3 换成真页面(`routes/TasksIndexPage.tsx`)——
 * 范围栅栏对剩下那三页仍然有效:每一页都只到「能导航过去、能过 guard、能显示自己还没实现」
 * 为止,把任何一页真的填上都是越界:§5 的拆棒是按数据源与验收边界切的,提前实现的那一半没人验收,
 * 也不会在它那一棒的预算里被复查。
 *
 * 唯一的「数据」是路由参数本身:`/tasks/$taskId` 的 id 来自 TanStack 的类型化 params,
 * 显示它是为了钉住一件事 —— 参数确实按名解出来了,而不是被 SPA fallback 兜成整页 HTML
 * (§2 的分区动机)。w4 会读同一条 params,不需要再解一次 URL。
 */

export function TaskDetailPage() {
  const { taskId } = useParams({ from: "/_auth/tasks/$taskId" });
  return (
    <PagePlaceholder title="任务详情" wave="w4" sources={["GET /api/tasks/:id", "GET /api/tasks/:id/events", "GET /api/tasks/:id/events/stream"]}>
      <p className="ca-muted">
        路由参数 <code>taskId</code> = <code>{taskId}</code>
      </p>
    </PagePlaceholder>
  );
}

export function ApprovalsPage() {
  return (
    <PagePlaceholder
      title="审批"
      wave="w5"
      sources={["GET /api/admin/tasks?state=AWAITING_APPROVAL", "POST /api/tasks/:id/approve"]}
    />
  );
}

export function AuditPage() {
  return (
    <PagePlaceholder
      title="审计"
      wave="w6"
      sources={["GET /api/admin/events", "GET /api/admin/chain-check"]}
    />
  );
}

/**
 * 客户端路由的 404:站内没有任何一条路由匹配上时由根路由渲染。
 *
 * 为什么必须自己给一个:`not_found_handling: "single-page-application"` 会把**任何**
 * 未匹配的 GET 变成 200 + index.html,于是「路径打错了」这件事在浏览器里唯一的落点
 * 就是路由层。留白屏会被读成「后端挂了」,而那两句话的处置完全不同。
 */
export function NotFoundPage() {
  return (
    <main className="ca-shell ca-stack">
      <h1 className="ca-text-md">这条路径在本站内没有对应页面</h1>
      <p className="ca-muted">
        站内可导航的路径只有 <code>/login</code>、<code>/</code>、<code>/tasks/&lt;taskId&gt;</code>、
        <code>/approvals</code>、<code>/audit</code>。API 一律在 <code>/api/*</code> 之下 ——
        直接敲地址栏访问 API 会拿到 JSON 而不是页面,这是 §2 分区表的规定形状。
      </p>
    </main>
  );
}
