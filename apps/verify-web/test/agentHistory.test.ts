import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentTaskHistory, clearHistory, forget, history, hrefFor, isAgentTask, remember, type HistoryItem } from "../lib/history";
import { readOnboardingSnapshot, saveOnboardingSnapshot } from "../components/onboarding/session";

const item = (kind: HistoryItem["kind"], id: string): HistoryItem => ({ kind, id, title: id, createdAt: "2026-09-25T01:00:00.000Z" });
let data: Map<string, string>;

beforeEach(() => {
  data = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
    removeItem: (key: string) => data.delete(key),
  });
  vi.stubGlobal("window", { dispatchEvent: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());

describe("本机任务回访与老记录兼容", () => {
  it("v6 新任务和旧误标记录都打开 agent 详情；老授权和其它核验仍去原路由", () => {
    expect(hrefFor(item("agent_task", "tsk_new"))).toBe("/agent/tasks/tsk_new");
    expect(hrefFor({ ...item("agent_task", "tsk_guided"), isolatedSimulation: true })).toBe("/start?task=tsk_guided");
    expect(hrefFor(item("mandate", "tsk_old"))).toBe("/agent/tasks/tsk_old");
    expect(hrefFor(item("mandate", "mnd_old"))).toBe("/tasks/mnd_old");
    expect(hrefFor(item("job", "job_old"))).toBe("/jobs/job_old");
    expect(hrefFor(item("plan", "pln_old"))).toBe("/plan?plan=pln_old");
    expect(hrefFor(item("simulation", "sim_old"))).toBe("/play?simulation=sim_old");
    expect(isAgentTask(item("job", "tsk_unrelated"))).toBe(false);
  });

  it("筛选本机 agent 任务并去掉重复显示，不改写、迁移或删除旧存储", () => {
    const legacy = item("mandate", "tsk_shared");
    const original = JSON.stringify([item("agent_task", "tsk_shared"), item("mandate", "mnd_old"), legacy, item("simulation", "sim_old"), item("mandate", "tsk_older")]);
    data.set("verify_history_v1", original);
    expect(agentTaskHistory().map((x) => x.id)).toEqual(["tsk_shared", "tsk_older"]);
    expect(data.get("verify_history_v1")).toBe(original);
    expect(history()).toHaveLength(5);
  });

  it("保存新记录会发出本机刷新事件，同时保留已有授权和旧任务记录", () => {
    const old = [item("mandate", "tsk_old"), item("mandate", "mnd_old")];
    data.set("verify_history_v1", JSON.stringify(old));
    remember(item("agent_task", "tsk_new"));
    expect(history()).toEqual([item("agent_task", "tsk_new"), ...old]);
    expect(window.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "verify:history" }));
  });

  it("浏览器禁止存储时返回空记录，不阻碍用户继续体验", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("unavailable"); }, setItem: () => { throw new Error("unavailable"); } });
    expect(agentTaskHistory()).toEqual([]);
    expect(() => remember(item("agent_task", "tsk_new"))).not.toThrow();
  });

  it("忘记隔离模拟时删除对应快照，并保留其他任务、快照与真实任务草稿", () => {
    const isolated = { ...item("agent_task", "tsk_guided"), isolatedSimulation: true };
    const other = { ...item("agent_task", "tsk_other"), isolatedSimulation: true };
    const old = item("mandate", "mnd_existing");
    data.set("verify_history_v1", JSON.stringify([isolated, other, old]));
    data.set("verify_task_draft_v1", "live draft");
    saveOnboardingSnapshot(isolated.id, { privatePlan: "first" });
    saveOnboardingSnapshot(other.id, { privatePlan: "second" });

    forget(isolated.kind, isolated.id);

    expect(readOnboardingSnapshot(isolated.id)).toBeNull();
    expect(readOnboardingSnapshot(other.id)).toEqual({ privatePlan: "second" });
    expect(history()).toEqual([other, old]);
    expect(data.get("verify_task_draft_v1")).toBe("live draft");
    expect(window.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "verify:history" }));
  });

  it("删除普通记录或不存在的记录不误删同 id 的隔离模拟快照", () => {
    const isolated = { ...item("agent_task", "tsk_guided"), isolatedSimulation: true };
    const ordinary = item("mandate", "tsk_guided");
    data.set("verify_history_v1", JSON.stringify([ordinary, isolated]));
    saveOnboardingSnapshot(isolated.id, { keep: true });

    forget(ordinary.kind, ordinary.id);
    forget("job", isolated.id);

    expect(history()).toEqual([isolated]);
    expect(readOnboardingSnapshot(isolated.id)).toEqual({ keep: true });
  });

  it("清空记录只删除其中隔离模拟的快照，不清扫其他本机数据", () => {
    const first = { ...item("agent_task", "tsk_first"), isolatedSimulation: true };
    const second = { ...item("agent_task", "tsk_second"), isolatedSimulation: true };
    const old = item("mandate", "mnd_existing");
    data.set("verify_history_v1", JSON.stringify([first, second, old]));
    data.set("verify_task_draft_v1", "live draft");
    data.set("verify_assets_cache_v1", "asset cache");
    saveOnboardingSnapshot(first.id, { value: "first" });
    saveOnboardingSnapshot(second.id, { value: "second" });
    saveOnboardingSnapshot("tsk_unlisted", { untouched: true });

    clearHistory();

    expect(history()).toEqual([]);
    expect(data.has("verify_history_v1")).toBe(false);
    expect(readOnboardingSnapshot(first.id)).toBeNull();
    expect(readOnboardingSnapshot(second.id)).toBeNull();
    expect(readOnboardingSnapshot("tsk_unlisted")).toEqual({ untouched: true });
    expect(data.get("verify_task_draft_v1")).toBe("live draft");
    expect(data.get("verify_assets_cache_v1")).toBe("asset cache");
    expect(window.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "verify:history" }));
  });
});
