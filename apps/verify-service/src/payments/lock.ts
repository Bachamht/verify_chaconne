/**
 * 进程内按键互斥（FIX-087）：同一订单的 验证→登记→结算→落库→交付 串行化。
 * 单进程部署（systemd 单实例）足够；多实例时需再加 DB 行锁（SELECT … FOR UPDATE），此处留接口。
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => mine);
    this.tails.set(key, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  /** 测试用：当前有多少键被占用 */
  get size(): number {
    return this.tails.size;
  }
}
