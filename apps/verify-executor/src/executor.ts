/**
 * 执行主循环（v7 §3.2 X6）：claim → 按 kind 处理 → 事件上报；**严格串行**（上一个作业 SENT 或判定放弃之前不领下一个）。
 *
 * execute_step：本地核对 → 链上预检（steps == stepIndex、未撤销、allowance ≥ amountIn、balance ≥ amountIn）→ estimateGas×1.3（回退即解码，preflight_failed）
 *               → 本地签名 → sending（发送提交点；409 = 不得广播，退回 nonce）→ 广播 → sent → 等回执（至签名 validUntil + 30 s）→ receipt。
 * permit：nonces(owner) == nonce、deadline 未近、eth_call permit 不回退 → 签名 → sending → 广播 → sent → 1 确认 → receipt（附 Approval）。
 * 崩溃恢复：claim 带回本地址 SENDING / SENT 作业（recover）；按 rawTxHash 查：已上链 → 上报；未见且证书仍有效且服务端同意（重发 sending 得 200）→ 原样重播；否则交给对账器。
 * 故障钩子（只在作业带 fault 时可达）：cert_void / receipt_delay / rpc_timeout；double_claim 在服务端制造。
 */
import { randomBytes } from "node:crypto";
import { decodeEventLog, type Hex } from "viem";
import type { ExecuteStepJobPayload, PermitJobPayload } from "@chaconne/core/verify";
import { buildExecuteStepTx, buildPermitTx, checkReadyStep, ExecSender, ExecTxError, TOKEN_ABI, WouldRevertError, type ChainIO, type ReadyStepBody, type SignedTx } from "@chaconne/verify-exec";
import type { ClaimedJob, JobEvent, ServiceApi } from "./client";

export interface ExecutorDeps {
  api: ServiceApi;
  chain: ChainIO;
  sender: ExecSender;
  planGuard: Hex;
  minCertRemainingS: number;
  minOkbWei: bigint;
  mode: "eoa" | "okx_agentic";
  version: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export class InjectedFault extends Error {}

/** wait_clock：最多预检 3 次，每次最多等 10 s（开发计划 §2.5 失败分类表） */
export const WAIT_CLOCK_TRIES = 3;
export const WAIT_CLOCK_MAX_S = 10;
/** 同一恢复作业两次处理之间的最短间隔 */
export const RECOVER_BACKOFF_MS = 2000;

export type JobOutcome = "sent" | "confirmed" | "reverted" | "refused" | "preflight_failed" | "recovered" | "waiting" | "crashed";

export class Executor {
  readonly instanceId = randomBytes(12).toString("hex");
  private gasLow = false;
  private stopped = false;
  private conflict = false;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (msg: string, extra?: Record<string, unknown>) => void;
  constructor(private readonly d: ExecutorDeps) {
    this.now = d.now ?? (() => Date.now());
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.log = d.log ?? ((msg, extra) => console.info(`[verify-executor] ${msg}${extra ? ` ${JSON.stringify(extra)}` : ""}`));
  }
  get address(): Hex {
    return this.d.sender.address.toLowerCase() as Hex;
  }
  get isGasLow(): boolean {
    return this.gasLow;
  }
  get instanceConflict(): boolean {
    return this.conflict;
  }
  stop(): void {
    this.stopped = true;
  }

  /** 每 30 s：gas 余额与链头；409 executor_instance_conflict → 停止；gas 低 → 停止领取（服务端据心跳报 executor_gas_low） */
  async heartbeat(): Promise<void> {
    const [bal, head] = await Promise.all([this.d.chain.nativeBalance(this.address), this.d.chain.head()]);
    this.gasLow = bal < this.d.minOkbWei;
    const r = await this.d.api.heartbeat({ executor: this.address, instanceId: this.instanceId, mode: this.d.mode, gasBalanceWei: bal.toString(), chainHead: head.number.toString(), version: this.d.version, gasLow: this.gasLow });
    if (r.status === 409) {
      this.conflict = true;
      this.stopped = true;
      this.log("同一执行身份已有别的实例在运行（executor_instance_conflict），本实例退出");
    }
    if (this.gasLow) this.log("执行身份 gas 低于阈值，停止领取", { gasBalanceWei: bal.toString() });
  }

  /** 一次 tick：领取 ≤ 1 个作业并处理完（串行）。返回处理结果；无作业 → null */
  async tick(): Promise<JobOutcome | null> {
    if (this.stopped || this.gasLow) return null;
    const r = await this.d.api.claim({ executor: this.address, instanceId: this.instanceId, max: 1 });
    if (r.status === 409) {
      this.conflict = true;
      this.stopped = true;
      return null;
    }
    if (r.status !== 200 || r.jobs.length === 0) return null;
    // 恢复作业优先（服务端已把它们排在最前）
    const job = r.jobs[0]!;
    try {
      if (job.recover) {
        // 恢复作业会被反复带回（SENT 要等服务端 6 确认才转 CONFIRMED）：每次处理后退避，避免 claim → receipt 的空转风暴
        const out = await this.recover(job);
        await this.sleep(RECOVER_BACKOFF_MS);
        return out;
      }
      return job.kind === "permit" ? await this.runPermit(job) : await this.runExecuteStep(job);
    } catch (e) {
      if (e instanceof InjectedFault) {
        this.log("故障注入：广播后人为断连，重启循环", { jobId: job.id });
        return "crashed";
      }
      throw e;
    }
  }

  async run(): Promise<void> {
    let lastBeat = 0;
    while (!this.stopped) {
      try {
        if (this.now() - lastBeat >= 30_000) {
          lastBeat = this.now();
          await this.heartbeat().catch((e) => this.log("心跳失败", { error: e instanceof Error ? e.message.slice(0, 200) : String(e) }));
        }
        const out = await this.tick();
        if (out === null) await this.sleep(1000);
      } catch (e) {
        this.log("循环出错，稍后重试", { error: e instanceof Error ? e.message.slice(0, 300) : String(e) });
        await this.sleep(2000);
      }
    }
  }

  private nowSec(): number {
    return Math.floor(this.now() / 1000);
  }
  private async ev(job: ClaimedJob, e: JobEvent) {
    return this.d.api.event(job.id, job.attempt, e);
  }

  /* ---------------- execute_step ---------------- */

  async runExecuteStep(job: ClaimedJob): Promise<JobOutcome> {
    const p = job.payload as ExecuteStepJobPayload;
    const ready = p.ready as unknown as ReadyStepBody;
    const fault = job.fault ?? p.fault ?? null;
    const local = checkReadyStep(ready, { chainId: this.d.chain.chainId, planGuard: this.d.planGuard, nowSec: this.nowSec(), minRemainingS: this.d.minCertRemainingS, expectedStepIndex: p.stepIndex, expectedOwner: job.owner });
    if (!local.ok) {
      await this.ev(job, { type: "preflight_failed", code: local.certRemainingLow && local.problems.length === 1 ? "cert_remaining_low" : "local_check_failed", detail: local.problems.join("; ").slice(0, 500) });
      return "preflight_failed";
    }
    const amountIn = BigInt(ready.step.amountIn);
    const inputToken = ready.mandate.inputToken as Hex;
    const owner = ready.mandate.owner as Hex;
    const st = await this.d.chain.mandateState(this.d.planGuard, local.mandateDigest);
    if (st.revoked) return this.fail(job, "mandate_revoked");
    if (st.steps !== Number(ready.step.stepIndex)) return this.fail(job, "step_index_mismatch", `chain steps ${st.steps} ≠ step ${ready.step.stepIndex}`);
    if ((await this.d.chain.allowance(inputToken, owner, this.d.planGuard)) < amountIn) return this.fail(job, "allowance_low");
    if ((await this.d.chain.balanceOf(inputToken, owner)) < amountIn) return this.fail(job, "balance_low");
    const tx = buildExecuteStepTx({ planGuard: this.d.planGuard, mandate: ready.mandate as unknown as Record<string, string>, mandateSignature: ready.mandateSignature, outputSet: local.outputSet, step: ready.step as unknown as Record<string, string>, certificate: ready.certificate as unknown as Record<string, string>, certificateSignature: ready.certificateSignature, routerCalldata: ready.routerCalldata });
    // 失败分类 wait_clock（§2.5）：链上时间还没到证书 issuedAt（链头时间戳落后于签发时钟几秒是常态）→ 等链上时钟追上再预检，不重签；三次仍失败才上报
    const issuedAt = Number(ready.certificate.issuedAt);
    await this.waitForChainClock(issuedAt);
    let signed: SignedTx | null = null;
    for (let tries = 1; !signed; tries++) {
      try {
        signed = await this.d.sender.sign(tx, { jobOwner: job.owner });
      } catch (e) {
        if (e instanceof WouldRevertError && e.revert.cls === "wait_clock" && tries < WAIT_CLOCK_TRIES) {
          this.log("链上时钟未到证书签发时间，等待后再预检（wait_clock）", { jobId: job.id, tries });
          await this.waitForChainClock(issuedAt + 1, true);
          continue;
        }
        if (e instanceof WouldRevertError) {
          await this.ev(job, { type: "preflight_failed", code: "would_revert", revert: { cls: e.revert.cls, error: e.revert.error, message: e.revert.message } });
          return "preflight_failed";
        }
        if (e instanceof ExecTxError) {
          await this.ev(job, { type: "preflight_failed", code: e.code, detail: e.message });
          return "preflight_failed";
        }
        throw e;
      }
    }
    // 故障 cert_void：等到证书剩余 < 门槛再走发送提交点 → 服务端拒绝并当场 EXPIRED
    const validUntil = Math.min(Number(ready.certificate.validUntil), Number(ready.step.deadline));
    if (fault?.kind === "cert_void") {
      const waitS = validUntil - this.d.minCertRemainingS + 1 - this.nowSec();
      if (waitS > 0) await this.sleep(waitS * 1000);
    }
    return this.commitAndSend(job, signed, validUntil, fault?.kind ?? null, fault?.delayS);
  }

  /** 等链头时间戳 ≥ target（每秒查一次，最多 WAIT_CLOCK_MAX_S 秒）；force = 至少等一次 */
  private async waitForChainClock(target: number, force = false): Promise<void> {
    const until = this.now() + WAIT_CLOCK_MAX_S * 1000;
    let first = true;
    for (;;) {
      const head = await this.d.chain.head().catch(() => null);
      if (head && Number(head.timestamp) >= target && !(force && first)) return;
      first = false;
      if (this.now() >= until) return;
      await this.sleep(1000);
    }
  }

  private async fail(job: ClaimedJob, code: string, detail?: string): Promise<JobOutcome> {
    await this.ev(job, { type: "preflight_failed", code, ...(detail ? { detail } : {}) });
    return "preflight_failed";
  }

  private async commitAndSend(job: ClaimedJob, signed: SignedTx, validUntilSec: number, fault: string | null, delayS?: number): Promise<JobOutcome> {
    const commit = await this.ev(job, { type: "sending", rawTxHash: signed.rawTxHash, nonce: String(signed.nonce), rawTx: signed.rawTx });
    if (commit.status !== 200) {
      this.d.sender.abandon(signed);
      this.log("发送提交点被拒，不广播", { jobId: job.id, status: commit.status, code: commit.body["code"] ?? commit.body["error"] });
      return "refused";
    }
    const txHash = await this.d.sender.broadcast(signed);
    if (fault === "rpc_timeout") throw new InjectedFault("rpc_timeout after broadcast");
    await this.ev(job, { type: "sent", txHash });
    if (fault === "receipt_delay") {
      // 广播后 delayS（缺省 90 s）内不报回执、不查回执：服务端闸门阻止重签，回执核实器自己确认
      await this.sleep((delayS ?? 90) * 1000);
    }
    return this.awaitReceipt(job, txHash, validUntilSec + 30);
  }

  private async awaitReceipt(job: ClaimedJob, txHash: Hex, untilSec: number): Promise<JobOutcome> {
    for (;;) {
      const r = await this.d.chain.getReceipt(txHash).catch(() => null);
      if (r) {
        await this.ev(job, { type: "receipt", txHash, status: r.status, blockNumber: r.blockNumber.toString(), approval: job.kind === "permit" ? approvalOf(r.logs, job) : null });
        return r.status === "success" ? "confirmed" : "reverted";
      }
      if (this.nowSec() > untilSec) return "sent";
      await this.sleep(2000);
    }
  }

  /* ---------------- permit ---------------- */

  async runPermit(job: ClaimedJob): Promise<JobOutcome> {
    const p = job.payload as PermitJobPayload;
    const token = p.token.toLowerCase() as Hex;
    if (BigInt(p.deadline) - BigInt(this.nowSec()) < 120n) return this.fail(job, "permit_deadline_near");
    const onchainNonce = await this.d.chain.nonces(token, p.owner);
    if (onchainNonce.toString() !== p.nonce) return this.fail(job, "permit_nonce_stale", `chain nonce ${onchainNonce} ≠ ${p.nonce}`);
    const tx = buildPermitTx({ token, owner: p.owner, spender: p.spender, value: BigInt(p.value), deadline: BigInt(p.deadline), signature: p.signature });
    try {
      await this.d.chain.call({ from: this.address, to: tx.to, data: tx.data });
    } catch (e) {
      return this.fail(job, "permit_would_revert", e instanceof Error ? e.message.split("\n")[0]!.slice(0, 200) : String(e));
    }
    let signed: SignedTx;
    try {
      signed = await this.d.sender.sign(tx, { jobOwner: job.owner });
    } catch (e) {
      if (e instanceof ExecTxError) return this.fail(job, e.code, e.message);
      throw e;
    }
    const fault = job.fault ?? p.fault ?? null;
    return this.commitAndSend(job, signed, Number(p.deadline), fault?.kind ?? null, fault?.delayS);
  }

  /* ---------------- 崩溃恢复 ---------------- */

  async recover(job: ClaimedJob): Promise<JobOutcome> {
    const hash = (job.txHash ?? job.rawTxHash) as Hex | null;
    const validUntil = job.validUntil ? Math.floor(Date.parse(job.validUntil) / 1000) : 0;
    if (hash) {
      const rcpt = await this.d.chain.getReceipt(hash).catch(() => null);
      const seen = rcpt !== null || (await this.d.chain.hasTransaction(hash).catch(() => false));
      if (seen) {
        if (job.state === "SENDING") await this.ev(job, { type: "sent", txHash: hash });
        if (rcpt) {
          await this.ev(job, { type: "receipt", txHash: hash, status: rcpt.status, blockNumber: rcpt.blockNumber.toString(), approval: job.kind === "permit" ? approvalOf(rcpt.logs, job) : null });
          return "recovered";
        }
        return this.awaitReceipt(job, hash, validUntil + 30);
      }
    }
    // 未见：证书仍有效且服务端同意（同一 rawTxHash 的 sending 重新确认）→ 原样重播 raw_tx
    if (job.state === "SENDING" && job.rawTx && job.rawTxHash && validUntil - this.nowSec() >= this.d.minCertRemainingS) {
      const ok = await this.ev(job, { type: "sending", rawTxHash: job.rawTxHash, nonce: null, rawTx: job.rawTx });
      if (ok.status === 200) {
        const txHash = await this.d.chain.sendRawTransaction(job.rawTx).catch(async (e: unknown) => ((await this.d.chain.hasTransaction(job.rawTxHash!).catch(() => false)) ? job.rawTxHash! : Promise.reject(e)));
        await this.ev(job, { type: "sent", txHash });
        return this.awaitReceipt(job, txHash, validUntil + 30);
      }
    }
    // 其余交给服务端对账器（reconcileStep：过了签名 validUntil + margin 且链上步序未动 → EXPIRED）
    return "waiting";
  }
}

function approvalOf(logs: Array<{ address: string; data: Hex; topics: Hex[] }>, job: ClaimedJob): { owner: string; spender: string; value: string } | null {
  for (const l of logs) {
    if (!job.token || l.address.toLowerCase() !== job.token.toLowerCase()) continue;
    try {
      const d = decodeEventLog({ abi: TOKEN_ABI, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
      if (d.eventName === "Approval") {
        const a = d.args as { owner: string; spender: string; value: bigint };
        return { owner: a.owner.toLowerCase(), spender: a.spender.toLowerCase(), value: a.value.toString() };
      }
    } catch {
      /* 其它事件 */
    }
  }
  return null;
}
