/** 会话令牌（FIX-175）：签名 / 篡改 / 过期；nonce 令牌带 issuedAt（含毫秒小数点，分隔符不能是点） */
import { describe, expect, it } from "vitest";
import { nonceFields, nonceToken, sessionAddress, sessionSecret, sessionToken, signToken, verifyToken } from "../lib/sessionToken";

const S = "test-secret";
const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("sessionToken", () => {
  it("会话：正确密钥 + 未过期 → 地址；改一位 / 换密钥 / 过期 → null", () => {
    const t = sessionToken("0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa", S, 1_000);
    expect(sessionAddress(t, S, 2_000)).toBe(A);
    expect(sessionAddress(t, "other", 2_000)).toBeNull();
    expect(sessionAddress(t.slice(0, -1) + (t.endsWith("A") ? "B" : "A"), S, 2_000)).toBeNull();
    expect(sessionAddress(t, S, 1_000 + 31 * 24 * 3600_000)).toBeNull();
    expect(sessionAddress(undefined, S, 0)).toBeNull();
    expect(sessionAddress("junk", S, 0)).toBeNull();
  });
  it("nonce 令牌原样带回 nonce 与 ISO issuedAt；10 分钟后失效", () => {
    const issuedAt = new Date(5_000).toISOString();
    const t = nonceToken("abcd1234abcd1234", issuedAt, S, 5_000);
    expect(nonceFields(t, S, 6_000)).toEqual({ nonce: "abcd1234abcd1234", issuedAt });
    expect(nonceFields(t, S, 5_000 + 11 * 60_000)).toBeNull();
    // 会话令牌不能冒充 nonce 令牌，反之亦然
    expect(nonceFields(sessionToken(A, S, 0), S, 0)).toBeNull();
    expect(sessionAddress(t, S, 6_000)).toBeNull();
  });
  it("字段里不能有分隔符；密钥缺省来自 VERIFY_WEB_SESSION_SECRET / VERIFY_WEB_API_KEY，生产环境两者都缺 → null", () => {
    expect(() => signToken(["a|b"], S, 1)).toThrow();
    expect(verifyToken(signToken(["x", "y"], S, 10), S, 5)).toEqual(["x", "y"]);
    expect(sessionSecret({ VERIFY_WEB_SESSION_SECRET: "s1", VERIFY_WEB_API_KEY: "k" })).toBe("s1");
    expect(sessionSecret({ VERIFY_WEB_API_KEY: "k" })).toBe("k");
    expect(sessionSecret({ NODE_ENV: "production" })).toBeNull();
    expect(sessionSecret({ NODE_ENV: "test" })).toBeTruthy();
  });
});
