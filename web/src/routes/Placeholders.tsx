import { PagePlaceholder } from "../components/PagePlaceholder";

/**
 * 还没接入的页面共用的形状说明件(w4a 起剩两条整页 + 详情内的分块占位)。
 *
 * 为什么占位页要长得像一份规格而不是「TODO」:这一页会被真实部署后被操作员看到,
 * 而那时最有用的信息是「哪一棒接管它、接管之后会读到哪个端点」。这两个事实直接来自
 * docs/product.md §5 的清单,写在这里等于把路由与规格绑住 —— 有人想顺手把页面填上时,
 * 他会先撞见这段写明「本棒不实现」的话。
 *
 * 刻意不画骨架屏、不放假表格:一个空 `<table>` 配上假列名就是一个「投影」,
 * 而投影必须来自真实数据(§1 的不变量:前端是投影,不做任何权威判定)。
 *
 * `/tasks/$taskId` 原来也在这里,已由 w4a 换成真页面(`routes/TaskDetailPage.tsx` 的上半);
 * 那一棒的拆围把 result/evidence/candidate 与 `/live` 退役留给 w4b,那三块以同一形状的
 * 说明件挂在详情页里 —— 范围栅栏对剩下这两页仍然有效:每一页都只到「能导航过去、能过
 * guard、能显示自己还没实现」为止。
 */

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
