"use client";
/**
 * 注入钱包封装：EIP-6963 多钱包发现 + 选择（V-06），连接、切链 196、精确 approve、EIP-712 签名、发 Guard 交易、等回执。
 * 不做无限授权；每一步都有可恢复状态；不信任前端"成功"，回执以链上为准。
 *
 * 钱包选择规则：
 *  - 页面加载即监听 `eip6963:announceProvider`，收集所有注入钱包（OKX Wallet / MetaMask / Phantom(EVM) …）；
 *  - `connect()`：已记住的选择（localStorage `verify-wallet-rdns`）优先；只有一个就直接用；多个时打开全局选择框（`WalletChooser`），
 *    OKX Wallet 排第一并标"推荐"；都没有时退回 `window.ethereum`；仍没有 → `no_wallet`；
 *  - 连接过程通过 `verify:wallet-status` 事件广播（connecting / idle），UI 显示"请在钱包里确认"，60 s 无响应给提示。
 */
import { createPublicClient, createWalletClient, custom, encodeFunctionData, erc20Abi, getAddress, http, type Hex, type TypedDataDomain } from "viem";

export const CHAIN_ID = Number(process.env["NEXT_PUBLIC_CHAIN_ID"] ?? 196);
export const RPC_URL = process.env["NEXT_PUBLIC_XLAYER_RPC_URL"] ?? "https://rpc.xlayer.tech";
export const EXPLORER = process.env["NEXT_PUBLIC_EXPLORER_URL"] ?? "https://www.okx.com/web3/explorer/xlayer";

export const xlayer = {
  id: CHAIN_ID,
  name: CHAIN_ID === 196 ? "X Layer" : "X Layer Testnet",
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: "OKX Explorer", url: EXPLORER } },
} as const;

type Eip1193 = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };
export interface WalletProviderInfo {
  rdns: string;
  name: string;
  icon: string;
  provider: Eip1193;
}

const SELECTED_KEY = "verify-wallet-rdns";
const discovered = new Map<string, WalletProviderInfo>();
let listening = false;
/** 推荐顺序：OKX Wallet 第一（本产品在 OKX 生态里执行），其余按发现顺序 */
const PREFERRED = ["com.okex.wallet", "io.metamask", "app.phantom", "com.bitget.web3", "com.coinbase.wallet"];

function startDiscovery(): void {
  if (listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener("eip6963:announceProvider", (ev: Event) => {
    const detail = (ev as CustomEvent<{ info: { rdns: string; name: string; icon: string }; provider: Eip1193 }>).detail;
    if (!detail?.info?.rdns || !detail.provider) return;
    discovered.set(detail.info.rdns, { rdns: detail.info.rdns, name: detail.info.name, icon: detail.info.icon, provider: detail.provider });
    window.dispatchEvent(new CustomEvent("verify:wallets-changed"));
  });
  window.dispatchEvent(new Event("eip6963:requestProvider"));
}

/** 已发现的钱包（推荐顺序） */
export function discoveredWallets(): WalletProviderInfo[] {
  startDiscovery();
  const list = [...discovered.values()];
  return list.sort((a, b) => {
    const ia = PREFERRED.indexOf(a.rdns);
    const ib = PREFERRED.indexOf(b.rdns);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.name.localeCompare(b.name);
  });
}
export function isRecommended(rdns: string): boolean {
  return rdns === "com.okex.wallet";
}
export function selectedWalletRdns(): string | null {
  try {
    return localStorage.getItem(SELECTED_KEY);
  } catch {
    return null;
  }
}
export function selectWallet(rdns: string | null): void {
  try {
    if (rdns) localStorage.setItem(SELECTED_KEY, rdns);
    else localStorage.removeItem(SELECTED_KEY);
  } catch {
    /* 私密窗口等 */
  }
  window.dispatchEvent(new CustomEvent("verify:wallets-changed"));
}

let activeProvider: Eip1193 | null = null;

/** 当前用于签名/发交易的 provider：已选择的 EIP-6963 钱包 → 唯一钱包 → window.ethereum */
export function injected(): Eip1193 | null {
  if (typeof window === "undefined") return null;
  if (activeProvider) return activeProvider;
  const wallets = discoveredWallets();
  const chosen = selectedWalletRdns();
  const hit = chosen ? wallets.find((w) => w.rdns === chosen) : null;
  if (hit) return hit.provider;
  if (wallets.length === 1) return wallets[0]!.provider;
  const w = window as unknown as { ethereum?: Eip1193 };
  return w.ethereum ?? null;
}

type ChooserRequest = { wallets: WalletProviderInfo[]; resolve: (rdns: string | null) => void };
/** 全局选择框（components/WalletChooser.tsx）监听此事件并回调 */
function askUserToChoose(wallets: WalletProviderInfo[]): Promise<string | null> {
  return new Promise((resolve) => {
    const req: ChooserRequest = { wallets, resolve };
    window.dispatchEvent(new CustomEvent<ChooserRequest>("verify:choose-wallet", { detail: req }));
  });
}
export type WalletStatus = "idle" | "connecting" | "slow";
function status(s: WalletStatus): void {
  window.dispatchEvent(new CustomEvent<WalletStatus>("verify:wallet-status", { detail: s }));
}

export const publicClient = createPublicClient({ chain: xlayer, transport: http(RPC_URL) });

/** 连接：多钱包时弹选择框（记住选择）；连接中广播状态，60 s 未返回提示"钱包可能锁着或弹窗被挡" */
export async function connect(opts: { force?: boolean } = {}): Promise<`0x${string}`> {
  startDiscovery();
  // 给钱包 300 ms 完成 EIP-6963 announce（首次调用时）
  if (discovered.size === 0) await new Promise((r) => setTimeout(r, 300));
  const wallets = discoveredWallets();
  let provider: Eip1193 | null = null;
  const remembered = selectedWalletRdns();
  if (!opts.force && remembered && wallets.some((w) => w.rdns === remembered)) provider = wallets.find((w) => w.rdns === remembered)!.provider;
  else if (wallets.length === 1 && !opts.force) provider = wallets[0]!.provider;
  else if (wallets.length >= 1) {
    const rdns = await askUserToChoose(wallets);
    if (!rdns) throw Object.assign(new Error("wallet_choice_cancelled"), { code: 4001 });
    selectWallet(rdns);
    provider = wallets.find((w) => w.rdns === rdns)!.provider;
  } else {
    const w = window as unknown as { ethereum?: Eip1193 };
    provider = w.ethereum ?? null;
  }
  if (!provider) throw new Error("no_wallet");
  activeProvider = provider;
  status("connecting");
  const slow = setTimeout(() => status("slow"), 60_000);
  try {
    const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
    const a = accounts[0];
    if (!a) throw new Error("no_account");
    return getAddress(a);
  } finally {
    clearTimeout(slow);
    status("idle");
  }
}

export async function currentChainId(): Promise<number> {
  const eth = injected();
  if (!eth) throw new Error("no_wallet");
  const hex = (await eth.request({ method: "eth_chainId" })) as string;
  return Number.parseInt(hex, 16);
}

export async function ensureChain(): Promise<void> {
  const eth = injected();
  if (!eth) throw new Error("no_wallet");
  const hex = `0x${CHAIN_ID.toString(16)}`;
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code === 4902) {
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [{ chainId: hex, chainName: xlayer.name, nativeCurrency: xlayer.nativeCurrency, rpcUrls: [RPC_URL], blockExplorerUrls: [EXPLORER] }],
      });
    } else throw err;
  }
}

function walletClient(account: `0x${string}`) {
  const eth = injected();
  if (!eth) throw new Error("no_wallet");
  return createWalletClient({ account, chain: xlayer, transport: custom(eth) });
}

export async function allowance(token: `0x${string}`, owner: `0x${string}`, spender: `0x${string}`): Promise<bigint> {
  return publicClient.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, spender] });
}

export async function balanceOf(token: `0x${string}`, owner: `0x${string}`): Promise<bigint> {
  return publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
}

/** 精确授权（不是无限）；等待回执后返回。 */
export async function approveExact(account: `0x${string}`, token: `0x${string}`, spender: `0x${string}`, amount: bigint): Promise<Hex> {
  const wc = walletClient(account);
  const hash = await wc.sendTransaction({ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }) });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

export async function signTypedData(account: `0x${string}`, domain: TypedDataDomain, types: Record<string, Array<{ name: string; type: string }>>, primaryType: string, message: Record<string, unknown>): Promise<Hex> {
  const wc = walletClient(account);
  return wc.signTypedData({ domain, types, primaryType, message });
}

export async function sendGuardCall(account: `0x${string}`, to: `0x${string}`, data: Hex, gas?: bigint): Promise<Hex> {
  const wc = walletClient(account);
  return wc.sendTransaction({ to, data, value: 0n, gas });
}

export async function waitReceipt(hash: Hex) {
  return publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
}

export function fmtUnits(raw: string | bigint, decimals: number, maxFrac = 6): string {
  const v = BigInt(raw);
  const s = v.toString().padStart(decimals + 1, "0");
  const i = s.slice(0, s.length - decimals);
  const f = s.slice(s.length - decimals).replace(/0+$/, "").slice(0, maxFrac);
  return f ? `${i}.${f}` : i;
}

export function short(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}
