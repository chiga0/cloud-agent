import { ThemeToggle } from "./components/ThemeToggle";

/**
 * 部署后 `/` 的真实首页(w2a 的壳)。**禁止空白**:静态资产一挂上,这里就是用户看到的
 * 第一页,渲染不出东西的故障形状与「后端整站挂了」在浏览器里长得一模一样。
 *
 * 刻意只有三样:产品名、一句状态说明、主题切换。页面清单(docs/product.md §5)由 w3–w6
 * 逐页接入,那之前这里没有任何数据形状可渲染 —— 现在多放一张卡片,就是给还没接的后端
 * 编一个投影,而前端是投影这件事由后端权威说了算(§1 的不变量)。
 *
 * 样式全部挂 base.css 的 `ca-` 工具类(4px 栅格 + 双主题 token),本文件不出现任何
 * 字面色值/尺寸,也不新增 class:由 test/web-theme-tokens.test.ts 双向钉住
 * (组件里的 class 必须在 base.css 里有定义、色值的唯一出口是 theme.css)。
 */
export function App() {
  return (
    <main className="ca-shell ca-stack">
      <header className="ca-cluster">
        <h1 className="ca-text-md">cloud-agent</h1>
        <span className="ca-badge">前端基座 · w2a</span>
        <div className="ca-cluster ca-ml-auto">
          <ThemeToggle />
        </div>
      </header>
      <p className="ca-muted">
        运维看板的前端与 API 同源部署在同一个 Worker 上:页面走静态资产,数据仍只认{" "}
        <code>/api/*</code>(无 CORS、会话 cookie 与 SSE 直接可用);任务列表、任务详情、
        审批与审计四页按 w3–w6 逐页接入,此刻这里只有壳。
      </p>
    </main>
  );
}
