/**
 * 第三个 A2MCP 服务「Agent Tasks」（Lane F；等 #13803 结果后再提交上架，D-085）。
 *   POST/GET /a2mcp/agent-tasks   输入 owner 或资产集合 → 事件影响 + 任务草案；审核期价格 0（不建订单，直接交付）。
 * 沿用 a2mcp 约定：只回 200/402（本端点审核期只有 200）；缺参 200 status=input_required；非法 JSON 由 app.ts 错误处理器兜成 200。
 * 事件影响（Lane D）与任务落库（Lane B）以可选钩子接入；未接上时对应字段 status=unavailable，不伪装。
 */
import type { Request, Response } from "express";
import type { AssetRegistry, EventImpact, MarketEvent } from "@chaconne/core/verify";
import type { VerifyConfig } from "../config";
import { rateLimit } from "./auth";
import { resolveAsset } from "./a2mcpInput";
import { buildMissions, type Mission } from "../missions/build";

export const A2MCP_AGENT_TASKS_PATH = "/a2mcp/agent-tasks";

export const A2MCP_AGENT_TASKS_INPUT_SCHEMA = {
  type: "object",
  description: "Give either an owner wallet (impacts are computed against its holdings and tasks) or a set of assets (symbols like AAPLx / NVDAx / AAPL, or eip155 keys).",
  properties: {
    owner: { type: "string", description: "EVM address (0x…, 40 hex). Optional if `assets` is given." },
    assets: { type: "array", items: { type: "string" }, description: "Stock tokens to plan for: symbols (AAPLx, NVDA) or eip155:<chainId>:<address>. Optional if `owner` is given. A comma-separated string is accepted too." },
    horizonHours: { type: "integer", minimum: 1, maximum: 336, description: "Event horizon for impacts, default 48" },
  },
} as const;

export interface AgentTasksDeps {
  cfg: VerifyConfig;
  registry: AssetRegistry;
  now?: () => Date;
  /** Lane D：owner 的事件影响；未接上返回 null */
  impacts?: (owner: string, horizonHours: number) => Promise<EventImpact[] | null>;
  /** Lane D：事件列表；未接上返回 null */
  events?: (fromUtc: Date, toUtc: Date) => Promise<MarketEvent[] | null>;
}

const OWNER_KEYS = ["owner", "ownerAddress", "wallet", "walletAddress", "address", "account"];
const ASSET_KEYS = ["assets", "asset", "assetKeys", "symbols", "symbol", "stock", "stocks", "outputAssetKey", "outputAssetKeys"];

function pick(body: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    if (body[k] !== undefined && body[k] !== null && body[k] !== "") return body[k];
    const hit = Object.keys(body).find((bk) => bk.toLowerCase() === k.toLowerCase());
    if (hit && body[hit] !== undefined && body[hit] !== null && body[hit] !== "") return body[hit];
  }
  return undefined;
}

export function createA2mcpAgentTasksHandler(d: AgentTasksDeps) {
  const now = d.now ?? (() => new Date());
  const example = { owner: "0x1111111111111111111111111111111111111111", assets: ["AAPLx", "NVDAx"], horizonHours: 48 };
  return async (req: Request, res: Response): Promise<void> => {
    res.setHeader("Cache-Control", "private, no-store");
    if (!rateLimit(`a2mcp-agent-tasks:${req.ip ?? "unknown"}`, d.cfg.RATE_LIMIT_PER_MIN, 60_000)) {
      res.status(429).json({ ok: false, status: "rate_limited", error: "rate_limited", retryAfterSeconds: 60 });
      return;
    }
    const body = ((req.method === "GET" ? req.query : req.body) ?? {}) as Record<string, unknown>;
    const stocks = d.registry.entries.filter((e) => e.role === "stock_output" && e.executionAllowed);
    const inputRequired = (missing: string[], problems: Array<{ field: string; value: string; hint: string }>) =>
      res.status(200).json({
        ok: false,
        status: "input_required",
        error: "input_required",
        service: "Chaconne Agent / Agent Tasks",
        summary: `${missing.length ? `Missing: ${missing.join(" or ")}. ` : ""}${problems.length ? `Invalid: ${problems.map((p) => `${p.field}="${p.value}" (${p.hint})`).join("; ")}. ` : ""}Call ${req.method} ${A2MCP_AGENT_TASKS_PATH} with owner (EVM address) and/or assets (${stocks.slice(0, 6).map((e) => e.displaySymbol).join(" / ")}${stocks.length > 6 ? " / …" : ""}). Returns event impacts and task drafts (SIMULATION or dated REPLAY); nothing is executed and nothing is charged during the listing review.`.trim(),
        missingParams: missing,
        problems,
        schema: A2MCP_AGENT_TASKS_INPUT_SCHEMA,
        example,
        supportedAssets: { stocks: stocks.map((e) => `${e.displaySymbol} (${e.underlyingId.split(":")[1]})`) },
        howToCall: { method: req.method, endpoint: A2MCP_AGENT_TASKS_PATH, contentType: "application/json (POST body) or query string (GET)" },
      });
    if (Object.keys(body).length === 0) {
      inputRequired(["owner", "assets"], []);
      return;
    }
    const problems: Array<{ field: string; value: string; hint: string }> = [];
    const ownerRaw = pick(body, OWNER_KEYS);
    const owner = typeof ownerRaw === "string" ? ownerRaw.trim().toLowerCase() : "";
    if (owner && !/^0x[0-9a-f]{40}$/.test(owner)) problems.push({ field: "owner", value: owner, hint: "must be a 0x-prefixed 40-hex EVM address" });
    const assetsRaw = pick(body, ASSET_KEYS);
    const assetStrings = Array.isArray(assetsRaw) ? assetsRaw.map(String) : typeof assetsRaw === "string" ? assetsRaw.split(",").map((s) => s.trim()).filter(Boolean) : [];
    const resolved: Array<{ input: string; assetKey: string; displaySymbol: string; underlyingId: string }> = [];
    for (const s of assetStrings) {
      const e = resolveAsset(d.registry, s, "stock_output");
      if (!e) problems.push({ field: "assets", value: s, hint: `unknown stock token; use one of ${stocks.map((x) => x.displaySymbol).join(" / ")} or an eip155 key` });
      else if (!e.executionAllowed) problems.push({ field: "assets", value: s, hint: `${e.displaySymbol} is listed but not enabled for execution` });
      else resolved.push({ input: s, assetKey: e.assetKey, displaySymbol: e.displaySymbol, underlyingId: e.underlyingId });
    }
    if (!owner && assetStrings.length === 0) {
      inputRequired(["owner", "assets"], problems);
      return;
    }
    if (problems.length) {
      inputRequired([], problems);
      return;
    }
    const horizon = Math.min(336, Math.max(1, Number(pick(body, ["horizonHours", "horizon"]) ?? 48) || 48));
    const t0 = now();
    const to = new Date(t0.getTime() + horizon * 3600_000);
    const impacts = owner && d.impacts ? await d.impacts(owner, horizon) : null;
    const events = d.events ? await d.events(new Date(t0.getTime() - 6 * 3600_000), to) : null;
    const assetsForMissions = resolved.length ? resolved : stocks.map((e) => ({ input: e.displaySymbol, assetKey: e.assetKey, displaySymbol: e.displaySymbol, underlyingId: e.underlyingId }));
    const missions: Mission[] = buildMissions({ now: t0, events, assets: assetsForMissions.map((a) => ({ assetKey: a.assetKey, displaySymbol: a.displaySymbol, underlyingId: a.underlyingId, executionAllowed: true })), focus: resolved.map((a) => a.assetKey), horizonDays: Math.ceil(horizon / 24) });
    res.status(200).json({
      ok: true,
      status: "delivered",
      service: "Chaconne Agent / Agent Tasks",
      priceUsd: "0",
      priceNote: "Free during the listing review; execution is always authorized separately by the owner's wallet (TradeMandate) and is never part of this service.",
      owner: owner || null,
      assets: assetsForMissions.map((a) => ({ input: a.input, assetKey: a.assetKey, displaySymbol: a.displaySymbol, underlyingId: a.underlyingId })),
      horizonHours: horizon,
      eventImpacts: owner ? (impacts ? { status: "ok", items: impacts } : { status: "unavailable", items: [], note: "event impacts (C6) not available on this deployment yet" }) : { status: "not_requested", items: [], note: "give `owner` to get impacts against holdings and tasks" },
      events: events ? { status: "ok", count: events.length, items: events.slice(0, 50) } : { status: "unavailable", count: 0, items: [], note: "event calendar (C6) not available on this deployment yet; drafts fall back to a dated replay" },
      taskDrafts: missions.map((m) => ({ ...m, createUrl: "/v1/tasks", createBody: { playbookId: m.draft.playbookId, params: m.draft.params, conditions: m.draft.conditions, mode: m.draft.mode === "REPLAY" ? "SIMULATION" : m.draft.mode, ownerAddress: owner || "<owner>" } })),
      disclaimer: "Drafts describe conditions and templates only; they are not investment advice and carry no prediction of price direction. A draft becomes a live task only after the owner signs a TradeMandate.",
    });
  };
}
