/**
 * O-01 · /v1/context 免费档写进 /developers；R-03 · 模式标签把 sample/backfill 渲染成非实时；
 * notReady() 只把「端点未部署」当空态，业务 404 仍是错误；导航保留旧 Verify 路由。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contextProvenance, isRecapPending, notReady } from "../lib/api-v2";
import { ENTRIES, SAMPLES } from "../components/agent/home/entries";

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

describe("O-01 · 开发者页文档", () => {
  it("/developers 写明 GET /v1/context 免费档、tier=agent、not_in_tier 与 provenance.mode", () => {
    const src = read("app/developers/page.tsx");
    expect(src).toContain("GET /v1/context");
    expect(src).toContain("tier=agent");
    expect(src).toContain("not_in_tier");
    expect(src).toContain("provenance.mode");
    expect(src).toContain("/a2mcp/agent-tasks");
    expect(src).toMatch(/verify-mcp，46 个|verify-mcp, 46/);
    expect(src).toContain("verify_once_free");
    expect(src).not.toContain("npx -y @chaconne/verify-mcp");
    expect(src).toContain("packages/verify-mcp/bin/chaconne-verify-mcp.mjs");
    for (const f of ["/openapi.json", "/llms.txt", "/.well-known/agent-card.json"]) expect(src).toContain(f);
    // 免 key 端点的 curl 示例不带 x-api-key
    const freeBlock = src.slice(src.indexOf('id="free"'), src.indexOf('id="a2mcp"'));
    expect(freeBlock).not.toContain("x-api-key:");
  });
});

describe("导航与路由", () => {
  it("Header 以 /agent 为首入口，旧 Verify 路由（/new /plan /play /me /live /developers /verify-bundle）全部保留；行情比价入口保留", () => {
    const src = read("components/Header.tsx");
    for (const h of ["/agent", "/agent/tasks", "/agent/events", "/agent/journal", "/agent/funds", "/agent/lab", "/new", "/plan", "/play", "/me", "/live", "/developers", "/verify-bundle"]) expect(src).toContain(`href: "${h}"`);
    expect(src).toContain("verify-switch");
    expect(src).toContain("行情比价");
  });
  it("V-47：只有一套导航——页头 5 主项 + 工具下拉 + 开发者；子导航 pill 删除；投屏模式在页脚且带说明；/me 改名", () => {
    const header = read("components/Header.tsx");
    expect(header).toMatch(/NAV_MAIN[\s\S]*"\/agent\/journal"/);
    expect(header).toMatch(/NAV_TOOLS[\s\S]*"\/me"/);
    expect(header).not.toContain("demo_mode");
    expect(read("components/agent/shared.tsx")).not.toContain("ag-subnav");
    const footer = read("components/Footer.tsx");
    expect(footer).toContain("demo_mode_hint");
    const i18n = read("lib/i18n.tsx");
    expect(i18n).toMatch(/nav_me: \{ en: "My records", zh: "我的记录" \}/);
    expect(read("app/globals.css")).toMatch(/\.verify-menu-toggle \{ display: none; \}/);
  });
  it("代理放行 §11.7 全部 v6 路径", () => {
    const src = read("app/api/verify/[...path]/route.ts");
    for (const p of ["v1/context", "v1/events", "v1/event-impacts", "v1/tasks", "v1/theses", "v1/budget-groups", "v1/portfolio", "v1/notify", "v1/replays", "v1/rebalance", "v1/recaps", "v1/missions"]) expect(src).toContain(p);
  });
  it("入口与示例任务（条件不含金额/钱包；不再默认限制美股常规时段）", () => {
    expect(ENTRIES.map((e) => e.id)).toEqual(["buy", "wait", "compare"]);
    expect(new Set(SAMPLES.map((s) => s.id)).size).toBe(SAMPLES.length);
    for (const s of SAMPLES) expect(s.conditions.some((c) => c.type === "session")).toBe(false);
    for (const s of SAMPLES) {
      const j = JSON.stringify(s.conditions);
      expect(j).not.toMatch(/0x[0-9a-fA-F]{40}/);
      expect(j).not.toMatch(/amount|budget|owner/i);
      if (s.playbookId === "discount_watch") expect(s.conditions.some((c) => c.type === "premium_bps_lte" && (c as { referenceKind: string }).referenceKind === "live")).toBe(true);
    }
  });
});

describe("空态与模式标识", () => {
  it("notReady：404 not_found / 501 / 503 / 502 → 空态；业务 404（task_not_found）→ 不是空态；200 不是", () => {
    expect(notReady({ status: 404, data: { error: "not_found" } })).toBe(true);
    expect(notReady({ status: 404, data: null })).toBe(true);
    expect(notReady({ status: 503, data: { error: "v6_disabled" } })).toBe(true);
    expect(notReady({ status: 502, data: { error: "service_unreachable" } })).toBe(true);
    expect(notReady({ status: 404, data: { error: "task_not_found" } })).toBe(false);
    expect(notReady({ status: 200, data: {} })).toBe(false);
  });
  it("R-03 / CV-D13：provenance 只有 live 才是 live；缺失 → unknown；pending 判定", () => {
    expect(contextProvenance({ provenance: { mode: "sample" } } as never)).toBe("sample");
    expect(contextProvenance({ provenance: { mode: "backfill" } } as never)).toBe("backfill");
    expect(contextProvenance({ provenance: { mode: "live" } } as never)).toBe("live");
    expect(contextProvenance({} as never)).toBe("unknown");
    expect(contextProvenance(null)).toBe("unknown");
    expect(isRecapPending({ status: "pending" } as never)).toBe(true);
    expect(isRecapPending({ id: "rcp_1" } as never)).toBe(false);
    const shared = read("components/agent/shared.tsx");
    // ModeTag：sample / backfill / FIXTURE 分支都不落到 ag_mode_live
    const liveBranch = shared.split("ag_mode_live")[0]!;
    expect(liveBranch).toMatch(/m === "LIVE" \|\| m === "live"/);
    expect(shared).toContain('m === "sample"');
    expect(shared).toContain('m === "backfill"');
  });
  it("任务详情的停止说明复述 D-088 三句", () => {
    const i18n = read("lib/i18n.tsx");
    expect(i18n).toMatch(/只阻止后续签发/);
    expect(i18n).toMatch(/仍可能可执行/);
    expect(i18n).toMatch(/链上 revokeMandate 确认为准/);
  });
});
