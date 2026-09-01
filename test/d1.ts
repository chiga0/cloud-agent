import { env } from "cloudflare:test";

interface Migration {
  name: string;
  queries: string[];
}

/**
 * 把 migrations/ 的 SQL 应用到测试 D1。终态归档会写 tasks/attempts/decisions/events,
 * 缺表时 DO 的 archive 会抛错,所以任何走到终态的用例都要先应用迁移。
 * 语句本身幂等(IF NOT EXISTS + 全量 DELETE 重写)。
 */
export async function applyMigrations(): Promise<void> {
  const migrations = JSON.parse(__D1_MIGRATIONS__) as Migration[];
  for (const m of migrations) {
    const queries = m.queries.filter((q) => q.trim().length > 0);
    if (queries.length > 0) await env.DB.batch(queries.map((q) => env.DB.prepare(q)));
  }
}
