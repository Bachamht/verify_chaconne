/** v7 Lane D · D5 时延计算（D-02 时延记录的工具部分）：用 captureEvent.ts 行形状的合成 FIXTURE 行 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { computeOutcomeLatency, latencyMarkdown, type LatencyLine } from "../src/events/latency";

const FIX = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages", "core", "src", "verify", "__fixtures__", "v7", "nfp-2026-10-02", "FIXTURE_nfp_outcome_event.json"), "utf8")) as Record<string, Record<string, unknown>>;
const ID = String(FIX["scheduled"]!["id"]);
const URL = "https://verify.example.invalid/v1/events?from=a&to=b";
const L = (file: string, objs: unknown[]): LatencyLine[] => objs.map((o, i) => ({ file, lineNo: i + 1, text: JSON.stringify(o) }));
const strip = (e: Record<string, unknown>) => {
  const { outcome: _o, ...rest } = e;
  void _o;
  return rest;
};

describe("D5 computeOutcomeLatency", () => {
  it("v7 轮询（带 outcome）+ DB 导出：精确 outcome_received_at，各段差值", () => {
    const polls = L("events.jsonl", [
      { capturedAt: "2026-10-02T12:30:00.000Z", url: URL, body: { events: [FIX["scheduled"]] } },
      { capturedAt: "2026-10-02T12:31:00.000Z", url: URL, body: { events: [FIX["scheduled"]] } },
      { capturedAt: "2026-10-02T12:32:00.000Z", url: URL, body: { events: [{ ...FIX["arrived"], outcomeRevision: 0, dataStatus: "data_arrived" }] } },
    ]);
    const db = L("db.jsonl", [{ id: ID, outcome_received_at: "2026-10-02T12:31:20.000Z", outcome_revision: 0 }]);
    const turns = L("turns.jsonl", [{ eventId: ID, reason: "data_arrived", requestedAt: "2026-10-02T12:31:25.000Z", startedAt: "2026-10-02T12:31:40.000Z" }]);
    const [r] = computeOutcomeLatency([...polls, ...db, ...turns]);
    expect(r).toMatchObject({
      eventId: ID,
      officialReleaseAt: "2026-10-02T12:30:00.000Z",
      officialReleaseSource: "outcome.publishedAt",
      crowsnestFetchedAt: "2026-10-02T12:30:40.000Z",
      crowsnestFetchedSource: "outcome.fetchedAt",
      verifyReceivedAt: "2026-10-02T12:31:20.000Z",
      verifyReceivedSource: "outcome_received_at",
      arrivalSignal: "outcome",
      deltasMs: { releaseToCrowsnest: 40_000, crowsnestToVerify: 40_000, releaseToVerify: 80_000, verifyToTurnOpened: 5_000, turnOpenedToRunStarted: 15_000 },
    });
    expect(latencyMarkdown([r!])).toContain("| 40.0 s | 40.0 s | 80.0 s | 5.0 s | 15.0 s | outcome |");
  });

  it("旧服务剥掉 outcome：退化为 status=released 信号 + 轮询上界 / 下界，来源如实标注", () => {
    const polls = L("events.jsonl", [
      { capturedAt: "2026-10-02T12:30:00.000Z", url: URL, body: { events: [FIX["scheduled"]] } },
      { capturedAt: "2026-10-02T12:31:00.000Z", url: URL, body: { events: [FIX["scheduled"]] } },
      { capturedAt: "2026-10-02T12:32:00.000Z", url: URL, body: { events: [strip(FIX["arrived"]!)] } },
      { capturedAt: "2026-10-02T12:33:00.000Z", url: URL, body: { events: [strip(FIX["arrived"]!)] } },
      "not json",
    ]);
    const [r] = computeOutcomeLatency(polls);
    expect(r).toMatchObject({
      officialReleaseSource: "scheduledAtUtc",
      crowsnestFetchedAt: "2026-10-02T12:30:40.000Z",
      crowsnestFetchedSource: "sourceFetchedAt",
      verifyReceivedAt: "2026-10-02T12:32:00.000Z",
      verifyReceivedSource: "first_verify_poll_with_data",
      verifyLastPollWithoutData: "2026-10-02T12:31:00.000Z",
      arrivalSignal: "status_released",
      deltasMs: { releaseToVerify: 120_000, verifyToTurnOpened: null },
    });
  });

  it("没有到达信号 → 缺省不列；--event 指定时给出空值而不是猜", () => {
    const polls = L("events.jsonl", [{ capturedAt: "2026-10-02T12:30:00.000Z", url: URL, body: { events: [FIX["scheduled"]] } }]);
    expect(computeOutcomeLatency(polls)).toEqual([]);
    const [r] = computeOutcomeLatency(polls, { eventIds: [ID] });
    expect(r).toMatchObject({ verifyReceivedAt: null, crowsnestFetchedAt: null, arrivalSignal: null, verifyLastPollWithoutData: "2026-10-02T12:30:00.000Z" });
  });
});
