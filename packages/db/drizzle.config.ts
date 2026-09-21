import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: ["./src/verifySchema.ts"],
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://verify:CHANGE_ME@127.0.0.1:5432/chaconne_verify",
  },
});
