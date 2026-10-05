/**
 * 串行 nonce 管理（一个执行身份一个实例；执行进程严格串行，不并发签名）：
 * 启动时取 pending nonce；每签一笔 +1；广播遇「nonce too low」即重同步；放弃一笔已签未广播的交易时回退。
 */
export interface NonceSource {
  pendingNonce(): Promise<number>;
}

export class SerialNonceManager {
  private next: number | null = null;
  constructor(private readonly src: NonceSource) {}
  async sync(): Promise<number> {
    this.next = await this.src.pendingNonce();
    return this.next;
  }
  /** 取下一个 nonce（首次自动同步） */
  async take(): Promise<number> {
    if (this.next === null) await this.sync();
    const n = this.next!;
    this.next = n + 1;
    return n;
  }
  /** 已签名但确定没有广播：退回这个 nonce（只允许退回最近一个） */
  release(n: number): void {
    if (this.next !== null && this.next === n + 1) this.next = n;
  }
  peek(): number | null {
    return this.next;
  }
}
