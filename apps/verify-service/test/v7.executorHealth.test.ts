/** /healthz executor 段（§12.15）：最近一次心跳的执行身份；无心跳 → 未知 */
import { describe, expect, it } from "vitest";
import { executorHealth } from "../src/execution/health";

describe("executorHealth", () => {
  it("无心跳 → address / gasOk / lastHeartbeatAt 为 null", () => {
    expect(executorHealth(true, [], () => false)).toEqual({ enabled: true, address: null, gasOk: null, lastHeartbeatAt: null });
    expect(executorHealth(false, [{ executor: "0xaa", lastHeartbeatAt: null }], () => false)).toEqual({ enabled: false, address: null, gasOk: null, lastHeartbeatAt: null });
  });
  it("取最近一次心跳的地址；gasOk = 未报 gasLow", () => {
    const st = [
      { executor: "0xAAAA000000000000000000000000000000000001", lastHeartbeatAt: new Date("2026-10-02T01:00:00Z") },
      { executor: "0xBBBB000000000000000000000000000000000002", lastHeartbeatAt: new Date("2026-10-02T02:00:00Z") },
    ];
    expect(executorHealth(true, st, () => false)).toEqual({ enabled: true, address: "0xbbbb000000000000000000000000000000000002", gasOk: true, lastHeartbeatAt: "2026-10-02T02:00:00.000Z" });
    expect(executorHealth(true, st, (e) => e.toLowerCase().startsWith("0xbbbb")).gasOk).toBe(false);
  });
});
