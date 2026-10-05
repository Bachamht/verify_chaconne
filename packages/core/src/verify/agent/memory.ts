/** 任务记忆（verify_agent_memory）：≤ 20 条 × 2 KB，先进先出；按 clientRequestId 去重 */
import { AGENT_MEMORY_MAX_NOTES, AGENT_MEMORY_NOTE_MAX_BYTES, type IsoUtc } from "../contracts";

export interface MemoryNote {
  at: IsoUtc;
  text: string;
  clientRequestId: string;
  by: "agent:hosted" | "agent:byo" | "owner";
}

export function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

export function validateMemoryText(text: unknown): { ok: true; text: string } | { ok: false; code: string } {
  if (typeof text !== "string" || !text.trim()) return { ok: false, code: "expected_non_empty_string" };
  const t = text.trim();
  if (utf8Bytes(t) > AGENT_MEMORY_NOTE_MAX_BYTES) return { ok: false, code: `max_${AGENT_MEMORY_NOTE_MAX_BYTES}_bytes` };
  return { ok: true, text: t };
}

/** 追加一条；同 clientRequestId 已存在 → 原样返回（duplicate=true）；超过上限丢最旧的 */
export function appendMemory(notes: readonly MemoryNote[], note: MemoryNote, max: number = AGENT_MEMORY_MAX_NOTES): { notes: MemoryNote[]; duplicate: boolean; dropped: number } {
  if (notes.some((n) => n.clientRequestId === note.clientRequestId)) return { notes: [...notes], duplicate: true, dropped: 0 };
  const next = [...notes, note];
  const dropped = Math.max(0, next.length - max);
  return { notes: next.slice(dropped), duplicate: false, dropped };
}
