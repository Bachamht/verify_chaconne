"use client";
/**
 * 链上撤销授权（PlanGuard.revokeMandate）的唯一实现：控制台与 /tasks/[id] 共用。
 *  - 先核对已连接账户是不是授权 owner（不是就不发交易，免得白花 gas 再回滚）
 *  - 等回执并看 status：回滚 ≠ 已撤销
 * 这是一笔用户签名并发送的交易（付 gas）；它不收回代币额度（收回额度在资金页）。
 */
import type { TradeMandate } from "@chaconne/core/verify";
import type { Locale } from "./i18n";
import { walletErrorText } from "./i18n.execute";
import { encodeRevoke } from "./mandate";
import { PLANGUARD_ADDRESS } from "./planGuardAbi";
import { CHAIN_ID, connect, currentChainId, ensureChain, sendGuardCall, waitReceipt } from "./wallet";

export type RevokeResult = { ok: true; hash: `0x${string}` } | { ok: false; message: string; hash?: `0x${string}` };

export async function revokeOnChain(mandate: TradeMandate, account: string | null, locale: Locale): Promise<RevokeResult> {
  const zh = locale === "zh";
  if (!PLANGUARD_ADDRESS) return { ok: false, message: zh ? "这个环境没有配置授权合约地址，不能链上撤销。" : "No authorization contract is configured here; on-chain revoke is unavailable." };
  try {
    const a = (account ?? (await connect())) as `0x${string}`;
    if (a.toLowerCase() !== String(mandate.owner).toLowerCase()) {
      return { ok: false, message: zh ? "已连接的账户不是这份授权的所有者。在钱包里切到所有者账户后再试，什么都没有发送。" : "The connected account does not own this authorization. Switch to the owner account and try again; nothing was sent." };
    }
    if ((await currentChainId()) !== CHAIN_ID) await ensureChain();
    const hash = await sendGuardCall(a, PLANGUARD_ADDRESS as `0x${string}`, encodeRevoke(mandate));
    const rcpt = await waitReceipt(hash);
    if (rcpt.status !== "success") return { ok: false, hash, message: zh ? "撤销交易在链上回滚，授权仍然有效。可以在区块浏览器里看原因后再试。" : "The revoke transaction reverted on-chain; the authorization is still active. Check the explorer and try again." };
    return { ok: true, hash };
  } catch (e) {
    return { ok: false, message: walletErrorText(e, locale) };
  }
}
