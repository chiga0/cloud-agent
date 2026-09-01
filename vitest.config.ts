import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

/**
 * workers 测试环境不会自动应用 D1 迁移(终态归档会 `no such table: tasks`)。
 * 构建期直接读 migrations/,把 SQL 内联成常量给测试用 —— 测试里再抄一份
 * schema 迟早会与迁移漂移。
 */
const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  define: {
    __D1_MIGRATIONS__: JSON.stringify(JSON.stringify(migrations)),
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
