import { describe, expect, it } from "vitest";
import sample from "./fixtures/activity-live-task.json";
import { actorLabel, agentQuoteText, humanizeActivity, type AssetLite } from "@/lib/activityText";

const ASSETS: AssetLite[] = [
  { assetKey: "eip155:196:0x4ae46a509f6b1d9056937ba4500cb143933d2dc8", tokenAddress: "0x4ae46a509f6b1d9056937ba4500cb143933d2dc8", tokenDecimals: 6, displaySymbol: "USDG", role: "stable_input" },
  { assetKey: "eip155:196:0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a", tokenAddress: "0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a", tokenDecimals: 18, displaySymbol: "AAPLx", role: "stock_output" },
  { assetKey: "eip155:196:0xc845b2894dbddd03858fd2d643b4ef725fe0849d", tokenAddress: "0xc845b2894dbddd03858fd2d643b4ef725fe0849d", tokenDecimals: 18, displaySymbol: "NVDAx", role: "stock_output" },
];
const RAW = /\b[a-z]+_[a-z_]+\b|0x[0-9a-f]{6,}|\b\d{6,}\b|\bmnd_|\bint_|\bprm_/;

describe("activity humanizer on a real live task (tsk_c7bc…)", () => {
  for (const locale of ["zh", "en"] as const) {
    it(`${locale}: no raw enums, addresses, ids or minimal units in the sentence`, () => {
      for (const it0 of sample) {
        const t = humanizeActivity(it0, { locale, assets: ASSETS });
        expect(t.text, `${it0.type}: ${t.text}`).not.toMatch(RAW);
        expect(t.text.length).toBeGreaterThan(3);
      }
    });
  }
  it("chinese sentences do not carry english system text", () => {
    for (const it0 of sample) {
      const t = humanizeActivity(it0, { locale: "zh", assets: ASSETS });
      expect(t.text, t.text).not.toMatch(/\b(certified|allowance|delegation|confirmed|spent|turn)\b/i);
    }
  });
  it("amounts are in human units with symbols", () => {
    const fill = sample.find((x) => x.type === "step_confirmed")!;
    expect(humanizeActivity(fill, { locale: "zh", assets: ASSETS }).text).toBe("第 1 步已在链上成交，花费 2 USDG");
    const cert = sample.find((x) => x.type === "intent_certified")!;
    expect(humanizeActivity(cert, { locale: "en", assets: ASSETS }).text).toMatch(/buying AAPLx with 2 USDG.*step 1/);
    const permit = sample.find((x) => x.type === "permit_submitted")!;
    expect(humanizeActivity(permit, { locale: "zh", assets: ASSETS }).text).toMatch(/USDG 额度许可（6\.03 USDG）/);
  });
  it("sell authorization names the stock, not the contract address", () => {
    const sell = sample.find((x) => x.type === "authorized" && (x.data as Record<string, unknown>)["side"] === "sell")!;
    expect(humanizeActivity(sell, { locale: "zh", assets: ASSETS }).text).toBe("签了卖出授权：AAPLx");
  });
  it("agent's own words are kept as a quote; system notes are never quoted", () => {
    const declined = sample.find((x) => x.type === "agent_declined")!;
    const t = humanizeActivity(declined, { locale: "zh", assets: ASSETS });
    expect(t.quote).toBeTruthy();
    expect(t.nextCheckAt).toBeTruthy();
    for (const it0 of sample.filter((x) => x.actor === "system")) expect(humanizeActivity(it0, { locale: "zh", assets: ASSETS }).quote).toBeNull();
  });
  it("a signature is never described as a trade", () => {
    const auth = sample.find((x) => x.type === "authorized" && !(x.data as Record<string, unknown>)["side"])!;
    expect(humanizeActivity(auth, { locale: "zh", assets: ASSETS }).text).toMatch(/不是交易/);
  });
  it("unknown events fall back to a category sentence", () => {
    const t = humanizeActivity({ id: 1, at: "2026-10-03T00:00:00Z", actor: "system", type: "brand_new_event", note: "raw english thing 12345678" }, { locale: "zh", assets: ASSETS });
    expect(t.text).toBe("其它活动");
    expect(t.quote).toBeNull();
    expect(actorLabel("executor:hosted", "zh")).toBe("平台执行");
  });
});

describe("agent quote: server suffixes are not part of the agent's words (10/5)", () => {
  it("drops the raw next-check ISO and localizes wants", () => {
    const note = "Market closed; holding cash until the open. · next check 2026-10-05T14:30:00.000Z";
    expect(agentQuoteText(note, "zh")).toBe("Market closed; holding cash until the open.");
    expect(agentQuoteText("Need the CPI print · wants: CPI actual; core CPI · next check 2026-10-06T12:30:00Z", "zh")).toBe("Need the CPI print\n想要的数据：CPI actual; core CPI");
    expect(agentQuoteText("No suffix here.", "en")).toBe("No suffix here.");
    const h = humanizeActivity({ id: 1, at: "2026-10-05T07:00:00Z", actor: "agent:hosted", type: "agent_declined", note }, { locale: "zh", assets: [], stableAssetKey: null });
    expect(h.quote).not.toContain("next check");
  });
});

describe("own-agent intents in observation mode (10/5): system notes are not quoted as the agent's words", () => {
  const base = { at: "2026-10-05T08:47:20Z", actor: "agent:byo" };
  it("simulated intent: amount converted, no quote", () => {
    const h = humanizeActivity({ id: 1, ...base, type: "intent_simulated", note: "intent int_c14222bb4a0b39220f023fa9 simulated: buy AAPLx 20000000" }, { locale: "zh", assets: ASSETS, stableAssetKey: ASSETS[0]!.assetKey });
    expect(h.text).toContain("Agent 提出用 20 USDG 买入 AAPLx");
    expect(h.text).toContain("观察");
    expect(h.quote).toBeNull();
  });
  it("rejected intent: reason code translated, no quote, no raw ids", () => {
    const h = humanizeActivity({ id: 2, ...base, type: "intent_rejected", note: "intent int_c154243fa482edfc899b827d rejected: scope, execution (INTENT_OUT_OF_SCOPE)" }, { locale: "zh", assets: ASSETS, stableAssetKey: ASSETS[0]!.assetKey });
    expect(h.text).toContain("超出了你签的范围");
    expect(h.text).not.toMatch(/int_|INTENT_OUT_OF_SCOPE/);
    expect(h.quote).toBeNull();
    expect(h.tone).toBe("bad");
  });
});
