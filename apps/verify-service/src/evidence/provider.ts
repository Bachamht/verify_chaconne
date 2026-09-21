/**
 * 证据提供者接口：服务在 创建任务 与 准备执行 两个时点调用 collect()。
 * - FixtureEvidenceProvider：把 core 共享 fixture 的时间平移到 now（FIXTURE 模式，测试/演示）。
 * - LiveEvidenceProvider：Lane B 实现（OKX RWA / quote / swap + Pyth + 链上 meta）。
 * 任何提供者都不得返回 mode=LIVE 的伪造记录；fixture 记录 mode 固定为 FIXTURE。
 */
import type { EvidenceRecord, NormalizedJob, AssetRegistry, EvmAddress } from "@chaconne/core/verify";
import {
  closeEvidence,
  pythEvidence,
  quoteEvidence,
  rwaEvidence,
  stableEvidence,
  tokenMetaEvidence,
} from "@chaconne/core/verify/fixtures";
import { isTradingDay, sessionAt } from "@chaconne/core";
import { newId } from "../ids";

/** 路由信息：Guard 调用所需（由 swap 适配返回；fixture 用占位） */
export interface RouteInfo {
  router: EvmAddress;
  spender: EvmAddress;
  /** 已解析校验的 router calldata（hex） */
  calldata: `0x${string}`;
}

export interface CollectedEvidence {
  evidence: EvidenceRecord[];
  route: RouteInfo | null;
}

/** 采集选项：授权计划的步骤由 PlanGuard 执行，路由收款人必须是 PlanGuard 而非 v1 Guard（I2 2026-09-21 端到端发现） */
export interface CollectOptions {
  /** 覆盖本次采集的执行合约地址（swapReceiverAddress / userWalletAddress / 解码校验） */
  executorContract?: EvmAddress;
}

export interface EvidenceProvider {
  readonly mode: "FIXTURE" | "LIVE";
  collect(job: NormalizedJob, registry: AssetRegistry, nowIso: string, opts?: CollectOptions): Promise<CollectedEvidence>;
}

export interface FixtureProviderOptions {
  router: EvmAddress;
  spender: EvmAddress;
  /** 覆盖场景：默认按当前时段自动选（常规时段=实时证据；休市=收盘交叉证据） */
  scenario?: "auto" | "live" | "closed" | "missing_source_time" | "no_quote";
}

export class FixtureEvidenceProvider implements EvidenceProvider {
  readonly mode = "FIXTURE" as const;
  constructor(private readonly opts: FixtureProviderOptions) {}

  async collect(job: NormalizedJob, registry: AssetRegistry, nowIso: string): Promise<CollectedEvidence> {
    const now = Date.parse(nowIso);
    const t = (offsetSec: number) => new Date(now - offsetSec * 1000).toISOString();
    const session = sessionAt(new Date(now)).session;
    const scenario = this.opts.scenario === undefined || this.opts.scenario === "auto" ? (session === "REGULAR" ? "live" : "closed") : this.opts.scenario;
    const outEntry = registry.entries.find((e) => e.assetKey === job.outputAssetKey);
    const inEntry = registry.entries.find((e) => e.assetKey === job.inputAssetKey);
    const evidence: EvidenceRecord[] = [];

    const quote = () =>
      quoteEvidence({ receivedAt: t(2), amountInRaw: job.amountInRaw, id: newId("ev") });
    const fixupAddresses = (e: EvidenceRecord): EvidenceRecord => {
      // fixture 构造器用占位地址；这里对齐到实际登记表条目，保证按地址匹配成立
      const p = e.payload;
      if (p.kind === "okx_quote" && inEntry && outEntry) {
        p.chainId = job.executionChainId;
        p.fromToken = inEntry.tokenAddress;
        p.toToken = outEntry.tokenAddress;
      }
      if ((p.kind === "okx_rwa_token" || p.kind === "token_meta") && outEntry) {
        p.chainId = outEntry.chainId;
        p.tokenAddress = outEntry.tokenAddress;
      }
      if (p.kind === "stablecoin_usd" && inEntry) {
        p.chainId = inEntry.chainId;
        p.tokenAddress = inEntry.tokenAddress;
      }
      if ((p.kind === "pyth_reference" || p.kind === "ref_close") && outEntry) {
        p.underlyingId = outEntry.underlyingId;
      }
      return e;
    };

    if (scenario !== "no_quote") evidence.push(quote());
    evidence.push(stableEvidence({ receivedAt: t(10), usdPerToken: "1", id: newId("ev") }));
    evidence.push(tokenMetaEvidence({ receivedAt: t(30), decimals: outEntry?.tokenDecimals ?? 18, id: newId("ev") }));

    if (scenario === "live") {
      const info = sessionAt(new Date(now));
      evidence.push(pythEvidence({ receivedAt: t(1), sourcePublishedAt: t(3), sessionAtPublish: info.session, tradingDate: info.nyDate, id: newId("ev") }));
      evidence.push(rwaEvidence({ receivedAt: t(4), stockPriceUsd: "250.1", id: newId("ev") }));
    } else if (scenario === "missing_source_time") {
      const info = sessionAt(new Date(now));
      evidence.push(pythEvidence({ receivedAt: t(1), sourcePublishedAt: null, sessionAtPublish: info.session, tradingDate: info.nyDate, id: newId("ev") }));
    } else if (scenario === "closed" || scenario === "no_quote") {
      // 最近一个已完成交易日 = 从今天往回找交易日（休市时段今天本身若是交易日且已过收盘则算今天）
      const tradingDate = lastCompletedTradingDate(new Date(now));
      evidence.push(closeEvidence({ receivedAt: t(1), closeSource: "pyth", tradingDate, sourcePublishedAt: `${tradingDate}T19:59:58.000Z`, id: newId("ev") }));
      evidence.push(rwaEvidence({ receivedAt: t(4), stockPriceUsd: "250.05", id: newId("ev") }));
    }

    return {
      evidence: evidence.map(fixupAddresses),
      route: { router: this.opts.router, spender: this.opts.spender, calldata: "0x" },
    };
  }
}

/** 最近一个已完成常规时段的 NY 交易日（YYYY-MM-DD）：今天已过收盘则为今天，否则往回找交易日。 */
export function lastCompletedTradingDate(now: Date): string {
  const DAY = 86_400_000;
  const today = sessionAt(now);
  const regularEnd = today.isHalfDay ? 13 * 60 : 16 * 60;
  const [y, m, d] = today.nyDate.split("-").map(Number) as [number, number, number];
  const base = Date.UTC(y, m - 1, d);
  if (isTradingDay(today.nyDate, new Date(base).getUTCDay()) && today.nyMinutes >= regularEnd) return today.nyDate;
  for (let i = 1; i <= 14; i++) {
    const dt = new Date(base - i * DAY);
    const iso = dt.toISOString().slice(0, 10);
    if (isTradingDay(iso, dt.getUTCDay())) return iso;
  }
  throw new Error("找不到最近交易日");
}
