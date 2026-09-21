/**
 * 核验规则引擎（技术设计 §4.4 / §5.2；验收 D-01～D-14）。
 *
 * 纯函数：只接受显式输入与 evaluatedAt；无 Date.now()、无网络、无 DB、无签名。
 * 三种策略绝不自动降级；任何策略被阻断时 executionEligible=false。
 *
 * verdict 判定：
 *   HARD 阻断码（明确拒绝）任一出现 → rejected
 *   其它 block（信息不足）任一出现 → limited
 *   否则 → eligible
 */
import { NYSE_CALENDAR, type MarketCalendar } from "../calendar";
import { sessionAt, sessionsSinceClose } from "../session";
import type { Session } from "../types";
import {
  computeMinOutRaw,
  deviationBps,
  executableUsdPerShare,
  isRawAmount,
  parseRaw,
} from "./amounts";
import type {
  AssetRegistry,
  ComparisonStatus,
  EffectivePolicy,
  EvidenceRecord,
  NormalizedJob,
  NormalizedQuote,
  OkxQuoteEvidence,
  OkxRwaTokenEvidence,
  PythReferenceEvidence,
  Reason,
  ReasonCode,
  RefCloseEvidence,
  ReportReference,
  StablecoinUsdEvidence,
  TokenMetaEvidence,
  Verdict,
} from "./contracts";
import { findEntry, isZeroAddress, registryHash } from "./registry";
import { ageSeconds, isFutureBeyondTolerance, parseIsoUtc } from "./time";

export interface EvaluationInput {
  /** v2：job.side 缺省 buy；sell = 股票代币→稳定币（角色对调、单价计算反向、参考价仍对股票 underlying） */
  job: NormalizedJob;
  policy: EffectivePolicy;
  registry: AssetRegistry;
  evidence: EvidenceRecord[];
  evaluatedAt: string;
  calendar?: MarketCalendar;
}

export interface EvaluationResult {
  verdict: Verdict;
  executionEligible: boolean;
  comparisonStatus: ComparisonStatus;
  marketSession: Session;
  reasons: Reason[];
  normalizedQuote: NormalizedQuote | null;
  reference: ReportReference | null;
  evidenceIds: string[];
  registryHash: `0x${string}`;
}

/** 明确拒绝（非"信息不足"）的原因码。 */
export const HARD_BLOCK_CODES: ReadonlySet<ReasonCode> = new Set<ReasonCode>([
  "ASSET_UNSUPPORTED",
  "REGISTRY_MISMATCH",
  "SOURCE_TIME_FUTURE",
  "REFERENCE_DEVIATION_EXCEEDED",
  "MARKET_OUTSIDE_REGULAR",
  "SOURCE_CONFLICT",
  "QUOTE_UNAVAILABLE",
  "QUOTE_TOO_OLD",
  "PRICE_IMPACT_EXCEEDED",
  "ROUTE_UNSUPPORTED",
  "MIN_OUT_INVALID",
  "AMOUNT_OUT_OF_RANGE",
  "POLICY_PARAM_OUT_OF_RANGE",
]);

export function verdictFromReasons(reasons: Reason[]): Verdict {
  let hard = false;
  let soft = false;
  for (const r of reasons) {
    if (r.severity !== "block") continue;
    if (HARD_BLOCK_CODES.has(r.code)) hard = true;
    else soft = true;
  }
  if (hard) return "rejected";
  if (soft) return "limited";
  return "eligible";
}

type Picked<K extends EvidenceRecord["payload"]["kind"]> = EvidenceRecord & {
  payload: Extract<EvidenceRecord["payload"], { kind: K }>;
};

function latestOf<K extends EvidenceRecord["payload"]["kind"]>(
  evidence: EvidenceRecord[],
  kind: K,
  pred: (p: Extract<EvidenceRecord["payload"], { kind: K }>) => boolean = () => true,
): Picked<K> | null {
  let best: Picked<K> | null = null;
  for (const e of evidence) {
    if (e.payload.kind !== kind) continue;
    const p = e.payload as Extract<EvidenceRecord["payload"], { kind: K }>;
    if (!pred(p)) continue;
    if (best === null || parseIsoUtc(e.time.receivedAt) > parseIsoUtc(best.time.receivedAt)) {
      best = e as Picked<K>;
    }
  }
  return best;
}

export function evaluateVerification(input: EvaluationInput): EvaluationResult {
  const { job, policy, registry, evidence, evaluatedAt } = input;
  const cal = input.calendar ?? NYSE_CALENDAR;
  const def = policy.definition;
  const params = policy.params;
  const reasons: Reason[] = [];
  const push = (code: ReasonCode, severity: Reason["severity"], evidenceIds: string[], detail?: Reason["detail"]) => {
    reasons.push(detail ? { code, severity, evidenceIds, detail } : { code, severity, evidenceIds });
  };

  const nowMs = parseIsoUtc(evaluatedAt);
  const sessionInfo = sessionAt(new Date(nowMs), cal);
  const regHash = registryHash(registry);
  const evidenceIds = evidence.map((e) => e.evidenceId).sort();

  /* ---------- 0. 证据时间健全性（D-02 / D-10） ---------- */
  for (const e of evidence) {
    const req = parseIsoUtc(e.time.requestedAt);
    const rec = parseIsoUtc(e.time.receivedAt);
    if (rec < req) push("SOURCE_TIME_FUTURE", "block", [e.evidenceId], { field: "receivedAt<requestedAt" });
    if (isFutureBeyondTolerance(e.time.receivedAt, evaluatedAt, def.futureSkewToleranceSeconds)) {
      push("SOURCE_TIME_FUTURE", "block", [e.evidenceId], { field: "receivedAt" });
    }
    if (
      e.time.sourcePublishedAt !== null &&
      isFutureBeyondTolerance(e.time.sourcePublishedAt, evaluatedAt, def.futureSkewToleranceSeconds)
    ) {
      push("SOURCE_TIME_FUTURE", "block", [e.evidenceId], { field: "sourcePublishedAt" });
    }
  }

  /* ---------- 1. 资产身份（D-01） ---------- */
  const side: "buy" | "sell" = job.side === "sell" ? "sell" : "buy";
  const inputEntry = findEntry(registry, job.inputAssetKey);
  const outputEntry = findEntry(registry, job.outputAssetKey);
  /** 股票腿 / 稳定币腿（买入：输出=股票；卖出：输入=股票） */
  const stockEntry = side === "buy" ? outputEntry : inputEntry;
  const stableEntry = side === "buy" ? inputEntry : outputEntry;
  const regEv = latestOf(evidence, "registry_lookup");
  const regIds = regEv ? [regEv.evidenceId] : [];
  if (!inputEntry) push("ASSET_UNSUPPORTED", "block", regIds, { assetKey: job.inputAssetKey, side: "input" });
  if (!outputEntry) push("ASSET_UNSUPPORTED", "block", regIds, { assetKey: job.outputAssetKey, side: "output" });
  if (inputEntry && outputEntry) {
    const wantIn = side === "buy" ? "stable_input" : "stock_output";
    const wantOut = side === "buy" ? "stock_output" : "stable_input";
    if (inputEntry.role !== wantIn) push("REGISTRY_MISMATCH", "block", regIds, { side: "input", role: inputEntry.role, expected: wantIn });
    if (outputEntry.role !== wantOut) push("REGISTRY_MISMATCH", "block", regIds, { side: "output", role: outputEntry.role, expected: wantOut });
    if (inputEntry.chainId !== job.executionChainId || outputEntry.chainId !== job.executionChainId || registry.chainId !== job.executionChainId) {
      push("REGISTRY_MISMATCH", "block", regIds, { field: "chainId", executionChainId: job.executionChainId });
    }
    if (!inputEntry.executionAllowed || !outputEntry.executionAllowed) {
      push("REGISTRY_MISMATCH", "block", regIds, { field: "executionAllowed" });
    }
    if (job.inputAssetKey === job.outputAssetKey) push("REGISTRY_MISMATCH", "block", regIds, { field: "input==output" });
  }
  if (regEv && (!regEv.payload.inputMatched || !regEv.payload.outputMatched || regEv.payload.registryHash !== regHash)) {
    push("REGISTRY_MISMATCH", "block", regIds, { field: "registry_lookup" });
  }
  if (isZeroAddress(job.recipientAddress) || isZeroAddress(job.ownerAddress)) {
    push("REGISTRY_MISMATCH", "block", [], { field: "zero_address" });
  }
  if (!isRawAmount(job.amountInRaw) || parseRaw(job.amountInRaw) <= 0n) {
    push("AMOUNT_OUT_OF_RANGE", "block", [], { amountInRaw: job.amountInRaw });
  }

  /* ---------- 2. 代币单位（D-05 / D-06） ---------- */
  const tokenMetaEv = stockEntry
    ? latestOf(evidence, "token_meta", (p) => p.tokenAddress === stockEntry.tokenAddress && p.chainId === stockEntry.chainId)
    : null;
  const tokenMeta: TokenMetaEvidence | null = tokenMetaEv?.payload ?? null;
  if (stockEntry && tokenMeta && tokenMeta.decimals !== null && tokenMeta.decimals !== stockEntry.tokenDecimals) {
    push("REGISTRY_MISMATCH", "block", tokenMetaEv ? [tokenMetaEv.evidenceId] : [], {
      field: "decimals",
      registry: stockEntry.tokenDecimals,
      onchain: tokenMeta.decimals,
    });
  }
  const sharesPerToken = stockEntry?.sharesPerToken ?? null;
  const unitVerified = stockEntry !== null && sharesPerToken !== null && stockEntry.unitSource !== null;
  if (stockEntry && !unitVerified && def.referenceRequirement !== "none") {
    push("TOKEN_UNIT_UNVERIFIED", "block", tokenMetaEv ? [tokenMetaEv.evidenceId] : [], { tokenForm: stockEntry.tokenForm });
  }
  /* ---------- 2b. 乘数变化（v2 W5 / T-04）：同一股票代币的乘数观测（okx_rwa_token.ratio / token_meta.multiplier）出现不同值 → UNIT_CHANGED（warning，non-HARD） ---------- */
  if (stockEntry) {
    const obs: Array<{ id: string; at: number; value: string; source: string }> = [];
    for (const e of evidence) {
      const p = e.payload;
      if (p.kind === "okx_rwa_token" && p.tokenAddress === stockEntry.tokenAddress && p.chainId === stockEntry.chainId && p.ratio !== undefined && p.ratio !== null) {
        obs.push({ id: e.evidenceId, at: parseIsoUtc(e.time.receivedAt), value: p.ratio, source: "okx_rwa_token.ratio" });
      }
      if (p.kind === "token_meta" && p.tokenAddress === stockEntry.tokenAddress && p.chainId === stockEntry.chainId && p.multiplier !== null) {
        obs.push({ id: e.evidenceId, at: parseIsoUtc(e.time.receivedAt), value: p.multiplier, source: "token_meta.multiplier" });
      }
    }
    // 同源比较：只在同一来源内检测变化（跨源口径差异属 TOKEN_UNIT_UNVERIFIED 范畴，由 registry.unitSource 决定）
    for (const source of ["okx_rwa_token.ratio", "token_meta.multiplier"]) {
      const same = obs.filter((o) => o.source === source).sort((a, b) => a.at - b.at);
      if (same.length >= 2) {
        const first = same[0]!;
        const last = same[same.length - 1]!;
        if (first.value !== last.value) {
          push("UNIT_CHANGED", "warning", [first.id, last.id], { source, from: first.value, to: last.value });
        }
      }
    }
  }

  /* ---------- 3. 报价（D-08 / D-10） ---------- */
  let normalizedQuote: NormalizedQuote | null = null;
  let quoteEv: Picked<"okx_quote"> | null = null;
  if (inputEntry && outputEntry) {
    quoteEv = latestOf(
      evidence,
      "okx_quote",
      (p) =>
        p.chainId === job.executionChainId &&
        p.fromToken === inputEntry.tokenAddress &&
        p.toToken === outputEntry.tokenAddress &&
        p.amountInRaw === job.amountInRaw,
    );
  }
  if (!quoteEv) {
    push("QUOTE_UNAVAILABLE", "block", [], { reason: "no_matching_quote" });
  } else {
    const q: OkxQuoteEvidence = quoteEv.payload;
    const qid = [quoteEv.evidenceId];
    const age = ageSeconds(quoteEv.time.receivedAt, evaluatedAt);
    if (age > def.quoteMaxAgeSeconds) {
      push("QUOTE_TOO_OLD", "block", qid, { ageSeconds: Math.floor(age), maxAgeSeconds: def.quoteMaxAgeSeconds });
    }
    if (!isRawAmount(q.expectedOutRaw) || parseRaw(q.expectedOutRaw) <= 0n) {
      push("QUOTE_UNAVAILABLE", "block", qid, { reason: "zero_output" });
    }
    if (!q.routeSupported) push("ROUTE_UNSUPPORTED", "block", qid, { route: q.routeSummary.join(">") });
    if (q.adverseImpactBps === null) {
      if (def.requireImpactKnown) push("PRICE_IMPACT_UNKNOWN", "block", qid, { raw: q.priceImpactPercentRaw });
      else push("PRICE_IMPACT_UNKNOWN", "warning", qid, { raw: q.priceImpactPercentRaw });
    } else if (params.maxPriceImpactBps !== null && q.adverseImpactBps > params.maxPriceImpactBps) {
      push("PRICE_IMPACT_EXCEEDED", "block", qid, { adverseImpactBps: q.adverseImpactBps, maxPriceImpactBps: params.maxPriceImpactBps });
    }
    let minOutRaw = "0";
    if (isRawAmount(q.expectedOutRaw) && parseRaw(q.expectedOutRaw) > 0n) {
      minOutRaw = computeMinOutRaw(q.expectedOutRaw, params.maxSlippageBps);
      if (parseRaw(minOutRaw) <= 0n) push("MIN_OUT_INVALID", "block", qid, { minOutRaw });
    } else {
      push("MIN_OUT_INVALID", "block", qid, { minOutRaw });
    }
    normalizedQuote = {
      amountInRaw: q.amountInRaw,
      expectedOutRaw: q.expectedOutRaw,
      minOutRaw,
      priceImpactPercent: q.priceImpactPercentRaw,
      adverseImpactBps: q.adverseImpactBps,
      requestedAt: quoteEv.time.requestedAt,
      receivedAt: quoteEv.time.receivedAt,
      sourcePublishedAt: quoteEv.time.sourcePublishedAt,
      executableUsdPerShare: null,
    };
  }

  /* ---------- 4. 稳定币美元计价（D-07） ---------- */
  let usdPerInput: string | null = null;
  let usdEv: Picked<"stablecoin_usd"> | null = null;
  if (stableEntry && def.referenceRequirement !== "none") {
    usdEv = latestOf(evidence, "stablecoin_usd", (p) => p.tokenAddress === stableEntry.tokenAddress && p.chainId === stableEntry.chainId);
    const p: StablecoinUsdEvidence | null = usdEv?.payload ?? null;
    if (!p || p.usdPerToken === null) {
      push("USD_CONVERSION_UNKNOWN", "block", usdEv ? [usdEv.evidenceId] : [], { token: stableEntry.tokenAddress });
    } else {
      usdPerInput = p.usdPerToken;
    }
  }

  /* ---------- 5. 参考价（D-03 / D-04 / D-13 / D-14） ---------- */
  let reference: ReportReference | null = null;
  let comparisonStatus: ComparisonStatus = "unverified";
  const session = sessionInfo.session;

  if (def.referenceRequirement === "none") {
    comparisonStatus = "not_requested";
    push("COMPARISON_NOT_REQUESTED", "info", []);
  } else if (stockEntry) {
    const underlyingId = stockEntry.underlyingId;
    const rwaEv = latestOf(evidence, "okx_rwa_token", (p) => p.tokenAddress === stockEntry.tokenAddress && p.chainId === stockEntry.chainId);
    const rwa: OkxRwaTokenEvidence | null = rwaEv?.payload ?? null;

    if (def.referenceRequirement === "live") {
      if (def.sessionRequirement === "regular" && session !== "REGULAR") {
        push("MARKET_OUTSIDE_REGULAR", "block", [], { session, nyDate: sessionInfo.nyDate });
      }
      const pythEv = latestOf(evidence, "pyth_reference", (p) => p.underlyingId === underlyingId);
      if (!pythEv) {
        push("REFERENCE_MISSING", "block", [], { underlyingId });
      } else {
        const p: PythReferenceEvidence = pythEv.payload;
        const pid = [pythEv.evidenceId];
        if (pythEv.time.sourcePublishedAt === null) {
          push("SOURCE_TIME_MISSING", "block", pid, { provider: pythEv.provider });
        } else {
          const age = ageSeconds(pythEv.time.sourcePublishedAt, evaluatedAt);
          if (age > def.liveReferenceMaxAgeSeconds) {
            push("REFERENCE_STALE", "block", pid, { ageSeconds: Math.floor(age), maxAgeSeconds: def.liveReferenceMaxAgeSeconds });
          }
          if (p.sessionAtPublish !== "REGULAR" || p.tradingDate !== sessionInfo.nyDate) {
            push("REFERENCE_STALE", "block", pid, { sessionAtPublish: p.sessionAtPublish, tradingDate: p.tradingDate, today: sessionInfo.nyDate });
          }
        }
        // 与 OKX RWA stockPrice 交叉核对（开市时该字段应为实时）
        if (rwa && rwa.stockPriceUsd !== null && rwaEv && session === "REGULAR") {
          const dev = deviationBps(p.priceUsd, rwa.stockPriceUsd);
          if (dev !== null && Math.abs(dev) > def.closeCrossVerifyToleranceBps) {
            push("SOURCE_CONFLICT", "block", [pythEv.evidenceId, rwaEv.evidenceId], { deviationBps: dev, toleranceBps: def.closeCrossVerifyToleranceBps });
          }
        }
        reference = {
          underlyingId,
          priceUsd: p.priceUsd,
          kind: "live",
          tradingDate: p.tradingDate,
          sourcePublishedAt: pythEv.time.sourcePublishedAt,
          sourceId: `${pythEv.provider}:${p.feedId}`,
          deviationBps: null,
        };
      }
    } else {
      // official_close：正式收盘 或 交叉核验收盘；provisional / 仅最后常规观测 不合格
      const closeEv = latestOf(evidence, "ref_close", (p) => p.underlyingId === underlyingId);
      if (!closeEv) {
        push("REFERENCE_MISSING", "block", [], { underlyingId, need: "official_close" });
      } else {
        const c: RefCloseEvidence = closeEv.payload;
        const cid = [closeEv.evidenceId];
        const missed = sessionsSinceClose(c.tradingDate, new Date(nowMs), cal);
        if (missed > def.closeMaxSessionsSinceClose) {
          push("CLOSE_SESSION_MISMATCH", "block", cid, { tradingDate: c.tradingDate, missedSessions: missed, today: sessionInfo.nyDate });
        }
        let kind: ReportReference["kind"];
        // v2 (CV-D06)：策略可显式声明接受的收盘 kind；v1.0.0 无该字段 → 沿用旧行为（official / cross_verified）
        const accepted = def.acceptedCloseKinds;
        const acceptsKind = (k: ReportReference["kind"]) => (accepted ? accepted.includes(k) : k === "official_close" || k === "close_cross_verified");
        if (c.closeSource === "official") {
          kind = "official_close";
          if (!acceptsKind(kind)) push("REFERENCE_PROVISIONAL", "block", cid, { closeSource: c.closeSource, kind, reason: "kind_not_accepted" });
        } else if (c.closeSource === "last_tick") {
          kind = "close_last_tick";
          push("CLOSE_UNCONFIRMED", "info", cid, { tradingDate: c.tradingDate, closeUsd: c.closeUsd });
          if (!acceptsKind(kind)) push("REFERENCE_PROVISIONAL", "block", cid, { closeSource: c.closeSource, kind, reason: "kind_not_accepted" });
        } else if (c.closeSource === "pyth_provisional") {
          kind = "provisional_close";
          push("REFERENCE_PROVISIONAL", "block", cid, { closeSource: c.closeSource });
        } else {
          kind = "last_regular_observation";
          const closedNow = session === "CLOSED" || session === "HOLIDAY";
          const rwaReceivedSession = rwaEv ? sessionAt(new Date(parseIsoUtc(rwaEv.time.receivedAt)), cal).session : null;
          const rwaUsable =
            rwa !== null && rwaEv !== null && rwa.stockPriceUsd !== null && closedNow &&
            (rwaReceivedSession === "CLOSED" || rwaReceivedSession === "HOLIDAY");
          if (rwaUsable && rwaEv) {
            const dev = deviationBps(c.closeUsd, rwa.stockPriceUsd as string);
            if (dev === null) {
              push("REFERENCE_PROVISIONAL", "block", cid, { closeSource: c.closeSource, crossVerify: "invalid_rwa_price" });
            } else if (Math.abs(dev) > def.closeCrossVerifyToleranceBps) {
              push("SOURCE_CONFLICT", "block", [closeEv.evidenceId, rwaEv.evidenceId], { deviationBps: dev, toleranceBps: def.closeCrossVerifyToleranceBps });
            } else {
              kind = "close_cross_verified";
              push("CLOSE_CROSS_VERIFIED", "info", [closeEv.evidenceId, rwaEv.evidenceId], { deviationBps: dev });
              if (!acceptsKind(kind)) push("REFERENCE_PROVISIONAL", "block", cid, { closeSource: c.closeSource, kind, reason: "kind_not_accepted" });
            }
          } else {
            push("REFERENCE_PROVISIONAL", "block", cid, {
              closeSource: c.closeSource,
              crossVerify: rwa === null ? "no_rwa_evidence" : closedNow ? "rwa_not_in_closed_session" : "market_not_closed",
            });
          }
        }
        reference = {
          underlyingId,
          priceUsd: c.closeUsd,
          kind,
          tradingDate: c.tradingDate,
          sourcePublishedAt: closeEv.time.sourcePublishedAt,
          sourceId: `${closeEv.provider}:${c.closeSource}`,
          deviationBps: null,
        };
      }
    }
  }

  /* ---------- 6. 可执行单价 vs 参考价（D-07 / D-08） ---------- */
  const referenceVerified =
    reference !== null &&
    !reasons.some((r) => r.severity === "block" && ["REFERENCE_MISSING", "REFERENCE_STALE", "REFERENCE_PROVISIONAL", "SOURCE_TIME_MISSING", "CLOSE_SESSION_MISMATCH", "SOURCE_CONFLICT"].includes(r.code));
  if (def.referenceRequirement !== "none") {
    if (referenceVerified && reference && normalizedQuote && stableEntry && stockEntry) {
      // 买入：USD 从输入侧（稳定币）来，股数从输出侧来；卖出：USD 从输出侧（稳定币）来，股数从输入侧来
      const exec = executableUsdPerShare(
        side === "buy"
          ? {
              amountInRaw: normalizedQuote.amountInRaw,
              inDecimals: stableEntry.tokenDecimals,
              usdPerInputToken: usdPerInput,
              expectedOutRaw: normalizedQuote.expectedOutRaw,
              outDecimals: stockEntry.tokenDecimals,
              sharesPerToken: unitVerified ? sharesPerToken : null,
            }
          : {
              amountInRaw: normalizedQuote.expectedOutRaw,
              inDecimals: stableEntry.tokenDecimals,
              usdPerInputToken: usdPerInput,
              expectedOutRaw: normalizedQuote.amountInRaw,
              outDecimals: stockEntry.tokenDecimals,
              sharesPerToken: unitVerified ? sharesPerToken : null,
            },
      );
      if (exec !== null) {
        normalizedQuote.executableUsdPerShare = exec;
        const dev = deviationBps(exec, reference.priceUsd);
        reference.deviationBps = dev;
        comparisonStatus = reference.kind === "live" ? "live" : "official_close";
        if (dev !== null && params.maxReferenceDeviationBps !== null && Math.abs(dev) > params.maxReferenceDeviationBps) {
          push("REFERENCE_DEVIATION_EXCEEDED", "block", quoteEv ? [quoteEv.evidenceId] : [], {
            deviationBps: dev,
            maxReferenceDeviationBps: params.maxReferenceDeviationBps,
          });
        }
      } else {
        comparisonStatus = "unverified";
      }
    } else {
      comparisonStatus = "unverified";
    }
  }

  const verdict = verdictFromReasons(reasons);
  return {
    verdict,
    executionEligible: verdict === "eligible",
    comparisonStatus,
    marketSession: session,
    reasons,
    normalizedQuote,
    reference,
    evidenceIds,
    registryHash: regHash,
  };
}
