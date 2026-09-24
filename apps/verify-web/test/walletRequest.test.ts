/**
 * V-36 · 钱包请求状态机：慢提示 / 硬超时 / 取消 / 错误归一化 / 切链后等 eth_chainId。
 * 用假的 EIP-1193 provider，不碰真钱包。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyWalletError, parseChainId, waitForChain, walletRequest, WalletRequestError } from "../lib/walletRequest";

/** 一个永远不回应的钱包（OKX 不弹窗的场景） */
const never = () => new Promise<never>(() => undefined);

describe("walletRequest · 超时与慢提示", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("60 s 无响应调 onSlow，5 min 后以 timeout 拒绝（不会一直「…」）", async () => {
    const onSlow = vi.fn();
    const onSettled = vi.fn();
    const p = walletRequest(never, { phase: "approve", onSlow, onSettled });
    const result = p.then(() => "ok", (e: unknown) => e);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(onSlow).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onSlow).toHaveBeenCalledTimes(1);
    expect(onSettled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    const err = (await result) as WalletRequestError;
    expect(err).toBeInstanceOf(WalletRequestError);
    expect(err.kind).toBe("timeout");
    expect(err.phase).toBe("approve");
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("钱包正常回应：结果透传，慢提示不触发", async () => {
    const onSlow = vi.fn();
    const p = walletRequest(async () => ["0xabc"], { phase: "connect", onSlow });
    await vi.advanceTimersByTimeAsync(10);
    await expect(p).resolves.toEqual(["0xabc"]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(onSlow).not.toHaveBeenCalled();
  });

  it("取消：AbortSignal 触发后立刻以 cancelled 拒绝，晚到的钱包结果被忽略", async () => {
    const ac = new AbortController();
    let resolveLate: (v: string) => void = () => undefined;
    const late = new Promise<string>((r) => { resolveLate = r; });
    const onSettled = vi.fn();
    const p = walletRequest(() => late, { phase: "sign", signal: ac.signal, onSettled });
    const result = p.then(() => "ok", (e: unknown) => e);
    ac.abort();
    const err = (await result) as WalletRequestError;
    expect(err.kind).toBe("cancelled");
    resolveLate("0xsig");
    await vi.advanceTimersByTimeAsync(1);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("已经 aborted 的 signal：不发起请求", async () => {
    const ac = new AbortController();
    ac.abort();
    const run = vi.fn(never);
    await expect(walletRequest(run, { phase: "send", signal: ac.signal })).rejects.toMatchObject({ kind: "cancelled" });
    expect(run).not.toHaveBeenCalled();
  });

  it("钱包抛错：4001 → rejected，-32002 → pending_in_wallet，其它 → unknown（带原错误）", async () => {
    const rejected = walletRequest(() => Promise.reject(Object.assign(new Error("User rejected the request."), { code: 4001 })), { phase: "approve" });
    await expect(rejected).rejects.toMatchObject({ kind: "rejected", code: 4001 });
    const pending = walletRequest(() => Promise.reject(Object.assign(new Error("Request of type 'eth_sendTransaction' already pending"), { code: -32002 })), { phase: "send" });
    await expect(pending).rejects.toMatchObject({ kind: "pending_in_wallet", code: -32002 });
    const weird = walletRequest(() => Promise.reject(new Error("boom")), { phase: "sign" });
    const e = (await weird.catch((x: unknown) => x)) as WalletRequestError;
    expect(e.kind).toBe("unknown");
    expect((e.cause as Error).message).toBe("boom");
  });

  it("同步抛错也归一化（没有钱包）", async () => {
    await expect(walletRequest(() => { throw new Error("no_wallet"); }, { phase: "connect" })).rejects.toMatchObject({ kind: "no_wallet" });
  });
});

describe("classifyWalletError", () => {
  it("按 code / message 归类", () => {
    expect(classifyWalletError({ code: 4001 })).toBe("rejected");
    expect(classifyWalletError({ message: "User denied transaction signature" })).toBe("rejected");
    expect(classifyWalletError({ code: -32002 })).toBe("pending_in_wallet");
    expect(classifyWalletError({ code: 4902 })).toBe("wrong_chain");
    expect(classifyWalletError(new Error("no_wallet"))).toBe("no_wallet");
    expect(classifyWalletError(new Error("no_account"))).toBe("no_account");
    expect(classifyWalletError(Object.assign(new Error("x"), { name: "AbortError" }))).toBe("cancelled");
    expect(classifyWalletError(new Error("Timed out"))).toBe("timeout");
    expect(classifyWalletError(null)).toBe("unknown");
    expect(classifyWalletError(new WalletRequestError("wrong_chain", "send"))).toBe("wrong_chain");
  });
});

describe("waitForChain · 切链后不能背靠背发交易", () => {
  it("轮询 eth_chainId 直到等于目标链", async () => {
    const answers = ["0x1", "0x1", "0xc4"];
    const read = vi.fn(async () => answers.shift() ?? "0xc4");
    const ok = await waitForChain(read, 196, { intervalMs: 1, sleep: async () => undefined });
    expect(ok).toBe(true);
    expect(read).toHaveBeenCalledTimes(3);
  });
  it("钱包一直停在别的链 → false（不发交易）", async () => {
    let now = 0;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const read = async () => "0x1";
    const ok = await waitForChain(read, 196, { timeoutMs: 100, intervalMs: 10, sleep: async () => { now += 10; } });
    expect(ok).toBe(false);
    spy.mockRestore();
  });
  it("读链 id 报错时继续等，不当成功", async () => {
    const answers: Array<() => Promise<string>> = [() => Promise.reject(new Error("switching")), async () => "0xc4"];
    const read = () => (answers.shift() ?? (async () => "0xc4"))();
    expect(await waitForChain(read, 196, { sleep: async () => undefined })).toBe(true);
  });
  it("parseChainId 接受十六进制与十进制", () => {
    expect(parseChainId("0xc4")).toBe(196);
    expect(parseChainId("196")).toBe(196);
    expect(parseChainId(196)).toBe(196);
    expect(Number.isNaN(parseChainId(null))).toBe(true);
  });
});
