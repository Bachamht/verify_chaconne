import { describe, expect, it } from "vitest";
import { TASK_STATUSES } from "@chaconne/core/verify";
import { EVIDENCE_MODE_META, EVIDENCE_MODES, STATUS_META, UI_STATUSES, evidenceMode, isKnownTaskStatus, isTerminal, modeUiStatus, taskUiStatus } from "@/lib/status";
import { commandTargets, isActive, NAV_TOOLS, NAV_WORKSPACE, usesAppShell } from "@/lib/nav";
import { compactDecimal, formatAbs, formatCountdown, formatRel, groupDecimal, middleTruncate, rawToDecimal, toDate } from "@/lib/numbers";
import { hasReasonText } from "@/lib/reasons";
import { reasonLevel } from "@/lib/reasonLevels";
import { blockerText } from "@/components/kit/Blockers";
import { numberToDecimal } from "@/components/kit/Amount";
import { availableBudget } from "@/components/features/today/model";

describe("v8 status map (single source)", () => {
  it("maps every backend task status to a UI status with zh/en copy", () => {
    for (const s of TASK_STATUSES) {
      expect(isKnownTaskStatus(s)).toBe(true);
      const ui = taskUiStatus(s);
      expect(STATUS_META[ui].zh).toBeTruthy();
      expect(STATUS_META[ui].en).toBeTruthy();
    }
  });
  it("every UI status has zh/en copy without SNAKE_CASE", () => {
    for (const s of UI_STATUSES) {
      expect(STATUS_META[s].zh).not.toMatch(/[A-Z]{2,}_[A-Z]/);
      expect(STATUS_META[s].en).not.toMatch(/[A-Z]{2,}_[A-Z]/);
    }
  });
  it("unknown status falls back to waiting instead of leaking the enum", () => {
    expect(taskUiStatus("SOMETHING_NEW")).toBe("waiting");
    expect(taskUiStatus(null)).toBe("waiting");
  });
  it("simulation is info (sky blue), never brand purple", () => {
    expect(STATUS_META.simulation.tone).toBe("info");
    expect(modeUiStatus("SIMULATION")).toBe("simulation");
    expect(modeUiStatus("LIVE")).toBe("live");
    expect(modeUiStatus(undefined)).toBeNull();
  });
  it("terminal states", () => {
    expect(isTerminal(taskUiStatus("COMPLETED"))).toBe(true);
    expect(isTerminal(taskUiStatus("CANCELLED"))).toBe(true);
    expect(isTerminal(taskUiStatus("PAUSED"))).toBe(false);
  });
  it("evidence modes: sample/backfill are never rendered as live", () => {
    for (const m of EVIDENCE_MODES) expect(EVIDENCE_MODE_META[m].zh).toBeTruthy();
    expect(evidenceMode("live")).toBe("LIVE");
    expect(EVIDENCE_MODE_META.sample.tone).not.toBe("ok");
    expect(EVIDENCE_MODE_META.backfill.tone).not.toBe("ok");
    expect(evidenceMode("weird")).toBeNull();
  });
});

describe("v8 nav (single source)", () => {
  it("workspace routes use the app shell; marketing routes do not", () => {
    for (const n of NAV_WORKSPACE) expect(usesAppShell(n.href)).toBe(true);
    expect(usesAppShell("/agent/tasks/tsk_1")).toBe(true);
    expect(usesAppShell("/")).toBe(false);
    expect(usesAppShell("/start")).toBe(false);
    expect(usesAppShell("/agents")).toBe(false);
  });
  it("active matching: /agent only exact; children match their section", () => {
    expect(isActive("/agent", "/agent")).toBe(true);
    expect(isActive("/agent/tasks", "/agent")).toBe(false);
    expect(isActive("/agent/tasks/tsk_1", "/agent/tasks")).toBe(true);
    expect(isActive("/agent/keys", "/agent/keys")).toBe(true);
  });
  it("command palette has no duplicate targets and every link has both languages", () => {
    const t = commandTargets();
    expect(new Set(t.map((x) => x.href)).size).toBe(t.length);
    for (const n of [...t, ...NAV_TOOLS]) { expect(n.label.zh).toBeTruthy(); expect(n.label.en).toBeTruthy(); }
  });
});

describe("v8 numbers", () => {
  it("raw → decimal truncates, never rounds, and keeps precision past Number", () => {
    expect(rawToDecimal("5000000", 6, 2)).toBe("5");
    expect(rawToDecimal("1999999", 6, 2)).toBe("1.99");
    expect(rawToDecimal("12345678901234567", 18, 6)).toBe("0.012345");
    expect(rawToDecimal("123456789012345678901234", 6, 2)).toBe("123456789012345678.9");
    expect(rawToDecimal("-1500000", 6, 2)).toBe("-1.5");
    expect(rawToDecimal("abc", 6, 2)).toBeNull();
  });
  it("groups thousands and pads fraction", () => {
    expect(groupDecimal("1234567.5", 2)).toBe("1,234,567.50");
    expect(groupDecimal("0.1")).toBe("0.1");
    expect(groupDecimal("-1234")).toBe("-1,234");
  });
  it("compact for table columns", () => {
    expect(compactDecimal("1234567", "en")).toBe("1.2M");
  });
  it("time helpers never render ISO", () => {
    const now = new Date("2026-10-03T12:00:00Z");
    expect(formatRel(new Date(now.getTime() - 2 * 3600_000), "zh", now)).toMatch(/2.*小时前/);
    expect(formatRel(new Date(now.getTime() - 10_000), "en", now)).toBe("just now");
    expect(formatRel(new Date(now.getTime() + 3 * 60_000), "en", now)).toMatch(/in 3 min/);
    expect(formatAbs(new Date("2026-10-03T04:34:00Z"), "zh", now)).not.toMatch(/T|Z/);
    expect(formatAbs(new Date("2025-10-03T04:34:00Z"), "en", now)).toMatch(/2025/);
    expect(formatAbs(new Date("2026-10-03T04:34:00Z"), "en", now)).toMatch(/Oct/);
    expect(toDate(1759480000)?.getUTCFullYear()).toBe(2025);
    expect(toDate("nope")).toBeNull();
  });
  it("countdown and truncation", () => {
    expect(formatCountdown(65_000)).toBe("1:05");
    expect(formatCountdown(3_725_000)).toBe("1:02:05");
    expect(formatCountdown(-5)).toBe("0:00");
    expect(middleTruncate("0xbacb4f2a9d27e1c00000000000000000000381")).toBe("0xbacb…0381");
    expect(middleTruncate("short")).toBe("short");
  });
});

describe("v8 blockers never leak SNAKE_CASE", () => {
  it("unmapped code gets a human sentence", () => {
    const zh = blockerText({ code: "SOMETHING_NEW_FROM_SERVER" }, "zh");
    expect(zh).not.toMatch(/[A-Z]{2,}_[A-Z]/);
    expect(blockerText({ code: "SOMETHING_NEW_FROM_SERVER" }, "en")).not.toMatch(/[A-Z]{2,}_[A-Z]/);
  });
  it("mapped code uses lib/reasons copy", () => {
    expect(hasReasonText("MARKET_OUTSIDE_REGULAR")).toBe(true);
    expect(blockerText({ code: "MARKET_OUTSIDE_REGULAR" }, "zh")).toMatch(/美股/);
  });
  it("levels: waiting-by-design codes are not treated as failures", () => {
    expect(reasonLevel("MARKET_OUTSIDE_REGULAR")).toBe("wait");
    expect(reasonLevel("SELL_MANDATE_REQUIRED")).toBe("warn");
    expect(reasonLevel("QUOTE_UNAVAILABLE")).toBe("block");
  });
});

describe("v8 Amount: number values never become scientific notation", () => {
  it("tiny / huge / ordinary numbers stay plain decimals", () => {
    expect(numberToDecimal(1e-7)).toBe("0.0000001");
    expect(numberToDecimal(0.000001234)).toBe("0.000001234");
    expect(numberToDecimal(1e21)).toBe("1000000000000000000000");
    expect(numberToDecimal(337.02)).toBe("337.02");
    expect(numberToDecimal(-2.5e-8)).toBe("-0.000000025");
    expect(numberToDecimal(0)).toBe("0");
    for (const n of [1e-7, 1e21, 5e-324 * 1e300, 123456789012345680000]) expect(numberToDecimal(n)).not.toMatch(/e/i);
  });
  it("non-finite → null (shown as not returned)", () => {
    expect(numberToDecimal(Number.NaN)).toBeNull();
    expect(numberToDecimal(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("v8 stable unknown → not returned, never guessed", () => {
  it("availableBudget without a stable_input asset leaves decimals / symbol null", () => {
    const b = availableBudget([], []);
    expect(b).toEqual({ raw: "0", decimals: null, symbol: null });
  });
});

describe("v8 Blockers meta slot", () => {
  it("renders each item's meta under its text; lab list uses kit Blockers without leaking codes", async () => {
    const React = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { BlockerEvidenceList } = await import("@/components/features/lab/BlockerEvidenceList");
    const { I18nProvider } = await import("@/lib/i18n");
    const list = React.createElement(BlockerEvidenceList, {
      blockers: [{ code: "SOME_UNMAPPED_CODE", evidenceAt: null, nextCheckAt: null, evidenceIds: ["e1", "e2"], userActionRequired: false }] as never,
      evaluatedAt: "2026-10-03T06:00:00Z",
      fallbackEvidenceAt: null,
    });
    const html = renderToStaticMarkup(React.createElement(I18nProvider, { initialLocale: "zh", children: list }));
    expect(html).toContain("2 条证据");
    expect(html).toContain("下次检查 · 未知");
    expect(html).toContain("另有一项条件暂未满足");
    expect(html.replace(/title="[^"]*"/g, "")).not.toContain("SOME_UNMAPPED_CODE");
  }, 20_000);
});
