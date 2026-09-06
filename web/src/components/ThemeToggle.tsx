import { useSyncExternalStore } from "react";

import { getTheme, subscribeTheme, toggleTheme, type Theme } from "../lib/theme";

const LABEL: Record<Theme, string> = { dark: "暗色", light: "浅色" };

/**
 * 主题切换按钮(w2a 壳上唯一可交互的控件)。
 *
 * 状态来源是 theme.ts 的缓存值而不是组件本地 state:本地一份、`data-theme` 一份就是
 * 两套权威,系统偏好变化(或将来多一个切换入口)时必然打架。`subscribeTheme` 让按钮
 * 跟着**实际渲染中**的主题走 —— 包括用户没点、由操作系统改色的那一类变化。
 *
 * 类名只有 `ca-btn`(base.css),没有任何内联样式与字面色值。
 */
export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribeTheme, getTheme);
  const target = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      className="ca-btn"
      onClick={() => {
        toggleTheme();
      }}
      aria-label={`当前 ${LABEL[theme]}主题,切换为 ${LABEL[target]}`}
    >
      {`主题 ${LABEL[theme]}`}
    </button>
  );
}
