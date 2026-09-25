"use client";
/**
 * 注入钱包封装：EIP-6963 多钱包发现 + 选择（V-06），连接、切链 196、精确 approve、EIP-712 签名、发 Guard 交易、等回执。
 * 不做无限授权；每一步都有可恢复状态；不信任前端"成功"，回执以链上为准。
 *
 * 钱包选择规则：
 *  - 页面加载即监听 `eip6963:announceProvider`，收集所有注入钱包（OKX Wallet / MetaMask / Phantom(EVM) …）；
 *  - `connect()`：已记住的选择（localStorage `verify-wallet-rdns`）优先；只有一个就直接用；多个时打开全局选择框（`WalletChooser`），
 *    OKX Wallet 排第一并标"推荐"；都没有时退回 `window.ethereum`；仍没有 → `no_wallet`；
 *  - `forgetWallet()`：清掉记住的选择并重新弹选择框（钱包区「更换钱包」）；
 *  - `restoreConnection()`：挂载时用 `eth_accounts` 静默恢复（不弹窗），刷新不掉线。
 *
 * 每个钱包请求（V-36）都经过 lib/walletRequest：60 s 慢提示、5 min 硬超时、可取消、错误归一化；
 * 状态通过 `verify:wallet-status` 事件广播（detail: WalletStatusDetail），全局提示条与执行页钱包卡共用。
 * 切链后必须等 `eth_chainId` 真的变成目标链才发交易；发交易前再读一次链 id（OKX Wallet 不弹窗的排查结论）。
 */
import { createPublicClient, createWalletClient, custom, encodeFunctionData, erc20Abi, getAddress, http, type Hex, type TypedDataDomain } from "viem";
import { waitForChain, walletRequest, WalletRequestError, type WalletPhase } from "./walletRequest";

export { WalletRequestError, classifyWalletError, type WalletPhase, type WalletErrorKind } from "./walletRequest";

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

/**
 * 等 EIP-6963 announce：一有钱包（或指定的那个）就返回，最多等 maxMs。
 * 之前固定等 300 ms 且不等指定钱包——announce 晚于 300 ms 时首击落到 window.ethereum 上，表现为「第一次点没反应」。
 */
export function waitForDiscovery(preferRdns: string | null = null, maxMs = 1200): Promise<void> {
  startDiscovery();
  const ready = () => (preferRdns ? discovered.has(preferRdns) : discovered.size > 0);
  if (ready()) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      window.removeEventListener("verify:wallets-changed", onChange);
      clearTimeout(t);
      resolve();
    };
    const onChange = () => { if (ready()) done(); };
    const t = setTimeout(done, maxMs);
    window.addEventListener("verify:wallets-changed", onChange);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
  });
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

/** 当前 provider 对应的钱包名（给「请在 <钱包名> 弹窗里确认」用）；认不出来时 null */
export function activeWalletName(): string | null {
  const p = injected();
  if (!p) return null;
  for (const w of discovered.values()) if (w.provider === p) return w.name;
  const eth = p as unknown as { isOkxWallet?: boolean; isOKExWallet?: boolean; isMetaMask?: boolean; isPhantom?: boolean };
  if (eth.isOkxWallet || eth.isOKExWallet) return "OKX Wallet";
  if (eth.isPhantom) return "Phantom";
  if (eth.isMetaMask) return "MetaMask";
  return null;
}

/** 「更换钱包」：忘掉记住的选择与当前 provider；下次 connect() 会重新弹选择框 */
export function forgetWallet(): void {
  activeProvider = null;
  selectWallet(null);
  window.dispatchEvent(new CustomEvent("verify:wallet-status", { detail: IDLE }));
}

type ChooserRequest = { wallets: WalletProviderInfo[]; resolve: (rdns: string | null) => void };
/** 全局选择框（components/WalletChooser.tsx）监听此事件并回调 */
function askUserToChoose(wallets: WalletProviderInfo[]): Promise<string | null> {
  return new Promise((resolve) => {
    const req: ChooserRequest = { wallets, resolve };
    window.dispatchEvent(new CustomEvent<ChooserRequest>("verify:choose-wallet", { detail: req }));
  });
}

/** 钱包请求状态：全局提示条（WalletChooser）与执行页钱包卡都订阅 `verify:wallet-status` */
export interface WalletStatusDetail {
  status: "idle" | "busy" | "slow";
  phase: WalletPhase | null;
  walletName: string | null;
  /** 停止页面等待（钱包若稍后弹窗，请在钱包里拒绝） */
  cancel: (() => void) | null;
}
/** 旧字段名保留给现有订阅者：idle / connecting(busy) / slow */
export type WalletStatus = WalletStatusDetail["status"];
const IDLE: WalletStatusDetail = { status: "idle", phase: null, walletName: null, cancel: null };
let current: WalletStatusDetail = IDLE;
export function walletStatus(): WalletStatusDetail {
  return current;
}
function emit(d: WalletStatusDetail): void {
  current = d;
  window.dispatchEvent(new CustomEvent<WalletStatusDetail>("verify:wallet-status", { detail: d }));
}
let currentController: AbortController | null = null;
/** 取消当前正在等待的钱包请求（全局提示条上的「取消」） */
export function cancelWalletRequest(): void {
  currentController?.abort();
}

/** 把一个钱包请求包成有状态、可取消、会超时的请求（V-36）；同一时刻只允许一个 */
async function guarded<T>(phase: WalletPhase, run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (currentController && !currentController.signal.aborted) throw new WalletRequestError("pending_in_wallet", phase);
  const controller = new AbortController();
  currentController = controller;
  if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });
  const walletName = activeWalletName();
  const cancel = () => controller.abort();
  emit({ status: "busy", phase, walletName, cancel });
  try {
    return await walletRequest(run, {
      phase,
      signal: controller.signal,
      onSlow: () => emit({ status: "slow", phase, walletName, cancel }),
    });
  } finally {
    if (currentController === controller) currentController = null;
    emit(IDLE);
  }
}

export const publicClient = createPublicClient({ chain: xlayer, transport: http(RPC_URL) });

/** 连接：多钱包时弹选择框（记住选择）；连接中广播状态，60 s 未返回提示"钱包可能锁着或弹窗被挡"，5 min 超时 */
export async function connect(opts: { force?: boolean; signal?: AbortSignal } = {}): Promise<`0x${string}`> {
  const remembered = opts.force ? null : selectedWalletRdns();
  await waitForDiscovery(remembered);
  const wallets = discoveredWallets();
  let provider: Eip1193 | null = null;
  if (!opts.force && remembered && wallets.some((w) => w.rdns === remembered)) provider = wallets.find((w) => w.rdns === remembered)!.provider;
  else if (wallets.length === 1 && !opts.force) provider = wallets[0]!.provider;
  else if (wallets.length >= 1) {
    const rdns = await askUserToChoose(wallets);
    if (!rdns) throw new WalletRequestError("cancelled", "connect");
    selectWallet(rdns);
    provider = wallets.find((w) => w.rdns === rdns)!.provider;
  } else {
    const w = window as unknown as { ethereum?: Eip1193 };
    provider = w.ethereum ?? null;
  }
  if (!provider) throw new WalletRequestError("no_wallet", "connect");
  activeProvider = provider;
  const p = provider;
  return guarded("connect", async () => {
    const accounts = (await p.request({ method: "eth_requestAccounts" })) as string[];
    const a = accounts[0];
    if (!a) throw new Error("no_account");
    return getAddress(a);
  }, opts.signal);
}

/** 静默恢复（不弹窗）：记住的钱包 / 唯一钱包上 eth_accounts 有值就算已连接；没有钱包或没授权 → null */
export async function restoreConnection(): Promise<`0x${string}` | null> {
  if (typeof window === "undefined") return null;
  const remembered = selectedWalletRdns();
  await waitForDiscovery(remembered);
  // 多个钱包、没记住选择、也没连过：不猜 window.ethereum 是哪个（换钱包后头部不能显示另一个钱包的账户）
  if (!activeProvider && !remembered && discovered.size > 1) return null;
  const eth = injected();
  if (!eth) return null;
  try {
    const list = (await eth.request({ method: "eth_accounts" })) as string[];
    const a = list?.[0];
    if (!a) return null;
    activeProvider = eth;
    return getAddress(a);
  } catch {
    return null;
  }
}

export async function currentChainId(): Promise<number> {
  const eth = injected();
  if (!eth) throw new WalletRequestError("no_wallet", "switch_chain");
  const hex = (await eth.request({ method: "eth_chainId" })) as string;
  return Number.parseInt(hex, 16);
}

/** 切到 X Layer，并等钱包真的切过去（轮询 eth_chainId）；切不过去抛 wrong_chain */
export async function ensureChain(opts: { signal?: AbortSignal } = {}): Promise<void> {
  const eth = injected();
  if (!eth) throw new WalletRequestError("no_wallet", "switch_chain");
  if ((await currentChainId()) === CHAIN_ID) return;
  const hex = `0x${CHAIN_ID.toString(16)}`;
  await guarded("switch_chain", async () => {
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
    const ok = await waitForChain(() => eth.request({ method: "eth_chainId" }), CHAIN_ID);
    if (!ok) throw new WalletRequestError("wrong_chain", "switch_chain");
  }, opts.signal);
}

/** 发交易前再读一次链 id；不对就抛 wrong_chain（不自动切链——切链与发交易不能背靠背） */
async function assertChain(phase: WalletPhase): Promise<void> {
  if ((await currentChainId()) !== CHAIN_ID) throw new WalletRequestError("wrong_chain", phase);
}

function walletClient(account: `0x${string}`) {
  const eth = injected();
  if (!eth) throw new WalletRequestError("no_wallet", "send");
  return createWalletClient({ account, chain: xlayer, transport: custom(eth) });
}

export async function allowance(token: `0x${string}`, owner: `0x${string}`, spender: `0x${string}`): Promise<bigint> {
  return publicClient.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, spender] });
}

export async function balanceOf(token: `0x${string}`, owner: `0x${string}`): Promise<bigint> {
  return publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
}

/** 精确授权（不是无限）；钱包确认后返回 hash，再等回执（最长 3 min）。 */
export async function approveExact(account: `0x${string}`, token: `0x${string}`, spender: `0x${string}`, amount: bigint, opts: { signal?: AbortSignal } = {}): Promise<Hex> {
  await assertChain("approve");
  const wc = walletClient(account);
  const hash = await guarded("approve", () => wc.sendTransaction({ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }) }), opts.signal);
  await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
  return hash;
}

/** EIP-191 personal_sign（登录消息 / 签发 API key 的消息）；不是交易 */
export async function signMessage(account: `0x${string}`, message: string, opts: { signal?: AbortSignal } = {}): Promise<Hex> {
  const wc = walletClient(account);
  return guarded("sign", () => wc.signMessage({ message }), opts.signal);
}

export async function signTypedData(account: `0x${string}`, domain: TypedDataDomain, types: Record<string, Array<{ name: string; type: string }>>, primaryType: string, message: Record<string, unknown>, opts: { signal?: AbortSignal } = {}): Promise<Hex> {
  const wc = walletClient(account);
  return guarded("sign", () => wc.signTypedData({ domain, types, primaryType, message }), opts.signal);
}

export async function sendGuardCall(account: `0x${string}`, to: `0x${string}`, data: Hex, gas?: bigint, opts: { signal?: AbortSignal } = {}): Promise<Hex> {
  await assertChain("send");
  const wc = walletClient(account);
  return guarded("send", () => wc.sendTransaction({ to, data, value: 0n, gas }), opts.signal);
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
