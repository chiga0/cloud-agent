/// <reference path="../node_modules/@cloudflare/vitest-pool-workers/types/cloudflare-test.d.ts" />

import type { Env as AppEnv } from "../src/types";

declare global {
  namespace Cloudflare {
    // 这个 interface 必须与 AppEnv **结构全等**:DO 桩类型按它推断(TaskSession extends
    // DurableObject<Env>),给它加任何成员都会让 runInDurableObject 的实例推断退化到基类,
    // 于是 test/session-do.test.ts 报「alarm 可能未定义」。要在新测试里读资产绑定,
    // 就地窄化取用 —— 见 test/assets-routing.test.ts 的 `assets`。
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface Env extends AppEnv {}
  }

  /** vitest.config.ts 构建期内联的 migrations/ SQL(JSON 字符串)。 */
  const __D1_MIGRATIONS__: string;

  /**
   * vitest.config.ts 构建期内联的 `web/src/styles/*.css` 原文(路径 → 源码)。
   * Workers 运行时没有 fs,而 `.css` 的 ?raw 在 worker 测试池里是空串,只能在配置里读。
   */
  const __WEB_STYLE_SOURCES__: Record<string, string>;
}

export {};
