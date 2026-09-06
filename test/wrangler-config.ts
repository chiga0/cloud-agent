/**
 * wrangler.*.jsonc 的测试侧读法。
 *
 * Workers 运行时里没有 fs,配置只能靠 `?raw` 在构建期内联成字符串(见
 * test/raw-imports.d.ts 与 test/admin-events.test.ts 对 README 的同一手法)。
 * 而 jsonc 带注释,`JSON.parse` 直接吃不下 —— 注释里恰恰写着「为什么是这套值」,
 * 把它们剥掉再解析,断言才落在真正生效的那份结构上。
 */

export interface AssetsConfig {
  directory?: string;
  binding?: string;
  html_handling?: string;
  not_found_handling?: string;
  run_worker_first?: string[] | boolean;
}

export interface WranglerConfig {
  name: string;
  main: string;
  assets?: AssetsConfig;
  vars?: Record<string, string>;
}

/** 剥掉 `//` 与 `/* *\/` 注释后 JSON.parse。字符串里的 `//`(URL)不受影响。 */
export function parseJsonc(source: string): unknown {
  let out = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];

    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 1;
      continue;
    }
    out += ch;
  }

  return JSON.parse(out) as unknown;
}

export function loadWranglerConfig(source: string): WranglerConfig {
  return parseJsonc(source) as WranglerConfig;
}

/**
 * `run_worker_first` 的规则 → 判定 pathname 是否归 worker。
 *
 * 实现的是文档里那条子集:`*` 匹配任意字符(含 `/`)、`?` 匹配单字符,其余按字面量,
 * 整条模式**两端锚定**(所以 `/live` 只匹配 `/live`,不会连 `/livenet` 一起吞了 ——
 * 那正是「覆盖面断言」要说反的那种假绿)。带 `!` 的取反规则与整 URL 规则不支持:
 * 用了就直接抛,免得测试悄悄给出一个「看起来覆盖了」的结果。
 */
export function matchesRunWorkerFirst(rules: string[], pathname: string): boolean {
  return rules.some((rule) => runWorkerFirstRule(rule).test(pathname));
}

function runWorkerFirstRule(rule: string): RegExp {
  if (rule.startsWith("!")) {
    throw new Error(`不支持 run_worker_first 的取反规则: ${rule}`);
  }
  if (!rule.startsWith("/")) {
    throw new Error(`不支持的 run_worker_first 规则(只支持路径式): ${rule}`);
  }
  const body = rule.endsWith("$") ? rule.slice(0, -1) : rule;
  const literal = body
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${literal}$`);
}
