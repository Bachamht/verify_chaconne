/**
 * v7 运营者面：一次性故障（D-095，只在 FAULT_INJECTION_ENABLED + 运营者 key 下可写）与完整性告警（integrity_alert）。
 * 故障只会造成延迟或过期，不能绕过任何核验；未挂故障时作业的 fault 恒为 null（测试断言故障分支不可达）。
 * 告警保留最近 200 条（进程内）；同时写日志，供 /v1/ops/status 与任务运行态 needsOperator。
 */
import { FAULT_KINDS, type FaultKind, type FaultSpec } from "@chaconne/core/verify";
import { log } from "../log";

export interface PendingFault extends FaultSpec {
  id: string;
  /** 只挂到这个任务的作业；null = 下一个匹配作业 */
  taskId: string | null;
  jobKind: "execute_step" | "permit" | null;
}
export interface IntegrityAlert {
  at: string;
  code: string;
  taskId: string | null;
  mandateId: string | null;
  detail: string;
}

export class OpsState {
  private faults: PendingFault[] = [];
  private alerts: IntegrityAlert[] = [];
  private seq = 0;
  constructor(private readonly now: () => Date = () => new Date()) {}

  addFault(a: { kind: FaultKind; taskId?: string | null; jobKind?: "execute_step" | "permit" | null; delayS?: number; by: string }): PendingFault {
    if (!(FAULT_KINDS as readonly string[]).includes(a.kind)) throw new Error("unknown fault kind");
    const f: PendingFault = { id: `flt_${++this.seq}`, kind: a.kind, taskId: a.taskId ?? null, jobKind: a.jobKind ?? null, ...(a.delayS !== undefined ? { delayS: a.delayS } : {}), createdAt: this.now().toISOString(), by: a.by };
    this.faults.push(f);
    return f;
  }
  /** 领取时取走第一个匹配的故障（一次性） */
  takeFault(job: { kind: string; taskId: string | null }): FaultSpec | null {
    const i = this.faults.findIndex((f) => (f.taskId === null || f.taskId === job.taskId) && (f.jobKind === null || f.jobKind === job.kind) && (f.kind !== "cert_void" || job.kind === "execute_step"));
    if (i < 0) return null;
    const [f] = this.faults.splice(i, 1);
    return { kind: f!.kind, ...(f!.delayS !== undefined ? { delayS: f!.delayS } : {}), createdAt: f!.createdAt, by: f!.by };
  }
  pendingFaults(): PendingFault[] {
    return [...this.faults];
  }
  alert(code: string, a: { taskId?: string | null; mandateId?: string | null; detail: string }): void {
    const x: IntegrityAlert = { at: this.now().toISOString(), code, taskId: a.taskId ?? null, mandateId: a.mandateId ?? null, detail: a.detail.slice(0, 500) };
    this.alerts.push(x);
    if (this.alerts.length > 200) this.alerts.splice(0, this.alerts.length - 200);
    log.error("integrity_alert", { code, taskId: x.taskId, mandateId: x.mandateId, detail: x.detail });
  }
  recentAlerts(taskId?: string): IntegrityAlert[] {
    return taskId ? this.alerts.filter((a) => a.taskId === taskId) : [...this.alerts];
  }
}
