/**
 * v8 资金页 / Agent 接入 key：纯逻辑 + 关键渲染。
 * 样本取自演示钱包 2026-10-03 的真实响应（portfolio 全部 unavailable、allowances 5 个代币），裁掉无关字段。
 */
import * as React from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { OwnerAllowanceRow, PortfolioView } from "../lib/api-v2";
import { budgetGroupsOf, buildAssetRows, excessRawOf, fundsKpis, marketValueUsd, normalizeBudgetGroup, allocationStateLabel, allocationsOf, periodEnded, reclaimable, sumStable, type AssetMeta } from "../components/features/funds/fundsModel";
import { writeErrorText } from "../components/features/common/writeError";
import { amountToRaw } from "../components/features/funds/CreateBudgetGroupDialog";
import { reclaimConsequence } from "../components/features/funds/ReclaimDialog";
import { FundsKpis } from "../components/features/funds/FundsKpis";
import { AssetTable } from "../components/features/funds/AssetTable";
import { curlExample, keyLabel, mcpConfig } from "../components/features/keys/keysModel";
import { cn } from "../lib/utils";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), useSearchParams: () => new URLSearchParams(""), usePathname: () => "/agent/funds" }));
vi.mock("../lib/i18n", () => ({ useI18n: () => ({ locale: "zh", t: (key: string) => key }) }));

const USDG = "eip155:196:0x4ae46a509f6b1d9056937ba4500cb143933d2dc8";
const USDC = "eip155:196:0xb6ceceab302e2e4948951ee7843fc24e92933061";
const AAPLX = "eip155:196:0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a";
const assets: AssetMeta[] = [
  { assetKey: USDG, displaySymbol: "USDG", tokenDecimals: 6, role: "stable_input" },
  { assetKey: USDC, displaySymbol: "USDC", tokenDecimals: 6, role: "stable_input" },
  { assetKey: AAPLX, displaySymbol: "AAPLx", tokenDecimals: 18, role: "stock_output" },
];
const portfolio = {
  owner: "0xbacb138e0e9e1444bae9b401c4615378c57c0381", chainId: 196, block: { number: 72243239, timestamp: "2026-10-03T07:24:35.000Z" },
  cash: [
    { assetKey: USDG, symbol: "USDG", balanceRaw: "0", decimals: 6, unavailable: true },
    { assetKey: USDC, symbol: "USDC", balanceRaw: "0", decimals: 6, unavailable: true },
  ],
  holdings: [{ assetKey: AAPLX, symbol: "AAPLx", decimals: 18, balanceRaw: "0", unavailable: true, priceUsd: "333.791661" }],
  budgetGroups: [{ groupId: "bgp_ee7fe9f4fd0b860653fbc953", name: "e2e-week-2026-09-23", inputAssetKey: USDG, period: { start: "2026-09-23T06:17:02.094Z", end: "2026-09-30T07:17:02.094Z" }, capRaw: "500000000", cashFloorRaw: "100000000", summary: { capRaw: "500000000", spentRaw: "0", reservedRaw: "1500000", pendingRaw: "0" }, allocations: [] }],
} as unknown as PortfolioView;
const allowances: Array<OwnerAllowanceRow & { symbol?: string; decimals?: number }> = [
  { token: "0x4ae46a509f6b1d9056937ba4500cb143933d2dc8", assetKey: USDG, symbol: "USDG", decimals: 6, onchainRaw: "10000", requiredRaw: "0", excessRaw: "10000", pendingPermit: false },
  { token: "0xb6ceceab302e2e4948951ee7843fc24e92933061", assetKey: USDC, symbol: "USDC", decimals: 6, onchainRaw: "0", requiredRaw: "0", excessRaw: "0", pendingPermit: false },
  { token: "0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a", assetKey: AAPLX, symbol: "AAPLx", decimals: 18, onchainRaw: "39184440595673601", requiredRaw: "38989493130023483", pendingPermit: true },
];

describe("资金页 · 资产行", () => {
  it("unavailable 的余额是 null（未返回），不是 0；浏览器直读到了就用直读值并标来源", () => {
    const rows = buildAssetRows({ portfolio, allowances, assets, rpcBalances: {} });
    expect(rows.map((r) => r.symbol)).toEqual(["USDC", "USDG", "AAPLx"]);
    expect(rows.every((r) => r.balanceRaw === null)).toBe(true);
    const withRpc = buildAssetRows({ portfolio, allowances, assets, rpcBalances: { [USDG]: "12500000", [USDC]: null } });
    const usdg = withRpc.find((r) => r.assetKey === USDG)!;
    expect(usdg).toMatchObject({ balanceRaw: "12500000", balanceSource: "rpc" });
    expect(usdg).not.toHaveProperty("guardRaw");
    expect(withRpc.find((r) => r.assetKey === USDC)!.balanceRaw).toBeNull();
  });
  it("多出：服务端 excessRaw 优先，否则 onchain − required；收回只在多出 > 0 且没有在途 permit 时出现", () => {
    expect(excessRawOf({ onchainRaw: "12060000", requiredRaw: "8000000" })).toBe("4060000");
    expect(excessRawOf({ onchainRaw: "1", requiredRaw: "8" })).toBe("0");
    const rows = buildAssetRows({ portfolio, allowances, assets, rpcBalances: {} });
    expect(rows.find((r) => r.assetKey === USDG)!.planGuard!.excessRaw).toBe("10000");
    expect(reclaimable(rows.find((r) => r.assetKey === USDG)!)).toBe(true);
    expect(reclaimable(rows.find((r) => r.assetKey === USDC)!)).toBe(false);
    expect(reclaimable(rows.find((r) => r.assetKey === AAPLX)!)).toBe(false); // 在途 permit
    const dust = buildAssetRows({ portfolio, allowances: [{ ...allowances[2]!, pendingPermit: false, reclaimSuggested: false }], assets, rpcBalances: {} });
    expect(reclaimable(dust.find((r) => r.assetKey === AAPLX)!)).toBe(false); // 服务端不建议：仍在用的额度里的零头
    const ok = buildAssetRows({ portfolio, allowances: [{ ...allowances[2]!, pendingPermit: false }], assets, rpcBalances: {} });
    expect(reclaimable(ok.find((r) => r.assetKey === AAPLX)!)).toBe(true);
  });
});

describe("资金页 · KPI", () => {
  it("稳定币合计按精度对齐；任何一项缺失 → null", () => {
    expect(sumStable([{ raw: "1500000", decimals: 6 }, { raw: "2000000000000000000", decimals: 18 }])).toBe("3.5");
    expect(sumStable([{ raw: "1", decimals: 6 }, { raw: null, decimals: 6 }])).toBeNull();
  });
  it("持仓市值 = 余额 × 价格；余额未知 → null；余额 0 不需要价格", () => {
    const base = { kind: "stock" as const, token: null, balanceSource: "service" as const, planGuard: null, decimals: 18, symbol: "AAPLx", assetKey: AAPLX };
    expect(marketValueUsd([{ ...base, balanceRaw: "2000000000000000000", priceUsd: "333.791661" }])).toBe("667.58");
    expect(marketValueUsd([{ ...base, balanceRaw: null, priceUsd: "333.79" }])).toBeNull();
    expect(marketValueUsd([{ ...base, balanceRaw: "0", priceUsd: null }])).toBe("0");
  });
  it("真实样本：可用 / 持仓市值未返回；已授权只含 PlanGuard；预留来自资金组", () => {
    const rows = buildAssetRows({ portfolio, allowances, assets, rpcBalances: {} });
    const k = fundsKpis(rows, budgetGroupsOf(portfolio), assets);
    expect(k).toMatchObject({ available: null, marketValue: null, authorized: "0.01", reserved: "1.5", groupCount: 1 });
  });
  it("渲染：缺值写「未返回」，不出现 $0", () => {
    const html = renderToStaticMarkup(React.createElement(FundsKpis, { kpis: { available: null, authorized: "0.01", marketValue: null, reserved: "0", groupCount: 0 }, loading: false, readingChain: false }));
    expect(html.match(/未返回/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain("链上余额读取失败，不当作 0");
    // 「预留」与资金组 10/5 起不在页面上显示
    expect(html).not.toContain("预留");
  });
  it("资产表渲染：列名、未返回、收回按钮、在途标签；页面上没有原始单位与 SNAKE_CASE", () => {
    const rows = buildAssetRows({ portfolio, allowances, assets, rpcBalances: {} });
    const html = renderToStaticMarkup(React.createElement(AssetTable, { rows, allowancesMissing: false, readingChain: false, onReclaim: () => undefined }));
    for (const t of ["资产", "余额", "已授权额度", "未返回", "收回", "额度上链中", "0.01"]) expect(html).toContain(t);
    expect(html).not.toContain("Guard");
    expect(html.replace(/title="[^"]*"/g, "")).not.toMatch(/39184440595673601|[A-Z]+_[A-Z_]+/);
  });
});

describe("资金组", () => {
  it("两种形状都能归一化；未知分配状态不露出原始值", () => {
    const fromPortfolio = budgetGroupsOf(portfolio)![0]!;
    expect(fromPortfolio).toMatchObject({ id: "bgp_ee7fe9f4fd0b860653fbc953", name: "e2e-week-2026-09-23", periodEnd: "2026-09-30T07:17:02.094Z", capRaw: "500000000", reservedRaw: "1500000" });
    const detail = { group: { id: "bgp_1", name: "十月", inputAssetKey: USDG, periodStart: "2026-10-01T00:00:00Z", periodEnd: "2026-10-31T00:00:00Z", capRaw: "9", cashFloorRaw: "1" }, summary: { capRaw: "9", spentRaw: "2", reservedRaw: "3", pendingRaw: "1" }, allocations: [{ taskId: "tsk_a", mandateId: "mnd_a", priority: 1, reservedRaw: "3", state: "reserved" }] };
    expect(normalizeBudgetGroup(detail)).toMatchObject({ id: "bgp_1", spentRaw: "2", cashFloorRaw: "1" });
    expect(allocationsOf(detail)[0]).toMatchObject({ taskId: "tsk_a", state: "reserved" });
    expect(normalizeBudgetGroup({ name: "x" })).toBeNull();
    expect(allocationStateLabel("waiting", true)).toBe("等额度");
    expect(allocationStateLabel("SOME_NEW_STATE", true)).toBe("其它");
    expect(periodEnded(fromPortfolio, new Date("2026-10-03T00:00:00Z"))).toBe(true);
    // 缺值 → null（未返回），不补 "0"
    const missing = normalizeBudgetGroup({ id: "bgp_2", name: "x", summary: { capRaw: "9" } })!;
    expect(missing).toMatchObject({ capRaw: "9", spentRaw: null, reservedRaw: null, pendingRaw: null, cashFloorRaw: null });
    expect(allocationsOf({ allocations: [{ taskId: "tsk_a", state: "reserved" }] })[0]!.reservedRaw).toBeNull();
  });
  it("金额输入按币种精度换算；小数位超精度拒绝；现金下限允许 0", () => {
    expect(amountToRaw("100", 6)).toBe("100000000");
    expect(amountToRaw("0.1234567", 6)).toBeNull();
    expect(amountToRaw("0", 6)).toBeNull();
    expect(amountToRaw("0", 6, true)).toBe("0");
    expect(amountToRaw("5", null)).toBeNull();
  });
});

describe("写操作失败文案", () => {
  it("本地只读中转 403 relay_read_only：人话 + 什么都没发生，不露出错误码", () => {
    const t = writeErrorText({ status: 403, data: { error: "relay_read_only", message: "Local relay only forwards GET." } }, true, "还没有签名，链上额度没有变化。");
    expect(t).toBe("服务拒绝了这次写入（HTTP 403）。还没有签名，链上额度没有变化。");
    expect(t).not.toMatch(/relay_read_only/);
  });
  it("已知错误码走 lib/errors 映射；超时有专门说法", () => {
    expect(writeErrorText({ status: 409, data: { error: "permit_pending" } }, true, "x")).toContain("已有一份额度在上链");
    expect(writeErrorText({ status: 0, data: null }, false, "Nothing happened.")).toBe("The service did not answer within 30 seconds. Nothing happened.");
  });
  it("收回额度的后果文案：两种方式各说各的，不和暂停 / 取消 / 撤销混用", () => {
    const sign = reclaimConsequence("sign", "USDG", true);
    const zero = reclaimConsequence("zero", "USDG", true);
    expect(sign).toContain("签名不是交易");
    expect(zero).toContain("你付 gas");
    for (const t of [sign, zero]) expect(t).not.toMatch(/暂停|取消任务|撤销|只签一次|不花钱|最多只损失/);
  });
});

describe("Agent 接入 key", () => {
  it("默认名与截断；MCP 配置与 curl 带上 key", () => {
    expect(keyLabel("  ", true, 40)).toBe("我的 Agent");
    expect(keyLabel("abcdef", false, 3)).toBe("abc");
    const cfg = JSON.parse(mcpConfig("vk_live_x", "https://svc"));
    expect(cfg.mcpServers["chaconne-verify"].env).toEqual({ VERIFY_SERVICE_URL: "https://svc", VERIFY_API_KEY: "vk_live_x" });
    expect(curlExample("vk_live_x", "0xabc", "https://svc")).toBe('curl -H "x-api-key: vk_live_x" "https://svc/v1/tasks?owner=0xabc"');
  });
});

describe("共享修复 · cn()", () => {
  it("v8 自定义字号不会被后面的文字颜色吞掉", () => {
    expect(cn("text-kpi font-semibold", "text-fg-1")).toBe("text-kpi font-semibold text-fg-1");
    expect(cn("text-md", "text-sm")).toBe("text-sm");
  });
});

describe("路由与锚点", () => {
  const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
  it("v8 开关：路由走客户端开关（构建期删死分支），旧组件原样保留", () => {
    for (const [p, v8, old] of [["components/routes/FundsRoute.tsx", "<FundsPage />", "<Funds />"], ["components/routes/KeysRoute.tsx", "<KeysPage />", "<ApiKeys />"]] as const) {
      const src = read(p);
      expect(src).toContain(`process.env.NEXT_PUBLIC_V8_UI === "1" ? ${v8} : ${old}`);
    }
  });
  it("#allowances 锚点与 ?group= 参数保留；key 只显示一次的提示在", () => {
    expect(read("components/features/funds/FundsPage.tsx")).toContain('<Panel id="allowances"');
    expect(read("components/features/funds/BudgetGroups.tsx")).toContain('useQueryState("group")');
    const dlg = read("components/features/keys/CreateKeyDialog.tsx");
    expect(dlg).toContain("关掉就再也看不到");
    expect(dlg).toContain('<Hash value={fresh.apiKey} kind="id"');
  });
});

describe("资金页 · 不猜（审查组 B-5 / B-6）", () => {
  const ODD = "eip155:196:0x1111111111111111111111111111111111111111";
  it("登记表与接口都没有的资产：名字 null（页面写未登记资产），精度 null（不换算金额），不拿地址片段冒充", () => {
    const pf = { ...portfolio, cash: [], holdings: [{ assetKey: ODD, balanceRaw: "5", unavailable: false, priceUsd: "1" }], budgetGroups: [] } as unknown as PortfolioView;
    const rows = buildAssetRows({ portfolio: pf, allowances: [], assets, rpcBalances: {} });
    expect(rows[0]).toMatchObject({ symbol: null, decimals: null, balanceRaw: "5" });
    expect(marketValueUsd(rows)).toBeNull();
    const html = renderToStaticMarkup(React.createElement(AssetTable, { rows, allowancesMissing: false, readingChain: false, onReclaim: () => undefined }));
    expect(html).toContain("未登记资产");
    expect(html.replace(/title="[^"]*"/g, "")).not.toMatch(/0x1111/);
  });
  it("接口返回了但真的没有现金行：可用是 0，不说读取失败；接口没返回才是 null", () => {
    expect(fundsKpis([], [], assets, true).available).toBe("0");
    expect(fundsKpis([], null, assets, false).available).toBeNull();
  });
  it("资金组币种精度未知：预留不合计", () => {
    const g = { ...budgetGroupsOf(portfolio)![0]!, inputAssetKey: ODD };
    expect(fundsKpis([], [g], assets).reserved).toBeNull();
    expect(sumStable([{ raw: "1", decimals: null }])).toBeNull();
  });
});
