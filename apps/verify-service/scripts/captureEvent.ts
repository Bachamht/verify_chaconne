/**
 * v7 Lane I / D（开发计划 §3.1 第 4 条）：事件窗口采集——v7 第一份真实 REPLAY 素材。
 * 只用生产环境的公开端点，不需要任何凭据：
 *   /v1/context?tier=agent、/v1/events（±48 h）、/pub/market/xlayer（100 / 1k / 10k USDG 买入报价）
 * 每 60 s 采一次，追加写 <out>/{context,events,market}.jsonl；结束时写 manifest.json（每个文件 sha256、行数、采集起止、来源 URL）。
 *
 * 用法：
 *   pnpm --filter @chaconne/verify-service exec tsx scripts/captureEvent.ts \
 *     --out "../../.probes/2026-10-02_NFP" --start 2026-10-02T11:30:00Z --end 2026-10-02T15:00:00Z
 *   （布里斯班 21:30 → 次日 01:00；--start 未到会先等待）
 * 本机睡眠会中断采集：重要窗口请在常开机器（服务器）上跑，或本机 `caffeinate -i` 保持唤醒。
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const opt = (name: string, dflt?: string): string => {
  const i = args.indexOf(name);
  if (i >= 0 && args[i + 1]) return args[i + 1]!;
  if (dflt === undefined) throw new Error(`缺少参数 ${name}`);
  return dflt;
};

const BASE = opt("--base", "https://verify.chaconne.xyz");
const OUT = resolve(opt("--out"));
const START = new Date(opt("--start", new Date().toISOString()));
const END = new Date(opt("--end"));
const INTERVAL_MS = Number(opt("--interval-ms", "60000"));
if (!(END > START)) throw new Error("--end 必须晚于 --start");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha256File = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

function sources(now: Date): Record<string, string> {
  const from = new Date(now.getTime() - 48 * 3600_000).toISOString();
  const to = new Date(now.getTime() + 48 * 3600_000).toISOString();
  return {
    context: `${BASE}/v1/context?tier=agent`,
    events: `${BASE}/v1/events?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    market: `${BASE}/pub/market/xlayer`,
  };
}

async function fetchOne(url: string): Promise<{ status: number; ms: number; body: unknown; error?: string }> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: { accept: "application/json" } });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* 非 JSON 原样保存 */
    }
    return { status: res.status, ms: Date.now() - t0, body };
  } catch (e) {
    return { status: 0, ms: Date.now() - t0, body: null, error: e instanceof Error ? e.message : String(e) };
  }
}

function writeManifest(firstAt: string | null, lastAt: string | null, rounds: number): void {
  const files: Record<string, { sha256: string; lines: number }> = {};
  for (const k of ["context", "events", "market"]) {
    const p = join(OUT, `${k}.jsonl`);
    if (!existsSync(p)) continue;
    files[`${k}.jsonl`] = { sha256: sha256File(p), lines: readFileSync(p, "utf8").split("\n").filter(Boolean).length };
  }
  const manifest = {
    schema: "chaconne-capture/1",
    mode: "REPLAY source (LIVE capture of public production endpoints)",
    purpose: "US September 2026 Employment Situation (BLS, 2026-10-02 08:30 ET) window",
    base: BASE,
    sources: sources(new Date()),
    plannedWindow: { start: START.toISOString(), end: END.toISOString(), intervalMs: INTERVAL_MS },
    captured: { firstAt, lastAt, rounds },
    files,
    writtenAt: new Date().toISOString(),
  };
  writeFileSync(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  // 按墙上时钟分段等待：笔记本睡眠时单个长 setTimeout 会暂停计时，唤醒后仍在等（2026-10-02 非农窗口因此漏采）
  if (START.getTime() > Date.now()) console.info(`等待采集开始：${START.toISOString()}（${Math.round((START.getTime() - Date.now()) / 60000)} 分钟后）`);
  while (START.getTime() > Date.now()) await sleep(Math.min(30_000, START.getTime() - Date.now()));
  let firstAt: string | null = null;
  let lastAt: string | null = null;
  let rounds = 0;
  while (Date.now() < END.getTime()) {
    const tick = Date.now();
    const at = new Date(tick).toISOString();
    const src = sources(new Date(tick));
    const results = await Promise.all(Object.entries(src).map(async ([k, url]) => [k, url, await fetchOne(url)] as const));
    for (const [k, url, r] of results) {
      appendFileSync(join(OUT, `${k}.jsonl`), JSON.stringify({ capturedAt: at, url, status: r.status, latencyMs: r.ms, error: r.error ?? null, body: r.body }) + "\n");
    }
    firstAt ??= at;
    lastAt = at;
    rounds += 1;
    console.info(`${at} 第 ${rounds} 轮：${results.map(([k, , r]) => `${k}=${r.status}`).join(" ")}`);
    writeManifest(firstAt, lastAt, rounds);
    while (Date.now() < tick + INTERVAL_MS && Date.now() < END.getTime()) await sleep(Math.min(5_000, tick + INTERVAL_MS - Date.now()));
  }
  writeManifest(firstAt, lastAt, rounds);
  console.info(`采集结束：${rounds} 轮，manifest 已写入 ${join(OUT, "manifest.json")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
