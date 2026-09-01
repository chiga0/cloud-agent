/// <reference path="../node_modules/@cloudflare/vitest-pool-workers/types/cloudflare-test.d.ts" />

import type { Env as AppEnv } from "../src/types";

declare global {
  namespace Cloudflare {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface Env extends AppEnv {}
  }

  /** vitest.config.ts 构建期内联的 migrations/ SQL(JSON 字符串)。 */
  const __D1_MIGRATIONS__: string;
}

export {};
