import { describe, expect, it } from "vitest";
import {
  ageSeconds,
  isFutureBeyondTolerance,
  isoFromUnixMillis,
  isoFromUnixSeconds,
  parseIsoUtc,
  unixSecondsFromIso,
} from "../src/verify";

describe("time：单位换算集中（D-02 / D-10）", () => {
  it("Pyth 秒 → ISO；OKX 毫秒 → ISO；秒当毫秒被拒（独立依据：`date -u -r 1789000000`）", () => {
    expect(isoFromUnixSeconds(1_789_000_000)).toBe("2026-09-10T00:26:40.000Z");
    expect(isoFromUnixMillis(1_789_000_000_123)).toBe("2026-09-10T00:26:40.123Z");
    expect(isoFromUnixMillis("1789000000123")).toBe("2026-09-10T00:26:40.123Z");
    expect(() => isoFromUnixMillis(1_789_000_000)).toThrow(/秒当毫秒/);
    expect(() => isoFromUnixSeconds(-1)).toThrow();
  });

  it("parseIsoUtc 只接受 Z 结尾的严格格式", () => {
    expect(parseIsoUtc("2026-09-18T15:00:00.000Z")).toBe(Date.UTC(2026, 8, 18, 15));
    expect(parseIsoUtc("2026-09-18T15:00:00Z")).toBe(Date.UTC(2026, 8, 18, 15));
    for (const bad of ["2026-09-18T15:00:00", "2026-09-18 15:00:00Z", "2026-09-18T15:00:00+10:00", "1789000000"]) {
      expect(() => parseIsoUtc(bad)).toThrow();
    }
  });

  it("age / future 判定", () => {
    const now = "2026-09-18T15:00:00.000Z";
    expect(ageSeconds("2026-09-18T14:59:00.000Z", now)).toBe(60);
    expect(ageSeconds("2026-09-18T15:00:10.000Z", now)).toBe(-10);
    expect(isFutureBeyondTolerance("2026-09-18T15:00:04.000Z", now, 5)).toBe(false);
    expect(isFutureBeyondTolerance("2026-09-18T15:00:06.000Z", now, 5)).toBe(true);
    expect(unixSecondsFromIso("2026-09-18T15:00:00.999Z")).toBe(Math.floor(Date.UTC(2026, 8, 18, 15) / 1000));
  });
});
