/**
 * 授权任务读数的防御层：线上 GET /v1/mandates/:id 的形状与 MandateView 类型不完全一致
 * （预算在 budget.cap、单步上限在 mandate.perStepCap、截止时间是 ISO、没有 evaluations / policyId）。
 * 只在 v8 视图里兜底，不改 lib/api-v2（normalizeMandate 的 stepRecords → steps 修复照旧）。
 */
import type { MandateView } from "@/lib/api-v2";

export interface TaskNumbers { budgetCap: string | null; perStepCap: string | null; spent: string | null; deadline: string | null; policyId: string | null }

export function taskNumbers(m: MandateView): TaskNumbers {
  const r = m as MandateView & { budget?: { cap?: string; spent?: string }; mandate?: { perStepCap?: string; budgetCap?: string; deadline?: string } };
  const s = (v: unknown) => (typeof v === "string" && v !== "" ? v : typeof v === "number" ? String(v) : null);
  return {
    budgetCap: s(r.budgetCap) ?? s(r.budget?.cap) ?? s(r.mandate?.budgetCap),
    perStepCap: s(r.perStepCap) ?? s(r.mandate?.perStepCap),
    spent: s(r.spent) ?? s(r.budget?.spent),
    deadline: s(r.deadline) ?? s(r.mandate?.deadline),
    policyId: s(r.policyId),
  };
}

export function evaluationsOf(m: MandateView): MandateView["evaluations"] {
  return Array.isArray(m.evaluations) ? m.evaluations : [];
}
