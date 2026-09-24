/**
 * 钱包请求状态机（V-36）：每个钱包请求（连接 / 切链 / approve / EIP-712 签名 / 发交易）都有
 *  - 慢响应提示（默认 60 s：「没看到弹窗？」）
 *  - 硬超时（默认 5 min：进入明确的错误态，不会一直「…」）
 *  - 可取消（AbortSignal；取消只是停止页面等待，钱包若稍后弹窗请在钱包里拒绝）
 *  - 错误归一化：4001 拒绝 / -32002 钱包里已有待处理请求 / 超时 / 取消 / 链不对
 * 纯逻辑，不依赖 DOM，便于单元测试。
 */

export type WalletPhase = "connect" | "switch_chain" | "approve" | "sign" | "send";
export type WalletErrorKind = "rejected" | "pending_in_wallet" | "timeout" | "cancelled" | "no_wallet" | "wrong_chain" | "no_account" | "unknown";

export class WalletRequestError extends Error {
  readonly kind: WalletErrorKind;
  readonly phase: WalletPhase;
  readonly code: number | undefined;
  override readonly cause: unknown;
  constructor(kind: WalletErrorKind, phase: WalletPhase, cause?: unknown) {
    super(`wallet_${kind}`);
    this.name = "WalletRequestError";
    this.kind = kind;
    this.phase = phase;
    this.cause = cause;
    this.code = typeof (cause as { code?: unknown })?.code === "number" ? (cause as { code: number }).code : undefined;
  }
}

/** EIP-1193 / EIP-1474 错误码 → 归类 */
export function classifyWalletError(err: unknown): WalletErrorKind {
  if (err instanceof WalletRequestError) return err.kind;
  const e = err as { code?: unknown; message?: unknown; name?: unknown } | null;
  const code = typeof e?.code === "number" ? e.code : undefined;
  const msg = typeof e?.message === "string" ? e.message : "";
  if (code === 4001 || /user rejected|user denied|rejected the request/i.test(msg)) return "rejected";
  if (code === -32002 || /already pending|request.*pending/i.test(msg)) return "pending_in_wallet";
  if (code === 4902 || /wrong_chain|chain mismatch|does not match the target chain/i.test(msg)) return "wrong_chain";
  if (msg === "no_wallet") return "no_wallet";
  if (msg === "no_account") return "no_account";
  if (e?.name === "AbortError" || msg === "wallet_cancelled") return "cancelled";
  if (/timed? ?out/i.test(msg)) return "timeout";
  return "unknown";
}

export interface WalletRequestOptions {
  phase: WalletPhase;
  /** 超过这个时间还没返回 → 调 onSlow（默认 60 s） */
  slowMs?: number;
  /** 超过这个时间 → 以 timeout 拒绝（默认 5 min；0 = 不设硬超时） */
  timeoutMs?: number;
  signal?: AbortSignal;
  onSlow?: () => void;
  /** 请求真正结束（成功 / 失败 / 取消）时调一次 */
  onSettled?: () => void;
}

export const DEFAULT_SLOW_MS = 60_000;
export const DEFAULT_TIMEOUT_MS = 5 * 60_000;

/**
 * 把一个钱包请求包成「有慢提示、有硬超时、可取消」的 promise。
 * 底层请求本身取消不了（EIP-1193 没有取消），这里只是让页面不再等；晚到的结果被忽略。
 */
export function walletRequest<T>(run: () => Promise<T>, opts: WalletRequestOptions): Promise<T> {
  const slowMs = opts.slowMs ?? DEFAULT_SLOW_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      opts.signal?.removeEventListener("abort", onAbort);
      fn();
      opts.onSettled?.();
    };
    const onAbort = () => finish(() => reject(new WalletRequestError("cancelled", opts.phase)));
    if (opts.signal?.aborted) {
      onAbort();
      return;
    }
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (slowMs > 0 && opts.onSlow) timers.push(setTimeout(() => { if (!settled) opts.onSlow?.(); }, slowMs));
    if (timeoutMs > 0) timers.push(setTimeout(() => finish(() => reject(new WalletRequestError("timeout", opts.phase))), timeoutMs));
    let p: Promise<T>;
    try {
      p = run();
    } catch (e) {
      finish(() => reject(new WalletRequestError(classifyWalletError(e), opts.phase, e)));
      return;
    }
    p.then(
      (v) => finish(() => resolve(v)),
      (e) => finish(() => reject(e instanceof WalletRequestError ? e : new WalletRequestError(classifyWalletError(e), opts.phase, e))),
    );
  });
}

/** 十六进制 / 十进制 chainId 串 → number；非法返回 NaN */
export function parseChainId(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return Number.NaN;
  return v.startsWith("0x") ? Number.parseInt(v, 16) : Number.parseInt(v, 10);
}

/**
 * 切链后不能立刻发交易（OKX Wallet 在 X Layer 上会把紧接着的 eth_sendTransaction 吞掉）：
 * 轮询 eth_chainId 直到等于目标链或超时。返回是否已在目标链。
 */
export async function waitForChain(readChainId: () => Promise<unknown>, target: number, opts: { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const intervalMs = opts.intervalMs ?? 250;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const started = Date.now();
  for (;;) {
    try {
      if (parseChainId(await readChainId()) === target) return true;
    } catch {
      /* 钱包切换中可能短暂报错，继续等 */
    }
    if (Date.now() - started >= timeoutMs) return false;
    await sleep(intervalMs);
  }
}
