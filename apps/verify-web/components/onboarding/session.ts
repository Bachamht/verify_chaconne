"use client";

import { api } from "@/lib/api";
import { normalizeTask, type CreateTaskBody } from "@/lib/api-v2";
import { ONBOARDING_SNAPSHOT_PREFIX } from "@/lib/history";
import type { SimulationTask } from "./model";

type Response<T> = { status: number; data: T; headers: Headers };
const TASK_ID = /^tsk_[A-Za-z0-9_]+$/;

async function normalizedSimulation(response: Promise<Response<unknown>>): Promise<Response<SimulationTask>> {
  const result = await response;
  const raw = result.data;
  // Keep error bodies and malformed successes intact; the caller validates simulation mode.
  const data = result.status >= 200 && result.status < 300 && raw && typeof raw === "object" && !Array.isArray(raw)
    ? normalizeTask(raw as Record<string, unknown>)
    : raw;
  return { ...result, data: data as SimulationTask };
}

/** Omit both outgoing cookies and response Set-Cookie handling, preserving the existing workspace identity. */
export async function createOnboardingSimulation(request: CreateTaskBody): Promise<Response<SimulationTask>> {
  if (request.mode !== "SIMULATION") throw new Error("Onboarding requests must use SIMULATION mode");
  return normalizedSimulation(api("POST", "v1/tasks", request, {}, { credentials: "omit" }));
}

/** The existing proxy accepts the original owner as caller when there is no identity cookie. */
export async function getOnboardingSimulation(id: string, owner: string): Promise<Response<SimulationTask>> {
  if (!TASK_ID.test(id) || !/^0x[0-9a-fA-F]{40}$/.test(owner)) throw new Error("Invalid onboarding task identity");
  const query = new URLSearchParams({ owner });
  return normalizedSimulation(api("GET", `v1/tasks/${encodeURIComponent(id)}?${query}`, undefined, {}, { credentials: "omit" }));
}

/** Local restoration data is separate from task history and the LIVE draft handoff. */
export function saveOnboardingSnapshot(id: string, value: unknown): boolean {
  if (!TASK_ID.test(id)) return false;
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return false;
    const key = ONBOARDING_SNAPSHOT_PREFIX + id;
    localStorage.setItem(key, serialized);
    return localStorage.getItem(key) === serialized;
  } catch {
    return false;
  }
}

/** Stored content is untrusted and deliberately returned as unknown for the UI to validate. */
export function readOnboardingSnapshot(id: string): unknown | null {
  if (!TASK_ID.test(id)) return null;
  try {
    const serialized = localStorage.getItem(ONBOARDING_SNAPSHOT_PREFIX + id);
    return serialized === null ? null : JSON.parse(serialized) as unknown;
  } catch {
    return null;
  }
}
