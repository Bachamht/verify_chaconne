/**
 * P-02 · 委托向导：固定顺序（buy → sell:* → permit:*）、计数器只读 counts、拒签从断点继续、
 * 409 permit_nonce_stale / permit_pending 自动重取、钱包 typedData 的整数转 bigint、P7 签名数预览。
 */
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { DelegationChecklist, DelegationItem } from "@chaconne/core/verify";
import { counterView, isRefetchConflict, itemPosition, nextItem, orderItems, signaturePreview, signLoop, typedDataForWallet, wizardPhase } from "../components/agent/delegation/delegationModel";
import { fxChecklist, FX_OWNER } from "../lib/v7fixtures";
import { DelegationWizard } from "../components/agent/delegation/DelegationWizard";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("../lib/i18n", () => ({ useI18n: () => ({ locale: "zh", t: (key: string) => key }) }));

const td = (value = "1") => ({ domain: { name: "T", version: "1", chainId: 196, verifyingContract: "0x0000000000000000000000000000000000000002" as const }, types: { Permit: [{ name: "owner", type: "address" }, { name: "value", type: "uint256" }] }, primaryType: "Permit", message: { owner: FX_OWNER, value } });
const item = (id: string, kind: DelegationItem["kind"], status: DelegationItem["status"] = "todo"): DelegationItem => ({ id, kind, assetKey: "k", title: { zh: id, en: id }, explain: { zh: "", en: "" }, typedData: status === "todo" ? td() : null, status, ref: null, ...(kind === "permit" ? { permitRequestId: `prm_${id}` } : {}) });

/** 假服务端：签过的项变 confirmed，counts 现算；可注入一次 409 */
function fakeServer(ids: Array<[string, DelegationItem["kind"]]>, opts: { staleOnce?: string } = {}) {
  const status = new Map(ids.map(([id]) => [id, "todo" as DelegationItem["status"]]));
  let stale = opts.staleOnce;
  let nonce = 0;
  const snapshot = (): DelegationChecklist => {
    const items = ids.map(([id, kind]) => ({ ...item(id, kind, status.get(id)!), ...(kind === "permit" ? { permitRequestId: `prm_${id}_${nonce}` } : {}) }));
    const done = items.filter((x) => x.status !== "todo").length;
    return { taskId: "t", items, counts: { signaturesNeeded: items.length, signaturesDone: done, userTransactions: 0 }, allowances: [], buyReady: false, sellReady: {}, complete: done === items.length };
  };
  return {
    snapshot,
    fetch: vi.fn(async () => { nonce++; return snapshot(); }),
    submit: vi.fn(async (it: DelegationItem) => {
      if (stale && it.id === stale) { stale = undefined; return { status: 409, data: { error: "permit_nonce_stale" } }; }
      status.set(it.id, "confirmed");
      return { status: it.kind === "permit" ? 202 : 201, data: {} };
    }),
  };
}
const SIX: Array<[string, DelegationItem["kind"]]> = [["permit:0xu", "permit"], ["sell:a", "mandate_sell"], ["buy", "mandate_buy"], ["permit:0xa", "permit"], ["sell:b", "mandate_sell"], ["permit:0xb", "permit"]];

describe("P-02 · 顺序与计数", () => {
  it("固定顺序 buy → sell:* → permit:*，组内保持服务端顺序", () => {
    const ordered = orderItems(SIX.map(([id, k]) => item(id, k))).map((x) => x.id);
    expect(ordered).toEqual(["buy", "sell:a", "sell:b", "permit:0xu", "permit:0xa", "permit:0xb"]);
  });
  it("下一项跳过 confirmed / submitted / not_needed；failed 只有带新 typedData 才可重签", () => {
    const list = { items: [item("buy", "mandate_buy", "confirmed"), item("permit:0xu", "permit", "not_needed"), item("sell:a", "mandate_sell", "failed")] };
    expect(nextItem(list)).toBeNull();
    const retry = { items: [...list.items.slice(0, 2), { ...item("sell:a", "mandate_sell"), status: "failed" as const }] };
    expect(nextItem(retry)?.id).toBe("sell:a");
    expect(itemPosition(retry, "sell:a")).toBe(2);
  });
  it("计数器读 counts 原值；userTransactions 0 → gas 0", () => {
    expect(counterView({ signaturesNeeded: 6, signaturesDone: 2, userTransactions: 0 })).toEqual({ done: 2, needed: 6, tx: 0, gasZero: true });
    expect(counterView({ signaturesNeeded: 2, signaturesDone: 0, userTransactions: 1 }).gasZero).toBe(false);
    expect(counterView(undefined)).toEqual({ done: 0, needed: 0, tx: 0, gasZero: true });
  });
  it("阶段：签名中 → 上链中（全部签完但未 complete）→ 完成", () => {
    expect(wizardPhase(fxChecklist("fresh"))).toBe("signing");
    expect(wizardPhase({ items: [item("buy", "mandate_buy", "confirmed"), item("permit:0xu", "permit", "submitted")], complete: false })).toBe("onchain");
    expect(wizardPhase(fxChecklist("done"))).toBe("done");
    expect(wizardPhase({ items: [], complete: false })).toBe("empty");
  });
  it("409 判定只认 permit_nonce_stale / permit_pending（及过期兼容码）", () => {
    expect(isRefetchConflict({ status: 409, data: { error: "permit_nonce_stale" } })).toBe(true);
    expect(isRefetchConflict({ status: 409, data: { error: "permit_pending" } })).toBe(true);
    expect(isRefetchConflict({ status: 409, data: { error: "turn_already_answered" } })).toBe(false);
    expect(isRefetchConflict({ status: 422, data: { error: "permit_nonce_stale" } })).toBe(false);
  });
  it("P7 预览：买入 2 次；含 2 只可减仓股票 6 次（DoD #1）", () => {
    expect(signaturePreview(2, false)).toBe(2);
    expect(signaturePreview(1, true)).toBe(4);
    expect(signaturePreview(2, true)).toBe(6);
  });
});

describe("P-02 · 签名循环", () => {
  it("一口气签完 6 项，按固定顺序签名与提交；每次提交后重取清单", async () => {
    const srv = fakeServer(SIX);
    const signed: string[] = [];
    const { end, list } = await signLoop(srv.snapshot(), { me: FX_OWNER, fetch: srv.fetch, submit: srv.submit, isRejection: () => false, sign: async (it) => { signed.push(it.id); return "0x01"; } });
    expect(end.kind).toBe("finished");
    expect(signed).toEqual(["buy", "sell:a", "sell:b", "permit:0xu", "permit:0xa", "permit:0xb"]);
    expect(list.counts).toEqual({ signaturesNeeded: 6, signaturesDone: 6, userTransactions: 0 });
    expect(srv.fetch).toHaveBeenCalledTimes(6);
  });
  it("第 3 项拒签 → 停在第 3 项；再次运行从第 3 项继续，不重签前两项", async () => {
    const srv = fakeServer(SIX);
    const signed: string[] = [];
    const reject = Object.assign(new Error("User rejected"), { code: 4001 });
    const first = await signLoop(srv.snapshot(), { me: FX_OWNER, fetch: srv.fetch, submit: srv.submit, isRejection: (e) => (e as { code?: number }).code === 4001, sign: async (it) => { if (it.id === "sell:b") throw reject; signed.push(it.id); return "0x01"; } });
    expect(first.end).toEqual({ kind: "rejected", k: 3, id: "sell:b" });
    expect(first.list.counts.signaturesDone).toBe(2);
    const second = await signLoop(first.list, { me: FX_OWNER, fetch: srv.fetch, submit: srv.submit, isRejection: () => false, sign: async (it) => { signed.push(it.id); return "0x01"; } });
    expect(second.end.kind).toBe("finished");
    expect(signed).toEqual(["buy", "sell:a", "sell:b", "permit:0xu", "permit:0xa", "permit:0xb"]);
  });
  it("409 permit_nonce_stale → 自动重取清单，用新的 permitRequestId 重签这一项", async () => {
    const srv = fakeServer([["buy", "mandate_buy"], ["permit:0xu", "permit"]], { staleOnce: "permit:0xu" });
    const steps: string[] = [];
    const submittedIds: string[] = [];
    const { end, list } = await signLoop(srv.snapshot(), {
      me: FX_OWNER, fetch: srv.fetch, isRejection: () => false, sign: async () => "0x01",
      submit: async (it, s) => { submittedIds.push(it.permitRequestId ?? it.id); void s; return srv.submit(it); },
      onStep: (s) => steps.push(s.kind === "refetch" ? "refetch" : `${s.kind}:${s.k}`),
    });
    expect(end.kind).toBe("finished");
    expect(list.complete).toBe(true);
    expect(steps).toEqual(["signing:1", "submitting:1", "signing:2", "submitting:2", "refetch", "signing:2", "submitting:2"]);
    expect(submittedIds[1]).not.toBe(submittedIds[2]);
  });
  it("签名人不是 typedData 的 owner → 不签、提示切换钱包", async () => {
    const srv = fakeServer([["buy", "mandate_buy"]]);
    const sign = vi.fn(async () => "0x01" as const);
    const { end } = await signLoop(srv.snapshot(), { me: "0x00000000000000000000000000000000000000ff", fetch: srv.fetch, submit: srv.submit, isRejection: () => false, sign });
    expect(end.kind).toBe("wrong_wallet");
    expect(sign).not.toHaveBeenCalled();
  });
  it("服务不可达 → 停下（不当成功）", async () => {
    const srv = fakeServer([["buy", "mandate_buy"]]);
    const { end } = await signLoop(srv.snapshot(), { me: FX_OWNER, fetch: srv.fetch, submit: async () => null, isRejection: () => false, sign: async () => "0x01" });
    expect(end).toEqual({ kind: "unreachable", k: 1 });
  });
});

describe("typedDataForWallet", () => {
  it("整数字段转 bigint（含嵌套 struct 与数组），去掉 EIP712Domain，chainId 是数字", () => {
    const w = typedDataForWallet({
      domain: { name: "PlanGuard", version: "2", chainId: "196" as unknown as number, verifyingContract: "0x0000000000000000000000000000000000000002" },
      types: { EIP712Domain: [{ name: "name", type: "string" }], TradeMandate: [{ name: "owner", type: "address" }, { name: "budgetCap", type: "uint256" }, { name: "maxSteps", type: "uint32" }, { name: "legs", type: "Leg[]" }, { name: "nums", type: "uint8[]" }], Leg: [{ name: "weight", type: "uint16" }, { name: "asset", type: "address" }] },
      primaryType: "TradeMandate",
      message: { owner: FX_OWNER, budgetCap: "10000000", maxSteps: "5", legs: [{ weight: "10000", asset: "0x0000000000000000000000000000000000000003" }], nums: ["1", "2"] },
    });
    expect(w.types["EIP712Domain"]).toBeUndefined();
    expect(w.domain.chainId).toBe(196);
    expect(w.message).toEqual({ owner: FX_OWNER, budgetCap: 10000000n, maxSteps: 5n, legs: [{ weight: 10000n, asset: "0x0000000000000000000000000000000000000003" }], nums: [1n, 2n] });
  });
});

describe("DelegationWizard（fixture 渲染）", () => {
  it("计数器、事先说明、每项人话、继续签名按钮在 fixture 下禁用", async () => {
    const html = renderToStaticMarkup(React.createElement(DelegationWizard, { taskId: "tsk_fixture", owner: FX_OWNER, fixture: true }));
    expect(html).toContain("签名 2 / 6 · 你的交易 0 · gas 0");
    expect(html).toContain("风险提示");
    expect(html).toContain("额度只给 PlanGuard 合约");
    expect(html).toContain("允许在 10/12 前用最多 10 USDG");
    expect(html).toContain("这是签名，不是交易，不花 gas");
    expect(html).toContain("从第 2 项继续签名");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>从第 2 项继续签名/);
    expect(html).toContain("FIXTURE");
    expect(html).toContain("不证明 Agent 的判断正确");
  }, 20_000);
});
