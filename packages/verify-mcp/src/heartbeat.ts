/**
 * agent-wallet 执行器心跳（interfaces §11.5 / §11.7）：每 60 s 对本进程正在执行的授权计划
 * POST /v1/mandates/:id/executor/heartbeat → 服务端据此把 executorPresence 标为 online（3 分钟内有心跳）。
 * 只在 agent-wallet 模式启动；心跳不携带任何权限（D-087），只是"我在线"。日志只走 stderr。
 */
import type { VerifyClient } from "./client";

export const HEARTBEAT_INTERVAL_MS = 60_000;

export class ExecutorHeartbeat {
  private readonly ids = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  readonly sent: Array<{ mandateId: string; status: number; at: string }> = [];
  constructor(
    private readonly client: VerifyClient,
    private readonly executor: string,
    private readonly intervalMs = HEARTBEAT_INTERVAL_MS,
    private readonly log: (msg: string) => void = (m) => console.error(`[chaconne-verify-mcp] ${m}`),
  ) {}

  get watching(): string[] {
    return [...this.ids];
  }
  watch(mandateId: string): void {
    if (!mandateId) return;
    this.ids.add(mandateId);
    if (this.timer) void this.beat(mandateId);
  }
  unwatch(mandateId: string): void {
    this.ids.delete(mandateId);
  }
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    // 不阻止进程退出（stdio 关闭即退出）
    (this.timer as { unref?: () => void }).unref?.();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  async tick(): Promise<void> {
    for (const id of this.ids) await this.beat(id);
  }
  /** 单次心跳；404/501/503 = 服务端尚未提供该端点，记录但不重试风暴（下一轮再试） */
  async beat(mandateId: string): Promise<{ status: number; notAvailable: boolean }> {
    try {
      const r = await this.client.call("POST", `/v1/mandates/${mandateId}/executor/heartbeat`, { executor: this.executor, at: new Date().toISOString() });
      this.sent.push({ mandateId, status: r.status, at: new Date().toISOString() });
      const notAvailable = r.status === 404 || r.status === 501 || r.status === 503;
      if (notAvailable) this.log(`heartbeat ${mandateId}: endpoint not available (${r.status})`);
      if (r.status === 404 && (r.body as { error?: string } | null)?.error === "mandate_not_found") this.unwatch(mandateId);
      return { status: r.status, notAvailable };
    } catch (e) {
      this.log(`heartbeat ${mandateId} failed: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`);
      return { status: 0, notAvailable: true };
    }
  }
}
