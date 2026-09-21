import { createDb, type Db, type DbHandle } from "@chaconne/db";

export type { Db };

export async function openDb(databaseUrl: string): Promise<DbHandle> {
  return createDb(databaseUrl, { max: 5 });
}
