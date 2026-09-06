import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

/**
 * workers 测试环境不会自动应用 D1 迁移(终态归档会 `no such table: tasks`)。
 * 构建期直接读 migrations/,把 SQL 内联成常量给测试用 —— 测试里再抄一份
 * schema 迟早会与迁移漂移。
 */
const migrations = await readD1Migrations("./migrations");

/**
 * 同一手法服务第二个读者:w2a 的设计 token 契约(test/web-theme-tokens.test.ts)必须拿
 * CSS **原文**才钉得住,而 Workers 运行时没有 fs、`?raw`/`?inline` 对 `.css` 又都返回空串
 * (样式在 worker 侧本就不执行,构建管线直接把 CSS 模块剥成空)。所以在这里读进来。
 *
 * 名单是硬编码的:文件改名/删掉会让 readFileSync 在配置加载期就抛,而不是让测试
 * 拿到 undefined 后「什么都没得比」地绿掉。
 */
const webStyleSources = Object.fromEntries(
  ["theme.css", "scale.css", "base.css"].map((name) => [
    `web/src/styles/${name}`,
    readFileSync(`web/src/styles/${name}`, "utf8"),
  ]),
);

export default defineConfig({
  define: {
    __D1_MIGRATIONS__: JSON.stringify(JSON.stringify(migrations)),
    __WEB_STYLE_SOURCES__: JSON.stringify(webStyleSources),
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.test.jsonc" },
      miniflare: {
        d1Databases: { bindings: "DB", migrationsDir: "migrations" },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
