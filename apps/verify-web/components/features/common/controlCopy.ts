/**
 * 暂停 / 取消 / 链上撤销的二次确认文案（Agent 任务控制台与授权任务页共用一份）。
 * 产品语义：四种「停」不是一回事（暂停 ≠ 取消 ≠ 收回额度 ≠ 链上撤销），各自说清后果：
 *  - 暂停：不再签发新步骤，可继续；不动链上额度。
 *  - 取消：不能继续；已取走的证书到期前仍可能执行；不自动收回额度。
 *  - 链上撤销：是你签名发送的交易，要付 gas；剩余步骤作废；不收回代币额度。
 * 纯数据，单测见 test/v8Report.test.ts。
 */
export type ControlOp = "pause" | "cancel" | "revoke";
export interface ControlCopy { title: string; body: string; label: string; done: string }

export function controlCopy(op: ControlOp, zh: boolean, opts: { hostedExecutor?: boolean; revokeAlsoCancels?: boolean } = {}): ControlCopy {
  switch (op) {
    case "pause": return {
      title: zh ? "暂停这个任务？" : "Pause this task?",
      body: zh
        ? `暂停后 Agent 不再签发新的步骤，可以随时继续。${opts.hostedExecutor ? "平台执行：暂停在交易发送前生效，已广播的交易以链上为准。" : ""}链上额度不变。`
        : `The agent stops issuing new steps; you can resume any time. ${opts.hostedExecutor ? "Platform execution: pausing applies before sending; a broadcast transaction settles on-chain. " : ""}On-chain allowance is unchanged.`,
      label: zh ? "暂停任务" : "Pause task",
      done: zh ? "任务已暂停" : "Task paused",
    };
    case "cancel": return {
      title: zh ? "取消这个任务？" : "Cancel this task?",
      body: zh
        ? "取消后不能继续，已确认的成交不受影响。已取走的证书在到期前仍可能被执行。链上额度不会自动收回，需要的话去「资金」收回。"
        : "A cancelled task cannot resume; confirmed fills are unaffected. Certificates already taken may still execute until they expire. On-chain allowance is not reclaimed automatically; reclaim it under Funds.",
      label: zh ? "取消任务" : "Cancel task",
      done: zh ? "任务已取消" : "Task cancelled",
    };
    case "revoke": return {
      title: zh ? "在链上撤销这份授权？" : "Revoke this authorization on-chain?",
      body: zh
        ? `这是一笔需要你在钱包里签名并发送的交易（要付 gas）。撤销后这份授权的剩余步骤全部作废，不能恢复。${opts.revokeAlsoCancels ? "任务同时标为取消。" : ""}它不会收回代币额度。`
        : `This is a transaction you sign and send from your wallet (gas applies). All remaining steps of this authorization become void and cannot be restored. ${opts.revokeAlsoCancels ? "The task is also marked cancelled. " : ""}It does not reclaim token allowance.`,
      label: zh ? "签名并撤销" : "Sign and revoke",
      done: zh ? "已在链上撤销" : "Revoked on-chain",
    };
  }
}
