/** v6 Lane B 测试工具：临时 Ed25519 密钥对（node:crypto，进程内生成，不落盘、不进仓库）+ 签一份 MarketContext */
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { contextSigningPayload, type MarketContext } from "@chaconne/core/verify";
import { fixtureMarketContext, type FixtureContextArgs } from "@chaconne/core/verify/context/fixture";

export interface TestKeypair {
  privateKey: KeyObject;
  /** 32 字节原始公钥 hex（配到 CROWSNEST_PUBKEY_ED25519） */
  publicKeyHex: string;
  publicKeyId: string;
}

export function testKeypair(publicKeyId = "test-k1"): TestKeypair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ type: "spki", format: "der" });
  return { privateKey, publicKeyHex: der.subarray(der.length - 32).toString("hex"), publicKeyId };
}

export function signContext(raw: Record<string, unknown>, kp: TestKeypair): string {
  const payload = contextSigningPayload({ ...raw, publicKeyId: kp.publicKeyId });
  const sig = cryptoSign(null, Buffer.from(payload, "utf8"), kp.privateKey);
  return JSON.stringify({ ...raw, publicKeyId: kp.publicKeyId, signature: "0x" + sig.toString("hex") });
}

/** 造一份签好名的上下文原文 */
export function signedContext(kp: TestKeypair, args: FixtureContextArgs): string {
  const ctx = fixtureMarketContext({ ...args, publicKeyId: kp.publicKeyId }) as unknown as Record<string, unknown>;
  const { signature: _s, ...rest } = ctx as unknown as MarketContext;
  void _s;
  return signContext(rest as unknown as Record<string, unknown>, kp);
}

export const CROWSNEST_FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "crowsnest");
export function crowsnestFixture(name: string): string {
  return readFileSync(join(CROWSNEST_FIXTURES, name), "utf8");
}
