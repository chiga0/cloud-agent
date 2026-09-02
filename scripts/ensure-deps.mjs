import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 依赖自检:npm scripts 里的 `tsc`/`vitest` 来自 node_modules/.bin,而 node_modules
 * 按 .gitignore 不入库。一次全新 clone 上直接跑 `npm run typecheck && npm test` 会以
 * `sh: 1: tsc: not found`(exit 127)收场 —— 那不是关于代码的任何事实,只是环境没就绪。
 * 所以 typecheck/test 前先把缺的装上(已装齐则零成本返回,不重复装)。
 *
 * 两个刻意的参数:
 * - `--include=dev`:typescript/vitest 是 devDependencies。沙箱带 NODE_ENV=production
 *   或 npm_config_omit=dev 时默认会跳过它们 —— 同样是「找不到 tsc」的成因,必须反向覆盖。
 * - `--prefer-offline`:有缓存的沙箱不必依赖 registry;缓存未命中才回落到网络。
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 装没装过,看的是真正要被执行的东西:命令入口 + 被 import 的包。 */
const REQUIRED = [
  "node_modules/.bin/tsc",
  "node_modules/.bin/vitest",
  "node_modules/typescript",
  "node_modules/vitest",
  "node_modules/@cloudflare/vitest-pool-workers",
  "node_modules/@cloudflare/workers-types",
  "node_modules/@cloudflare/sandbox",
];

const missing = REQUIRED.filter((p) => !existsSync(join(root, p)));
if (missing.length === 0) process.exit(0);

process.stdout.write(`[ensure-deps] 缺少 ${missing.join(", ")} → npm install --include=dev\n`);
const res = spawnSync(
  "npm",
  ["install", "--no-audit", "--no-fund", "--include=dev", "--prefer-offline"],
  { cwd: root, stdio: "inherit" },
);
process.exit(res.status === 0 ? 0 : res.status ?? 1);
