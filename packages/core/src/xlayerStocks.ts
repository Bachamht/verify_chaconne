/**
 * X Layer 上**已放行执行**的 xStocks（底层代码 → X Layer 代币符号）。
 *
 * 放在 core 而不是各自 app 里，是因为两边都要用同一份：主站据此决定哪只资产给「去 Agent 交易」的深链，
 * Verify 侧的执行登记表是它的来源。以前主站那份是手维护的，登记表一扩容就漂移——漂移的后果是
 * 主站给出的深链指向一只并未放行执行的股票，用户点进去必然失败。
 *
 * 由 `node scripts/genXlayerStocks.mjs` 从 `apps/verify-service/config/registry.xlayer.v1.2.json` 生成，
 * **勿手改**；`apps/verify-service/test/xlayerStocks.test.ts` 会断言两者一致，登记表改了而这里没跟上会红。
 * 口径：只收 `role=stock_output && executionAllowed`——展示层、以及买得进卖不出的（NKEx）都不在此列。
 */
export const XLAYER_EXECUTABLE_STOCKS: Record<string, string> = {
  AAPL: "AAPLx",
  AMD: "AMDx",
  AMZN: "AMZNx",
  ASML: "ASMLx",
  AVGO: "AVGOx",
  BMNR: "BMNRx",
  "BRK.B": "BRK.Bx",
  COIN: "COINx",
  CRCL: "CRCLx",
  DELL: "DELLx",
  GME: "GMEx",
  GOOGL: "GOOGLx",
  HOOD: "HOODx",
  IBM: "IBMx",
  ICE: "ICEx",
  INTC: "INTCx",
  IWM: "IWMx",
  KO: "KOx",
  MCD: "MCDx",
  META: "METAx",
  MRK: "MRKx",
  MRNA: "MRNAx",
  MRVL: "MRVLx",
  MSFT: "MSFTx",
  MSTR: "MSTRx",
  MU: "MUx",
  NVDA: "NVDAx",
  ORCL: "ORCLx",
  PLTR: "PLTRx",
  QQQ: "QQQx",
  RDDT: "RDDTx",
  SKHY: "SKHYx",
  SLV: "SLVx",
  SMCI: "SMCIx",
  SNDK: "SNDKx",
  SPCX: "SPCXx",
  SPY: "SPYx",
  TSLA: "TSLAx",
  TSM: "TSMx",
  WMT: "WMTx",
};

/** 底层代码（如 "AAPL"，也接受 "us-equity:AAPL"）→ X Layer 代币符号；未放行执行的返回 null */
export function xlayerStockFor(underlying: string | null | undefined): string | null {
  if (!underlying) return null;
  const t = underlying.includes(":") ? underlying.split(":").pop()! : underlying;
  return XLAYER_EXECUTABLE_STOCKS[t.toUpperCase()] ?? null;
}
