/**
 * v7MainnetSmoke.ts 的本地分叉演练（不碰主网写入）：
 *   anvil 分叉 X Layer 主网最新块 → 在分叉上冒充生产 PlanGuard 的 owner，把签名者 epoch 1 换成本次现生成的一次性测试私钥、放行分叉本地测试路由
 *   （生产 PlanGuard 地址不变——冒烟脚本里写死的 spender / 合约地址原样生效）→ 一次性 owner（冒充代币持有人转入 5 USDG）与一次性执行身份（anvil_setBalance 给 OKB）
 *   → 进程内 verify-service（pglite，与 index.ts 同一 assemble 装配；v7 开关全关 = 与生产 v6 同一组端点；fixture 证据 + 分叉本地路由）
 *   → 以子进程跑 v7MainnetSmoke.ts：① 执行身份 = owner 时必须拒绝 ② --dry-run ③ --execute --cancel（stdin 输入 yes）。
 * 一次性私钥写进 scripts/out/ 下的临时文件（已 gitignore），跑完删除；不读任何 .env / .qa-live。
 * 用法：pnpm --filter @chaconne/verify-service exec tsx scripts/v7MainnetSmokeFork.ts   （先在 packages/verify-contracts 里 forge build）
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@chaconne/db";
import type { Db } from "@chaconne/db";
import { createPublicClient, createWalletClient, encodeFunctionData, erc20Abi, http, parseAbi, toFunctionSelector, type Abi, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { findEntry, type AssetRegistry, type EvidenceRecord, type NormalizedJob } from "@chaconne/core/verify";
import { loadConfig } from "../src/config";
import { assembleService, type AssembledService } from "../src/assemble";
import { FixtureEvidenceProvider, type CollectedEvidence, type CollectOptions, type EvidenceProvider } from "../src/evidence/provider";
import { signedContext, testKeypair } from "../test/contextHelpers";

const here = dirname(fileURLToPath(import.meta.url));
const SERVICE_ROOT = resolve(here, "..");
const REPO = resolve(SERVICE_ROOT, "..", "..");
const OUT_DIR = join(here, "out");
const RUN_TS = new Date().toISOString().replace(/[:.]/g, "-");
const FORK_URL = process.env["XLAYER_RPC_URL"] ?? "https://rpc.xlayer.tech";
const PORT = Number(process.env["SMOKE_FORK_PORT"] ?? 8553);
const RPC = `http://127.0.0.1:${PORT}`;
const PLANGUARD = "0xe8517f296211f4b9175796baab47979fb14fd2f0" as Hex;
const USDG = "0x4ae46a509f6b1d9056937ba4500cb143933d2dc8" as Hex;
const AAPLX = "0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a" as Hex;
const REGISTRY_FILE = join(SERVICE_ROOT, "config", "registry.xlayer.v1.2.json");
const ARTIFACTS = join(REPO, "packages", "verify-contracts", "out");
/** anvil 默认账户 #0（公开测试私钥，仅本地分叉）：部署分叉本地测试路由 */
const ADMIN_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const PRICE_MICRO: Record<string, bigint> = { [USDG]: 1_000_000n, [AAPLX]: 250_000_000n };
const ROUTER_ABI = parseAbi(["function swap(address tokenIn, address tokenOut, uint256 amountOut) returns (uint256)"]);
const PG_ADMIN_ABI = parseAbi(["function owner() view returns (address)", "function setSignerEpoch(uint64 epoch, address signer, bool enabled)", "function setRoute(address router, address spender, bool enabled)", "function setSelector(address router, bytes4 selector, bool enabled)"]);
const lc = (s: string) => s.toLowerCase() as Hex;
const say = (m: string, x?: Record<string, unknown>) => process.stderr.write(`[smoke-fork ${new Date().toISOString()}] ${m}${x ? ` ${JSON.stringify(x)}` : ""}\n`);

class ForkFixtureEvidence implements EvidenceProvider {
  readonly mode = "FIXTURE" as const;
  private readonly inner: FixtureEvidenceProvider;
  constructor(private readonly router: Hex) {
    this.inner = new FixtureEvidenceProvider({ router, spender: router });
  }
  async collect(job: NormalizedJob, registry: AssetRegistry, nowIso: string, _opts?: CollectOptions): Promise<CollectedEvidence> {
    const c = await this.inner.collect(job, registry, nowIso);
    const inE = findEntry(registry, job.inputAssetKey);
    const outE = findEntry(registry, job.outputAssetKey);
    const pIn = inE ? PRICE_MICRO[lc(inE.tokenAddress)] : undefined;
    const pOut = outE ? PRICE_MICRO[lc(outE.tokenAddress)] : undefined;
    if (!inE || !outE || !pIn || !pOut) return c;
    const out = (((BigInt(job.amountInRaw) * pIn) / 10n ** BigInt(inE.tokenDecimals)) * 10n ** BigInt(outE.tokenDecimals)) / pOut;
    const evidence = c.evidence.map((e): EvidenceRecord => (e.payload.kind === "okx_quote" ? { ...e, payload: { ...e.payload, amountInRaw: job.amountInRaw, expectedOutRaw: out.toString() } } : e));
    return { evidence, route: { router: this.router, spender: this.router, calldata: encodeFunctionData({ abi: ROUTER_ABI, functionName: "swap", args: [lc(inE.tokenAddress), lc(outE.tokenAddress), out] }) } };
  }
}

function startAnvil(): Promise<() => void> {
  return new Promise((ok, fail) => {
    const p = spawn("anvil", ["--fork-url", FORK_URL, "--port", String(PORT), "--block-time", "1", "--silent"], { stdio: ["ignore", "ignore", "ignore"] });
    p.on("error", fail);
    const probe = async (n: number) => {
      try {
        const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
        if (r.ok) return ok(() => p.kill("SIGTERM"));
      } catch {
        /* retry */
      }
      if (n > 90) return fail(new Error("anvil not ready"));
      setTimeout(() => void probe(n + 1), 1000);
    };
    void probe(0);
  });
}
async function rpc<T = unknown>(method: string, params: unknown[]): Promise<T> {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = (await r.json()) as { result?: T; error?: { message?: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message ?? JSON.stringify(j.error)}`);
  return j.result as T;
}

function runSmoke(args: string[], stdin: string | null): Promise<{ code: number | null; summary: Record<string, unknown> | null; stderr: string }> {
  return new Promise((ok) => {
    const p = spawn(process.execPath, ["--import", "tsx", join(here, "v7MainnetSmoke.ts"), ...args], { cwd: SERVICE_ROOT, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d: Buffer) => (out += d.toString()));
    p.stderr.on("data", (d: Buffer) => {
      err += d.toString();
      if (process.env["SMOKE_VERBOSE"] === "1") process.stderr.write(d);
    });
    if (stdin !== null) p.stdin.write(stdin);
    p.stdin.end();
    p.on("close", (code) => {
      const last = out.trim().split("\n").pop() ?? "";
      let summary: Record<string, unknown> | null = null;
      try {
        summary = JSON.parse(last) as Record<string, unknown>;
      } catch {
        /* 非 JSON */
      }
      ok({ code, summary, stderr: err });
    });
  });
}

async function main(): Promise<Record<string, unknown>> {
  for (const f of ["E2EForkRouter.sol/E2EForkRouter.json"]) if (!existsSync(join(ARTIFACTS, f))) throw new Error(`missing artifact ${f}: run forge build in packages/verify-contracts`);
  const result: Record<string, unknown> = { kind: "chaconne-v7-mainnet-smoke-fork", startedAt: new Date().toISOString(), forkUrl: FORK_URL };
  const killAnvil = await startAnvil();
  const tmpDir = join(OUT_DIR, `v7smoke-fork-keys-${RUN_TS}`);
  let svc: AssembledService | null = null;
  let stopSvc: (() => void) | null = null;
  let server: ReturnType<AssembledService["app"]["listen"]> | null = null;
  let ctxTimer: NodeJS.Timeout | null = null;
  try {
    const chain = { id: 196, name: "xlayer-fork", nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;
    const pub = createPublicClient({ chain, transport: http(RPC) });
    const forkBlock = await pub.getBlockNumber();
    result["forkBlock"] = forkBlock.toString();

    /* ---- 1. 生产 PlanGuard（分叉上）：冒充 owner → 签名者 epoch 1 = 一次性测试私钥；放行分叉本地测试路由 ---- */
    const signerPk = generatePrivateKey();
    const signer = privateKeyToAccount(signerPk);
    const admin = privateKeyToAccount(ADMIN_PK);
    const wAdmin = createWalletClient({ account: admin, chain, transport: http(RPC) });
    const rtArt = JSON.parse(readFileSync(join(ARTIFACTS, "E2EForkRouter.sol", "E2EForkRouter.json"), "utf8")) as { abi: Abi; bytecode: { object: Hex } };
    const rh = await wAdmin.deployContract({ abi: rtArt.abi, bytecode: rtArt.bytecode.object, args: [] });
    const router = lc((await pub.waitForTransactionReceipt({ hash: rh })).contractAddress!);
    const pgOwner = lc(await pub.readContract({ address: PLANGUARD, abi: PG_ADMIN_ABI, functionName: "owner" }));
    await rpc("anvil_impersonateAccount", [pgOwner]);
    await rpc("anvil_setBalance", [pgOwner, "0x56BC75E2D63100000"]);
    for (const data of [
      encodeFunctionData({ abi: PG_ADMIN_ABI, functionName: "setSignerEpoch", args: [1n, signer.address, true] }),
      encodeFunctionData({ abi: PG_ADMIN_ABI, functionName: "setRoute", args: [router, router, true] }),
      encodeFunctionData({ abi: PG_ADMIN_ABI, functionName: "setSelector", args: [router, toFunctionSelector("swap(address,address,uint256)"), true] }),
    ]) await pub.waitForTransactionReceipt({ hash: await rpc<Hex>("eth_sendTransaction", [{ from: pgOwner, to: PLANGUARD, data }]) });
    await rpc("anvil_stopImpersonatingAccount", [pgOwner]);
    result["fork"] = { planGuard: PLANGUARD, planGuardOwnerImpersonated: pgOwner, testSigner: lc(signer.address), router };
    say("production PlanGuard reconfigured on the fork", result["fork"] as Record<string, unknown>);

    /* ---- 2. 一次性 owner / 执行身份；资金 ---- */
    const ownerPk = generatePrivateKey();
    const execPk = generatePrivateKey();
    const owner = privateKeyToAccount(ownerPk);
    const exec = privateKeyToAccount(execPk);
    const bal = (t: Hex, w: Hex) => pub.readContract({ address: t, abi: erc20Abi, functionName: "balanceOf", args: [w] });
    const mainnetRead = createPublicClient({ transport: http(FORK_URL) });
    const transferEv = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"])[0];
    const findWhale = async (token: Hex, need: bigint): Promise<Hex> => {
      const seen = new Set<string>();
      for (let to = forkBlock; to > forkBlock - 30_000n; to -= 100n) {
        const logs = await mainnetRead.getLogs({ address: token, event: transferEv, fromBlock: to - 99n, toBlock: to }).catch(() => []);
        for (const l of logs) {
          const a = (l as unknown as { args: { from: string; to: string } }).args;
          for (const c of [a.to, a.from]) {
            const cand = lc(c);
            if (seen.has(cand) || cand === PLANGUARD || /^0x0{40}$/.test(cand)) continue;
            seen.add(cand);
            const code = await pub.getCode({ address: cand });
            if (code && code !== "0x") continue;
            if ((await bal(token, cand)) >= need) return cand;
          }
        }
      }
      throw new Error(`no holder with ≥ ${need} of ${token}`);
    };
    const fund = async (token: Hex, to: Hex, amount: bigint) => {
      const whale = await findWhale(token, amount);
      await rpc("anvil_impersonateAccount", [whale]);
      await rpc("anvil_setBalance", [whale, "0x56BC75E2D63100000"]);
      await pub.waitForTransactionReceipt({ hash: await rpc<Hex>("eth_sendTransaction", [{ from: whale, to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] }) }]) });
      await rpc("anvil_stopImpersonatingAccount", [whale]);
    };
    await fund(USDG, lc(owner.address), 5_000_000n);
    await fund(AAPLX, router, 50_000_000_000_000_000n);
    await rpc("anvil_setBalance", [exec.address, "0x2386F26FC10000"]); // 0.01 OKB
    result["funding"] = { ownerUsdg: (await bal(USDG, owner.address)).toString(), routerAaplx: (await bal(AAPLX, router)).toString(), executorOkbWei: (await pub.getBalance({ address: exec.address })).toString() };
    mkdirSync(tmpDir, { recursive: true });
    const ownerFile = join(tmpDir, "owner.env");
    const execFile = join(tmpDir, "executor.env");
    writeFileSync(ownerFile, `DEMO_USER_PRIVATE_KEY=${ownerPk}\n`, { mode: 0o600 });
    writeFileSync(execFile, `EXECUTOR_PRIVATE_KEY=${execPk}\n`, { mode: 0o600 });

    /* ---- 3. verify-service（v7 开关全关 = 生产 v6 端点集合） ---- */
    const client = new PGlite();
    const db = drizzle(client, { schema }) as unknown as Db;
    await migrate(drizzle(client), { migrationsFolder: join(REPO, "packages", "db", "migrations") });
    const kp = testKeypair("smoke-k1");
    const cfg = loadConfig({
      DATABASE_URL: "pglite://memory",
      NODE_ENV: "development",
      PAYMENT_MODE: "mock",
      PAYMENT_NETWORK: "eip155:1952",
      REPORT_PRICE_USD: "0",
      EVIDENCE_MODE: "fixture",
      REGISTRY_MODE: "file",
      REGISTRY_FILE,
      EXECUTION_CHAIN_ID: "196",
      XLAYER_RPC_URL: RPC,
      PLANGUARD_ADDRESS: PLANGUARD,
      ATTESTATION_PRIVATE_KEY: signerPk,
      SIGNER_EPOCH: "1",
      VERIFY_API_KEYS: `vk_smoke_ops_${randomBytes(16).toString("hex")}:smoke-operator`,
      RATE_LIMIT_PER_MIN: "5000",
      FREE_RATE_LIMIT_PER_MIN: "5000",
      CROWSNEST_PUBKEY_ED25519: `${kp.publicKeyId}=${kp.publicKeyHex}`,
      PORTFOLIO_PRICE_SOURCE: "none",
      AGENT_C6_STORE: "memory",
      RECEIPT_INTERVAL_MS: "2000",
    });
    if (cfg.v7.hostedExecutor || cfg.v7.delegation || cfg.v7.sell || cfg.v7.hostedAgent) throw new Error("v7 switches must be off to mirror production v6");
    svc = await assembleService(cfg, { db, evidence: new ForkFixtureEvidence(router) });
    stopSvc = svc.start();
    server = svc.app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server!.once("listening", () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const ingest = async () => {
      const r = await svc!.crowsnest.ingest(signedContext(kp, { at: new Date().toISOString() }), { endpoint: "smoke-fork", mode: "LIVE" });
      if (!r.ok) say("context ingest refused", { reason: r.reason });
    };
    await ingest();
    ctxTimer = setInterval(() => void ingest(), 60_000);
    ctxTimer.unref();
    say("verify-service up (v7 off)", { base });
    // v7 路由不可用（生产 v6 = 404 未挂载；本地 v7 代码开关关 = 503 hosted_disabled）——冒烟脚本本身从不调用它们
    const v7probe = await Promise.all(["/v1/tasks/tsk_x/delegation", "/v1/tasks/tsk_x/positions"].map((p) => fetch(`${base}${p}`).then((r) => r.status)));
    result["v7RoutesUnavailable"] = { statuses: v7probe, ok: v7probe.every((c) => c === 404 || c === 503) };

    const common = ["--base-url", base, "--rpc-url", RPC];
    /* ---- 4a. 执行身份 = owner → 必须拒绝 ---- */
    writeFileSync(join(tmpDir, "same.env"), `EXECUTOR_PRIVATE_KEY=${ownerPk}\n`, { mode: 0o600 });
    const same = await runSmoke([...common, "--owner-key-file", ownerFile, "--executor-key-file", join(tmpDir, "same.env")], null);
    const sameChecks = (same.summary?.["checks"] as Array<{ id: string; ok: boolean }> | undefined) ?? [];
    result["negativeExecutorIsOwner"] = { exit: same.code, refused: same.code === 1 && sameChecks.some((c) => c.id === "executor_not_owner" && !c.ok), error: same.summary?.["error"] ?? null };
    say("negative (executor == owner)", result["negativeExecutorIsOwner"] as Record<string, unknown>);

    /* ---- 4b. dry-run ---- */
    const ownerNonce0 = await pub.getTransactionCount({ address: owner.address });
    const dry = await runSmoke([...common, "--owner-key-file", ownerFile, "--executor-key-file", execFile], null);
    const execNonceAfterDry = await pub.getTransactionCount({ address: exec.address });
    result["dryRun"] = { exit: dry.code, ok: dry.summary?.["ok"] ?? null, failed: ((dry.summary?.["checks"] as Array<{ id: string; ok: boolean }> | undefined) ?? []).filter((c) => !c.ok).map((c) => c.id), executorNonceAfter: execNonceAfterDry, tasksCreated: (await db.select().from(schema.verifyTasks)).length, error: dry.summary?.["error"] ?? null };
    say("dry-run", result["dryRun"] as Record<string, unknown>);
    if (dry.code !== 0) process.stderr.write(dry.stderr.slice(-4000));

    /* ---- 4c. 「不输入 yes」= 不写 ---- */
    const no = await runSmoke([...common, "--owner-key-file", ownerFile, "--executor-key-file", execFile, "--execute"], "no\n");
    result["executeWithoutYes"] = { exit: no.code, aborted: no.summary?.["aborted"] ?? null, tasksCreated: (await db.select().from(schema.verifyTasks)).length, executorNonce: await pub.getTransactionCount({ address: exec.address }) };
    say("execute without yes", result["executeWithoutYes"] as Record<string, unknown>);

    /* ---- 4d. --execute --cancel（yes） ---- */
    const run = await runSmoke([...common, "--owner-key-file", ownerFile, "--executor-key-file", execFile, "--execute", "--cancel"], "yes\n");
    if (run.code !== 0) process.stderr.write(run.stderr.slice(-6000));
    const s = run.summary ?? {};
    const failed = ((s["checks"] as Array<{ id: string; ok: boolean }> | undefined) ?? []).filter((c) => !c.ok).map((c) => c.id);
    const ownerNonce1 = await pub.getTransactionCount({ address: owner.address });
    result["execute"] = { exit: run.code, ok: s["ok"] ?? null, failed, tx: s["tx"] ?? null, permit: s["permit"] ?? null, executeStep: s["executeStep"] ?? null, deltas: s["deltas"] ?? null, serviceStepState: s["serviceStepState"] ?? null, leftoverAllowance: s["leftoverAllowance"] ?? null, ownerTxCountBefore: ownerNonce0, ownerTxCountAfter: ownerNonce1, error: s["error"] ?? null, mainnetEvidenceV7Preview: s["mainnetEvidenceV7"] ?? null };
    say("execute", { exit: run.code, ok: s["ok"], failed, tx: s["tx"] });
    result["ok"] = (result["negativeExecutorIsOwner"] as { refused: boolean }).refused && dry.code === 0 && no.code === 0 && (result["executeWithoutYes"] as { tasksCreated: number }).tasksCreated === 0 && run.code === 0 && s["ok"] === true && ownerNonce1 === ownerNonce0 && (result["v7RoutesUnavailable"] as { ok: boolean }).ok;
    return result;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    if (ctxTimer) clearInterval(ctxTimer);
    stopSvc?.();
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    killAnvil();
  }
}

main().then(
  (r) => {
    r["finishedAt"] = new Date().toISOString();
    const file = join(OUT_DIR, `v7MainnetSmokeFork-${RUN_TS}.json`);
    writeFileSync(file, JSON.stringify(r, null, 2));
    process.stdout.write(`${JSON.stringify(r)}\n`);
    process.exit(r["ok"] ? 0 : 1);
  },
  (e) => {
    process.stderr.write(`smoke fork failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
    process.exit(1);
  },
);
