/**
 * TaskReader 实现：
 *  - `nullTaskReader`：Lane B 的任务表落地前的生产缺省（一切任务 404，不伪装）；
 *  - `InMemoryTaskReader`：测试 / 本地演示；合并后由 Lane B 用 verify_tasks + 最近一次评估（含证据、上下文、事件版本）实现同一接口。
 */
import type { LabTaskRecord, TaskReader } from "@chaconne/core/verify";

export const nullTaskReader: TaskReader = { readTask: async () => null };

export class InMemoryTaskReader implements TaskReader {
  private readonly map = new Map<string, LabTaskRecord>();
  put(rec: LabTaskRecord): this {
    this.map.set(rec.task.id, rec);
    return this;
  }
  async readTask(taskId: string): Promise<LabTaskRecord | null> {
    const rec = this.map.get(taskId);
    // 返回深拷贝：调用方拿到的对象改了也不影响"真实任务"（L-02 断言真实任务不变）
    return rec ? (JSON.parse(JSON.stringify(rec)) as LabTaskRecord) : null;
  }
  /** 测试用：读原始对象（判断是否被改动） */
  raw(taskId: string): LabTaskRecord | undefined {
    return this.map.get(taskId);
  }
}
