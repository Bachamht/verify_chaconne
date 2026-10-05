import { describe, expect, it } from "vitest";
import type { AssetEntry } from "../lib/assets";
import { buildStartRequest, sameScope, type StartDraft } from "../components/onboarding/modelV7";
import { editJourney, emptyJourney, journeyKey, liveFromObservation, parseJourney, type StartJourney } from "../components/onboarding/journeyV7";
const owner = "0x00000000000000000000000000000000000000aa";
const stable: AssetEntry = { assetKey: "eip155:196:0x4ae46a509f6b1d9056937ba4500cb143933d2dc8", tokenAddress: "0x4ae46a509f6b1d9056937ba4500cb143933d2dc8", tokenDecimals: 6, displaySymbol: "USDG", role: "stable_input", executionAllowed: true, underlyingId: "fiat:USD" };
const draft: StartDraft = { objective: "观察宏观事件", strategy: "先等证据", assetKeys: ["eip155:196:0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a"], totalHuman: "10", perStepHuman: "2", maxSteps: 5, days: 7, allowSell: false, regularOnly: false, trustTier: "agent_data", watch: ["MACRO_TIER1"], exampleId: "macro_allocation" };
const deadline = "2030-01-10T00:00:00.000Z";
const body = buildStartRequest(draft, stable, owner, "SIMULATION", "web-start7-sim-test", deadline)!;
const attempt = { draft, stable, body };
const journey: StartJourney = { ...emptyJourney(owner), draft, observation: { ...attempt, id: "tsk_test" }, liveRequestId: "web-start7-live-test", liveId: "tsk_live" };

describe("v7 journey recovery and live scope", () => {
  it("restores the original observation and live destination on refresh", () => {
    expect(parseJourney(JSON.stringify(journey), owner)).toEqual(journey);
  });
  it("restores a pending request's exact id and deadline for an idempotent retry", () => {
    const pending = { ...emptyJourney(owner), draft, attempt };
    expect(parseJourney(JSON.stringify(pending), owner)?.attempt?.body).toEqual(body);
  });
  it("isolates wallet records and rejects another wallet's persisted request", () => {
    const other = owner.slice(0, -2) + "bb";
    expect(journeyKey(owner)).not.toBe(journeyKey(other));
    expect(parseJourney(JSON.stringify(journey), other)).toBeNull();
    expect(parseJourney(JSON.stringify({ ...journey, observation: { ...journey.observation, body: { ...body, ownerAddress: other } } }), owner)).toBeNull();
  });
  it("ignores malformed, partial, and tampered stored requests", () => {
    for (const raw of ["{", "null", "{}", JSON.stringify({ ...journey, observation: { ...attempt, id: "../escape" } }), JSON.stringify({ ...journey, observation: { ...journey.observation, body: { ...body, mode: "LIVE" } } }), JSON.stringify({ ...journey, observation: { ...journey.observation, body: { ...body, scope: { ...body.scope, budgetCapRaw: "999999999" } } } })]) {
      expect(parseJourney(raw, owner)).toBeNull();
    }
  });
  it("editing clears old requests and tasks so a new goal cannot reuse an old authorization", () => {
    const changed = { ...draft, totalHuman: "20" };
    const next = editJourney({ ...journey, attempt }, changed, 2);
    expect(next).toMatchObject({ draft: changed, template: 2, attempt: null, observation: null, liveRequestId: null, liveId: null });
    expect(journey.liveId).toBe("tsk_live");
  });
  it("live promotion retains the observed scope including its original expiry", () => {
    const live = liveFromObservation(body, "web-start7-live", Date.parse("2030-01-05"))!;
    expect(sameScope(body, live)).toBe(true);
    expect(live.scope?.deadline).toBe(deadline);
    expect(live.mode).toBe("LIVE");
    expect(live.executor?.mode).toBe("hosted");
    expect(body.executor).toBeUndefined();
  });
  it("expired observation cannot silently get a longer live scope", () => {
    expect(liveFromObservation(body, "new", Date.parse(deadline))).toBeNull();
    expect(liveFromObservation({ ...body, scope: { ...body.scope, deadline: "bad" } }, "new")).toBeNull();
  });
});
