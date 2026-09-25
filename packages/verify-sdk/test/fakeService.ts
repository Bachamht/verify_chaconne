/**
 * 进程内假 verify-service（node http）：按 interfaces §5/§10.4 冻结的路径返回契约形状的 JSON；
 * 收费时用 x402 v2 的 PAYMENT-REQUIRED 头（与官方服务端 SDK 相同编码：base64(JSON)）。
 * 只校验凭证是否存在且 payer 与 EIP-3009 授权字段一致，不做链上结算。
 */
import { createServer, type IncomingMessage, type Server } from "node:http";

export interface FakeOptions {
  priceUsd?: string; // "0" = free
  network?: string;
  payTo?: string;
  asset?: string;
  /** v6 端点（tasks/context/events/…）；false = 全部 404，用于测「尚未就绪」路径 */
  v6?: boolean;
}
export interface Seen {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
const fromB64 = (s: string) => JSON.parse(Buffer.from(s, "base64").toString("utf8")) as Record<string, unknown>;

export async function startFakeService(opts: FakeOptions = {}): Promise<{ url: string; seen: Seen[]; settled: unknown[]; heartbeats: Array<{ mandateId: string; at: number }>; close: () => Promise<void>; server: Server }> {
  const priceUsd = opts.priceUsd ?? "0";
  const network = opts.network ?? "eip155:1952";
  const payTo = opts.payTo ?? "0x5e7914a9fb0243d22d863107b994d58f6043e1bc";
  const asset = opts.asset ?? "0x9e29b3aada05bf2d2c827af80bd28dc0b9b4fb0c";
  const amount = String(Math.round(Number(priceUsd) * 1_000_000));
  const seen: Seen[] = [];
  const settled: unknown[] = [];
  const jobs = new Map<string, Record<string, unknown>>();
  const mandates = new Map<string, Record<string, unknown>>();
  const paidJobs = new Set<string>();
  const v6 = opts.v6 ?? true;
  const tasks = new Map<string, Record<string, unknown>>();
  const intents = new Map<string, Record<string, unknown>>();
  const drafts = new Map<string, Record<string, unknown>>();
  const heartbeats: Array<{ mandateId: string; at: number }> = [];
  const theses = new Map<string, Record<string, unknown>>();

  const readBody = (req: IncomingMessage) =>
    new Promise<unknown>((resolve) => {
      let t = "";
      req.on("data", (c) => (t += c));
      req.on("end", () => {
        try {
          resolve(t ? JSON.parse(t) : undefined);
        } catch {
          resolve({ raw: t });
        }
      });
    });

  const server = createServer(async (req, res) => {
    const path = req.url ?? "/";
    const method = req.method ?? "GET";
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(",") : String(v ?? "")]));
    const body = await readBody(req);
    seen.push({ method, path, headers, body });
    const json = (status: number, o: unknown, extra: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...extra });
      res.end(JSON.stringify(o));
    };
    const requirePay = (resource: string) => {
      const sig = headers["payment-signature"];
      if (!sig) {
        json(402, { error: "payment_required" }, { "payment-required": b64({ x402Version: 2, accepts: [{ scheme: "exact", network, amount, asset, payTo, maxTimeoutSeconds: 120, resource: { url: resource }, extra: { name: "USD₮0", version: "1" } }] }) });
        return false;
      }
      const payload = fromB64(sig) as { payload?: { authorization?: Record<string, string>; signature?: string } };
      const auth = payload.payload?.authorization;
      if (!auth || auth["to"]?.toLowerCase() !== payTo.toLowerCase() || auth["value"] !== amount || !payload.payload?.signature) {
        json(402, { error: "settlement_failed", reason: "requirements_mismatch" });
        return false;
      }
      settled.push({ payer: auth["from"], amount, resource });
      res.setHeader("payment-response", b64({ success: true, status: "success", transaction: "0x" + "ab".repeat(32), network, payer: auth["from"] }));
      return true;
    };
    const auth = headers["x-api-key"];
    if (path.startsWith("/v1/") && !auth) return json(401, { error: "missing_api_key" });

    if (path === "/healthz") return json(200, { ok: true });
    if (path === "/v1/assets") return json(200, { registryVersion: "xlayer-registry/1.0.0", registryHash: "0x" + "ab".repeat(32), evidenceMode: "FIXTURE", assets: [] });
    if (path === "/v1/policies") return json(200, { policies: [{}, {}, {}], pricing: { reportPriceUsd: priceUsd } });
    if (path === "/v1/products") return json(200, { products: [{ sku: "verify_once", priceUsd }, { sku: "plan", priceUsd }, { sku: "monitor_window", priceUsd }, { sku: "task_bundle", priceUsd }] });
    if (path === "/v1/jobs" && method === "POST") {
      const b = body as Record<string, unknown>;
      const id = `job_${String(b["clientRequestId"])}`;
      jobs.set(id, { jobId: id, job: b, order: { state: priceUsd === "0" ? "PAID" : "REPORT_READY", priceUsd }, latestReport: { version: 1, verdict: "eligible" }, executions: [] });
      return json(201, jobs.get(id));
    }
    let m = /^\/v1\/jobs\/([^/?]+)\/report/.exec(path);
    if (m) {
      const id = m[1]!;
      if (!jobs.has(id)) return json(404, { error: "job_not_found" });
      if (priceUsd !== "0" && !paidJobs.has(id)) {
        if (!requirePay(`http://svc/v1/jobs/${id}/report`)) return;
        paidJobs.add(id);
      }
      return json(200, { report: { schemaVersion: "1", jobId: id, reportVersion: 1, verdict: "eligible", comparisonStatus: "live", marketSession: "REGULAR" }, reportHash: "0x" + "cd".repeat(32), evidence: [{}, {}] });
    }
    m = /^\/v1\/jobs\/([^/?]+)\/bundle$/.exec(path);
    if (m) return jobs.has(m[1]!) ? json(200, { schemaVersion: "1", kind: "job", id: m[1], bundleHash: "0x" + "ef".repeat(32) }) : json(404, { error: "job_not_found" });
    m = /^\/v1\/jobs\/([^/?]+)\/bill$/.exec(path);
    if (m) return json(200, { jobId: m[1], bill: { serviceFees: [], principal: [], gas: [], selfPayment: false } }); // 与真实服务同形（曾因假服务返回裸 Bill 而漏掉页面白屏）
    m = /^\/v1\/jobs\/([^/?]+)$/.exec(path);
    if (m) return jobs.has(m[1]!) ? json(200, jobs.get(m[1]!)) : json(404, { error: "job_not_found" });

    if (path === "/v1/plans" && method === "POST") {
      const b = body as Record<string, unknown>;
      const id = `plan_${String(b["clientRequestId"])}`;
      if (priceUsd !== "0" && !requirePay("http://svc/v1/plans")) return;
      return json(201, { planId: id, plan: { schemaVersion: "1", planId: id, candidates: [{ candidateId: "cand_0_10000", legIndex: 0, amountInRaw: String(b["budget"] ? (b["budget"] as Record<string, string>)["amountInRaw"] : "0"), completionBps: 10000, chosenPolicyVerdict: "eligible", nextStep: "READY" }], recommended: "cand_0_10000", planHash: "0x" + "11".repeat(32) } });
    }
    m = /^\/v1\/plans\/([^/?]+)\/jobs$/.exec(path);
    if (m && method === "POST") {
      const id = `job_from_${m[1]}`;
      jobs.set(id, { jobId: id, order: { state: "PAID", priceUsd: "0" }, latestReport: { version: 1, verdict: "eligible" }, executions: [] });
      return json(201, jobs.get(id));
    }
    m = /^\/v1\/plans\/([^/?]+)$/.exec(path);
    if (m) return json(200, { planId: m[1], plan: { recommended: "cand_0_10000", candidates: [] } });

    if (path === "/v1/mandates" && method === "POST") {
      const b = body as { typedData?: { message?: Record<string, unknown> }; signature?: string };
      if (!b.typedData?.message || !b.signature) return json(422, { error: "invalid_mandate" });
      if (priceUsd !== "0" && !requirePay("http://svc/v1/mandates")) return;
      const id = `mnd_${mandates.size + 1}`;
      mandates.set(id, { mandateId: id, state: "ACTIVE", mandate: b.typedData.message, spent: "0", stepsDone: 0, maxSteps: b.typedData.message["maxSteps"], nextStepIndex: 0, steps: [] });
      return json(201, mandates.get(id));
    }
    m = /^\/v1\/mandates\/([^/?]+)\/(pause|resume|cancel|prepare-step)$/.exec(path);
    if (m && method === "POST") {
      const mm = mandates.get(m[1]!);
      if (!mm) return json(404, { error: "mandate_not_found" });
      if (m[2] === "pause") mm["state"] = "PAUSED";
      if (m[2] === "resume") mm["state"] = "ACTIVE";
      if (m[2] === "cancel") mm["state"] = "CANCELLED";
      if (m[2] === "prepare-step") {
        if (mm["state"] !== "ACTIVE") return json(409, { error: "mandate_not_active", state: mm["state"] });
        const mandate = mm["mandate"] as Record<string, string>;
        const idx = mm["nextStepIndex"] as number;
        const step = { mandateDigest: "0x" + "22".repeat(32), stepIndex: String(idx), outputToken: "0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a", amountIn: mandate["perStepCap"], minAmountOut: "1", router: "0x7c5bee2a8091c3ef39072f64f18fac913060aeaf", spender: "0x8b773d83bc66be128c60e07e17c8901f7a64f000", calldataHash: "0x" + "33".repeat(32), evidenceHash: "0x" + "44".repeat(32), deadline: String(Math.floor(Date.now() / 1000) + 60) };
        return json(200, { status: "READY", stepIndex: String(idx), typedData: { domain: { name: "ChaconneVerifyPlanGuard", version: "1", chainId: 196, verifyingContract: "0x" + "55".repeat(20) }, primaryType: "MandateStep", message: step }, step, stepDigest: "0x" + "66".repeat(32), certificate: { stepDigest: "0x" + "66".repeat(32), evidenceHash: step.evidenceHash, policyDefinitionHash: mandate["policyDefinitionHash"], effectivePolicyHash: mandate["effectivePolicyHash"], issuedAt: String(Math.floor(Date.now() / 1000)), validUntil: String(Math.floor(Date.now() / 1000) + 60), signerEpoch: "1" }, certificateSignature: "0x" + "77".repeat(65), routerCalldata: "0x0c307f76", outputSet: ["0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a"], planGuard: "0x" + "55".repeat(20), validUntil: new Date(Date.now() + 60_000).toISOString() });
      }
      return json(200, mm);
    }
    m = /^\/v1\/mandates\/([^/?]+)\/steps\/(\d+)\/submissions$/.exec(path);
    if (m && method === "POST") {
      const mm = mandates.get(m[1]!);
      if (!mm) return json(404, { error: "mandate_not_found" });
      (mm["steps"] as unknown[]).push({ stepIndex: m[2], txHash: (body as Record<string, unknown>)["txHash"], state: "SUBMITTED" });
      mm["nextStepIndex"] = Number(m[2]) + 1;
      return json(202, { stepIndex: m[2], state: "SUBMITTED", txHash: (body as Record<string, unknown>)["txHash"] });
    }
    m = /^\/v1\/mandates\/([^/?]+)\/(bundle|bill)$/.exec(path);
    if (m) return json(200, m[2] === "bundle" ? { schemaVersion: "1", kind: "mandate", id: m[1] } : { mandateId: m[1], bill: { serviceFees: [], principal: [], gas: [], selfPayment: false } });
    m = /^\/v1\/mandates\/([^/?]+)$/.exec(path);
    if (m) return mandates.has(m[1]!) ? json(200, mandates.get(m[1]!)) : json(404, { error: "mandate_not_found" });

    if (path === "/v1/simulations" && method === "POST") return json(201, { simulationId: "sim_1", verdict: "eligible", mode: "SIMULATION" });
    if (path === "/v1/profiles/me") return json(200, method === "PUT" ? { ...(body as object), ok: true } : { personaId: "turtle_drummer", name: "Tempo", tone: "calm" });
    if (path === "/v1/shares" && method === "POST") return json(201, { shareId: "sh_1", url: "/r/sh_1", public: false });
    m = /^\/pub\/reports\/([^/?]+)$/.exec(path);
    if (m) return json(200, { shareId: m[1], status: "completed" });
    /* ---------- v6（interfaces §11.7）：契约形状的最小假实现 ---------- */
    if (v6) {
      const ctxField = (value: unknown, status = "ok") => ({ value, source: "crowsnest", observedAt: "2026-09-18T15:00:00Z", fetchedAt: "2026-09-18T15:00:10Z", status, purposes: ["agent"] });
      if (path.startsWith("/v1/context")) return json(200, { schemaVersion: "chaconne-context/1", producer: "crowsnest", packagedAt: "2026-09-18T15:00:10Z", session: { label: ctxField("US_REGULAR"), usTradingDay: ctxField(true) }, events: [], fed: { blackout: ctxField(false) }, risk: { vix: { value: null, source: "yahoo", observedAt: null, fetchedAt: "2026-09-18T15:00:10Z", status: "unavailable", purposes: ["internal"], note: "not_in_tier" } }, driftVerdict: ctxField("neutral") });
      if (/^\/v1\/events\/[^/]+\/revisions/.test(path)) return json(200, { revisions: [] });
      if (path.startsWith("/v1/events")) return json(200, { events: [{ id: "crowsnest:MACRO_TIER1:2026-09-22:cpi", kind: "MACRO_TIER1", name: "CPI", underlyingIds: [], scheduledAtUtc: "2026-09-22T12:30:00Z", dateLocal: "2026-09-22", datePrecision: "exact", sessionHint: null, status: "confirmed", revision: 1, source: "crowsnest", sourceFetchedAt: "2026-09-18T00:00:00Z", firstKnownAt: "2026-09-01T00:00:00Z", tz: "America/New_York" }] });
      if (path.startsWith("/v1/event-impacts")) return json(200, { impacts: [{ eventId: "crowsnest:MACRO_TIER1:2026-09-22:cpi", relation: "macro_research", assets: [], holdings: [], tasks: [], actions: ["view_evidence", "create_watch_task"] }] });
      if (path === "/v1/tasks" && method === "POST") {
        const b = body as Record<string, unknown>;
        const id = `tsk_${String(b["clientRequestId"])}`;
        const mode = b["mode"] === "LIVE" ? "LIVE" : "SIMULATION";
        const task = { id, owner: String(b["ownerAddress"]).toLowerCase(), playbookId: b["playbookId"], goal: { side: "buy", legs: [], budget: { inputAssetKeys: [] } }, conditions: { ...(b["conditions"] as object), hash: "0x" + "c1".repeat(32) }, mandateIds: [], status: mode === "LIVE" ? "AWAITING_AUTHORIZATION" : "WAITING", blockers: [{ code: "EVENT_WINDOW_ACTIVE", evidenceIds: ["ev_1"], evidenceAt: "2026-09-18T15:00:00Z", nextCheckAt: "2026-09-22T13:30:00Z", userActionRequired: false, text: "inside an event window" }], nextCheckAt: "2026-09-22T13:30:00Z", executorPresence: "offline", createdAt: "2026-09-18T15:00:00Z", updatedAt: "2026-09-18T15:00:00Z" };
        tasks.set(id, task);
        const mandateDraft = { typedData: { domain: { name: "ChaconneVerifyPlanGuard", version: "1", chainId: 196, verifyingContract: "0x" + "55".repeat(20) }, types: {}, primaryType: "TradeMandate", message: { owner: task.owner, recipient: task.owner, inputToken: "0x4ae46a509f6b1d9056937ba4500cb143933d2dc8", outputSetHash: "0x" + "22".repeat(32), budgetCap: "15000000", perStepCap: "5000000", maxSteps: "3", policyDefinitionHash: "0x" + "11".repeat(32), effectivePolicyHash: "0x" + "12".repeat(32), registryHash: "0x" + "13".repeat(32), validFrom: "1", deadline: "9999999999", nonce: "9" } }, outputSet: ["0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a"] };
        drafts.set(id, mandateDraft);
        return json(201, { task, mandateDraft, thesisDraft: null, budgetAllocation: null });
      }
      if (path.startsWith("/v1/tasks?")) return json(200, { tasks: [...tasks.values()] });
      // CV-D16：交易意图 / agent 状态
      m = /^\/v1\/tasks\/([^/?]+)\/intents(?:\/([^/?]+))?(\/withdraw)?(?:\?step=1)?$/.exec(path);
      if (m) {
        const t = tasks.get(m[1]!);
        if (!t) return json(404, { error: "task_not_found" });
        if (!m[2] && method === "POST") {
          const b = body as { clientRequestId: string; outputAssetKey: string; amountInRaw: string; decision?: { claims?: Array<{ kind: string }> } };
          const id = `int_${b.clientRequestId}`;
          const research = (b.decision?.claims ?? []).some((c) => c.kind === "agent_research");
          const status = research ? "rejected" : "certified";
          const intent = { id, taskId: m[1], clientRequestId: b.clientRequestId, kind: "buy", outputAssetKey: b.outputAssetKey, amountInRaw: b.amountInRaw, decision: b.decision, triage: [], checks: [{ id: "facts", ok: !research, reasons: research ? [{ code: "DECISION_BASIS_NOT_ADMISSIBLE", severity: "block", evidenceIds: [], detail: {} }] : [], detail: {} }, { id: "scope", ok: true, reasons: [], detail: {} }, { id: "execution", ok: !research, reasons: [], detail: {} }, { id: "binding", ok: !research, reasons: [], detail: {} }], status, step: research ? null : { mandateId: `mnd_task_${m[1]}`, stepIndex: 0, validUntil: "2999-01-01T00:00:00Z" }, planDeviations: [], createdAt: "2026-09-18T15:00:00Z", updatedAt: "2026-09-18T15:00:00Z" };
          intents.set(id, intent);
          if (research) return json(422, { intent, taskId: m[1], taskStatus: t["status"] });
          return json(201, { intent, taskId: m[1], taskStatus: "STEP_PREPARED", status: "READY", stepIndex: 0, guardCall: { functionName: "executeStep" }, certificate: { effectivePolicyHash: "0x" + "12".repeat(32) } });
        }
        if (!m[2]) return json(200, { intents: [...intents.values()].filter((i) => i["taskId"] === m![1]) });
        const it = intents.get(m[2]);
        if (!it) return json(404, { error: "intent_not_found" });
        if (m[3]) { it["status"] = "withdrawn"; return json(200, { intent: it, taskId: m[1], taskStatus: "ACTIVE", stepVoided: true }); }
        return json(200, { ...it, ...(path.endsWith("?step=1") && it["status"] === "certified" ? { ready: { status: "READY", stepIndex: 0 } } : {}) });
      }
      m = /^\/v1\/tasks\/([^/?]+)\/agent-status$/.exec(path);
      if (m && method === "POST") {
        const t = tasks.get(m[1]!);
        if (!t) return json(404, { error: "task_not_found" });
        const b = body as { status: string; note?: string; plan?: { conditions?: unknown[] } };
        if (b.status === "plan_revised" && b.plan?.conditions?.some((c) => (c as { type?: string }).type === "session")) return json(409, { error: "scope_locked" });
        if (b.status === "ended") t["status"] = "PAUSED";
        if (b.status === "accepted" && !(body as { agent?: { name?: string } }).agent?.name) return json(400, { error: "invalid_request", details: [{ field: "agent.name", code: "required_for_accepted" }] });
        return json(200, { task: { ...t, brief: b.status === "accepted" ? { agent: { name: (body as { agent: { name: string } }).agent.name } } : undefined }, agentTurn: { version: 1, state: b.status === "accepted" ? "awaiting_agent" : b.status, response: b }, note: b.status === "ended" ? "task paused service-side" : "recorded" });
      }
      m = /^\/v1\/tasks\/([^/?]+)\/(pause|resume|cancel|authorize|prepare-step|explain-wait|compare-policies)$/.exec(path);
      if (m) {
        const t = tasks.get(m[1]!);
        if (!t) return json(404, { error: "task_not_found" });
        const a = m[2]!;
        if (a === "pause" || a === "resume" || a === "cancel") {
          t["status"] = a === "pause" ? "PAUSED" : a === "resume" ? "ACTIVE" : "CANCELLED";
          return json(200, { task: t, note: "Service-side stop only blocks new certificates; an already-issued, unexpired certificate may still execute. A hard stop is the on-chain revokeMandate confirmation." });
        }
        if (a === "authorize") {
          const b = body as { signature?: string };
          if (!b.signature) return json(422, { error: "signature_required" });
          const mid = `mnd_task_${m[1]}`;
          mandates.set(mid, { mandateId: mid, state: "ACTIVE", mandate: {}, spent: "0", stepsDone: 0, maxSteps: 3, nextStepIndex: 0, steps: [] });
          (t["mandateIds"] as string[]).push(mid);
          t["status"] = "ACTIVE";
          return json(201, { task: t, mandateId: mid });
        }
        if (a === "prepare-step") return json(409, { status: "WAIT", blockers: t["blockers"], nextCheckAt: t["nextCheckAt"] });
        if (a === "explain-wait") return json(200, { taskId: m[1], blockers: t["blockers"], nextCheckAt: t["nextCheckAt"], userActionRequired: false, evidenceAt: "2026-09-18T15:00:00Z" });
        if (a === "compare-policies") return json(201, { id: "cmp_1", taskId: m[1], evidenceSnapshotId: "snap_1", variants: ((body as { variants?: unknown[] }).variants ?? []).map((v) => ({ ...(v as object), outcome: "INSUFFICIENT_EVIDENCE", perItem: [] })), diff: [], mode: "SIMULATION" });
      }
      m = /^\/v1\/tasks\/([^/?]+)$/.exec(path);
      if (m) return tasks.has(m[1]!) ? json(200, { task: tasks.get(m[1]!), mandateDraft: (tasks.get(m[1]!)!["mandateIds"] as string[]).length ? null : (drafts.get(m[1]!) ?? null) }) : json(404, { error: "task_not_found" });
      m = /^\/v1\/mandates\/([^/?]+)\/executor\/heartbeat$/.exec(path);
      if (m && method === "POST") {
        heartbeats.push({ mandateId: m[1]!, at: Date.now() });
        res.writeHead(204);
        return res.end();
      }
      if (path === "/v1/theses" && method === "POST") {
        const id = `ths_${theses.size + 1}`;
        theses.set(id, { id, ...(body as object), status: "unknown" });
        return json(201, theses.get(id));
      }
      m = /^\/v1\/theses\/([^/?]+)(\/review-items)?$/.exec(path);
      if (m) return theses.has(m[1]!) ? json(m[2] ? 201 : 200, m[2] ? { thesisId: m[1], item: body } : theses.get(m[1]!)) : json(404, { error: "thesis_not_found" });
      if (path === "/v1/budget-groups" && method === "POST") return json(201, { id: "bg_1", ...(body as object), priorityRule: "priority_then_created" });
      m = /^\/v1\/budget-groups\/([^/?]+)(\/allocations)?$/.exec(path);
      if (m) return json(m[2] ? 201 : 200, m[2] ? { groupId: m[1], state: "reserved", ...(body as object) } : { id: m[1], capRaw: "100000000", cashFloorRaw: "5000000", allocations: [] });
      m = /^\/v1\/portfolio\/([^/?]+)(\/cost-overrides)?$/.exec(path);
      if (m) return json(m[2] ? 201 : 200, m[2] ? { owner: m[1], override: body, source: "user_reported" } : { owner: m[1], chainId: 196, blockNumber: 1, holdings: [] });
      if (path === "/v1/notify/webhooks" && method === "POST") return json(201, { id: "wh_1", url: (body as { url?: string }).url });
      m = /^\/v1\/notify\/webhooks\/([^/?]+)$/.exec(path);
      if (m) return method === "DELETE" ? (res.writeHead(204), res.end()) : json(200, { id: m[1] });
      if (path === "/v1/notify/telegram/link") return json(201, { code: "TG-1234", expiresAt: "2026-09-18T16:00:00Z" });
      if (path === "/v1/notify/test") return json(200, { ok: true });
      if (path === "/v1/replays" && method === "POST") return json(201, { id: "rpl_1", ...(body as object), points: [], coverage: [], gaps: [{ from: "2026-09-17T00:00:00Z", to: "2026-09-17T23:59:59Z", reason: "NO_ARCHIVE" }] });
      m = /^\/v1\/replays\/([^/?]+)$/.exec(path);
      if (m) return json(200, { id: m[1], points: [], coverage: [], gaps: [] });
      if (path === "/v1/rebalance/preview") return json(200, { legs: [], partialAllowed: true });
      if (path === "/v1/rebalance/plans" && method === "POST") return json(201, { id: "rbp_1", legs: [] });
      m = /^\/v1\/rebalance\/plans\/([^/?]+)$/.exec(path);
      if (m) return json(200, { id: m[1], legs: [] });
      if (path.startsWith("/v1/recaps?")) return json(200, { id: "rcp_1", owner: "0x", date: "2026-09-17", modes: ["SIMULATION"], sections: { handled: [], waited: [], trades: [], remaining: [], decisions: [] }, ledger: [], timeline: [], milestones: [], remixable: [], share: { public: false, hideAssets: true, hideAmounts: true, shareId: null, publicUrl: null } });
      m = /^\/v1\/recaps\/([^/?]+)(\/share)?$/.exec(path);
      if (m) return json(200, m[2] ? { recapId: m[1], share: { ...(body as object), shareId: "rsh_1" } } : { id: m[1] });
      if (path.startsWith("/v1/missions")) return json(200, { eventsCoverage: "unavailable", missions: [] });
      if (path === "/a2mcp/agent-tasks") return json(200, { ok: true, status: "delivered", taskDrafts: [] });
    }

    if (path === "/a2mcp/verify" && method === "POST") {
      if (priceUsd !== "0" && !requirePay("http://svc/a2mcp/verify")) return;
      return json(200, { service: "Chaconne Verify / StockProof", jobId: "job_a2mcp", verdict: "eligible" });
    }
    return json(404, { error: "not_found", path });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, seen, settled, heartbeats, server, close: () => new Promise<void>((r) => server.close(() => r())) };
}
