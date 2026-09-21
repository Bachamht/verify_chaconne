/** 配置护栏（验收 O-01）与私钥范围（D-080） */
import { describe, expect, it } from "vitest";
import { assertOnlyAttestationKey, loadConfig, parseApiKeys } from "../src/config";
import { lastCompletedTradingDate } from "../src/evidence/provider";

const base = {
  DATABASE_URL: "pglite://memory",
  NODE_ENV: "test",
  PAYMENT_MODE: "mock",
  MERCHANT_RECIPIENT_ADDRESS: "0xcccccccccccccccccccccccccccccccccccccccc",
};

describe("loadConfig 护栏", () => {
  it("fixture 证据 + 真实收费 → 拒绝", () => {
    expect(() => loadConfig({ ...base, PAYMENT_MODE: "okx", OKX_API_KEY: "k", OKX_SECRET_KEY: "s", OKX_PASSPHRASE: "p", REPORT_PRICE_USD: "0.01", EVIDENCE_MODE: "fixture" })).toThrow(/fixture 证据不得与真实收费/);
    // mock 支付 + fixture 证据 是允许的测试组合
    expect(loadConfig({ ...base, REPORT_PRICE_USD: "0.01", EVIDENCE_MODE: "fixture" }).paid).toBe(true);
  });
  it("生产 + fixture → 拒绝；生产 + mock 支付 → 拒绝", () => {
    expect(() => loadConfig({ ...base, NODE_ENV: "production", EVIDENCE_MODE: "fixture" })).toThrow(/生产环境禁止 fixture/);
    expect(() => loadConfig({ ...base, NODE_ENV: "production", EVIDENCE_MODE: "live", REGISTRY_MODE: "file", REGISTRY_FILE: "/x.json", PAYMENT_MODE: "mock" })).toThrow(/mock 支付/);
  });
  it("收费 + okx 模式缺凭据 → 拒绝；缺商户地址 → 拒绝", () => {
    expect(() => loadConfig({ ...base, PAYMENT_MODE: "okx", REPORT_PRICE_USD: "0.01", EVIDENCE_MODE: "live" })).toThrow(/OKX_API_KEY/);
    expect(() => loadConfig({ ...base, REPORT_PRICE_USD: "0.01", EVIDENCE_MODE: "live", MERCHANT_RECIPIENT_ADDRESS: "" })).toThrow(/MERCHANT_RECIPIENT_ADDRESS/);
  });
  it("非法地址/私钥格式 → 拒绝", () => {
    expect(() => loadConfig({ ...base, GUARD_ADDRESS: "0x12" })).toThrow(/GUARD_ADDRESS/);
    expect(() => loadConfig({ ...base, ATTESTATION_PRIVATE_KEY: "abc" })).toThrow(/ATTESTATION_PRIVATE_KEY/);
  });
  it("API key 解析", () => {
    expect(parseApiKeys("a:x, b:y")).toEqual([
      { key: "a", callerId: "x" },
      { key: "b", callerId: "y" },
    ]);
    expect(() => parseApiKeys("nocolon")).toThrow();
    expect(loadConfig({ ...base, REPORT_PRICE_USD: "0" }).paid).toBe(false);
  });
});

describe("assertOnlyAttestationKey", () => {
  it("只允许 ATTESTATION_PRIVATE_KEY 与 OKX_SECRET_KEY；其它私钥形态拒绝", () => {
    expect(() => assertOnlyAttestationKey({ ATTESTATION_PRIVATE_KEY: "0x1", OKX_SECRET_KEY: "s" })).not.toThrow();
    expect(() => assertOnlyAttestationKey({ PRIVATE_KEY_SOLANA: "x" })).toThrow(/额外私钥/);
    expect(() => assertOnlyAttestationKey({ DEPLOYER_PRIVATE_KEY: "x" })).toThrow();
    expect(() => assertOnlyAttestationKey({ WALLET_MNEMONIC: "x" })).toThrow();
  });
});

describe("lastCompletedTradingDate", () => {
  it("周六 → 周五；周一开盘前 → 周五；周一收盘后 → 周一；假日后 → 假日前一交易日", () => {
    expect(lastCompletedTradingDate(new Date("2026-09-20T02:00:00.000Z"))).toBe("2026-09-18"); // 周六 22:00 ET
    expect(lastCompletedTradingDate(new Date("2026-09-21T12:00:00.000Z"))).toBe("2026-09-18"); // 周一 08:00 ET
    expect(lastCompletedTradingDate(new Date("2026-09-21T21:00:00.000Z"))).toBe("2026-09-21"); // 周一 17:00 ET
    expect(lastCompletedTradingDate(new Date("2026-09-08T12:00:00.000Z"))).toBe("2026-09-04"); // 劳动节次日早晨
  });
});
