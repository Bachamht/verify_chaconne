# @chaconne/db (Verify subset)

The `verify_*` tables live in `src/verifySchema.ts`; `src/sharedSchema.ts` defines the two read-only tables (`assets`, `premium_1h`) that the event replay archive reads. Migrations are shipped as plain SQL (`migrations/0000_shared_readonly.sql` for the two read-only tables shared with the main site, then the `verify_*` migrations) and applied with `pnpm db:migrate` (`DATABASE_URL=postgres://…` or `pglite://…`). drizzle-kit snapshots are intentionally not included; regenerate from scratch if you change the schema.
