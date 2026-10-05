import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { normalizePublicActivity, normalizePublicReport, type PublicReport } from "@/lib/publicData";
import { boardKpis, hasAddress, presenceUiStatus, publicReportView, scrubAddresses, shareUiStatus, watchView } from "@/components/features/public/publicView";
import { policyLabel, sessionText as sessionLabel } from "@/lib/policyLabels";
import { checkDetailText, checkStepState, checkTitle, loadFailureKey, refFromId, refFromParams, summarizeChecks, v3Groups } from "@/components/features/public/bundleChecks";
import { eventUnits, onlineDetailText, type OnlineInfo } from "@/components/features/public/onlineChecks";
import { DEV_TABS, SECTIONS, tabFor } from "@/components/features/developers/devNav";
import { V1_ROWS, V5_ROWS, V6_ROWS } from "@/components/features/developers/restEndpoints";
import { fxPublicActivity } from "@/lib/v7fixtures";

/** 地址形状（0x + 40 位十六进制，后面不再接十六进制）：公开页数据里一个都不能有 */
const ADDRESS = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/;
const WALLET = "0x00000000000000000000000000000000000000aa";

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/pub-reports.json", import.meta.url)), "utf8")) as { items: unknown[] };
const real = fixture.items.map(normalizePublicReport).filter((x): x is PublicReport => x !== null);

describe("v8 public pages never show wallet addresses", () => {
  it("real /pub/reports sample → view model carries no 0x address (contract address in verifier block is dropped)", () => {
    expect(real.length).toBe(2);
    expect(JSON.stringify(fixture)).toMatch(ADDRESS); // 原始响应里确实有地址（verifier.contractAddress）
    for (const r of real) for (const loc of ["zh", "en"] as const) {
      const v = publicReportView(r, loc);
      expect(JSON.stringify(v)).not.toMatch(ADDRESS);
      expect(v.title).not.toContain("——");
    }
  });
  it("hostile free text and asset fields are scrubbed", () => {
    const base = real[0]!;
    const evil: PublicReport = {
      ...base,
      headline: { zh: `买给 ${WALLET}`, en: `bought for ${WALLET}` },
      persona: { personaId: "cat_conductor", name: `me ${WALLET}`, tone: "calm" },
      goal: { ...base.goal, outputSymbols: [WALLET, "AAPLx"], inputSymbol: `eip155:196:${WALLET}`, amountDisplay: `${WALLET} 100` },
      result: { ...base.result, waitingOn: `owner ${WALLET} must sign`, spentDisplay: WALLET, receivedDisplay: null, feesDisplay: null },
      evidence: { ...base.evidence, txHashes: [`0x${"ab".repeat(32)}`, WALLET] },
    };
    for (const loc of ["zh", "en"] as const) {
      const v = publicReportView(evil, loc);
      expect(JSON.stringify(v)).not.toMatch(ADDRESS);
      expect(v.goal.assets[0]).toBe(loc === "zh" ? "未登记资产" : "Unregistered asset");
      expect(v.goal.assets[1]).toBe("AAPLx");
      expect(v.hashes.txHashes).toEqual([`0x${"ab".repeat(32)}`]); // 64 位交易哈希是公开证据，保留
    }
    expect(scrubAddresses(`a ${WALLET} b`, "zh")).toBe("a （地址已隐藏） b");
    expect(hasAddress(`0x${"ab".repeat(32)}`)).toBe(false);
  });
  it("watch board view only has fixed labels + times, even from hostile payloads", () => {
    const raw = { shareId: "s", presence: "working", items: [{ at: "2026-10-05T23:40:00.000Z", category: `bought for ${WALLET}`, actor: WALLET, owner: WALLET, note: `to ${WALLET}`, amountRaw: "100" }, { at: "2026-10-05T23:41:00.000Z", category: "fill_confirmed", actor: "executor" }] };
    const v = watchView(normalizePublicActivity(raw), "zh");
    expect(JSON.stringify(v)).not.toMatch(ADDRESS);
    expect(v.items.map((i) => i.label)).toEqual(["成交确认", "其它活动"]);
    expect(v.items[1]!.actor).toBeNull();
    expect(v.fills).toBe(1);
    expect(v.now).toBe("正在工作");
  });
  it("fixture board: newest first, KPI counts", () => {
    const v = watchView(fxPublicActivity(), "en");
    expect(v.total).toBe(8);
    expect(v.fills).toBe(1);
    expect(Date.parse(v.items[0]!.at)).toBeGreaterThan(Date.parse(v.items[7]!.at));
  });
});

describe("v8 public status / copy maps", () => {
  it("share status → StatusBadge (partial gets a warn tag)", () => {
    expect(shareUiStatus("completed")).toEqual({ status: "done" });
    expect(shareUiStatus("rejected")).toEqual({ status: "failed" });
    expect(shareUiStatus("simulation")).toEqual({ status: "simulation" });
    expect(shareUiStatus("waiting")).toEqual({ status: "waiting" });
    expect(shareUiStatus("partial")).toMatchObject({ tone: "warn" });
  });
  it("presence → UI status; unknown → no badge", () => {
    expect(presenceUiStatus("working")).toBe("running");
    expect(presenceUiStatus("blocked_owner")).toBe("needs_you");
    expect(presenceUiStatus("ended")).toBe("done");
    expect(presenceUiStatus("<img>")).toBeNull();
  });
  it("policy and session ids never reach the page as SNAKE_CASE", () => {
    for (const id of ["STRICT_LIVE", "REFERENCE_CONTEXT", "QUOTE_ONLY", "SOMETHING_NEW"]) for (const loc of ["zh", "en"] as const) expect(policyLabel(id, loc)).not.toMatch(/[A-Z]+_[A-Z]+/);
    for (const s of ["REGULAR", "PRE", "POST", "CLOSED", "HOLIDAY", "WEIRD"]) expect(sessionLabel(s, "zh")).not.toMatch(/[A-Z]/);
  });
  it("board KPIs count only statuses (no amounts)", () => {
    expect(boardKpis(real)).toEqual({ total: 2, completed: 0, simulation: 0, waiting: 2 });
  });
});

describe("v8 verify-bundle checks → StepFlow", () => {
  it("maps ok / failed / skipped to done / failed / skipped", () => {
    expect(checkStepState({ ok: true })).toBe("done");
    expect(checkStepState({ ok: false })).toBe("failed");
    expect(checkStepState({ ok: true, skipped: true })).toBe("skipped");
    expect(summarizeChecks([{ id: "a", ok: true, detail: "" }, { id: "b", ok: false, detail: "" }, { id: "c", ok: true, detail: "", skipped: true }])).toEqual({ total: 3, passed: 1, failed: 1, skipped: 1 });
  });
  it("every core check id gets a human title (no SNAKE_CASE)", () => {
    const ids = ["bundle_hash", "bundle_signature", "evidence_raw_hash", "registry_hash", "policy_definition_hash", "effective_policy_hash", "report_v1_evidence_hash", "report_v2_hash", "report_v1_policy", "report_v1_rules", "plan_pln_1_hash", "plan_pln_1_evidence_present", "cert_0_intent_digest", "cert_0_evidence_hash", "cert_1_step_digest", "cert_0_digest", "cert_0_signature", "intent_0_signature", "mandate_digest", "mandate_signature", "mandate_step_1_digest", "mandate_step_1_cert_signature", "mandate_mnd_x_digest", "mandate_mnd_x_step_2_cert_binding", "mandate_mnd_x_step_2_fill_attribution", "permit_p1_fields", "run_hash_chain", "run_3_action_recorded", "timeline_digest", "conditions_hash", "receipt_0xabcdef12_status", "event_0xabcdef12_MandateStep", "no_executions"];
    for (const id of ids) for (const loc of ["zh", "en"] as const) {
      const t = checkTitle(id, loc);
      expect(t, id).not.toMatch(/_/);
      expect(t, id).not.toBe(loc === "zh" ? "附加检查" : "Additional check");
    }
    expect(checkTitle("cert_0_signature", "zh")).toBe("证书 1：签名");
    expect(checkTitle("totally_new", "zh")).toBe("附加检查");
  });
  it("v3 groups only when a timeline check exists", () => {
    expect(v3Groups([{ id: "bundle_hash", ok: true, detail: "" }])).toBeNull();
    const g = v3Groups([{ id: "timeline_digest", ok: true, detail: "" }, { id: "permit_a_fields", ok: false, detail: "" }]);
    expect(g?.find((x) => x.key === "permits")).toMatchObject({ total: 1, failed: 1 });
  });
  it("load failures map to a reason; ?task= is kept", () => {
    expect(loadFailureKey(404)).toBe("bundle_not_yours");
    expect(loadFailureKey(403)).toBe("bundle_unauthorized");
    expect(loadFailureKey(0)).toBe("bundle_load_failed");
    expect(refFromParams(new URLSearchParams("task=tsk_c7bc0d49075b80b3d83e1a8c"))).toEqual({ task: "tsk_c7bc0d49075b80b3d83e1a8c" });
    expect(refFromParams(new URLSearchParams("job=job_1&task=tsk_1"))).toEqual({ job: "job_1" });
    expect(refFromParams(new URLSearchParams(""))).toBeNull();
    expect(refFromId(" tsk_1 ")).toEqual({ task: "tsk_1" });
    expect(refFromId("mnd_1")).toEqual({ mandate: "mnd_1" });
  });
});

describe("v8 developers", () => {
  it("developers: every section belongs to a tab; hash / tab query resolve", () => {
    expect(SECTIONS).toHaveLength(9);
    for (const s of SECTIONS) expect(DEV_TABS).toContain(s.tab);
    for (const t of DEV_TABS) expect(SECTIONS.some((s) => s.tab === t)).toBe(true);
    expect(tabFor("#v6")).toBe("rest");
    expect(tabFor("trust")).toBe("contracts");
    expect(tabFor("sdk")).toBe("sdk");
    expect(tabFor("nonsense")).toBe("rest");
    expect(V1_ROWS.length + V5_ROWS.length + V6_ROWS.length).toBe(28);
    for (const [, zh, en] of [...V1_ROWS, ...V5_ROWS, ...V6_ROWS]) { expect(zh).toBeTruthy(); expect(en).toBeTruthy(); }
  });
});

describe("v8 verify-bundle: zh pages get words, not raw ids / English detail", () => {
  it("core check detail is localized on zh; skipped never reads as passed", () => {
    const zh = (c: { id: string; ok: boolean; detail: string; skipped?: boolean }) => checkDetailText(c, "zh");
    expect(zh({ id: "bundle_hash", ok: true, detail: "recomputed 0xabc" })).toBe("通过。");
    expect(zh({ id: "bundle_signature", ok: false, detail: "signer mismatch" })).toMatch(/未通过/);
    expect(zh({ id: "bundle_signature", ok: true, detail: "no expected signer", skipped: true })).toMatch(/未校验.*不代表通过/);
    for (const c of [{ id: "x_y", ok: true, detail: "Some English" }, { id: "x_y", ok: false, detail: "Other English" }]) {
      expect(zh(c)).not.toMatch(/[A-Za-z]{3,}/);
    }
    expect(checkDetailText({ id: "x", ok: false, detail: "signer mismatch" }, "en")).toBe("signer mismatch");
  });
  it("online check text: every kind has zh and en with no SNAKE_CASE or English on zh", () => {
    const infos: OnlineInfo[] = [
      { kind: "receipt", block: "123", success: true }, { kind: "receipt", block: "9", success: false },
      { kind: "event", event: "MandateStep", known: true, spent: null, received: null }, { kind: "event", event: "GuardedExecution", known: false, spent: null, received: null },
      { kind: "missing_event" }, { kind: "rpc_error" }, { kind: "no_executions" },
    ];
    for (const i of infos) {
      expect(onlineDetailText(i, "zh").replace(/PlanGuard|Guard|RPC/g, "")).not.toMatch(/[A-Z]{2,}_|[a-z]{4,}/); // 合约名 / RPC 是专有名词
      expect(onlineDetailText(i, "en")).toBeTruthy();
    }
  });
  it("event amounts use registry decimals only; unknown decimals are never guessed", () => {
    const reg = [
      { assetKey: "eip155:196:0xusd", tokenAddress: "0x00000000000000000000000000000000000000a1", tokenDecimals: 6, displaySymbol: "USDG", role: "stable_input" },
      { assetKey: "eip155:196:0xstk", tokenAddress: "0x00000000000000000000000000000000000000b2", tokenDecimals: 18, displaySymbol: "AAPLx", role: "stock_output" },
    ] as never;
    const job = { inputAssetKey: "eip155:196:0xusd", outputAssetKey: "eip155:196:0xstk" } as never;
    expect(eventUnits({ registry: reg, job }, null)).toEqual({ spent: { decimals: 6, symbol: "USDG" }, received: { decimals: 18, symbol: "AAPLx" } });
    expect(eventUnits({ registry: reg, job: null }, "0x00000000000000000000000000000000000000B2")).toEqual({ spent: { decimals: 6, symbol: "USDG" }, received: { decimals: 18, symbol: "AAPLx" } });
    expect(eventUnits({ registry: reg, job: null }, "0x00000000000000000000000000000000000000c3")).toEqual({ spent: { decimals: null, symbol: null }, received: { decimals: null, symbol: null } });
  });
});
