import type { ReactNode } from "react";

import { toneClass, type Tone } from "../lib/view";

/**
 * 状态徽章(四态三件套的唯一渲染出口)。
 *
 * 单独一个组件只为守住一条纪律:**底色/描边/字色必须成组换**(§7 设计语言)。
 * 让组件直接写 `ca-state--warn` 也能跑,但下一步就有人会去补一句 `style={{color}}`
 * 而把三件套拆开 —— 拆开的表现是「浅色主题下这块字看不见」,而暗色永远绿。
 * 色调值由数据层算好传进来(view.ts / stream-protocol.ts),这里不做任何判定。
 */
export function StatusBadge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={toneClass(tone)}>{children}</span>;
}
