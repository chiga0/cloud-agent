import type { ReactNode } from "react";

/**
 * 还没接入的页面共用的形状说明件(w2b)。
 *
 * 为什么占位页要长得像一份规格而不是「TODO」:这一页会被真实部署后被操作员看到,
 * 而那时最有用的信息是「哪一棒接管它、接管之后会读到哪个端点」。这两个事实直接来自
 * docs/product.md §5 的清单,写在这里等于把路由与规格绑住 —— 有人想顺手把页面填上时,
 * 他会先撞见这段写明「本棒不实现」的话。
 *
 * 刻意不画骨架屏、不放假表格:一个空 `<table>` 配上假列名就是一个「投影」,
 * 而投影必须来自真实数据(§1 的不变量:前端是投影,不做任何权威判定)。
 *
 * 没有任何内联 style:尺寸与颜色的唯一出口是 base.css/theme.css/scale.css 那三个文件。
 */
export function PagePlaceholder({
  title,
  wave,
  sources,
  children,
}: {
  title: string;
  wave: string;
  sources: readonly string[];
  children?: ReactNode;
}) {
  return (
    <section className="ca-card ca-stack">
      <div className="ca-cluster">
        <h2 className="ca-text-md">{title}</h2>
        <span className="ca-badge">{wave}</span>
      </div>
      <p className="ca-muted">
        本页由 <code>{wave}</code> 接入。路由、鉴权与数据层已就位,缺的是页面本身 ——
        范围栅栏写明了那一棒之前的任何内容都不该出现在这里。
      </p>
      <div className="ca-field">
        <span className="ca-label">数据源</span>
        {sources.map((source) => (
          <code key={source}>{source}</code>
        ))}
      </div>
      {children}
    </section>
  );
}
