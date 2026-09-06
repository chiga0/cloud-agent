import { describe, expect, it } from "vitest";

import appRaw from "../web/src/App.tsx?raw";
import themeToggleRaw from "../web/src/components/ThemeToggle.tsx?raw";
import themeLibRaw from "../web/src/lib/theme.ts?raw";
import mainRaw from "../web/src/main.tsx?raw";

/**
 * 设计 token 与样式契约(w2a,docs/product.md §4/§7)。
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

  it("壳与入口的四个源文件不出现字面色值", () => {
    for (const [name, source] of [
      ["web/src/App.tsx", appRaw],
      ["web/src/components/ThemeToggle.tsx", themeToggleRaw],
      ["web/src/lib/theme.ts", themeLibRaw],
      ["web/src/main.tsx", mainRaw],
    ] as const) {
      expect(colorLiterals(source), name).toEqual([]);
    }
  });

  it("theme.ts 不写内联样式、不复制第二套变量(只置/移 data-theme)", () => {
    expect(themeLibRaw).not.toMatch(/setProperty\(/);
    expect(themeLibRaw).not.toMatch(/\.style\./);
    expect(themeLibRaw).toContain("THEME_ATTRIBUTE");
    expect(themeLibRaw).toMatch(/removeAttribute\(THEME_ATTRIBUTE\)/);
  });

  it("组件只挂 base.css 里存在的 class(引用不存在的类名 = 静默无样式)", () => {
    const defined = new Set(
      [...stripComments(baseCss).matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1] as string),
    );
    const used = [appRaw, themeToggleRaw].flatMap((src) =>
      [...src.matchAll(/className="([^"]*)"/g)].flatMap((m) => (m[1] as string).split(/\s+/)),
    );
    expect(used.length).toBeGreaterThan(5);
    expect([...new Set(used)].filter((name) => !defined.has(name))).toEqual([]);
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

  it("壳不自带内容:产品名、状态说明、主题切换三样齐备", () => {
    expect(appRaw).toContain("cloud-agent");
    expect(appRaw).toContain("ThemeToggle");
    expect(themeToggleRaw).toContain("toggleTheme");
    // 主题状态的唯一来源是 theme.ts 的订阅,组件里不得再起一份本地 state(两套权威必然打架)。
    expect(themeToggleRaw).not.toMatch(/useState\(/);
  });
});
