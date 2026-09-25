CREATE TABLE "verify_api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"key_hash" text NOT NULL,
	"owner_address" text NOT NULL,
	"label" text NOT NULL,
	"hint" text NOT NULL,
	"nonce" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "verify_api_keys_hash_uq" UNIQUE("key_hash"),
	CONSTRAINT "verify_api_keys_nonce_uq" UNIQUE("nonce")
);
--> statement-breakpoint
CREATE INDEX "verify_api_keys_owner_idx" ON "verify_api_keys" USING btree ("owner_address");