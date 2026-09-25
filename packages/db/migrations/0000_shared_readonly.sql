CREATE TABLE "assets" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"underlying" text NOT NULL,
	"name_en" text NOT NULL,
	"name_cn" text NOT NULL,
	"issuer" text NOT NULL,
	"issuer_model" text NOT NULL,
	"chain" text NOT NULL,
	"address" text NOT NULL,
	"decimals" integer NOT NULL,
	"pyth_equity_id" text,
	"pyth_token_id" text,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "assets_chain_address_uq" UNIQUE("chain","address")
);
--> statement-breakpoint
CREATE TABLE "premium_1h" (
	"asset_id" integer NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"premium_avg" numeric(14, 4),
	"premium_min" numeric(14, 4),
	"premium_max" numeric(14, 4),
	"premium_close" numeric(14, 4),
	"ratio_close" numeric(24, 12),
	"token_price_close" numeric(24, 12),
	"ref_price_close" numeric(24, 12),
	"net_edge_close" numeric(14, 4),
	"sample_n" integer NOT NULL,
	"quality_worst" text DEFAULT 'ok' NOT NULL,
	CONSTRAINT "premium_1h_asset_id_ts_pk" PRIMARY KEY("asset_id","ts")
);
--> statement-breakpoint
CREATE INDEX "assets_underlying_idx" ON "assets" USING btree ("underlying");--> statement-breakpoint
CREATE INDEX "assets_symbol_idx" ON "assets" USING btree ("symbol");
