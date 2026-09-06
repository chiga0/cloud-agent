import { createRoot } from "react-dom/client";

import { App } from "./App";
import { initTheme } from "./lib/theme";

// 顺序即层叠:主题色 → 尺子 → 工具类。三者都是纯 CSS 变量与 class,没有框架。
import "./styles/theme.css";
import "./styles/scale.css";
import "./styles/base.css";

const container = document.getElementById("root");
if (!container) throw new Error("#root is missing in index.html");

// 主题必须在 React 挂载之前落定(防闪帧):第一帧渲染就得带着最终的 data-theme,
// 否则手动/系统偏好与 `:root` 缺省不一致时,用户会先看到一帧另一套配色。
// 顺序由 test/web-theme-tokens.test.ts 钉住 —— 它读的是这里的源码位置关系,
// 把 initTheme() 挪进组件、或改回 render(null),钉子立刻红。
initTheme();

createRoot(container).render(<App />);
