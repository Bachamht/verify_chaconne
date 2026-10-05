/** v7 Lane A 测试基建：在 createTestEnv 的同一套服务上再起一个挂了 v7.a（托管 Agent 运行时）的 app，并给出服务 key / 托管任务 / 领取轮次的捷径 */
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import type { Express } from "express";
import { eq } from "drizzle-orm";
import { verifyTasks } from "@chaconne/db";
import { createApp } from "../src/http/app";
import { ApiKeysService } from "../src/keys/service";
import { loadPlaybooks } from "../src/tasks/playbooks";
import { AgentRuntime, type AgentRuntimeProviders, type ClaimedRun } from "../src/agent/service";
import type { EvidenceProvider } from "../src/evidence/provider";
import { FIXTURE_STOCK_KEY } from "@chaconne/core/verify/fixtures";
import { createTestEnv, TEST_API_KEY, type TestEnv, type TestEnvOptions } from "./helpers";

export const AGENT_KEY = "svc-agent-test-key-0123456789abcdef0123456789";
export const EXEC_KEY = "svc-exec-test-key-0123456789abcdef0123456789ab";
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const STOCK = FIXTURE_STOCK_KEY;
export const OWNER_ADDR = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";

export interface V7AEnv extends TestEnv {
  app: Express;
  url: string;
  baseUrl: string;
  runtime: AgentRuntime;
  close(): Promise<void>;
}

export async function createV7AEnv(opts: TestEnvOptions & { prices?: boolean; hostedAgent?: boolean; providers?: AgentRuntimeProviders } = {}): Promise<V7AEnv> {
  const prices = opts.prices ?? true;
  const env = await createTestEnv({
    wire: "production",
    ...opts,
    env: {
      HOSTED_AGENT_ENABLED: opts.hostedAgent === false ? "false" : "true",
      VERIFY_HOSTED_AGENT_KEY_SHA256: sha256(AGENT_KEY),
      VERIFY_EXECUTOR_KEY_SHA256: sha256(EXEC_KEY),
      ...(prices ? { AGENT_PRICE_INPUT_PER_MTOK_USD: "3", AGENT_PRICE_OUTPUT_PER_MTOK_USD: "15", AGENT_PRICE_CACHE_READ_PER_MTOK_USD: "0.3" } : {}),
      AGENT_MIN_RUN_INTERVAL_S: "600",
      ...(opts.env ?? {}),
    },
  });
  const now = () => new Date(env.cfgNow());
  const evidence = (env.service as unknown as { d: { evidence: EvidenceProvider } }).d.evidence;
  const runtime = new AgentRuntime({ db: env.db, cfg: env.cfg, tasks: env.tasks, theses: env.theses, context: env.context, evidence, registry: env.service.registry, notifier: env.notifier, operatorAlert: (c, t) => env.notify.operatorAlert(c, t), providers: opts.providers, now });
  const app = createApp({ cfg: env.cfg, service: env.service, keys: new ApiKeysService({ db: env.db, now }), paywall: env.paywall, plans: env.plans, mandates: env.mandates, club: env.club, signer: env.signer, market: null, context: env.context, crowsnest: env.crowsnest, events: env.events, tasks: env.tasks, theses: env.theses, playbooks: loadPlaybooks(), laneD: env.laneD, budget: env.budget, portfolio: env.portfolio, rebalance: env.rebalance, notify: env.notify, lab: env.lab, recaps: env.recaps, now, health: () => ({}), v7: { a: { runtime } } });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", () => r()));
  const { port } = server.address() as AddressInfo;
  const baseUrl = env.url;
  return {
    ...env,
    app,
    baseUrl,
    url: `http://127.0.0.1:${port}`,
    runtime,
    close: async () => {
      runtime.stop();
      await new Promise<void>((r) => server.close(() => r()));
      await env.close();
    },
  };
}

export async function call(env: { url: string }, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(env.url + path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

export const asOwner = (extra: Record<string, string> = {}) => ({ "x-api-key": TEST_API_KEY, ...extra });
export const asAgent = (token?: string) => ({ "x-api-key": AGENT_KEY, ...(token ? { "x-agent-run-token": token } : {}) });
export const asExecutor = () => ({ "x-api-key": EXEC_KEY });

/** 建一个目标式 SIMULATION 任务（Lane X 合并前没有 agent:{mode}，这里直接把 agent_mode 置为 hosted） */
export async function hostedTask(env: V7AEnv, crid: string, opts: { hosted?: boolean; strategy?: string } = {}): Promise<string> {
  const r = await call(env, "POST", "/v1/tasks", { clientRequestId: crid, ownerAddress: OWNER_ADDR, mode: "SIMULATION", strategy: opts.strategy ?? "buy on dips inside the scope", scope: { objective: "accumulate on weakness", outputAssetKeys: [STOCK], budgetCapRaw: "50000000", perStepCapRaw: "10000000", maxSteps: 5 } }, asOwner());
  if (r.status !== 201) throw new Error(`create task failed ${r.status} ${JSON.stringify(r.json)}`);
  const id = String((r.json["task"] as { id: string }).id);
  if (opts.hosted !== false) await env.db.update(verifyTasks).set({ agentMode: "hosted" }).where(eq(verifyTasks.id, id));
  return id;
}

/** 给任务开一个可领取的轮次并由托管 Agent 领取 */
export async function claimFor(env: V7AEnv, taskId: string, reason: "assigned" | "scheduled" | "data_arrived" | "execution_failed" = "assigned", trigger = `t:${Math.random()}`): Promise<ClaimedRun> {
  await env.tasks.openAgentTurn(taskId, reason, `test turn (${reason})`, trigger);
  const r = await call(env, "POST", "/v1/agent/claim", { worker: "w1", max: 5 }, asAgent());
  if (r.status !== 200) throw new Error(`claim failed ${r.status} ${JSON.stringify(r.json)}`);
  const run = (r.json["runs"] as ClaimedRun[]).find((x) => x.taskId === taskId);
  if (!run) throw new Error(`no run claimed for ${taskId}: ${JSON.stringify(r.json)}`);
  return run;
}
