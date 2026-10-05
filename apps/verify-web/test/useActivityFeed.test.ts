import { describe, expect, it, vi } from "vitest";
import type { ActivityItem, ActivityPage } from "../lib/api-v2";
import { fxRuntime } from "../lib/v7fixtures";
import { createActivityFeedCoordinator } from "../components/agent/tasks/v7/useActivityFeed";

type Response = { status: number; data: ActivityPage };
type Snapshot = ReturnType<ReturnType<typeof createActivityFeedCoordinator>["visible"]>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const item = (id: string): ActivityItem => ({ id, at: "2026-10-03T00:00:00.000Z", actor: "system", type: "waiting" });
const page = (id: string, nextCursor: string | number | null = id, runtime: ActivityPage["runtime"] = fxRuntime("waiting")): Response => ({ status: 200, data: { items: [item(id)], nextCursor, runtime } });

describe("活动流会话隔离（真实异步完成顺序，无 DOM）", () => {
  it.each(["success", "503", "network"] as const)("切到 B 后，A 的迟到 %s 不得提交活动、runtime 或错误状态", async (outcome) => {
    const a = deferred<Response>();
    const b = deferred<Response>();
    const load = vi.fn((_id: string, _cursor: string | number | null) => a.promise).mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise).mockResolvedValue(page("22"));
    const feed = createActivityFeedCoordinator(load);
    const publish = vi.fn<(value: Snapshot) => void>();
    feed.start({ taskId: "A" }, publish);
    const oldRequest = feed.pull(publish.mock.lastCall![0].key);
    const newRuntime = fxRuntime("working", "SIMULATION");
    feed.start({ taskId: "B", initialRuntime: newRuntime }, publish);
    const key = publish.mock.lastCall![0].key;
    const newRequest = feed.pull(key);
    b.resolve(page("21", "cursor-B", newRuntime));
    await newRequest;
    const committed = publish.mock.lastCall![0];
    const commits = publish.mock.calls.length;
    if (outcome === "network") a.reject(new Error("old network failure"));
    else a.resolve(outcome === "success" ? page("old-A", "wrong-cursor", fxRuntime("awaiting_fill")) : { status: 503, data: { items: [], nextCursor: null } });
    await oldRequest;
    expect(publish).toHaveBeenCalledTimes(commits);
    expect(publish.mock.lastCall![0]).toBe(committed);
    expect(committed).toMatchObject({ items: [item("21")], runtime: newRuntime, status: "ok", http: 200 });
    await feed.pull(key);
    expect(load).toHaveBeenLastCalledWith("B", "cursor-B");
  });

  it("切任务首帧清空旧活动、错误和游标；新任务使用自己的初始运行态", async () => {
    const load = vi.fn<(id: string, cursor: string | number | null) => Promise<Response>>()
      .mockResolvedValueOnce(page("10", "cursor-A"))
      .mockResolvedValueOnce({ status: 503, data: { items: [], nextCursor: null } })
      .mockResolvedValueOnce(page("1", null))
      .mockResolvedValueOnce(page("2"));
    const feed = createActivityFeedCoordinator(load);
    const publish = vi.fn<(value: Snapshot) => void>();
    feed.start({ taskId: "A" }, publish);
    const keyA = publish.mock.lastCall![0].key;
    await feed.pull(keyA);
    await feed.pull(keyA);
    const old = publish.mock.lastCall![0];
    expect(old).toMatchObject({ status: "nr", http: 503 });
    const inputB = { taskId: "B", initialRuntime: fxRuntime("working") };
    // 与 hook 相同的可见值选择：在 effect/start 尚未运行时也不能显示 A。
    expect(feed.visible(inputB, old)).toMatchObject({ items: [], runtime: inputB.initialRuntime, status: "busy", http: 0 });
    expect(feed.visible({ taskId: "C" }, old)).toMatchObject({ items: [], runtime: null, status: "busy", http: 0 });
    feed.start(inputB, publish);
    const keyB = publish.mock.lastCall![0].key;
    await feed.pull(keyB);
    expect(load).toHaveBeenLastCalledWith("B", null);
    await feed.pull(keyB);
    expect(load).toHaveBeenLastCalledWith("B", "1"); // nextCursor 缺失时用本页末项
    expect(publish.mock.lastCall![0].items.map((x) => x.id)).toEqual(["1", "2"]);
  });

  it("A → B → A 也不能接收第一次 A 的请求；旧清理函数不能停掉新会话", async () => {
    const old = deferred<Response>();
    const load = vi.fn<(id: string, cursor: string | number | null) => Promise<Response>>()
      .mockReturnValueOnce(old.promise).mockResolvedValue(page("fresh"));
    const feed = createActivityFeedCoordinator(load);
    const publish = vi.fn<(value: Snapshot) => void>();
    const disposeA = feed.start({ taskId: "A" }, publish);
    const key = publish.mock.lastCall![0].key;
    const request = feed.pull(key);
    feed.start({ taskId: "B" }, publish);
    feed.start({ taskId: "A" }, publish);
    disposeA();
    await feed.pull(key);
    expect(load).toHaveBeenLastCalledWith("A", null);
    const commits = publish.mock.calls.length;
    old.resolve(page("stale"));
    await request;
    expect(publish).toHaveBeenCalledTimes(commits);
    expect(publish.mock.lastCall![0].items.map((x) => x.id)).toEqual(["fresh"]);
  });

  it("同会话刷新复用在途请求；invalidate 后完成的请求不得发布或继续发起请求", async () => {
    const pending = deferred<Response>();
    const load = vi.fn((_id: string, _cursor: string | number | null) => pending.promise);
    const feed = createActivityFeedCoordinator(load);
    const publish = vi.fn<(value: Snapshot) => void>();
    const invalidate = feed.start({ taskId: "A" }, publish);
    const key = publish.mock.lastCall![0].key;
    const first = feed.pull(key);
    expect(feed.pull(key)).toBe(first);
    expect(load).toHaveBeenCalledTimes(1);
    invalidate();
    pending.resolve(page("late"));
    await first;
    await feed.pull(key);
    expect(publish).toHaveBeenCalledTimes(1); // 只有初始状态
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("fixture、LIVE/SIMULATION 和 disabled 切换均隔离；fixture 不发真实请求", async () => {
    const pending = deferred<Response>();
    const load = vi.fn<(id: string, cursor: string | number | null) => Promise<Response>>()
      .mockReturnValueOnce(pending.promise).mockResolvedValue(page("real"));
    const feed = createActivityFeedCoordinator(load);
    const publish = vi.fn<(value: Snapshot) => void>();
    feed.start({ taskId: "A", mode: "LIVE" }, publish);
    const request = feed.pull(publish.mock.lastCall![0].key);
    const fixture = { taskId: "A", mode: "SIMULATION" as const, fixture: true };
    const firstFixture = feed.visible(fixture, publish.mock.lastCall![0]);
    expect(firstFixture.status).toBe("ok");
    expect(firstFixture.runtime?.executorMode).toBeNull();
    expect(firstFixture.items.some((x) => x.type === "job.confirmed")).toBe(false);
    feed.start(fixture, publish);
    await feed.pull(publish.mock.lastCall![0].key);
    pending.resolve(page("stale-live"));
    await request;
    expect(load).toHaveBeenCalledTimes(1);
    expect(publish.mock.lastCall![0].items.some((x) => x.id === "stale-live")).toBe(false);
    const live = { taskId: "A", mode: "LIVE" as const };
    expect(feed.visible(live, publish.mock.lastCall![0])).toMatchObject({ items: [], runtime: null, status: "busy", http: 0 });
    feed.start(live, publish);
    await feed.pull(publish.mock.lastCall![0].key);
    expect(load).toHaveBeenLastCalledWith("A", null);
    const sim = { taskId: "A", mode: "SIMULATION" as const };
    expect(feed.visible(sim, publish.mock.lastCall![0])).toMatchObject({ items: [], runtime: null, status: "busy", http: 0 });
    feed.start(sim, publish);
    await feed.pull(publish.mock.lastCall![0].key);
    expect(load).toHaveBeenLastCalledWith("A", null);
    feed.start({ ...sim, enabled: false }, publish);
    await feed.pull(publish.mock.lastCall![0].key);
    expect(load).toHaveBeenCalledTimes(3);
    expect(publish.mock.lastCall![0]).toMatchObject({ items: [], status: "busy", http: 0 });
  });

  it("服务返回 runtime:null 时清除初始运行态，之后的 prop seed 不得伪装成最新运行态", async () => {
    const feed = createActivityFeedCoordinator(async () => page("1", 0, null));
    const publish = vi.fn<(value: Snapshot) => void>();
    feed.start({ taskId: "A", initialRuntime: fxRuntime("working") }, publish);
    const key = publish.mock.lastCall![0].key;
    await feed.pull(key);
    feed.seed(key, fxRuntime("waiting"));
    expect(publish.mock.lastCall![0].runtime).toBeNull();
  });
});
