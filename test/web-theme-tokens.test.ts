import { describe, expect, it } from "vitest";

import appRaw from "../web/src/App.tsx?raw";
import routerRaw from "../web/src/router.tsx?raw";
import authedLayoutRaw from "../web/src/components/AuthedLayout.tsx?raw";
import dataTableRaw from "../web/src/components/DataTable.tsx?raw";
import pagePlaceholderRaw from "../web/src/components/PagePlaceholder.tsx?raw";
import statusBadgeRaw from "../web/src/components/StatusBadge.tsx?raw";
import themeToggleRaw from "../web/src/components/ThemeToggle.tsx?raw";
import loginPageRaw from "../web/src/routes/LoginPage.tsx?raw";
import placeholdersRaw from "../web/src/routes/Placeholders.tsx?raw";
import tasksIndexPageRaw from "../web/src/routes/TasksIndexPage.tsx?raw";
import themeLibRaw from "../web/src/lib/theme.ts?raw";
import apiLibRaw from "../web/src/lib/api.ts?raw";
import authLibRaw from "../web/src/lib/auth.ts?raw";
import kindsLibRaw from "../web/src/lib/kinds.ts?raw";
import queriesLibRaw from "../web/src/lib/queries.ts?raw";
import queryClientLibRaw from "../web/src/lib/query-client.ts?raw";
import schemaLibRaw from "../web/src/lib/schema.ts?raw";
import streamProtocolLibRaw from "../web/src/lib/stream-protocol.ts?raw";
import tasksPageLibRaw from "../web/src/lib/tasks-page.ts?raw";
import useEventStreamLibRaw from "../web/src/lib/use-event-stream.ts?raw";
import viewLibRaw from "../web/src/lib/view.ts?raw";
import mainRaw from "../web/src/main.tsx?raw";

/**
 * 设计 token 与样式契约(w2a 定下, w2b 随页面与数据层落地后扩到全部源文件)。
 *
 * 为什么这些事实值得钉、又钉不住在组件测试里:它们全是**跨文件的口头纪律**,而违反的代价
 * 都表现为「只在另一套主题/另一个分辨率下坏」——
 * - theme.css 的两套主题变量名集合若少一个名字,组件在那套主题下静默拿到 `unset`:
 *   边框消失、文字透明。线上现场就是「只有暗色是对的」,而暗色永远绿。
 * - 浅色块必须排在暗色块之后:两者特异度相同(`[data-theme="light"]` 与 `:root` 都是 0,1,0),
 *   覆盖全靠源码顺序赢。调换顺序 = 浅色主题整体失效,一个字都不用改。
 * - 色值的唯一出口是 theme.css。组件里出现 `#0d1117` 的那一刻,它就与主题解绑了 ——
 *   浅色下这块颜色不会跟着变,而没人会去 grep 组件找硬编码。
 * - 间距脱离 4px 栅格(手写的 6px/10px)不会报错,只会让相邻两块「看着不齐」,
 *   并且此后每次改动都在继续放大这个偏差。
 *
 * 样式表原文取自 `__WEB_STYLE_SOURCES__`(vitest.config.ts 构建期内联):Workers 运行时没有
 * fs,而 `.css` 的 `?raw` 在 worker 测试池里恒为空串(样式在 worker 侧本就不执行)。
 * 组件源码走 `?raw`(与 test/web-build-base.test.ts 读 vite.config.ts 同一手法):要钉的是
 * 「源码里有没有写死色值/变量」「挂载顺序对不对」,不需要真的渲染 DOM。
 */

const THEME_DARK = ":root";
const THEME_LIGHT = '[data-theme="light"]';

const styleSources = __WEB_STYLE_SOURCES__;

function css(path: string): string {
  const text = styleSources[path];
  // 空串是这套内联机制唯一会「静默通过」的失败形状:名单里少了文件或读出来是空的,
  // 后面的断言就全在拿 undefined/"" 比 —— 所以在这里当场炸掉。
  expect(typeof text, `vitest.config.ts 没有内联 ${path}`).toBe("string");
  expect((text ?? "").length, `${path} 内联内容为空`).toBeGreaterThan(0);
  return text as string;
}

const themeCss = css("web/src/styles/theme.css");
const scaleCss = css("web/src/styles/scale.css");
const baseCss = css("web/src/styles/base.css");

/**
 * 前端的**全部**源文件(w2b 起页面与数据层落地,名单跟着扩)。
 *
 * 名单是硬编码的,不是 glob:新增一个 .tsx 而没登记进这里,它就从「禁字面色值、只挂
 * base.css 已有 class、不写内联 style」这三条纪律里漏出去了 —— 而漏出去的文件正是最可能
 * 抄来一段组件库样式的那个。硬名单让「漏登记」在这里红,而不是在线上红。
 */
const TSX_SOURCES: Record<string, string> = {
  "web/src/main.tsx": mainRaw,
  "web/src/App.tsx": appRaw,
  "web/src/router.tsx": routerRaw,
  "web/src/components/AuthedLayout.tsx": authedLayoutRaw,
  "web/src/components/DataTable.tsx": dataTableRaw,
  "web/src/components/PagePlaceholder.tsx": pagePlaceholderRaw,
  "web/src/components/StatusBadge.tsx": statusBadgeRaw,
  "web/src/components/ThemeToggle.tsx": themeToggleRaw,
  "web/src/routes/LoginPage.tsx": loginPageRaw,
  "web/src/routes/Placeholders.tsx": placeholdersRaw,
  "web/src/routes/TasksIndexPage.tsx": tasksIndexPageRaw,
};

/**
 * 全部源文件(含 lib 下的 .ts):「禁色值、禁第二套 CSS 变量、禁内联 style」三条同样管它们 ——
 * lib 里也照样能写出 `color: "#0d1117"` 或一套新变量,只扫 .tsx 就是给自己留后门。
 */
const WEB_SOURCES: Record<string, string> = {
  ...TSX_SOURCES,
  "web/src/lib/theme.ts": themeLibRaw,
  "web/src/lib/api.ts": apiLibRaw,
  "web/src/lib/auth.ts": authLibRaw,
  "web/src/lib/kinds.ts": kindsLibRaw,
  "web/src/lib/queries.ts": queriesLibRaw,
  "web/src/lib/query-client.ts": queryClientLibRaw,
  "web/src/lib/schema.ts": schemaLibRaw,
  "web/src/lib/stream-protocol.ts": streamProtocolLibRaw,
  "web/src/lib/tasks-page.ts": tasksPageLibRaw,
  "web/src/lib/use-event-stream.ts": useEventStreamLibRaw,
  "web/src/lib/view.ts": viewLibRaw,
};

/**
 * 名单完整性:登记的文件 == 磁盘上的文件,**双向**都要相等。
 *
 * 上面那段「硬名单」的说法只有在有人把新文件登记进来时才成立,而「忘了登记」恰恰是唯一会
 * 发生的失误 —— 所以这里拿 `__WEB_SOURCE_PATHS__`(vitest.config.ts 用 fs 扫出来的真清单)
 * 对表:漏登记 → 红(新文件逃出色值/class 纪律);登记了却删掉文件 → 也红(?raw 导入会在
 * 转换期就炸,这条是顺手兜住的)。
 */
describe("源文件名单完整性", () => {
  it("WEB_SOURCES 与 web/src 磁盘清单双向相等(新增文件不许逃过样式纪律)", () => {
    expect([...__WEB_SOURCE_PATHS__].sort()).toEqual([...Object.keys(WEB_SOURCES)].sort());
    const tsxOnDisk = __WEB_SOURCE_PATHS__.filter((p) => p.endsWith(".tsx"));
    expect([...tsxOnDisk].sort()).toEqual([...Object.keys(TSX_SOURCES)].sort());
  });
});

/** base.css 里定义的 class 全集(选择器位置上的 `.foo`,不含注释里的举例)。 */
function baseCssClasses(): Set<string> {
  return new Set(
    [...stripComments(baseCss).matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1] as string),
  );
}

/** 注释里的示例值会被正则当成声明,解析前一律剥掉。 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** 顶层块的原文(本仓三份样式表都没有嵌套规则,所以取第一个 `}` 就是块尾)。 */
function blockOf(text: string, selector: string): string {
  const start = text.indexOf(selector);
  expect(start, `样式里找不到选择器 ${selector}`).toBeGreaterThanOrEqual(0);
  const open = text.indexOf("{", start);
  const close = text.indexOf("}", open);
  expect(close, `${selector} 的块没有闭合`).toBeGreaterThan(open);
  return text.slice(open + 1, close);
}

function customPropsInOrder(block: string): string[] {
  return [...block.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1] as string);
}

function declarations(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of block.matchAll(/([-\w]+)\s*:\s*([^;]+);/g)) {
    out.set(match[1] as string, (match[2] as string).trim());
  }
  return out;
}

/** `--space-N: Mpx` → N→M 的映射(值取整数 px)。 */
function spaceScale(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const match of declarations(stripComments(text))) {
    const [name, value] = match;
    const px = /^(\d+(?:\.\d+)?)px$/.exec(value);
    if (name.startsWith("--space-") && px) out.set(name.slice("--space-".length), Number(px[1]));
  }
  return out;
}

const SPACING_PROPS = new Set([
  "gap",
  "row-gap",
  "column-gap",
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "padding-inline",
  "padding-inline-start",
  "padding-inline-end",
  "padding-block",
  "padding-block-start",
  "padding-block-end",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "margin-inline",
  "margin-inline-start",
  "margin-inline-end",
  "margin-block",
  "margin-block-start",
  "margin-block-end",
]);

/** 色值字面量:十六进制与颜色函数(主题名 light/dark 不是色值,故不列入关键字表)。 */
function colorLiterals(text: string): string[] {
  const stripped = stripComments(text);
  return [
    ...stripped.matchAll(/#[0-9a-fA-F]{3,8}\b/g),
    ...stripped.matchAll(/\b(?:rgba?|hsla?|hwb|lab|lch|color|color-mix)\s*\(/g),
    ...stripped.matchAll(/(?<![-\w])(?:red|green|blue|white|black|gray|grey|orange|purple|yellow|pink|teal|silver|maroon)(?![-\w])/g),
  ].map((m) => m[0] as string);
}

/** 去掉注释行后的源码(挂载顺序要比的是语句,不是说明文字)。 */
function codeLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => !line.startsWith("//") && !line.startsWith("/*") && !line.startsWith("*"));
}

function firstLineMatching(lines: string[], pattern: RegExp): number {
  return lines.findIndex((line) => pattern.test(line));
}

describe("双主题的变量名集合(theme.css)", () => {
  const darkBlock = blockOf(stripComments(themeCss), THEME_DARK);
  const lightBlock = blockOf(stripComments(themeCss), THEME_LIGHT);

  it("两套主题的变量名集合逐字一致(同序、同数量)", () => {
    const dark = customPropsInOrder(darkBlock);
    const light = customPropsInOrder(lightBlock);
    // 解析失败会让两边都是空数组从而「一致」地绿掉,所以先钉数量地板。
    expect(dark.length).toBeGreaterThanOrEqual(30);
    expect(light).toEqual(dark);
  });

  it("浅色块排在暗色块之后(特异度相同,覆盖只靠源码顺序)", () => {
    const stripped = stripComments(themeCss);
    expect(stripped.indexOf(THEME_LIGHT)).toBeGreaterThan(stripped.indexOf(THEME_DARK));
  });

  it("两套主题确实是两套(不是把暗色值复制一遍交差)", () => {
    const dark = declarations(darkBlock);
    const light = declarations(lightBlock);
    const identical = [...dark].filter(([name, value]) => light.get(name) === value);
    expect(identical.map(([name]) => name)).toEqual([]);
  });

  it("color-scheme 与主题同向(表单控件、滚动条、UA 默认底色跟着走)", () => {
    expect(declarations(darkBlock).get("color-scheme")).toBe("dark");
    expect(declarations(lightBlock).get("color-scheme")).toBe("light");
  });
});

describe("关键值抽查(规格表经用户签字的值逐字钉住)", () => {
  const dark = declarations(blockOf(stripComments(themeCss), THEME_DARK));
  const light = declarations(blockOf(stripComments(themeCss), THEME_LIGHT));

  /** 面 + 字 + 四态的字色:§7 那句「暗色运维风 --bg:#0d1117 系」的具体落点。 */
  const EXPECTED: Array<[Map<string, string>, string, string, string]> = [
    [dark, "--bg", "#0d1117", "暗色面"],
    [dark, "--surface", "#161b22", "暗色卡片"],
    [dark, "--surface-2", "#21262d", "暗色次级面"],
    [dark, "--border", "#30363d", "暗色描边"],
    [dark, "--fg", "#e6edf3", "暗色正文"],
    [dark, "--fg-muted", "#8b949e", "暗色次要字"],
    [dark, "--ok-fg", "#7ee787", "ok 字色"],
    [dark, "--run-fg", "#79b8ff", "run 字色"],
    [dark, "--warn-fg", "#ffd866", "warn 字色"],
    [dark, "--err-fg", "#ff9b9b", "err 字色"],
    [light, "--bg", "#ffffff", "浅色面"],
    [light, "--surface", "#f6f8fa", "浅色卡片"],
    [light, "--surface-2", "#eaeef2", "浅色次级面"],
    [light, "--border", "#d0d7de", "浅色描边"],
    [light, "--fg", "#1f2328", "浅色正文"],
    [light, "--fg-muted", "#57606a", "浅色次要字"],
    [light, "--ok-fg", "#116329", "ok 字色"],
    [light, "--run-fg", "#0969da", "run 字色"],
    [light, "--warn-fg", "#7d4e00", "warn 字色"],
    [light, "--err-fg", "#cf222e", "err 字色"],
  ];

  for (const [set, name, value, note] of EXPECTED) {
    it(`${name} = ${value}(${note})`, () => {
      expect(set.get(name), note).toBe(value);
    });
  }

  it("result 徽章的反白件:--ok-on 恒等于同主题的 --bg(不成组命名,靠这条钉子防漂移)", () => {
    expect(dark.get("--ok-on")).toBe(dark.get("--bg"));
    expect(light.get("--ok-on")).toBe(light.get("--bg"));
  });
});

describe("4px 栅格", () => {
  const ALLOWED = new Set([4, 8, 12, 16, 24, 32, 48]);
  const scale = spaceScale(scaleCss);

  it("scale.css 的 --space-* 恰是这七个值,且名字 = 值是 4 的几倍", () => {
    expect([...scale.values()].sort((a, b) => a - b)).toEqual([...ALLOWED].sort((a, b) => a - b));
    const mismatched = [...scale].filter(([name, px]) => Number(name) * 4 !== px).map(([name]) => `--space-${name}`);
    expect(mismatched).toEqual([]);
  });

  it("base.css 工具类的间距全部落在栅格上(字面 px 或 var(--space-*) 解析后的值)", () => {
    const stripped = stripComments(baseCss);
    const offenders: string[] = [];
    let checked = 0;
    for (const match of stripped.matchAll(/([-\w]+)\s*:\s*([^;]+);/g)) {
      const prop = match[1] as string;
      const value = (match[2] as string).trim();
      if (!SPACING_PROPS.has(prop)) continue;
      checked += 1;
      for (const px of value.matchAll(/(-?[\d.]+)px/g)) {
        const size = Number(px[1]);
        if (size !== 0 && !ALLOWED.has(size)) offenders.push(`${prop}: ${value}`);
      }
      for (const ref of value.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)) {
        const name = ref[1] as string;
        if (!name.startsWith("--space-")) {
          offenders.push(`${prop}: ${value} —— 间距必须走 --space-*`);
          continue;
        }
        const size = scale.get(name.slice("--space-".length));
        if (size === undefined || !ALLOWED.has(size)) offenders.push(`${prop}: ${value}(${name} 未定义或不在栅格上)`);
      }
    }
    // 一条都没扫到说明解析或工具类都被删了 —— 那也是红,不能绿。
    expect(checked).toBeGreaterThan(10);
    expect([...new Set(offenders)]).toEqual([]);
  });

  it("base.css 引用的每个 CSS 变量都有定义处(theme.css 或 scale.css)", () => {
    const defined = new Set([
      ...customPropsInOrder(blockOf(stripComments(themeCss), THEME_DARK)),
      ...customPropsInOrder(blockOf(stripComments(themeCss), THEME_LIGHT)),
      ...[...declarations(stripComments(scaleCss))].map(([name]) => name),
    ]);
    const used = [...stripComments(baseCss).matchAll(/var\(\s*(--[\w-]+)\s*[),]/g)].map((m) => m[1] as string);
    expect(used.length).toBeGreaterThan(20);
    expect([...new Set(used)].filter((name) => !defined.has(name))).toEqual([]);
  });
});

describe("字面色值的唯一出口是 theme.css", () => {
  it("base.css / scale.css 只有变量与形状,没有色值", () => {
    expect(colorLiterals(baseCss)).toEqual([]);
    expect(colorLiterals(scaleCss)).toEqual([]);
  });

  it("全部前端源文件不出现字面色值(唯一出口是 theme.css)", () => {
    for (const [name, source] of Object.entries(WEB_SOURCES)) {
      expect(colorLiterals(source), name).toEqual([]);
    }
  });

  it("除三份样式表外没有任何文件声明 CSS 自定义属性(不许另起一套变量体系)", () => {
    // 组件库(shadcn/ui 那类)落地时的标准动作就是再发一套 `--background`/`--primary`,
    // 与本仓签字的 token 并行 —— 两套变量漂移的表现永远是「只有暗色是对的」。
    for (const [name, source] of Object.entries(WEB_SOURCES)) {
      // 前缀字符里带引号也算:组件库/生成物发的第二套变量常常出现在字符串与模板串里。
      expect(stripComments(source), name).not.toMatch(/(^|[\s({"'\`])--[\w-]+\s*:/m);
    }
  });

  it("组件不写内联 style(尺寸与颜色的出口只有样式表)", () => {
    for (const [name, source] of Object.entries(WEB_SOURCES)) {
      // 与色值那条同理:注释里举例写的 `style={{...}}` 不是声明,先剥掉再扫。
      expect(stripComments(source), name).not.toMatch(/style=\{\{/);
    }
  });

  it("theme.ts 不写内联样式、不复制第二套变量(只置/移 data-theme)", () => {
    expect(themeLibRaw).not.toMatch(/setProperty\(/);
    expect(themeLibRaw).not.toMatch(/\.style\./);
    expect(themeLibRaw).toContain("THEME_ATTRIBUTE");
    expect(themeLibRaw).toMatch(/removeAttribute\(THEME_ATTRIBUTE\)/);
  });

  it("组件只挂 base.css 里存在的 class(引用不存在的类名 = 静默无样式)", () => {
    const defined = baseCssClasses();
    const used = Object.entries(TSX_SOURCES).flatMap(([name, source]) =>
      [...stripComments(source).matchAll(/\bca-[a-z0-9]+(?:-[a-z0-9]+)*/g)].map(
        (m) => [name, m[0] as string] as const,
      ),
    );
    expect(used.length).toBeGreaterThan(20);
    // 只看**完整**的 class 字面量:由数据层拼出来的类名不在这里放行,
    // 它由 test/web-view.test.ts 直接调用 view.ts 的函数逐值比对(那边才知道全集)。
    expect([...new Set(used.filter(([, token]) => !defined.has(token)))].map(
      ([name, token]) => `${name}: ${token}`,
    )).toEqual([]);
  });
});

describe("挂载顺序(防闪帧 + 禁止空白首页)", () => {
  const lines = codeLines(mainRaw);

  it("initTheme() 在 createRoot().render() 之前", () => {
    const themeAt = firstLineMatching(lines, /^initTheme\(\);$/);
    const renderAt = firstLineMatching(lines, /^createRoot\(/);
    expect(themeAt).toBeGreaterThanOrEqual(0);
    expect(renderAt).toBeGreaterThanOrEqual(0);
    expect(themeAt).toBeLessThan(renderAt);
  });

  it("渲染的是 App,不是占位的 null", () => {
    expect(lines.some((line) => /render\(\s*<App/.test(line))).toBe(true);
    expect(lines.some((line) => /render\(\s*null\s*\)/.test(line))).toBe(false);
  });

  it("样式导入顺序仍是 theme → scale → base(尺子与工具类都要读主题的变量)", () => {
    const at = (path: string) => mainRaw.indexOf(path);
    expect(at("./styles/theme.css")).toBeLessThan(at("./styles/scale.css"));
    expect(at("./styles/scale.css")).toBeLessThan(at("./styles/base.css"));
  });

  it("壳不自带内容:产品名、三格导航、主题切换、会话状态位齐备", () => {
    // w2b 起 `/` 的壳从 App.tsx 挪进 AuthedLayout(App 只剩两个 Provider)。
    expect(authedLayoutRaw).toContain("cloud-agent");
    expect(authedLayoutRaw).toContain("ThemeToggle");
    for (const nav of ["Tasks", "Approvals", "Audit"]) {
      expect(authedLayoutRaw, `顶导航少了 ${nav}`).toContain(nav);
    }
    // 角标是 warn 三件套(§5),不是自造的红点:审批积压不是故障,是「需要有人动手」。
    expect(authedLayoutRaw).toContain('tone="warn"');
    expect(themeToggleRaw).toContain("toggleTheme");
    // 主题状态的唯一来源是 theme.ts 的订阅,组件里不得再起一份本地 state(两套权威必然打架)。
    expect(themeToggleRaw).not.toMatch(/useState\(/);
  });

  it("App 只做装配:Provider 之外不含任何 markup 与 class", () => {
    // 这条钉子管的是「第二处装配点」:布局一旦回到 App.tsx,它就绕过了路由的 guard 与壳。
    expect(appRaw).toContain("QueryClientProvider");
    expect(appRaw).toContain("RouterProvider");
    expect(appRaw).not.toMatch(/\bclassName=/);
    expect(appRaw).not.toMatch(/<div|<main|<header/);
  });
});
