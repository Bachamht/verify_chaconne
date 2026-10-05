/**
 * 不依赖 viem 的链常量（v8 kit / 营销页用）：与 lib/wallet.ts 读同样的构建期变量。
 * 首页与开发者页不得加载钱包代码（D6），所以 kit 从这里取，而不是从 lib/wallet。
 */
export const EXPLORER = process.env["NEXT_PUBLIC_EXPLORER_URL"] ?? "https://www.okx.com/web3/explorer/xlayer";
export const CHAIN_ID_PUBLIC = Number(process.env["NEXT_PUBLIC_CHAIN_ID"] ?? 196);
/** X Layer RPC（与 lib/wallet.ts 的 RPC_URL 读同一个构建期变量）：v8 证据包验证页「联网检查」的默认值，不必为它预加载钱包代码 */
export const RPC_URL_PUBLIC = process.env["NEXT_PUBLIC_XLAYER_RPC_URL"] ?? "https://rpc.xlayer.tech";
