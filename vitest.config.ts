import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
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
