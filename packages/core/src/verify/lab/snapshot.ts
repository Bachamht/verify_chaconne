/**
 * 证据快照与条件集合哈希（Lane E）。
 * - `conditionSetHash` 与冻结约定一致：keccak256(canonical({version, items}))（interfaces §11.4）；Lane B 的实现应得到相同值。
 * - `buildEvidenceSnapshot`：对照固定输入的快照，id 由内容哈希派生（同证据 → 同 id，L-02 可复算）。
 */
import type { Bytes32, Condition, ConditionSet, IsoUtc, MarketEvent } from "../contracts";
import { hashCanonical } from "../canonical";
import type { ConditionEvidenceInput, EvidenceSnapshot } from "./types";

export function conditionSetHash(items: Condition[]): Bytes32 {
  return hashCanonical({ version: "conditions/1", items });
}

export function buildConditionSet(items: Condition[]): ConditionSet {
  return { version: "conditions/1", items, hash: conditionSetHash(items) };
}

export function eventVersionKeys(events: MarketEvent[]): Array<{ id: string; revision: number; firstKnownAt: IsoUtc }> {
  return events.map((e) => ({ id: e.id, revision: e.revision, firstKnownAt: e.firstKnownAt })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.revision - b.revision));
}

export function evidenceSnapshotHash(taskId: string, takenAt: IsoUtc, evidence: ConditionEvidenceInput): Bytes32 {
  return hashCanonical({
    taskId,
    takenAt,
    evidenceIds: evidence.records.map((r) => r.evidenceId).sort(),
    contextHash: evidence.context ? hashCanonical(evidence.context) : null,
    eventVersions: eventVersionKeys(evidence.events),
  });
}

export function buildEvidenceSnapshot(taskId: string, takenAt: IsoUtc, evidence: ConditionEvidenceInput): EvidenceSnapshot {
  const hash = evidenceSnapshotHash(taskId, takenAt, evidence);
  return { id: `snap_${hash.slice(2, 26)}`, taskId, takenAt, records: evidence.records, context: evidence.context, events: evidence.events, hash };
}

export function snapshotInput(s: EvidenceSnapshot): ConditionEvidenceInput {
  return { records: s.records, context: s.context, events: s.events };
}
