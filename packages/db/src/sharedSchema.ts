/**
 * Read-only tables shared with the main Chaconne site. The event replay archive reads
 * hourly premium history from them. Only their definitions are published here.
 */
import { boolean, index, integer, numeric, pgTable, primaryKey, serial, text, timestamp, unique } from "drizzle-orm/pg-core";

const price = (name: string) => numeric(name, { mode: "number", precision: 24, scale: 12 });
const bps = (name: string) => numeric(name, { mode: "number", precision: 14, scale: 4 });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const assets = pgTable(
  "assets",
  {
    id: serial("id").primaryKey(),
    symbol: text("symbol").notNull(), // 例: TSLAx / TSLAon
    underlying: text("underlying").notNull(), // 底层股票代码: TSLA
    nameEn: text("name_en").notNull(),
    nameCn: text("name_cn").notNull(), // 特斯拉
    issuer: text("issuer").notNull(), // backed_xstocks | ondo_gm | ...
    issuerModel: text("issuer_model").notNull(), // price_tracking | total_return（§5）
    chain: text("chain").notNull(), // solana | ethereum | bnb | base | arbitrum
    address: text("address").notNull(), // mint/合约地址（种子脚本≥2源核验后写入，禁止手填）
    decimals: integer("decimals").notNull(),
    pythEquityId: text("pyth_equity_id"), // 底层股票 Pyth feed id
    pythTokenId: text("pyth_token_id"), // 代币自身 Pyth feed（如 Crypto.TSLAX）
    tags: text("tags").array().notNull().default([]), // etf | crypto_stock(币股) | ...
    active: boolean("active").notNull().default(true),
  },
  (t) => [
    unique("assets_chain_address_uq").on(t.chain, t.address),
    index("assets_underlying_idx").on(t.underlying),
    index("assets_symbol_idx").on(t.symbol),
  ],
);

const aggColumns = {
  assetId: integer("asset_id").notNull(),
  ts: ts("ts").notNull(), // 桶起始时刻（UTC）
  premiumAvg: bps("premium_avg"),
  premiumMin: bps("premium_min"),
  premiumMax: bps("premium_max"),
  premiumClose: bps("premium_close"),
  ratioClose: numeric("ratio_close", { mode: "number", precision: 24, scale: 12 }),
  tokenPriceClose: price("token_price_close"),
  refPriceClose: price("ref_price_close"),
  netEdgeClose: bps("net_edge_close"),
  sampleN: integer("sample_n").notNull(),
  qualityWorst: text("quality_worst").notNull().default("ok"),
};

export const premium1h = pgTable(
  "premium_1h",
  { ...aggColumns },
  (t) => [primaryKey({ columns: [t.assetId, t.ts] })],
);
