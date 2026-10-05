import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FLOW_COPY, FLOW_STEPS, FLOW_TAGS, LEGEND } from "@/components/features/home/flowCopy";
import { MASCOT, SCENES, STATIONS } from "@/components/features/home/scoreScene";
import { BEAT, beatTimes, CUES, flashes, IMPACT, LOOP, normalCues, rippleScale, rogueCue, STILL_AT, track } from "@/components/features/home/scoreTimeline";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FEATURE = join(WEB, "components/features/home");
const read = (rel: string) => readFileSync(join(WEB, rel), "utf8");
const CSS = read("app/globals.css");
const HEX = /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![-\w])/;

/** keyTimes 从 0 到 1 严格递增，样条数 = 区间数，取值个数 = 时刻个数 */
function expectWellFormed(tr: ReturnType<typeof track>) {
  const times = tr.keyTimes.split(";").map(Number);
  expect(times[0]).toBe(0);
  expect(times[times.length - 1]).toBe(1);
  times.slice(1).forEach((t, i) => expect(t, tr.keyTimes).toBeGreaterThan(times[i]!));
  expect(tr.values.split(";")).toHaveLength(times.length);
  expect(tr.keySplines.split(";")).toHaveLength(times.length - 1);
}

describe("v8 home score: copy stays short and true", () => {
  it("every label exists in both languages and stays a label", () => {
    for (const l of ["zh", "en"] as const) {
      for (const tag of FLOW_TAGS) {
        expect(FLOW_COPY[l].tags[tag], `${l} ${tag}`).toBeTruthy();
        expect(FLOW_COPY[l].tags[tag].length, `${l} ${tag}`).toBeLessThanOrEqual(20);
      }
      for (const k of LEGEND) expect(FLOW_COPY[l].legend[k].length, `${l} legend ${k}`).toBeLessThanOrEqual(16);
      expect(FLOW_COPY[l].blocked.length).toBeLessThanOrEqual(8);
    }
    // 四站按资金实际经过的顺序编号：核验 → PlanGuard → OKX DEX → 钱包
    expect(Object.entries(FLOW_STEPS).sort((a, b) => a[1]!.localeCompare(b[1]!)).map(([k]) => k)).toEqual(["verify", "guard", "dex", "wallet"]);
    // 画面为主：说明一句话
    expect(FLOW_COPY.zh.lead.length).toBeLessThanOrEqual(64);
    expect(FLOW_COPY.en.lead.length).toBeLessThanOrEqual(200);
  });
  it("Chinese copy has no em-dash; nothing promises a single signature", () => {
    expect(JSON.stringify(FLOW_COPY.zh)).not.toContain("——");
    expect(JSON.stringify(FLOW_COPY.zh)).not.toMatch(/只签一次|失败交易不花钱/);
    expect(JSON.stringify(FLOW_COPY.en)).not.toMatch(/sign only once|failed trades (are|cost) (free|nothing)/i);
  });
  it("names the PlanGuard contract, the allowance and the wallet, so the Funds page reads the same", () => {
    expect(FLOW_COPY.zh.tags.guard).toContain("PlanGuard");
    expect(FLOW_COPY.zh.tags.allowance).toBe("额度");
    expect(FLOW_COPY.zh.lead).toMatch(/额度只授权给 PlanGuard/);
    expect(FLOW_COPY.en.lead).toMatch(/allowance goes only to the PlanGuard contract/i);
    expect(FLOW_COPY.zh.summary).toMatch(/核验.*PlanGuard.*OKX DEX.*钱包.*拦下/);
    expect(FLOW_COPY.en.summary).toMatch(/verified.*PlanGuard.*OKX DEX.*wallet.*stopped/);
  });
  it("the retired Guard (v1) contract is not mentioned anywhere on the home page", () => {
    for (const f of readdirSync(FEATURE)) {
      const src = readFileSync(join(FEATURE, f), "utf8");
      expect(src, f).not.toMatch(/(?<!Plan)Guard\b/);
      expect(src, f).not.toMatch(/0x02834e26/i);
    }
  });
});

describe("v8 home score: one 12-second timeline", () => {
  it("every phrase finishes inside the loop, and the conductor's wind-up never starts before 0", () => {
    for (const c of CUES) expect(c.at - 0.35).toBeGreaterThanOrEqual(0);
    for (const c of normalCues) expect(c.at + BEAT.wallet + 0.8, `cue ${c.at}`).toBeLessThan(LOOP);
    expect(rogueCue.at + IMPACT + 0.08 + 0.16 + 1.25 + 0.35).toBeLessThan(LOOP);
    expect(STILL_AT).toBeGreaterThan(0);
    expect(STILL_AT).toBeLessThan(LOOP);
  });
  it("money moves only after verification, and reaches PlanGuard after the note does", () => {
    expect(BEAT.spawn).toBeLessThan(BEAT.verify);
    expect(BEAT.verify).toBeLessThan(BEAT.verifyOut);
    expect(BEAT.verifyOut).toBeLessThan(BEAT.guard);
    expect(BEAT.coinOut).toBeGreaterThanOrEqual(BEAT.verify);
    expect(BEAT.coinCenter).toBeGreaterThan(BEAT.guard);
    const coin = [BEAT.coinOut, BEAT.coinAttach, BEAT.coinCenter, BEAT.coinGo, BEAT.dex, BEAT.tokenOut, BEAT.wallet, BEAT.done];
    coin.slice(1).forEach((t, i) => expect(t).toBeGreaterThan(coin[i]!));
  });
  it("exactly one note strays, and it never gets a coin or a token", () => {
    expect(CUES.filter((c) => c.rogue)).toHaveLength(1);
    const actors = read("components/features/home/ScoreActors.tsx");
    expect(actors).toMatch(/normalCues\.map\(\(c\) => <Phrase /);
    const rogue = actors.slice(actors.indexOf("function Rogue"), actors.indexOf("export function ScoreActors"));
    expect(rogue).not.toMatch(/coin|token/i);
  });
  it("flashes at the same station never overlap", () => {
    for (const [times, span] of [[beatTimes(BEAT.verify), 0.8], [beatTimes(BEAT.coinCenter), 0.76], [beatTimes(BEAT.wallet), 0.81]] as const) {
      [...times].sort((a, b) => a - b).slice(1).forEach((t, i) => expect(t - times[i]!).toBeGreaterThan(span));
    }
  });
  it("track(): keyTimes run 0 → 1 strictly, one spline per interval, values line up", () => {
    expectWellFormed(track(flashes(beatTimes(BEAT.verify), { rise: 0.12, hold: 0.25, fall: 0.45 })));
    expectWellFormed(track(rippleScale(beatTimes(BEAT.wallet), 0.8, 1.55)));
    expectWellFormed(track(CUES.flatMap((c) => [{ t: c.at - 0.35, v: "0 1 2" }, { t: c.at, v: "-2 1 2" }, { t: c.at + 0.6, v: "0 1 2" }])));
    // 同一时刻的两帧会往后错开一点，而不是写出相等的 keyTimes
    expectWellFormed(track([{ t: 1, v: 0 }, { t: 1, v: 1 }, { t: 2, v: 0 }]));
    // 取值不变的区间走直线
    const flat = track([{ t: 3, v: 0.5 }]);
    expect(flat.keyTimes).toBe("0;0.25;1");
    expect(flat.keySplines).toBe("0 0 1 1;0 0 1 1");
    expect(() => track([{ t: LOOP + 0.5, v: 1 }])).toThrow(/past/);
    expect(() => track([{ t: -0.1, v: 1 }])).toThrow(/before/);
  });
});

describe("v8 home score: geometry", () => {
  for (const scene of Object.values(SCENES)) {
    it(`${scene.key}: stations sit in order along every staff line`, () => {
      expect(scene.lanes.map((l) => l.k)).toEqual([-2, -1, 0, 1, 2]);
      for (const l of scene.lanes) {
        expect(l.f.verify).toBeGreaterThan(0);
        expect(l.f.verify).toBeLessThan(l.f.guard);
        expect(l.f.guard).toBeLessThan(l.f.dex);
        expect(l.f.dex).toBeLessThan(1);
        expect(l.d).not.toMatch(/NaN|Infinity/);
      }
      expect(scene.coin.fAttach).toBeGreaterThan(0);
      expect(scene.coin.fAttach).toBeLessThan(scene.coin.fCenter);
      expect(scene.coin.fCenter).toBeLessThan(1);
      expect(scene.rogue.fVerify).toBeGreaterThan(0);
      expect(scene.rogue.fVerify).toBeLessThan(1);
      for (const d of [scene.band, scene.thread, scene.coin.d, scene.rogue.d]) expect(d).not.toMatch(/NaN|Infinity/);
    });
    it(`${scene.key}: the stray note hits the shield, off the staff`, () => {
      const g = scene.stations.guard;
      const [x, y] = scene.rogue.end;
      expect(Math.abs(x - g.x)).toBeLessThanOrEqual(44 * scene.shield);
      expect(Math.abs(y - g.y)).toBeLessThanOrEqual(60 * scene.shield);
      expect(Math.hypot(x - g.x, y - g.y)).toBeGreaterThan(25);
    });
    it(`${scene.key}: everything is drawn inside the canvas`, () => {
      const inside = (x: number, y: number, pad = 0) => x - pad >= 0 && y - pad >= 0 && x + pad <= scene.w && y + pad <= scene.h;
      expect(inside(scene.tip[0], scene.tip[1])).toBe(true);
      for (const k of STATIONS) expect(inside(scene.stations[k].x, scene.stations[k].y), k).toBe(true);
      expect(inside(scene.wallet.x, scene.wallet.y, scene.wallet.r)).toBe(true);
      expect(inside(scene.mascot.x, scene.mascot.y) && inside(scene.mascot.x + scene.mascot.w, scene.mascot.y + scene.mascot.h)).toBe(true);
      expect(inside(scene.blocked[0], scene.blocked[1], 10)).toBe(true);
    });
    it(`${scene.key}: element ids are scene-prefixed and never read as hex colours`, () => {
      for (const name of ["staff", "band", "halo", "note", "coin", "rogue", "lane-2", "lane0", "lane2"]) {
        const ref = `url(#${scene.id(name)})`;
        expect(ref).toMatch(/^url\(#chs-[wt]-/);
        expect(ref).not.toMatch(HEX);
      }
    });
  }
  it("the two layouts never share an id", () => {
    expect(SCENES.wide.id("staff")).not.toBe(SCENES.tall.id("staff"));
  });
  it("the mascot is the transparent cut-out, and the baton tip is where the staff starts", () => {
    const file = join(WEB, "public", MASCOT.src);
    expect(existsSync(file)).toBe(true);
    const head = readFileSync(file).subarray(0, 30);
    expect(head.toString("latin1", 0, 4)).toBe("RIFF");
    expect(head.toString("latin1", 8, 12)).toBe("WEBP");
    expect(head.toString("latin1", 12, 16)).toBe("VP8X");
    expect(head[20]! & 0x10).toBe(0x10); // alpha
    expect(head.readUIntLE(24, 3) + 1).toBe(MASCOT.w);
    expect(head.readUIntLE(27, 3) + 1).toBe(MASCOT.h);
    for (const scene of Object.values(SCENES)) {
      const s = scene.mascot.h / MASCOT.h;
      expect(scene.tip[0]).toBeCloseTo(scene.mascot.x + MASCOT.tip[0] * s, 1);
      expect(scene.tip[1]).toBeCloseTo(scene.mascot.y + MASCOT.tip[1] * s, 1);
    }
  });
});

describe("v8 home score: page wiring", () => {
  it("the score comes first below the fold, and the section numbers follow it", () => {
    const below = read("components/features/home/HomeBelowFold.tsx");
    expect(below.indexOf("<HomeFlow")).toBeLessThan(below.indexOf("<HomePreview"));
    expect(FLOW_COPY.zh.eyebrow.startsWith("01")).toBe(true);
    expect(FLOW_COPY.en.eyebrow.startsWith("01")).toBe(true);
    const home = read("components/features/home/copy.ts");
    expect(home).toContain('"02 / 任务视角"');
    expect(home).toContain('"04 / A record at every step"');
  });
  it("the drawing is hidden from screen readers and described by a figcaption", () => {
    const flow = read("components/features/home/HomeFlow.tsx");
    expect(flow).toMatch(/className=\{`ch-score-canvas ch-score-\$\{key\}`\} aria-hidden="true"/);
    expect(flow).toMatch(/<figcaption className="sr-only">\{f\.summary\}<\/figcaption>/);
    expect(read("components/features/home/ScoreSvg.tsx")).toMatch(/aria-hidden="true" focusable="false"/);
  });
  it("reduced motion: no pause button, and the player freezes on one still frame", () => {
    expect(CSS).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.ch-score-pause \{ display: none; \}/);
    const player = read("components/features/home/useScorePlayer.ts");
    expect(player).toMatch(/prefers-reduced-motion: reduce/);
    expect(player).toMatch(/svg\.pauseAnimations\(\);\s*svg\.setCurrentTime\(STILL_AT\);/);
  });
  it("every label sits where scoreScene.ts says, in both layouts", () => {
    for (const scene of Object.values(SCENES)) {
      for (const tag of FLOW_TAGS) {
        const m = CSS.match(new RegExp(`\\.ch-score-${scene.key} \\.ch-score-tag\\[data-at="${tag}"\\] \\{ left: ([\\d.]+)%; top: ([\\d.]+)%; \\}`));
        expect(m, `${scene.key} ${tag}`).toBeTruthy();
        const [x, y] = scene.tags[tag];
        expect(Number(m![1]), `${scene.key} ${tag} left`).toBeCloseTo((x / scene.w) * 100, 1);
        expect(Number(m![2]), `${scene.key} ${tag} top`).toBeCloseTo((y / scene.h) * 100, 1);
      }
      expect(CSS).toContain(`.ch-score-${scene.key === "wide" ? "wide { aspect-ratio: 1200 / 400" : "tall { display: none; aspect-ratio: 360 / 600"}`);
      expect([scene.w, scene.h]).toEqual(scene.key === "wide" ? [1200, 400] : [360, 600]);
    }
  });
  it("the phone layout takes over below 768px, in CSS and in the player", () => {
    expect(CSS).toMatch(/@media \(max-width: 767px\) \{[^@]*\.ch-score-wide \{ display: none; \}\s*\.ch-score-tall \{ display: block; \}/);
    expect(read("components/features/home/useScorePlayer.ts")).toContain('"(max-width: 767px)"');
  });
});
