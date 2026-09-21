# @chaconne/db (Verify subset)

Only the `verify_*` tables live here (`src/verifySchema.ts`). Migrations are shipped as plain SQL (`migrations/0000_verify_init.sql`, `0001_verify_v5.sql`) and applied with `pnpm db:migrate` (`DATABASE_URL=postgres://…` or `pglite://…`). drizzle-kit snapshots are intentionally not included; regenerate from scratch if you change the schema.
