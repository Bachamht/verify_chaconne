import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FIXTURE_MODE, FIXTURE_TASK } from "@/components/features/home/fixture";
import { HOME_COPY, PLANGUARD } from "@/components/features/home/copy";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FEATURE = join(WEB, "components/features/home");

function read(rel: string): string {
  return readFileSync(join(WEB, rel), "utf8");
}

function importsOf(src: string): string[] {
  return [...src.matchAll(/(?:import|export)\s[^"']*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|^import\s+["']([^"']+)["']/gm)]
    .map((m) => m[1] ?? m[2] ?? m[3] ?? "");
}

/** 从首页入口沿本地 import 走一遍（@/ 与相对路径），收集首页 v8 静态依赖到的所有文件 */
function staticGraph(entry: string): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop()!;
    if (graph.has(file)) continue;
    const src = readFileSync(file, "utf8");
    const specs = importsOf(src);
    graph.set(file, specs);
    for (const s of specs) {
      const base = s.startsWith("@/") ? join(WEB, s.slice(2)) : s.startsWith(".") ? resolve(dirname(file), s) : null;
      if (!base) continue;
      const hit = [".tsx", ".ts", "/index.ts", "/index.tsx", ""].map((ext) => base + ext).find((p) => {
        try { readFileSync(p); return true; } catch { return false; }
      });
      if (hit && /\.(tsx?|ts)$/.test(hit)) stack.push(hit);
    }
  }
  return graph;
}

describe("v8 home: FIXTURE data is always labelled", () => {
  it("every block of the example task carries mode FIXTURE", () => {
    expect(FIXTURE_TASK.mode).toBe(FIXTURE_MODE);
    expect(FIXTURE_TASK.agentSays.mode).toBe("FIXTURE");
    expect(FIXTURE_TASK.steps.length).toBeGreaterThanOrEqual(3);
    for (const s of FIXTURE_TASK.steps) expect(s.mode).toBe("FIXTURE");
    expect(FIXTURE_TASK.evidence.length).toBeGreaterThanOrEqual(2);
    for (const e of FIXTURE_TASK.evidence) {
      expect(e.mode).toBe("FIXTURE");
      expect(e.hash).toMatch(/example/);
    }
    expect(FIXTURE_TASK.id).toMatch(/example/);
  });
  it("the preview renders a FIXTURE ModeTag in the header, on AgentSays and in every evidence row", () => {
    const src = read("components/features/home/HomePreview.tsx");
    expect(src).toMatch(/<ModeTag mode=\{T\.mode\} \/>/);
    expect(src).toMatch(/<ModeTag mode=\{T\.agentSays\.mode\} \/>/);
    expect(src).toMatch(/mode=\{e\.mode\}/);
  });
  it("only an on-chain confirmation is called a fill", () => {
    const fills = FIXTURE_TASK.kpis.find((k) => k.key === "fills");
    expect(fills?.label.zh).toBe("已成交");
    const confirmed = FIXTURE_TASK.steps.filter((s) => s.note?.zh.includes("成交"));
    expect(confirmed).toHaveLength(0);
  });
});

describe("v8 home: copy rules", () => {
  const all = (l: "zh" | "en") => JSON.stringify(HOME_COPY[l]) + JSON.stringify(FIXTURE_TASK);
  it("never promises outcomes we cannot guarantee", () => {
    for (const l of ["zh", "en"] as const) {
      expect(all(l)).not.toMatch(/失败交易不花钱|最多只损失余额|只签一次/);
      expect(all(l)).not.toMatch(/failed trades (are|cost) (free|nothing)|lose at most your balance|sign only once/i);
    }
  });
  it("Chinese copy has no em-dash and no English tagline", () => {
    const zh = JSON.stringify(HOME_COPY.zh);
    expect(zh).not.toContain("——");
    expect(zh).not.toMatch(/NO FOMO|JUST TEMPO|BRING YOUR OWN AGENT/);
  });
  it("the sign-in card says the message is only for signing in (home no longer carries the note, 10/5)", () => {
    const gate = readFileSync(join(WEB, "components/shell/SignInGateV8.tsx"), "utf8");
    expect(gate).toContain("这条消息只用于登录");
    expect(gate).toMatch(/This message signs you in/);
  });
  it("three steps: brief, observe, authorize", () => {
    expect(HOME_COPY.zh.steps.map((s) => s.title)).toEqual(["交代", "观察", "授权"]);
    expect(HOME_COPY.en.steps).toHaveLength(3);
  });
  it("contract address is a full address", () => {
    expect(PLANGUARD).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});

describe("v8 home: no wallet code on the home page (D6)", () => {
  // app/page.tsx 用内联构建期常量 + require 选版本：v8 构建只留 HomeV8 这一支
  const graph = staticGraph(join(WEB, "components/features/home/HomeV8.tsx"));
  const files = [...graph.keys()].map((f) => f.replace(/\\/g, "/"));
  it("the route picks HomeV8 at build time and keeps the legacy page out of the v8 bundle", () => {
    const page = read("app/page.tsx");
    expect(page).toMatch(/process\.env\.NEXT_PUBLIC_V8_UI === "1"\s*(?:\/\/[^\n]*\n\s*)?\?\s*\(require\("@\/components\/features\/home\/HomeV8"\)/);
    expect(page).not.toMatch(/^import\s+(?!type)[^;]*from\s+["'](\.\/HomeLegacy|@\/components\/features)/m);
    expect(files.some((f) => f.endsWith("components/features/home/HomePreview.tsx"))).toBe(true);
    expect(files.some((f) => f.endsWith("app/HomeLegacy.tsx"))).toBe(false);
  });
  it("the root layout does not statically import the v7 chrome (it pulls viem into every route)", () => {
    const layout = read("app/layout.tsx");
    expect(layout).not.toMatch(/^import[^;]*from\s+["']@\/components\/(Header|Footer|WalletChooser)["']/m);
  });
  it("never imports lib/wallet, lib/api, lib/session or viem", () => {
    for (const [file, specs] of graph) {
      for (const s of specs) {
        expect(s, `${file} imports ${s}`).not.toMatch(/^viem|lib\/(wallet|api|api-v2|session|mandate|walletRequest|useAccount|useWalletStatus)$/);
      }
    }
  });
  it("feature files do not import legacy CSS", () => {
    for (const f of readdirSync(FEATURE)) {
      const src = readFileSync(join(FEATURE, f), "utf8");
      expect(src).not.toMatch(/home\.css|Conductor/);
    }
    expect(read("app/page.tsx")).not.toMatch(/import\s+["'][^"']*\.css["']/);
  });
  it("exactly one solid primary button on the page", () => {
    const srcs = readdirSync(FEATURE).map((f) => readFileSync(join(FEATURE, f), "utf8")).join("\n");
    const buttons = [...(srcs.match(/<Button\b[^>]*>/g) ?? []), ...(srcs.match(/buttonVariants\([^)]*\)/g) ?? [])];
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).not.toMatch(/variant/);
    expect(read("components/features/home/HomeHero.tsx")).toMatch(/<Link href="\/start" className=\{buttonVariants\(/);
  });
});
