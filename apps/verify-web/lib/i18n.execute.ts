"use client";
/**
 * 执行链路 / 旧页面修复（V-36 / V-37 / V-38 / V-44）新增文案，独立于 lib/i18n.tsx 的主字典，避免与并行改动冲突。
 * 用法：`tx(locale, "wallet_change")`；带变量：`tx(locale, "wallet_confirm_in", { wallet: "OKX Wallet" })`。
 */
import type { Locale } from "./i18n";
import { classifyWalletError } from "./walletRequest";

const X = {
  /* ---- 钱包卡（V-36） ---- */
  wallet_card: { en: "Wallet", zh: "钱包" },
  wallet_change: { en: "Switch wallet", zh: "更换钱包" },
  wallet_change_hint: { en: "Forgets the remembered wallet and opens the picker again.", zh: "清除记住的钱包并重新选择。" },
  wallet_restoring: { en: "Checking for a connected wallet…", zh: "正在检查已连接的钱包…" },
  wallet_state_connecting: { en: "Connecting", zh: "连接中" },
  wallet_state_awaiting: { en: "Awaiting signature", zh: "等待签名" },
  wallet_state_connected: { en: "Connected", zh: "已连接" },
  wallet_state_wrong_account: { en: "Wrong account", zh: "账户不对" },
  wallet_state_cert_expired: { en: "Certificate expired", zh: "证明已过期" },
  wallet_state_cert_valid: { en: "Certificate valid · {s} s left", zh: "证明有效 · 剩余 {s} 秒" },
  wallet_confirm_in: { en: "Confirm in the {wallet} popup…", zh: "请在 {wallet} 弹窗里确认…" },
  wallet_confirm_generic: { en: "Confirm in your wallet popup…", zh: "请在钱包弹窗里确认…" },
  wallet_no_popup: { en: "No popup? Click the extension icon at the top right of the browser, or switch wallet.", zh: "没看到弹窗？点浏览器右上角的扩展图标，或更换钱包。" },
  wallet_cancel_wait: { en: "Stop waiting", zh: "取消等待" },
  wallet_cancel_note: { en: "Stopping only ends the wait on this page. If the wallet pops up later, reject it there.", zh: "取消只是停止页面等待；钱包若稍后弹窗，请在钱包里拒绝。" },
  phase_connect: { en: "connecting", zh: "连接钱包" },
  phase_switch_chain: { en: "switching network", zh: "切换网络" },
  phase_approve: { en: "approving the exact amount", zh: "精确授权" },
  phase_sign: { en: "signing the intent", zh: "签署意图" },
  phase_send: { en: "sending the Guard transaction", zh: "发送 Guard 交易" },
  wallet_owner_needed: { en: "This task belongs to {owner}. Switch to that account in the wallet, or switch wallet.", zh: "这个任务属于 {owner}。请在钱包里切到该账户，或更换钱包。" },
  disabled_not_owner: { en: "Disabled: the connected account is not the task owner.", zh: "不可用：已连接账户不是任务 owner。" },
  disabled_no_wallet: { en: "Connect the wallet first.", zh: "先连接钱包。" },
  disabled_wrong_chain: { en: "Switch to X Layer first.", zh: "先切换到 X Layer。" },
  disabled_busy: { en: "Waiting for the wallet to answer.", zh: "正在等钱包响应。" },
  err_rejected: { en: "Rejected in the wallet. Nothing was sent; the report stays valid.", zh: "钱包里拒绝了。未发送任何交易，报告仍有效。" },
  err_pending_in_wallet: { en: "The wallet already has a pending request. Open the extension, finish or reject it, then try again.", zh: "钱包里已有一个待处理的请求。请打开扩展处理（确认或拒绝）后再试。" },
  err_timeout: { en: "The wallet did not answer within 5 minutes. Nothing was sent. Check the extension, or switch wallet.", zh: "钱包 5 分钟没有响应，未发送任何交易。请检查扩展，或更换钱包。" },
  err_cancelled: { en: "Stopped waiting. If the wallet pops up later, reject it there.", zh: "已取消等待。钱包若稍后弹窗，请在钱包里拒绝。" },
  err_wrong_chain: { en: "The wallet is not on X Layer. Switch the network and try again.", zh: "钱包不在 X Layer 上。请先切换网络再试。" },
  err_no_account: { en: "The wallet returned no account. Unlock it and try again.", zh: "钱包没有返回账户。请解锁后再试。" },
  err_unknown: { en: "The wallet returned an error: {detail}", zh: "钱包返回错误：{detail}" },
  retry_switch: { en: "Switch to X Layer", zh: "切换到 X Layer" },
  cert_countdown: { en: "Certificate valid for {s} s", zh: "证明剩余 {s} 秒" },
  cert_expired_reverify: { en: "Certificate expired — re-verify to get a new one.", zh: "证明已过期——再核验获取新证明。" },
  approve_btn: { en: "Approve {amount}", zh: "授权 {amount}" },
  approve_pending: { en: "Approving · confirm in wallet", zh: "授权中 · 请在钱包确认" },
  approve_mining: { en: "Approval sent · waiting for the chain", zh: "授权已发出 · 等待上链" },
  sign_pending: { en: "Signing · confirm in wallet", zh: "签名中 · 请在钱包确认" },
  send_pending: { en: "Sending · confirm in wallet", zh: "发送中 · 请在钱包确认" },
  execute_btn: { en: "Send the transaction", zh: "发送交易" },
  balance_line: { en: "Balance {balance} · approved {allowance}", zh: "余额 {balance} · 已授权 {allowance}" },
  server_receipt_line: { en: "spent {spent} · received {received} · refunded {refunded}", zh: "支出 {spent} · 到账 {received} · 退回 {refunded}" },
  server_receipt_wait: { en: "Waiting for the server to verify on-chain…", zh: "等待服务端链上核实…" },
  reverify: { en: "Re-verify", zh: "再核验" },
  hard_bounds: { en: "Hard bounds for this execution (enforced on-chain)", zh: "本次执行的硬边界（链上强制）" },
  recipient: { en: "Recipient", zh: "收款人" },
  router_spender: { en: "Router / spender", zh: "路由 / 授权对象" },
  attestation_signer: { en: "Attestation signer", zh: "证明签发身份" },
  deadline: { en: "Deadline", zh: "截止时间" },
  sign_send_card: { en: "Sign & send", zh: "签名与发送" },
  signed: { en: "Signed", zh: "已签名" },
  confirmations: { en: "{n}/{m} confirmations", zh: "{n}/{m} 次确认" },

  /* ---- 报告页（V-37） ---- */
  free_this_time: { en: "Free this time", zh: "本次免费" },
  reset_at: { en: "resets at {t}", zh: "重置于 {t}" },
  input_amount: { en: "Input amount", zh: "输入金额" },
  expected_out: { en: "Expected output", zh: "预计到账" },
  min_out: { en: "Minimum received", zh: "最少到账" },
  approx_note: { en: "≈ means an estimate from the quote, not a settled amount.", zh: "≈ 表示按报价估算，不是已结算金额。" },
  usd_per_share: { en: "USD / share", zh: "USD / 股" },
  raw_units: { en: "raw units", zh: "原始单位" },

  /* ---- 分享卡 / 证据包（V-38） ---- */
  template_making: { en: "Creating template…", zh: "正在生成模板…" },
  template_done: { en: "Template created. Anyone with this link gets the structure only (assets, policy, limits).", zh: "模板已生成。拿到链接的人只得到结构（资产、策略、限额）。" },
  template_copy: { en: "Copy link", zh: "复制链接" },
  copied: { en: "Copied", zh: "已复制" },
  bundle_not_yours: { en: "This job does not belong to the current wallet / key, or it does not exist.", zh: "这个 job 不属于当前钱包/密钥，或不存在。" },
  bundle_unauthorized: { en: "The service refused the request: no valid key for this job.", zh: "服务拒绝了请求：没有这个 job 的有效密钥。" },
  bundle_load_failed: { en: "Could not load from the service ({detail}). Paste the bundle JSON instead.", zh: "从服务加载失败（{detail}）。可以改为粘贴证据包 JSON。" },
  bundle_loading: { en: "Loading…", zh: "加载中…" },

  /* ---- /plan /play /me（V-44） ---- */
  plan_sign_wait: { en: "Sign authorization & wait", zh: "签授权并等待" },
  plan_sign_wait_hint: { en: "Opens the one-signature authorization; the monitor then waits for the condition and executes within your bounds.", zh: "打开一次签名的授权流程；之后由监测器等条件满足，在你的边界内执行。" },
  plan_view_policy: { en: "View by policy", zh: "按策略查看" },
  plan_view_chosen: { en: "as planned", zh: "规划所选" },
  plan_view_note: { en: "Verdicts and blockers below follow the selected policy; actions still use the policy you planned with ({policy}).", zh: "下表的结论与阻断按所选策略显示；动作仍按规划时的策略（{policy}）。" },
  plan_balance_short: { en: "Not enough balance: the wallet holds {balance}, the budget is {budget}.", zh: "余额不足：钱包里只有 {balance}，预算是 {budget}。" },
  plan_use_balance: { en: "Plan with {balance} instead", zh: "改按 {balance} 规划" },
  plan_balance_checking: { en: "Checking balance…", zh: "正在查余额…" },
  col_leg: { en: "Leg", zh: "腿" },
  col_expected_out: { en: "Expected output", zh: "预计到账" },
  col_impact: { en: "Impact", zh: "冲击" },
  col_actions: { en: "Action", zh: "操作" },
  play_persona_chosen: { en: "Playing as {persona}", zh: "当前角色：{persona}" },
  me_title: { en: "Local verification records", zh: "本机核验记录" },
  me_note: { en: "Not the same as the agent's task list: this is only what this browser created.", zh: "与 Agent 的任务列表不同：这里只有本浏览器创建过的记录。" },
} as const;

export type ExecKey = keyof typeof X;

export function tx(locale: Locale, key: ExecKey, vars?: Record<string, string | number>): string {
  const s: string = X[key][locale];
  return vars ? s.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m)) : s;
}

/** 钱包请求错误 → 一句人话（不把原始 JSON / 内部码甩给用户；未知错误只带钱包给的 message 前 120 字） */
export function walletErrorText(err: unknown, locale: Locale): string {
  const kind = classifyWalletError(err);
  switch (kind) {
    case "rejected": return tx(locale, "err_rejected");
    case "pending_in_wallet": return tx(locale, "err_pending_in_wallet");
    case "timeout": return tx(locale, "err_timeout");
    case "cancelled": return tx(locale, "err_cancelled");
    case "wrong_chain": return tx(locale, "err_wrong_chain");
    case "no_account": return tx(locale, "err_no_account");
    case "no_wallet": return locale === "zh" ? "浏览器里没有检测到钱包。请安装 OKX Wallet（X Layer 上推荐）或 MetaMask。" : "No wallet found in this browser. Install OKX Wallet (recommended on X Layer) or MetaMask.";
    default: {
      const cause = (err as { cause?: unknown })?.cause ?? err;
      const m = cause instanceof Error ? cause.message : typeof (cause as { message?: unknown })?.message === "string" ? String((cause as { message: string }).message) : "";
      return tx(locale, "err_unknown", { detail: (m || "unknown").split("\n")[0]!.slice(0, 120) });
    }
  }
}
