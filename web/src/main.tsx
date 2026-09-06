import { createRoot } from "react-dom/client";

// 顺序即层叠:主题色 → 尺子 → 工具类。三者都是纯 CSS 变量与 class,没有框架。
import "./styles/theme.css";
import "./styles/scale.css";
import "./styles/base.css";

const container = document.getElementById("root");
if (!container) throw new Error("#root is missing in index.html");

// 工程基座占位(w2a-v2 writer 交付 App 壳与主题逻辑后重写本文件):
// 只保证 Vite 入口依赖图闭合、CSS 基座随构建产出。
createRoot(container).render(null);
