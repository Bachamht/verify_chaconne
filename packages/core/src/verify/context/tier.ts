/**
 * 档位裁剪（D-084 / interfaces §11.3）：字段不在档位 → 整个字段 `{status:'unavailable', note:'not_in_tier'}`，绝不省略键（X-04）。
 *
 * 两层过滤取交集：
 *  1. producer 自报 purposes（events.yaml 白名单）；
 *  2. 本服务的固定档位策略（防御：即便 producer 误标，agent/paid 也拿不到 Yahoo/Coinglass 派生值 risk.*）。
 */
import type { ContextTier, CtxField, MarketContext } from "../contracts";
import { CONTEXT_FIELD_PATHS, contextPathGet, contextPathSet } from "./schema";

/** 服务侧档位策略：路径前缀 → 允许的档位 */
const SERVICE_TIER_POLICY: ReadonlyArray<readonly [string, ReadonlyArray<ContextTier>]> = [
  ["session.", ["internal", "display", "agent", "paid"]],
  ["fed.", ["internal", "display", "agent", "paid"]],
  ["rates.", ["internal", "display", "agent", "paid"]],
  ["crossAsset.", ["internal", "display", "agent", "paid"]],
  ["driftVerdict", ["internal", "display", "agent", "paid"]],
  /** Yahoo（VIX/NQ/ES/DXY）派生值：只 internal / display */
  ["risk.", ["internal", "display"]],
];

export function fieldAllowedInTier(path: string, field: CtxField<unknown>, tier: ContextTier): boolean {
  if (tier === "internal") return true;
  const policy = SERVICE_TIER_POLICY.find(([prefix]) => path.startsWith(prefix));
  if (!policy || !policy[1].includes(tier)) return false;
  return field.purposes.includes(tier);
}

export function notInTierField(f: CtxField<unknown>): CtxField<null> {
  return { value: null, source: f.source, observedAt: null, fetchedAt: f.fetchedAt, status: "unavailable", purposes: [], note: "not_in_tier" };
}

/** 返回裁剪后的副本：全部键保留；events 不裁（事件层对所有档位公开，由 filter 决定相关性） */
export function trimContextToTier(ctx: MarketContext, tier: ContextTier): MarketContext {
  const clone = structuredClone(ctx) as unknown as Record<string, unknown>;
  for (const [path] of CONTEXT_FIELD_PATHS) {
    const f = contextPathGet(clone, path) as CtxField<unknown> | undefined;
    if (!f) continue;
    if (!fieldAllowedInTier(path, f, tier)) contextPathSet(clone, path, notInTierField(f));
  }
  return clone as unknown as MarketContext;
}

export function isContextTier(x: unknown): x is ContextTier {
  return x === "internal" || x === "display" || x === "agent" || x === "paid";
}
