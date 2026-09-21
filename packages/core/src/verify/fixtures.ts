/**
 * 共享 FIXTURE 场景（各 lane 共用同一份；验收清单 §三 的 FIXTURE 模式）。
 *
 * ⚠ 全部地址/喂价 ID 均为**明显占位值**（0x1111…、0x2222…），不是任何真实资产；
 *   真实 registry 由 Lane B 经双源核验 + 运营者批准后另行提供（硬约束①）。
 */
import { keccak256Utf8 } from "./canonical";
import type {
  AssetRegistry,
  CreateVerifyJob,
  EvidenceRecord,
  EvidenceTime,
  EvmAddress,
  OkxQuoteEvidence,
} from "./contracts";

export const FIXTURE_CHAIN_ID = 196;
export const FIXTURE_STABLE: EvmAddress = "0x1111111111111111111111111111111111111111";
export const FIXTURE_STOCK: EvmAddress = "0x2222222222222222222222222222222222222222";
export const FIXTURE_STOCK_LOOKALIKE: EvmAddress = "0x3333333333333333333333333333333333333333";
export const FIXTURE_OWNER: EvmAddress = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const FIXTURE_RECIPIENT: EvmAddress = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

export const FIXTURE_STABLE_KEY = `eip155:${FIXTURE_CHAIN_ID}:${FIXTURE_STABLE}`;
export const FIXTURE_STOCK_KEY = `eip155:${FIXTURE_CHAIN_ID}:${FIXTURE_STOCK}`;

/** 常规时段样本时刻：2026-09-18（周五）11:00 ET = 15:00Z */
export const T_REGULAR = "2026-09-18T15:00:00.000Z";
/** 休市样本时刻：2026-09-19（周六）22:00 ET = 2026-09-20T02:00Z；最近已完成交易日 = 09-18 */
export const T_CLOSED = "2026-09-20T02:00:00.000Z";
/** 盘后样本时刻：2026-09-18 17:00 ET = 21:00Z */
export const T_POST = "2026-09-18T21:00:00.000Z";

export function fixtureRegistry(overrides?: Partial<AssetRegistry>): AssetRegistry {
  const version = "fixture-registry/1";
  const verifiedAt = "2026-09-20T00:00:00.000Z";
  return {
    version,
    chainId: FIXTURE_CHAIN_ID,
    entries: [
      {
        assetKey: FIXTURE_STABLE_KEY,
        chainId: FIXTURE_CHAIN_ID,
        tokenAddress: FIXTURE_STABLE,
        tokenDecimals: 6,
        issuerId: "fixture-stable-issuer",
        displaySymbol: "FUSD",
        underlyingId: "fiat:USD",
        tokenForm: "plain",
        registryVersion: version,
        role: "stable_input",
        sharesPerToken: null,
        unitSource: null,
        usdPegSource: "fixture-attestation",
        provenance: [{ source: "fixture", verifiedAt }],
        executionAllowed: true,
      },
      {
        assetKey: FIXTURE_STOCK_KEY,
        chainId: FIXTURE_CHAIN_ID,
        tokenAddress: FIXTURE_STOCK,
        tokenDecimals: 18,
        issuerId: "fixture-stock-issuer",
        displaySymbol: "FAKEx",
        underlyingId: "us-equity:FAKE",
        tokenForm: "rebasing",
        registryVersion: version,
        role: "stock_output",
        sharesPerToken: "1",
        unitSource: { description: "fixture: 1 token = 1 share", verifiedAt },
        usdPegSource: null,
        provenance: [{ source: "fixture", verifiedAt }],
        executionAllowed: true,
      },
    ],
    ...overrides,
  };
}

export function fixtureJob(overrides?: Partial<CreateVerifyJob>): CreateVerifyJob {
  return {
    clientRequestId: "fixture-req-1",
    ownerAddress: FIXTURE_OWNER,
    recipientAddress: FIXTURE_RECIPIENT,
    executionChainId: FIXTURE_CHAIN_ID,
    inputAssetKey: FIXTURE_STABLE_KEY,
    outputAssetKey: FIXTURE_STOCK_KEY,
    amountInRaw: "100000000", // 100 FUSD
    mode: "exactIn",
    policyId: "STRICT_LIVE",
    policyVersion: "1.0.0",
    maxSlippageBps: 50,
    maxPriceImpactBps: 100,
    maxReferenceDeviationBps: 300,
    ...overrides,
  };
}

function timeAt(receivedAt: string, sourcePublishedAt: string | null, latencyMs = 200): EvidenceTime {
  const rec = Date.parse(receivedAt);
  return {
    requestedAt: new Date(rec - latencyMs).toISOString(),
    receivedAt,
    sourcePublishedAt,
    sourceTimeKind: sourcePublishedAt === null ? "not_provided" : "published",
  };
}

let seq = 0;
function evId(prefix: string): string {
  seq += 1;
  return `ev_${prefix}_${String(seq).padStart(3, "0")}`;
}
export function resetFixtureIds(): void {
  seq = 0;
}

export function quoteEvidence(args: {
  receivedAt: string;
  amountInRaw?: string;
  expectedOutRaw?: string;
  priceImpactPercentRaw?: string | null;
  adverseImpactBps?: number | null;
  routeSupported?: boolean;
  fromToken?: EvmAddress;
  toToken?: EvmAddress;
  id?: string;
}): EvidenceRecord {
  const payload: OkxQuoteEvidence = {
    kind: "okx_quote",
    chainId: FIXTURE_CHAIN_ID,
    fromToken: args.fromToken ?? FIXTURE_STABLE,
    toToken: args.toToken ?? FIXTURE_STOCK,
    amountInRaw: args.amountInRaw ?? "100000000",
    // 100 USD → 0.4 股 @ $250/股
    expectedOutRaw: args.expectedOutRaw ?? "400000000000000000",
    priceImpactPercentRaw: args.priceImpactPercentRaw === undefined ? "-0.12" : args.priceImpactPercentRaw,
    adverseImpactBps: args.adverseImpactBps === undefined ? 12 : args.adverseImpactBps,
    routeSummary: ["fixture-amm"],
    routeSupported: args.routeSupported ?? true,
  };
  return {
    evidenceId: args.id ?? evId("quote"),
    provider: "okx-dex",
    endpoint: "aggregator/quote",
    // v1 黄金样本依赖 `quote:<amount>` 指纹；只有自定义方向（卖出）时才纳入代币地址
    requestFingerprint: keccak256Utf8(args.fromToken || args.toToken ? `quote:${payload.fromToken}:${payload.toToken}:${payload.amountInRaw}` : `quote:${payload.amountInRaw}`),
    time: timeAt(args.receivedAt, null),
    block: null,
    rawHash: keccak256Utf8(`raw-quote:${args.receivedAt}`),
    parserVersion: "okx-quote/1",
    mode: "FIXTURE",
    payload,
  };
}

export function pythEvidence(args: {
  receivedAt: string;
  sourcePublishedAt: string | null;
  priceUsd?: string;
  sessionAtPublish?: "PRE" | "REGULAR" | "POST" | "CLOSED" | "HOLIDAY";
  tradingDate?: string;
  underlyingId?: string;
  id?: string;
}): EvidenceRecord {
  return {
    evidenceId: args.id ?? evId("pyth"),
    provider: "pyth-hermes",
    endpoint: "v2/updates/price/latest",
    requestFingerprint: keccak256Utf8("pyth:FAKE"),
    time: timeAt(args.receivedAt, args.sourcePublishedAt),
    block: null,
    rawHash: keccak256Utf8(`raw-pyth:${args.receivedAt}`),
    parserVersion: "pyth/1",
    mode: "FIXTURE",
    payload: {
      kind: "pyth_reference",
      underlyingId: args.underlyingId ?? "us-equity:FAKE",
      feedId: "fixturefeed0000000000000000000000000000000000000000000000000000",
      priceUsd: args.priceUsd ?? "250",
      confBps: 3,
      sessionAtPublish: args.sessionAtPublish ?? "REGULAR",
      tradingDate: args.tradingDate ?? "2026-09-18",
    },
  };
}

export function rwaEvidence(args: {
  receivedAt: string;
  stockPriceUsd: string | null;
  priceUsd?: string | null;
  ratio?: string | null;
  id?: string;
}): EvidenceRecord {
  return {
    evidenceId: args.id ?? evId("rwa"),
    provider: "okx-market",
    endpoint: "dex/market/rwa/tokens",
    requestFingerprint: keccak256Utf8("rwa:196"),
    time: timeAt(args.receivedAt, null),
    block: null,
    rawHash: keccak256Utf8(`raw-rwa:${args.receivedAt}`),
    parserVersion: "okx-rwa/1",
    mode: "FIXTURE",
    payload: {
      kind: "okx_rwa_token",
      chainId: FIXTURE_CHAIN_ID,
      tokenAddress: FIXTURE_STOCK,
      issuer: "fixture-stock-issuer",
      priceUsd: args.priceUsd === undefined ? "250.3" : args.priceUsd,
      stockPriceUsd: args.stockPriceUsd,
      ...(args.ratio !== undefined ? { ratio: args.ratio } : {}),
    },
  };
}

export function closeEvidence(args: {
  receivedAt: string;
  closeUsd?: string;
  tradingDate?: string;
  closeSource?: "pyth" | "pyth_provisional" | "official" | "last_tick";
  sourcePublishedAt?: string | null;
  confirmation?: { method: "candle" | "next_day_pc"; confirmedAt: string; matchedUsd: string } | null;
  id?: string;
}): EvidenceRecord {
  return {
    evidenceId: args.id ?? evId("close"),
    provider: "chaconne-ref-closes",
    endpoint: "ref_closes",
    requestFingerprint: keccak256Utf8("close:FAKE"),
    time: timeAt(args.receivedAt, args.sourcePublishedAt ?? "2026-09-18T19:59:58.000Z"),
    block: null,
    rawHash: keccak256Utf8(`raw-close:${args.receivedAt}`),
    parserVersion: "ref-close/1",
    mode: "FIXTURE",
    payload: {
      kind: "ref_close",
      underlyingId: "us-equity:FAKE",
      closeUsd: args.closeUsd ?? "250",
      tradingDate: args.tradingDate ?? "2026-09-18",
      closeSource: args.closeSource ?? "pyth",
      ...(args.confirmation !== undefined ? { confirmation: args.confirmation } : {}),
    },
  };
}

export function stableEvidence(args: { receivedAt: string; usdPerToken: string | null; id?: string }): EvidenceRecord {
  return {
    evidenceId: args.id ?? evId("stable"),
    provider: "fixture-peg",
    endpoint: "peg",
    requestFingerprint: keccak256Utf8("peg:FUSD"),
    time: timeAt(args.receivedAt, null),
    block: null,
    rawHash: keccak256Utf8(`raw-peg:${args.receivedAt}`),
    parserVersion: "peg/1",
    mode: "FIXTURE",
    payload: {
      kind: "stablecoin_usd",
      tokenAddress: FIXTURE_STABLE,
      chainId: FIXTURE_CHAIN_ID,
      usdPerToken: args.usdPerToken,
      method: "fixture-attestation",
    },
  };
}

export function tokenMetaEvidence(args: { receivedAt: string; decimals: number | null; multiplier?: string | null; id?: string }): EvidenceRecord {
  return {
    evidenceId: args.id ?? evId("meta"),
    provider: "xlayer-rpc",
    endpoint: "eth_call:decimals",
    requestFingerprint: keccak256Utf8("meta:FAKEx"),
    time: { ...timeAt(args.receivedAt, null), sourceTimeKind: "block" },
    block: { chainId: FIXTURE_CHAIN_ID, blockNumber: "1", blockHash: null, blockTimestamp: null },
    rawHash: keccak256Utf8(`raw-meta:${args.receivedAt}`),
    parserVersion: "erc20-meta/1",
    mode: "FIXTURE",
    payload: {
      kind: "token_meta",
      chainId: FIXTURE_CHAIN_ID,
      tokenAddress: FIXTURE_STOCK,
      decimals: args.decimals,
      symbol: "FAKEx",
      multiplier: args.multiplier ?? null,
    },
  };
}

/** 一套「常规时段、全部证据合格」的 STRICT_LIVE 证据。 */
export function liveHappyEvidence(now = T_REGULAR): EvidenceRecord[] {
  const t = (offsetSec: number) => new Date(Date.parse(now) - offsetSec * 1000).toISOString();
  return [
    quoteEvidence({ receivedAt: t(5) }),
    pythEvidence({ receivedAt: t(3), sourcePublishedAt: t(4) }),
    rwaEvidence({ receivedAt: t(6), stockPriceUsd: "250.1" }),
    stableEvidence({ receivedAt: t(20), usdPerToken: "1" }),
    tokenMetaEvidence({ receivedAt: t(60), decimals: 18 }),
  ];
}

/** 一套「休市、交叉核验收盘合格」的 REFERENCE_CONTEXT 证据。 */
export function closeCrossVerifiedEvidence(now = T_CLOSED): EvidenceRecord[] {
  const t = (offsetSec: number) => new Date(Date.parse(now) - offsetSec * 1000).toISOString();
  return [
    quoteEvidence({ receivedAt: t(5) }),
    closeEvidence({ receivedAt: t(3), closeSource: "pyth" }),
    rwaEvidence({ receivedAt: t(6), stockPriceUsd: "250.05" }),
    stableEvidence({ receivedAt: t(20), usdPerToken: "1" }),
    tokenMetaEvidence({ receivedAt: t(60), decimals: 18 }),
  ];
}
