import { drizzle } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import pg from "pg";
import * as schema from "./verifySchema";

/**
 * 驱动无关的 Db 类型：node-postgres（生产）与 PGlite（本地开发/测试）实例均可用。
 * 两驱动都继承 PgDatabase；HKT 泛型差异用单点断言收敛（用法子集完全兼容）。
 */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface DbHandle {
  db: Db;
  close: () => Promise<void>;
}

/**
 * DATABASE_URL 双协议：
 *   postgres://…      → node-postgres 连接池（生产，Ubuntu 本机 PG 16 / Supabase）
 *   pglite://<目录>   → 嵌入式 Postgres（本地开发零依赖；pglite://memory 为纯内存）
 */
export async function createDb(databaseUrl: string, opts?: { max?: number }): Promise<DbHandle> {
  if (databaseUrl.startsWith("pglite://")) {
    const target = databaseUrl.slice("pglite://".length);
    // webpackIgnore：pglite 的 WASM 装载不可被打包器重写（仅本地开发路径，生产走 postgres://）
    const { PGlite } = await import(/* webpackIgnore: true */ "@electric-sql/pglite");
    const { drizzle: drizzlePglite } = await import(
      /* webpackIgnore: true */ "drizzle-orm/pglite"
    );
    const client = target === "memory" || target === "" ? new PGlite() : new PGlite(target);
    const db = drizzlePglite(client, { schema }) as unknown as Db;
    return { db, close: () => client.close() };
  }
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: opts?.max ?? 10,
    connectionTimeoutMillis: 10_000,
  });
  const db = drizzle(pool, { schema });
  return { db, close: () => pool.end() };
}
