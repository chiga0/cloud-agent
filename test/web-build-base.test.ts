import { describe, expect, it } from "vitest";

import { loadWranglerConfig, matchesRunWorkerFirst, parseJsonc } from "./wrangler-config";
import packageJsonRaw from "../package.json?raw";
import viteConfigRaw from "../web/vite.config.ts?raw";
import rootTsconfigRaw from "../tsconfig.json?raw";
import workerTsconfigRaw from "../tsconfig.worker.json?raw";
import webTsconfigRaw from "../web/tsconfig.json?raw";
import gitignoreRaw from "../.gitignore?raw";
import prodWranglerRaw from "../wrangler.jsonc?raw";
import testWranglerRaw from "../wrangler.test.jsonc?raw";

/**
 * 构建基座的**跨文件一致性**(w2a)。
 *
 * 这些事实分散在四个文件里(package.json / web/vite.config.ts / 两份 tsconfig /
 * wrangler.jsonc),每一个单独看都正常,拼错其中一个时坏在**另一侧**:
 * - Vite 的 outDir 与 wrangler 的 assets.directory 不一致 → 部署的是上一个棒留下的 dist,
 *   或者 wrangler 直接报「目录不存在」。本地 `npm run build` 照样全绿。
 * - dev proxy 与 run_worker_first 不一致 → 只在 `npm run dev` 出现的假故障
 *   (某个 API 前缀被 vite 当成本地路由,返回 index.html),线上却是好的。
 * - dist/ 没被 .gitignore 覆盖 → 守门链的 build 前后快照比对判 tests_ok 不过
 *   (scripts/land-gate.mjs:「落地 commit 的差量必须恰为候选 patch」)。
 * 单文件测试钉不住这类「两边各写一遍」的漂移,所以集中钉在这里。
 */

interface PackageJson {
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

interface Tsconfig {
  compilerOptions: {
    strict?: boolean;
    jsx?: string;
    lib?: string[];
    types?: string[];
    noEmit?: boolean;
  };
  include?: string[];
  extends?: string;
}

const pkg = JSON.parse(packageJsonRaw) as PackageJson;
const prodWrangler = loadWranglerConfig(prodWranglerRaw);
const testWrangler = loadWranglerConfig(testWranglerRaw);
const rootTsconfig = parseJsonc(rootTsconfigRaw) as Tsconfig;
const workerTsconfig = parseJsonc(workerTsconfigRaw) as Tsconfig;
const webTsconfig = parseJsonc(webTsconfigRaw) as Tsconfig;

describe("npm 脚本面", () => {
  it("verify 三步齐备:typecheck 双跑两份 tsconfig、test 跑 vitest、build 跑 vite build", () => {
    const typecheck = pkg.scripts.typecheck ?? "";
    expect(typecheck).toContain("tsconfig.worker.json");
    expect(typecheck).toContain("web/tsconfig.json");
    expect((typecheck.match(/tsc --noEmit/g) ?? []).length).toBe(2);
    expect(typecheck).toContain("&&"); // 两份都必须过,不是一过一跳
    expect(pkg.scripts.test).toContain("vitest run");
    expect(pkg.scripts.build).toMatch(/^vite build --config web\/vite\.config\.ts$/);
  });

  it("任一步单独跑之前都先 ensure-deps(全新 clone 上不会 tsc/vite: not found)", () => {
    for (const step of ["pretypecheck", "pretest", "prebuild"]) {
      expect(pkg.scripts[step], step).toBe("node scripts/ensure-deps.mjs");
    }
  });

  it("部署前先构建:assets 目录为空时 wrangler 会拒,predeploy 是唯一的顺序保证", () => {
    expect(pkg.scripts.predeploy).toBe("npm run build");
  });

  it("web 侧依赖各就各位:react/react-dom 是运行时,vite 工具链是 devDependencies", () => {
    expect(pkg.dependencies.react).toBeTruthy();
    expect(pkg.dependencies["react-dom"]).toBeTruthy();
    expect(pkg.devDependencies.vite).toBeTruthy();
    expect(pkg.devDependencies["@vitejs/plugin-react"]).toBeTruthy();
    // worker 打包只走 src/index.ts,前端依赖不该出现在 worker 的运行时里
    expect(pkg.dependencies.vite).toBeUndefined();
  });
});

describe("两份 tsconfig", () => {
  it("worker 与 web 都是 strict + noEmit,且各有自己的 lib(web 有 DOM、worker 有 WebWorker)", () => {
    expect(workerTsconfig.compilerOptions.strict).toBe(true);
    expect(webTsconfig.compilerOptions.strict).toBe(true);
    expect(workerTsconfig.compilerOptions.noEmit).toBe(true);
    expect(webTsconfig.compilerOptions.noEmit).toBe(true);
    expect(workerTsconfig.compilerOptions.lib).toContain("WebWorker");
    expect(webTsconfig.compilerOptions.lib).toContain("DOM");
    expect(webTsconfig.compilerOptions.types).not.toContain("@cloudflare/workers-types");
    expect(webTsconfig.compilerOptions.types).toContain("vite/client");
  });

  it("react 的 jsx 转换在 web 侧开着,root/worker 两侧互不越界", () => {
    expect(webTsconfig.compilerOptions.jsx).toBe("react-jsx");
    expect(webTsconfig.include).toEqual(["src", "vite.config.ts"]); // 相对 web/
    // worker 程序的边界:不含 web —— 浏览器代码不该被 WebWorker lib 检查
    expect(workerTsconfig.include).toEqual(["src", "test", "vitest.config.ts"]);
    expect(rootTsconfig.extends).toBe("./tsconfig.worker.json");
  });
});

describe("构建产物 ↔ 资产目录", () => {
  it("Vite 的 root/outDir 与 wrangler 的 assets.directory 指向同一个 dist", () => {
    expect(viteConfigRaw).toContain('root: "web"');
    expect(viteConfigRaw).toContain('outDir: "../dist"');
    // outDir 在 root 之外,不显式允许清空时 Vite 会拒绝构建(而不是报错)→ 首次 build 就红
    expect(viteConfigRaw).toContain("emptyOutDir: true");
    expect(prodWrangler.assets?.directory).toBe("dist");
  });

  it("dist/ 被 git 忽略:build 产物不得进落地 commit 的差量(land-gate 的快照比对)", () => {
    const ignored = gitignoreRaw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
    expect(ignored).toContain("dist/");
  });
});

describe("dev proxy ↔ run_worker_first", () => {
  /** vite.config.ts 里 proxy 的键;去掉引号与前导斜杠外的杂质。 */
  function proxyPrefixes(): string[] {
    const block = /server:\s*\{[\s\S]*?proxy:\s*\{([\s\S]*?)\n\s{4}\},/.exec(viteConfigRaw);
    expect(block, "vite.config.ts 里找不到 server.proxy").not.toBeNull();
    return [...(block?.[1] ?? "").matchAll(/"(\/[^"]*)"\s*:/g)].map((m) => m[1]);
  }

  function workerFirstPrefixes(config: { assets?: { run_worker_first?: string[] | boolean } }): string[] {
    const rules = config.assets?.run_worker_first;
    expect(Array.isArray(rules), "run_worker_first 必须是显式清单").toBe(true);
    return [...new Set((rules as string[]).map((rule) => rule.replace(/\/\*$/, "")))].sort();
  }

  it("两份清单同源:vite dev 转发的路径集合 == 线上 worker-first 的路径集合", () => {
    expect([...new Set(proxyPrefixes())].sort()).toEqual(workerFirstPrefixes(prodWrangler));
  });

  it("测试配置的资产面与生产同构(只是目录换成夹具):否则「测试里绿的兜底」不代表线上行为", () => {
    expect(workerFirstPrefixes(testWrangler)).toEqual(workerFirstPrefixes(prodWrangler));
    expect(testWrangler.assets?.not_found_handling).toBe("single-page-application");
    expect(testWrangler.assets?.binding).toBe("ASSETS");
    expect(testWrangler.assets?.directory).toBe("test/fixtures/spa");
    // 生产指向 dist,测试指向夹具:两处都不能是仓库里不存在的目录
    expect(prodWrangler.assets?.directory).toBe("dist");
  });

  it("夹具里放着一个真资产,SPA 兜底与命中路径可分辨", () => {
    // 兜底断言在 test/assets-routing.test.ts;这里只钉「未匹配」的判定本身不误伤:
    // 夹具内的路径不该被 run_worker_first 盖住,否则测的是 worker 而不是资产层。
    const rules = (testWrangler.assets?.run_worker_first ?? []) as string[];
    expect(matchesRunWorkerFirst(rules, "/assets/probe.js")).toBe(false);
    expect(matchesRunWorkerFirst(rules, "/index.html")).toBe(false);
  });
});
