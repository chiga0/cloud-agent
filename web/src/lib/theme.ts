/**
 * 主题选择与落定(docs/product.md §4 技术栈 / §7 设计语言在 w2a 的唯一逻辑面)。
 *
 * 三条规则,按权威等级排:
 *
 * 1. **手动选择是权威**:localStorage 里有一个合法值就照它渲染,此后操作系统的偏好不再
 *    改页面(所以 `setTheme` 会同时退订系统监听 —— 留着它,「手动选了却被 OS 改回去」
 *    就会在用户眼皮底下发生)。回到「跟随系统」的唯一动作是删掉那个键。
 * 2. **没有手动选择才跟随 `prefers-color-scheme`**,并订阅系统变化实时跟随。
 * 3. **渲染只做一件事**:暗色是 theme.css 里 `:root` 的缺省,所以 light → 置
 *    `data-theme="light"`,dark → 移掉该属性(置/移,不写第二个值)。
 *
 * 这里不出现任何色值,也不写任何 CSS 变量:`--bg`/`--fg`/四态色的唯一定义处是 theme.css,
 * 两套主题的变量名集合由它自己保证(逐字一致),test/web-theme-tokens.test.ts 钉着。
 * 复制一份的第二套变量迟早与它漂移,而漂移的表现是「只有暗色是对的」。
 *
 * 模块顶层不碰 document/localStorage —— 导入即生效的副作用会让「谁先落主题」变成读代码猜,
 * 而落定顺序正是防闪帧的机制本身(见 main.tsx)。
 */

export type Theme = "dark" | "light";

/** theme.css 里浅色块的选择器所读的属性。 */
export const THEME_ATTRIBUTE = "data-theme";

/** 手动选择的存放点;值域就是 `Theme`。删键 = 回到跟随系统。 */
export const STORAGE_KEY = "ca-theme";

const LIGHT_QUERY = "(prefers-color-scheme: light)";

/** 与 theme.css 的 `:root` 缺省同值:在 initTheme() 之前被读到也不能是错的方向。 */
let current: Theme = "dark";

const listeners = new Set<() => void>();

/** 系统偏好订阅(有手动选择时恒为 null)。 */
let systemSubscription: { media: MediaQueryList; handler: () => void } | null = null;

function mediaQuery(): MediaQueryList | null {
  return typeof matchMedia === "function" ? matchMedia(LIGHT_QUERY) : null;
}

function systemTheme(): Theme {
  return mediaQuery()?.matches ? "light" : "dark";
}

/**
 * 读取手动选择。只认 `"light"`/`"dark"` 两个字面量,其余(旧版本留下的、别的标签页
 * 写坏的、值被改成空串的)一律当「没有手动选择」→ 跟随系统,而不是照抄一个渲染不出来的值。
 */
function storedTheme(): Theme | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === "light" || raw === "dark" ? raw : null;
  } catch {
    // 浏览器禁存储(Safari 无痕、第三方 cookie 全禁、企业策略)时,连读 `localStorage`
    // 这个 getter 本身都会抛。这是用户能撞上的环境事实,不是防御性装饰:让它冒出去,
    // 首页就在挂载前红屏 —— 而代价不过是「本次会话内可切换、不落盘」。
    return null;
  }
}

/** 置/移 `data-theme`,并通知订阅者。返回传进来的主题,便于链式取用。 */
export function applyTheme(theme: Theme): Theme {
  const root = document.documentElement;
  if (theme === "light") {
    root.setAttribute(THEME_ATTRIBUTE, "light");
  } else {
    root.removeAttribute(THEME_ATTRIBUTE);
  }
  current = theme;
  for (const notify of listeners) notify();
  return theme;
}

/** 当前渲染中的主题(读的是模块内缓存,不碰 DOM,因此可以安全地给 useSyncExternalStore 用)。 */
export function getTheme(): Theme {
  return current;
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 开/关系统偏好跟随。开启时若已有手动选择,保持关闭 —— 手动权威优先。 */
function followSystem(follow: boolean): void {
  if (systemSubscription !== null) {
    systemSubscription.media.removeEventListener("change", systemSubscription.handler);
    systemSubscription = null;
  }
  const media = follow ? mediaQuery() : null;
  if (media === null || storedTheme() !== null) return;
  const handler = () => {
    applyTheme(systemTheme());
  };
  media.addEventListener("change", handler);
  systemSubscription = { media, handler };
}

/**
 * 挂载前落定初始主题(main.tsx 的第一条语句)。返回落定的那个值。
 *
 * 顺序即正确性:React 渲染的第一帧必须已经带着最终 `data-theme`,否则暗色偏好系统上
 * 会先闪一帧另一套配色。`initTheme()` 排在 `createRoot().render()` 之前正是为此。
 */
export function initTheme(): Theme {
  const theme = applyTheme(storedTheme() ?? systemTheme());
  followSystem(true);
  return theme;
}

/** 手动选定主题:写盘(权威)、立即生效、此后不再跟随系统。 */
export function setTheme(theme: Theme): Theme {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // 同上:禁存储时切换照样当场生效,只是下次进入还是跟随系统。不阻塞首页。
  }
  followSystem(false);
  return applyTheme(theme);
}

/** 在两个具体主题之间切换(壳上那个按钮的语义)。 */
export function toggleTheme(): Theme {
  return setTheme(current === "dark" ? "light" : "dark");
}
