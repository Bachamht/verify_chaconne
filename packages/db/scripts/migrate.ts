/**
 * 应用 SQL 迁移（migrations/ 由 `pnpm db:generate` 生成、随仓库提交）。
 * 用法：DATABASE_URL=postgres://... pnpm db:migrate
 *      DATABASE_URL=pglite://.pgdata-dev pnpm db:migrate   （本地零依赖开发）
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("缺少 DATABASE_URL 环境变量");
  process.exit(1);
}

const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

if (url.startsWith("pglite://")) {
  const target = url.slice("pglite://".length);
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const client = target === "memory" || target === "" ? new PGlite() : new PGlite(target);
  await migrate(drizzle(client), { migrationsFolder });
  await client.close();
  console.info("迁移完成 ✓ (pglite)");
} else {
  const { default: pg } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { migrate } = await import("drizzle-orm/node-postgres/migrator");
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder });
    console.info("迁移完成 ✓ (postgres)");
  } finally {
    await pool.end();
  }
}
