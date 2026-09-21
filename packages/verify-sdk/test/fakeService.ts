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
}
export interface Seen {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
const fromB64 = (s: string) => JSON.parse(Buffer.from(s, "base64").toString("utf8")) as Record<string, unknown>;

export async function startFakeService(opts: FakeOptions = {}): Promise<{ url: string; seen: Seen[]; settled: unknown[]; close: () => Promise<void>; server: Server }> {
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
    if (path === "/a2mcp/verify" && method === "POST") {
      if (priceUsd !== "0" && !requirePay("http://svc/a2mcp/verify")) return;
      return json(200, { service: "Chaconne Verify / StockProof", jobId: "job_a2mcp", verdict: "eligible" });
    }
    return json(404, { error: "not_found", path });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, seen, settled, server, close: () => new Promise<void>((r) => server.close(() => r())) };
}
