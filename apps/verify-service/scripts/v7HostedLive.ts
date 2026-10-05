/**
 * v7 线上首单（G4 收尾）：在生产服务上走真实的 v7 流程——演示钱包只签名，托管 Agent 决策，平台执行身份代付上链。
 * 与 v7MainnetSmoke.ts 不同：这里不碰任何执行身份私钥，permit 中继与 executeStep 全由服务器上的 chaconne-verify-executor 完成。
 *
 * 流程（--execute）：
 *   1. 演示钱包签 EIP-191 消息 → POST /v1/keys 签发 owner API key（与网页 /agent/keys 同一条消息）
 *   2. POST /v1/tasks：LIVE 目标任务，agent = hosted、executor = hosted、可选允许卖出
 *   3. GET /v1/tasks/:id/delegation → 逐项签 TradeMandate（POST /authorize）与 EIP-2612 permit（POST /allowances）；permit 由服务器执行身份中继，等它 confirmed
 *   4. 观察 GET /v1/tasks/:id/activity（增量游标），直到 --watch-min 用完或出现 --stop-after-fills 笔成交；摘要写 scripts/out/
 *   5. 结束时吊销本次签发的 API key（任务继续由托管 Agent 值守；--cancel 则同时取消任务）
 * 接着做已有任务：--task-id <id>（补完清单里还没签的项，然后观察；会重新签发一把 key，结束吊销）。
 *
 * 安全：
 *   - 缺省 dry-run：只读检查（healthz、托管开关、余额），打印计划；不签名、不建任务。
 *   - --execute 需交互输入 yes（打印金额、资产、地址）。
 *   - 演示钱包私钥只在运行时从 .qa-live/demo-wallet.env 读取，从不打印；脚本不发任何链上交易（owner 交易数应保持不变）。
 *   - 硬上限：预算 ≤ 10 USDG、每笔 ≤ 3 USDG；签名前核对 typedData 的 chainId、verifyingContract（PlanGuard）、owner、spender、permit value ≤ 预算 × 1.01。
 *
 * 用法（仓库根目录）：
 *   pnpm --filter @chaconne/verify-service exec tsx scripts/v7HostedLive.ts                 # dry-run
 *   pnpm --filter @chaconne/verify-service exec tsx scripts/v7HostedLive.ts --execute       # 真实首单（交互确认）
 *   参数：--budget 6 --per-step 2 --max-steps 3 --assets AAPLx,NVDAx --allow-sell --hours 48 --watch-min 45 --stop-after-fills 1 --strategy "<text>" --cancel --yes
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createPublicClient, http, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { apiKeyIssueMessage } from "@chaconne/core/verify";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "..", "..", "..");
const OUT_DIR = join(here, "out");
const RUN_TS = new Date().toISOString().replace(/[:.]/g, "-");

const CHAIN_ID = 196;
const PROD_PLANGUARD = "0xe8517f296211f4b9175796baab47979fb14fd2f0";
/** 资产地址只从登记表读（与生产服务同一份 config/registry.xlayer.v1.2.json），不手写 */
const REGISTRY = JSON.parse(readFileSync(join(here, "..", "config", "registry.xlayer.v1.2.json"), "utf8")) as { entries: Array<{ displaySymbol: string; tokenAddress: string }> };
const TOKENS: Record<string, Hex> = Object.fromEntries(REGISTRY.entries.map((e) => [e.displaySymbol.toUpperCase(), e.tokenAddress.toLowerCase() as Hex]));
const KEY = (t: string) => `eip155:${CHAIN_ID}:${t.toLowerCase()}`;
const MAX_BUDGET_RAW = 10_000_000n;
const MAX_PER_STEP_RAW = 3_000_000n;
const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

const { values: argv } = parseArgs({
  options: {
    execute: { type: "boolean", default: false },
    yes: { type: "boolean", default: false },
    "base-url": { type: "string", default: "https://verify.chaconne.xyz" },
    "rpc-url": { type: "string", default: "https://rpc.xlayer.tech" },
    "owner-key-file": { type: "string", default: join(REPO, ".qa-live", "demo-wallet.env") },
    budget: { type: "string", default: "6" },
    "per-step": { type: "string", default: "2" },
    "max-steps": { type: "string", default: "3" },
    assets: { type: "string", default: "AAPLx,NVDAx" },
    "allow-sell": { type: "boolean", default: false },
    hours: { type: "string", default: "48" },
    "watch-min": { type: "string", default: "45" },
    "stop-after-fills": { type: "string", default: "1" },
    strategy: { type: "string" },
    "task-id": { type: "string" },
    cancel: { type: "boolean", default: false },
  },
  strict: true,
});
const BASE = String(argv["base-url"]).replace(/\/+$/, "");
const usdgRaw = (s: string) => {
  if (!/^\d+(\.\d{1,6})?$/.test(s)) throw new Error(`bad USDG amount ${s}`);
  const [w, f = ""] = s.split(".");
  return BigInt(w!) * 1_000_000n + BigInt((f + "000000").slice(0, 6));
};
const BUDGET = usdgRaw(String(argv.budget));
const PER_STEP = usdgRaw(String(argv["per-step"]));
const MAX_STEPS = Number(argv["max-steps"]);
if (BUDGET > MAX_BUDGET_RAW || PER_STEP > MAX_PER_STEP_RAW || PER_STEP > BUDGET || !(MAX_STEPS >= 1 && MAX_STEPS <= 10)) throw new Error("budget ≤ 10 USDG, per-step ≤ 3 USDG ≤ budget, 1 ≤ max-steps ≤ 10");
const ASSETS = String(argv.assets).split(",").map((s) => s.trim().toUpperCase());
if (!TOKENS["USDG"]) throw new Error("USDG missing from registry");
for (const a of ASSETS) if (!TOKENS[a] || a.startsWith("USD")) throw new Error(`unknown stock ${a}`);
const HOURS = Number(argv.hours);
const WATCH_MS = Number(argv["watch-min"]) * 60_000;
const STOP_AFTER_FILLS = Number(argv["stop-after-fills"]);
const STRATEGY = argv.strategy ?? "Build a small starter position in the allowed stocks over the next two days. Buy in small steps, at most one buy per hour, and only when the quote and the latest context look normal. If the context is unclear or a major release is pending, wait. Keep a written reason for every decision.";

mkdirSync(OUT_DIR, { recursive: true });
const summary: Record<string, unknown> = { kind: "chaconne-v7-hosted-live", startedAt: new Date().toISOString(), baseUrl: BASE };
const say = (msg: string, extra?: unknown) => process.stderr.write(`[v7live ${new Date().toISOString().slice(11, 19)}] ${msg}${extra === undefined ? "" : " " + JSON.stringify(extra)}\n`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const fmt6 = (raw: bigint) => `${raw / 1_000_000n}.${(raw % 1_000_000n).toString().padStart(6, "0")}`;
const save = () => writeFileSync(join(OUT_DIR, `v7HostedLive-${RUN_TS}.json`), JSON.stringify(summary, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");

async function http0(method: string, path: string, body?: unknown, key?: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json", ...(key ? { "x-api-key": key } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  const text = await r.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  return { status: r.status, json };
}

function readKey(file: string): Hex {
  const m = /^\s*DEMO_USER_PRIVATE_KEY\s*=\s*["']?(0x)?([0-9a-fA-F]{64})["']?\s*$/m.exec(readFileSync(file, "utf8"));
  if (!m) throw new Error(`DEMO_USER_PRIVATE_KEY not found in ${file}`);
  return `0x${m[2]}` as Hex;
}

async function confirm(): Promise<void> {
  if (argv.yes) return;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const ans = await new Promise<string>((r) => rl.question("type yes to continue: ", r));
  rl.close();
  if (ans.trim() !== "yes") throw new Error("aborted");
}

type TD = { domain: Record<string, unknown>; types: Record<string, Array<{ name: string; type: string }>>; primaryType: string; message: Record<string, string> };
type Item = { id: string; kind: string; status: string; typedData: TD | null; permitRequestId?: string; txHash?: string | null; error?: { code: string; message?: string } };
type Checklist = { items: Item[]; counts: { signaturesNeeded: number; signaturesDone: number; userTransactions: number }; buyReady: boolean; sellReady: Record<string, boolean>; complete: boolean };

async function main(): Promise<void> {
  const owner = privateKeyToAccount(readKey(String(argv["owner-key-file"])));
  const ownerAddr = owner.address.toLowerCase();
  const pub = createPublicClient({ transport: http(String(argv["rpc-url"])) });
  if ((await pub.getChainId()) !== CHAIN_ID) throw new Error("RPC is not X Layer 196");
  const hz = await http0("GET", "/healthz");
  if (hz.status !== 200 || String(hz.json["planGuard"]).toLowerCase() !== PROD_PLANGUARD) throw new Error(`healthz ${hz.status} planGuard ${String(hz.json["planGuard"])}`);
  const bal = async (t: Hex) => (await pub.readContract({ address: t, abi: ERC20, functionName: "balanceOf", args: [owner.address] })) as bigint;
  const before = { usdg: await bal(TOKENS.USDG!), okb: await pub.getBalance({ address: owner.address }), nonce: await pub.getTransactionCount({ address: owner.address }) };
  summary["owner"] = ownerAddr;
  summary["before"] = before;
  say(`owner ${owner.address}  USDG ${fmt6(before.usdg)}  owner tx count ${before.nonce}`);

  const resume = !!argv["task-id"];
  if (!resume) {
    if (before.usdg < BUDGET) throw new Error(`demo wallet has ${fmt6(before.usdg)} USDG < budget ${fmt6(BUDGET)}`);
    say("plan", { task: "LIVE, agent hosted, executor hosted", assets: ASSETS, budgetUsdg: fmt6(BUDGET), perStepUsdg: fmt6(PER_STEP), maxSteps: MAX_STEPS, allowSell: argv["allow-sell"], hours: HOURS, strategy: STRATEGY });
    if (!argv.execute) {
      say("dry-run only; add --execute to create the task and sign");
      return;
    }
    await confirm();
  } else if (argv.execute) await confirm();
  else {
    say("dry-run only; add --execute to resume the task");
    return;
  }

  // 1. owner API key
  const fields = { owner: ownerAddr, label: `v7-live-${RUN_TS.slice(0, 16)}`.slice(0, 40), nonce: randomBytes(16).toString("hex"), issuedAt: new Date().toISOString() };
  const kr = await http0("POST", "/v1/keys", { ownerAddress: fields.owner, label: fields.label, nonce: fields.nonce, issuedAt: fields.issuedAt, signature: await owner.signMessage({ message: apiKeyIssueMessage(fields) }) });
  if (kr.status !== 201) throw new Error(`POST /v1/keys ${kr.status} ${JSON.stringify(kr.json).slice(0, 300)}`);
  const apiKey = String(kr.json["apiKey"]);
  const keyId = String(kr.json["id"]);
  const api = (m: string, p: string, b?: unknown) => http0(m, p, b, apiKey);
  let taskId = argv["task-id"] ?? null;
  try {
    if (!taskId) {
      // 2. 建任务
      const created = await api("POST", "/v1/tasks", {
        clientRequestId: `v7live-${RUN_TS}`,
        mode: "LIVE",
        ownerAddress: ownerAddr,
        strategy: STRATEGY,
        agent: { mode: "hosted" },
        executor: { mode: "hosted" },
        scope: { objective: "Chaconne Agent first live hosted run", inputAssetKey: KEY(TOKENS.USDG!), outputAssetKeys: ASSETS.map((a) => KEY(TOKENS[a]!)), budgetCapRaw: BUDGET.toString(), perStepCapRaw: PER_STEP.toString(), maxSteps: MAX_STEPS, deadline: new Date(Date.now() + HOURS * 3600_000).toISOString(), allowSell: argv["allow-sell"] },
      });
      if (created.status !== 201) throw new Error(`POST /v1/tasks ${created.status} ${JSON.stringify(created.json).slice(0, 600)}`);
      taskId = String((created.json["task"] as { id: string }).id);
      summary["task"] = { id: taskId };
      say("task created", { taskId });
      save();
    } else say("resuming task", { taskId });
    {

      // 3. 委托清单
      const checklist = async (): Promise<Checklist> => {
        const r = await api("GET", `/v1/tasks/${taskId}/delegation`);
        if (r.status !== 200) throw new Error(`delegation ${r.status} ${JSON.stringify(r.json).slice(0, 400)}`);
        return r.json as unknown as Checklist;
      };
      const c0 = await checklist();
      summary["delegationInitial"] = { items: c0.items.map((i) => `${i.id}:${i.status}`), counts: c0.counts };
      say("checklist", summary["delegationInitial"]);
      let signatures = 0;
      for (const it of c0.items.filter((i) => i.kind !== "permit" && i.status === "todo")) {
        const td = it.typedData!;
        const m = td.message;
        if (Number(td.domain["chainId"]) !== CHAIN_ID || String(td.domain["verifyingContract"]).toLowerCase() !== PROD_PLANGUARD || m["owner"]!.toLowerCase() !== ownerAddr || m["recipient"]!.toLowerCase() !== ownerAddr) throw new Error(`mandate ${it.id}: unexpected domain or parties`);
        const sig = await owner.signTypedData({ domain: td.domain, types: { TradeMandate: td.types["TradeMandate"]! }, primaryType: "TradeMandate", message: { ...m, budgetCap: BigInt(m["budgetCap"]!), perStepCap: BigInt(m["perStepCap"]!), maxSteps: Number(m["maxSteps"]), validFrom: BigInt(m["validFrom"]!), deadline: BigInt(m["deadline"]!), nonce: BigInt(m["nonce"]!) } } as never);
        signatures += 1;
        const r = await api("POST", `/v1/tasks/${taskId}/authorize`, { itemId: it.id, signature: sig });
        if (r.status !== 200 && r.status !== 201) throw new Error(`authorize ${it.id} ${r.status} ${JSON.stringify(r.json).slice(0, 400)}`);
        say(`signed ${it.id}`);
      }
      const permits: Array<{ item: string; txHash: string | null; value: string }> = [];
      for (let guard = 0; guard < 10; guard++) {
        const c = await checklist();
        const todo = c.items.find((i) => i.kind === "permit" && i.status === "todo" && i.permitRequestId);
        if (!todo) break;
        const td = todo.typedData!;
        const m = td.message;
        const cap = (it: string) => (it.includes(TOKENS.USDG!) || it.toLowerCase().includes("usdg") ? (BUDGET * 101n) / 100n + 1n : null);
        const limit = cap(todo.id);
        if (m["owner"]!.toLowerCase() !== ownerAddr || m["spender"]!.toLowerCase() !== PROD_PLANGUARD || Number(td.domain["chainId"]) !== CHAIN_ID || (limit !== null && BigInt(m["value"]!) > limit)) throw new Error(`permit ${todo.id}: unexpected owner / spender / value`);
        const sig = await owner.signTypedData({ domain: td.domain, types: { Permit: td.types["Permit"]! }, primaryType: "Permit", message: { owner: m["owner"], spender: m["spender"], value: BigInt(m["value"]!), nonce: BigInt(m["nonce"]!), deadline: BigInt(m["deadline"]!) } } as never);
        signatures += 1;
        const sub = await api("POST", `/v1/tasks/${taskId}/allowances`, { permitRequestId: todo.permitRequestId, signature: sig });
        if (sub.status !== 202) throw new Error(`allowances ${todo.id} ${sub.status} ${JSON.stringify(sub.json).slice(0, 400)}`);
        say(`signed ${todo.id} (value ${m["value"]}); waiting for the platform executor to relay it`);
        let done: Item | null = null;
        for (const t0 = Date.now(); Date.now() - t0 < 180_000 && !done; await sleep(3000)) {
          const x = (await checklist()).items.find((i) => i.id === todo.id);
          if (x?.status === "failed") throw new Error(`permit ${todo.id} failed: ${JSON.stringify(x.error)}`);
          if (x?.status === "confirmed") done = x;
        }
        if (!done) throw new Error(`permit ${todo.id} not confirmed within 3 min`);
        permits.push({ item: todo.id, txHash: done.txHash ?? null, value: m["value"]! });
        say(`permit confirmed`, { item: todo.id, txHash: done.txHash });
      }
      const c1 = await checklist();
      summary["delegation"] = { items: c1.items.map((i) => `${i.id}:${i.status}`), counts: c1.counts, signaturesProduced: signatures, permits, buyReady: c1.buyReady, sellReady: c1.sellReady, complete: c1.complete };
      say("delegation done", summary["delegation"]);
      save();
      if (!c1.buyReady) throw new Error("buy not ready after delegation");
    }

    // 4. 观察活动流
    let cursor: string | null = null;
    let fills = 0;
    const seen: unknown[] = [];
    let lastRuntime: unknown = null;
    for (const t0 = Date.now(); Date.now() - t0 < WATCH_MS; await sleep(15_000)) {
      const r = await api("GET", `/v1/tasks/${taskId}/activity${cursor ? `?since=${cursor}` : ""}`);
      if (r.status !== 200) {
        say(`activity ${r.status}`);
        continue;
      }
      const items = (r.json["items"] as Array<Record<string, unknown>>) ?? [];
      cursor = (r.json["nextCursor"] as string | null) ?? cursor;
      for (const it of items) {
        seen.push(it);
        say(`· ${String(it["at"] ?? "").slice(11, 19)} ${String(it["type"])} [${String(it["actor"] ?? "")}] ${String(it["note"] ?? "").slice(0, 160)}${it["ref"] ? ` ref ${String(it["ref"])}` : ""}`);
        if (it["type"] === "step_confirmed") fills += 1;
      }
      const rt = r.json["runtime"];
      if (JSON.stringify(rt) !== JSON.stringify(lastRuntime)) {
        lastRuntime = rt;
        say("runtime", rt);
      }
      summary["activity"] = seen;
      summary["runtime"] = rt;
      summary["taskStatus"] = r.json["taskStatus"];
      save();
      if (fills >= STOP_AFTER_FILLS) {
        say(`${fills} fill(s) seen; stopping the watch`);
        break;
      }
    }
    summary["fillsSeen"] = fills;

    const runs = await api("GET", `/v1/tasks/${taskId}/runs`);
    summary["runs"] = runs.json;
    if (argv.cancel) {
      const c = await api("POST", `/v1/tasks/${taskId}/cancel`, {});
      say(`cancel → ${c.status}`);
    }
  } finally {
    const d = await http0("DELETE", `/v1/keys/${keyId}`, undefined, apiKey).catch(() => ({ status: 0 }));
    say(`api key revoked → ${d.status}`);
    const after = { usdg: await bal(TOKENS.USDG!), okb: await pub.getBalance({ address: owner.address }), nonce: await pub.getTransactionCount({ address: owner.address }) };
    const stocks: Record<string, string> = {};
    for (const a of ASSETS) stocks[a] = (await bal(TOKENS[a]!)).toString();
    summary["after"] = { ...after, stocks };
    summary["ownerTransactionsSent"] = after.nonce - before.nonce;
    summary["finishedAt"] = new Date().toISOString();
    save();
    say(`done. owner transactions sent: ${after.nonce - before.nonce}; USDG ${fmt6(before.usdg)} → ${fmt6(after.usdg)}; summary in scripts/out/v7HostedLive-${RUN_TS}.json`);
  }
}

main().catch((e) => {
  summary["error"] = e instanceof Error ? e.message : String(e);
  save();
  say(`ERROR ${summary["error"]}`);
  process.exit(1);
});

