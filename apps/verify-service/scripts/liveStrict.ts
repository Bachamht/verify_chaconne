/**
 * LIVE 窗口脚本（I2 维护）：对公网服务发一次 STRICT_LIVE 核验（A2MCP 免费端点，无需 key），
 * 把报告、证据条数、reportHash 与时间存到 .probes/<ts>_LIVE_strict.json。
 * 美股常规时段内应为 eligible（或被冲击/偏差规则拒绝，但不应是 MARKET_OUTSIDE_REGULAR）；休市时应为 rejected(MARKET_OUTSIDE_REGULAR)。
 * 环境：VERIFY_SERVICE_URL（默认 https://verify.chaconne.xyz）、POLICY（默认 STRICT_LIVE）、AMOUNT_RAW（默认 5000000）、OWNER（默认演示钱包）。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SERVICE = process.env["VERIFY_SERVICE_URL"] ?? "https://verify.chaconne.xyz";
const POLICY = process.env["POLICY"] ?? "STRICT_LIVE";
const OWNER = process.env["OWNER"] ?? "0xbacb138e0e9e1444bae9b401c4615378c57c0381";
const OUT = join(process.cwd(), "..", "..", "OKX dev day", "probes");

async function main() {
  mkdirSync(OUT, { recursive: true });
  const body = {
    ownerAddress: OWNER,
    inputAssetKey: "eip155:196:0x4ae46a509f6b1d9056937ba4500cb143933d2dc8",
    outputAssetKey: process.env["OUTPUT_ASSET_KEY"] ?? "eip155:196:0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a",
    amountInRaw: process.env["AMOUNT_RAW"] ?? "5000000",
    policyId: POLICY,
    maxSlippageBps: 50,
    maxPriceImpactBps: 100,
    maxReferenceDeviationBps: POLICY === "QUOTE_ONLY" ? null : 300,
  };
  const requestedAt = new Date().toISOString();
  const res = await fetch(`${SERVICE}/a2mcp/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  const receivedAt = new Date().toISOString();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    data = { raw: text.slice(0, 500) };
  }
  const summary = { mode: "LIVE", service: SERVICE, policy: POLICY, requestedAt, receivedAt, status: res.status, jobId: data["jobId"], verdict: data["verdict"], marketSession: data["marketSession"], comparisonStatus: data["comparisonStatus"], reasons: data["reasons"], reference: data["reference"], normalizedQuote: data["normalizedQuote"], reportHash: data["reportHash"], evidenceHash: data["evidenceHash"] };
  console.info(JSON.stringify(summary, null, 1));
  writeFileSync(join(OUT, `${requestedAt.replace(/[:.]/g, "-")}_LIVE_${POLICY}.json`), JSON.stringify({ summary, response: data }, null, 2));
}
main().catch((e) => {
  console.error("liveStrict failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
