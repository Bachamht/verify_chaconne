/**
 * P-09 · v7 文案：每条都有中英两份、占位符两边一致；不夸大（不写 100% 安全 / 合规 / 保证收益）；
 * 公开导出扫描器的禁词与「12 个小写词连写」助记词形态都不出现。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tv, V7_STRINGS } from "../lib/i18n.v7";

const MNEMONIC = /\b(?:[a-z]{3,8} ){11}[a-z]{3,8}\b/;
const OVERCLAIM = /100%\s*(安全|safe)|绝对安全|(?<!不)保证收益|(?<!not )guaranteed|risk[- ]free|零风险|合规|compliant|官方认证/i;

describe("P-09 · v7 双语字典", () => {
  it("每条中英都非空，占位符一致", () => {
    for (const [k, v] of Object.entries(V7_STRINGS)) {
      expect(v.zh.trim(), k).not.toBe("");
      expect(v.en.trim(), k).not.toBe("");
      const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect(ph(v.zh), k).toEqual(ph(v.en));
    }
  });
  it("不夸大；没有助记词形态的长串小写英文", () => {
    for (const [k, v] of Object.entries(V7_STRINGS)) {
      expect(OVERCLAIM.test(v.zh) || OVERCLAIM.test(v.en), k).toBe(false);
      expect(MNEMONIC.test(v.en), `${k}: ${v.en}`).toBe(false);
    }
  });
  it("变量替换", () => {
    expect(tv("zh", "d_counter", { done: 1, needed: 2, tx: 0, gas: "0" })).toBe("签名 1 / 2 · 你的交易 0 · gas 0");
    expect(tv("en", "d_counter", { done: 1, needed: 2, tx: 0, gas: "0" })).toBe("Signatures 1 / 2 · your transactions 0 · gas 0");
  });
  it("没有需要你处理的事（P-03 空态）两种语言都有", () => {
    expect(tv("zh", "q4_none")).toBe("没有需要你处理的事。");
    expect(tv("en", "q4_none")).toBe("Nothing needs your attention.");
  }, 30_000);
});

describe("公开导出扫描（v7 新文件）", () => {
  const ROOT = join(__dirname, "..");
  const files: string[] = [];
  const walk = (d: string) => { for (const n of readdirSync(d)) { if (n === "node_modules" || n.startsWith(".next")) continue; const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|tsx|css)$/.test(n)) files.push(p); } };
  walk(ROOT);
  it("verify-web 里没有大写的模型厂商名与内部协作词，没有助记词形态", () => {
    const banned = ["Cl" + "aude", "Anth" + "ropic", "AI_" + "SYNC", "DECI" + "SIONS", "sub" + "agent", "fork " + "agent", "claude.ai" + "/code"];
    const hits: string[] = [];
    for (const f of files) {
      readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        for (const b of banned) if (line.includes(b)) hits.push(`${f}:${i + 1} ${b}`);
        if (MNEMONIC.test(line)) hits.push(`${f}:${i + 1} mnemonic-like`);
      });
    }
    expect(hits).toEqual([]);
  }, 30_000);
});
