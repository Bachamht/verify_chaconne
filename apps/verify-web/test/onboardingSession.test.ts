import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import { agentTasks, type CreateTaskBody } from "../lib/api-v2";
import { createOnboardingSimulation, getOnboardingSimulation, readOnboardingSnapshot, saveOnboardingSnapshot } from "../components/onboarding/session";

const owner = "0x0000000000000000000000000000000000000001";
const request: CreateTaskBody = { clientRequestId: "start-test", ownerAddress: owner, playbookId: "session_dca", mode: "SIMULATION", params: { steps: 3, perStepAmountRaw: "10000000" }, conditions: { version: "conditions/1", items: [] } };
const rawTask = { mode: "SIMULATION", task: { id: "tsk_start", status: "ACTIVE", conditions: { items: [] } }, lastEvaluation: { outcome: "SATISFIED", simulation: { wouldIssue: true } } };
const fetchMock = vi.fn<typeof fetch>();
let storage: Map<string, string>;

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response(JSON.stringify(rawTask), { status: 201, headers: { "x-test": "preserved" } }));
  vi.stubGlobal("fetch", fetchMock);
  storage = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("Onboarding simulation identity isolation", () => {
  it("creates simulations without sending or accepting identity cookies and preserves the request", async () => {
    const response = await createOnboardingSimulation(request);
    expect(fetchMock).toHaveBeenCalledWith("/api/verify/v1/tasks", expect.objectContaining({ method: "POST", credentials: "omit", body: JSON.stringify(request) }));
    expect(response.status).toBe(201);
    expect(response.headers.get("x-test")).toBe("preserved");
    expect(response.data).toMatchObject({ ...rawTask, task: { ...rawTask.task, blockers: [], mandateIds: [], executorPresence: "offline", nextCheckAt: null }, mandateDraft: null });
  });

  it("reads a saved simulation under its original owner without the workspace cookie", async () => {
    await getOnboardingSimulation("tsk_start", owner);
    expect(fetchMock).toHaveBeenCalledWith(`/api/verify/v1/tasks/tsk_start?owner=${owner}`, expect.objectContaining({ method: "GET", credentials: "omit", body: undefined }));
  });

  it("leaves existing api and agentTasks calls on their original same-origin cookie behavior", async () => {
    await api("GET", "v1/assets");
    await agentTasks.create({ ...request, mode: "LIVE" });
    await agentTasks.get("tsk_existing");
    expect(fetchMock.mock.calls.map(([, options]) => options?.credentials)).toEqual(["same-origin", "same-origin", "same-origin"]);
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ ...request, mode: "LIVE" }));
    expect(fetchMock.mock.calls[2]?.[0]).toBe("/api/verify/v1/tasks/tsk_existing");
  });

  it("preserves API failure details instead of manufacturing a task", async () => {
    const error = { error: "task_forbidden", message: "wrong owner" };
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(error), { status: 403 }));
    const response = await getOnboardingSimulation("tsk_start", owner);
    expect(response.status).toBe(403);
    expect(response.data).toEqual(error);
  });

  it("does not hide network failures or invent simulation mode for an unexpected response", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("network unavailable"));
    const failure = await createOnboardingSimulation(request);
    expect(failure).toMatchObject({ status: 0, data: { error: "service_unreachable" } });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ task: rawTask.task, mode: "LIVE" }), { status: 200 }));
    expect((await getOnboardingSimulation("tsk_start", owner)).data.mode).toBe("LIVE");
  });

  it("rejects LIVE creation and malformed retrieval identities before making a request", async () => {
    await expect(createOnboardingSimulation({ ...request, mode: "LIVE" })).rejects.toThrow("SIMULATION");
    await expect(getOnboardingSimulation("tsk_start?owner=other", owner)).rejects.toThrow("identity");
    await expect(getOnboardingSimulation("tsk_start", "not-an-address")).rejects.toThrow("identity");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Local onboarding restoration snapshots", () => {
  it("round-trips the request, assets and template independently for each task without touching other storage", () => {
    storage.set("verify_history_v1", "existing history");
    storage.set("verify_task_draft_v1", "existing live draft");
    const snapshot = { view: rawTask, request, stock: { assetKey: "stock" }, stable: { tokenDecimals: 6 }, sample: { steps: 3, conditions: [{ type: "session", allow: ["US_REGULAR"] }] } };
    expect(saveOnboardingSnapshot("tsk_start", snapshot)).toBe(true);
    expect(saveOnboardingSnapshot("tsk_other", { request: { ...request, clientRequestId: "second" } })).toBe(true);
    expect(readOnboardingSnapshot("tsk_start")).toEqual(snapshot);
    expect(readOnboardingSnapshot("tsk_other")).toEqual({ request: { ...request, clientRequestId: "second" } });
    expect(storage.get("verify_history_v1")).toBe("existing history");
    expect(storage.get("verify_task_draft_v1")).toBe("existing live draft");
    expect(readOnboardingSnapshot("tsk_missing")).toBeNull();
  });

  it("returns failure when storage is blocked or a browser silently drops the write", () => {
    vi.stubGlobal("localStorage", { setItem: () => { throw new Error("quota"); }, getItem: () => { throw new Error("denied"); } });
    expect(saveOnboardingSnapshot("tsk_start", rawTask)).toBe(false);
    expect(readOnboardingSnapshot("tsk_start")).toBeNull();
    vi.stubGlobal("localStorage", { setItem: () => undefined, getItem: () => null });
    expect(saveOnboardingSnapshot("tsk_start", rawTask)).toBe(false);
  });

  it("handles corrupted, non-serializable, or invalid-identity snapshots without throwing", () => {
    storage.set("verify_onboarding_snapshot_v1:tsk_corrupt", "{bad-json");
    expect(readOnboardingSnapshot("tsk_corrupt")).toBeNull();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(saveOnboardingSnapshot("tsk_start", circular)).toBe(false);
    expect(saveOnboardingSnapshot("tsk_start", undefined)).toBe(false);
    expect(saveOnboardingSnapshot("../other", rawTask)).toBe(false);
    expect(readOnboardingSnapshot("../other")).toBeNull();
  });
});
