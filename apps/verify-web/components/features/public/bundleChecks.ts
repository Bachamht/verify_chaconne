/**
 * /verify-bundle（v8）的纯逻辑：检查项 → StepFlow 状态、检查 id → 人话标题、汇总、任务记录 v3 分组。
 * 检查本身由 @chaconne/core/verify 的 verifyEvidenceBundle 在浏览器里算，这里只管怎么显示。
 */
import type { StepState } from "@/components/kit/StepFlow";
import type { Locale } from "@/lib/i18n";

export interface CheckLike { id: string; ok: boolean; detail: string; skipped?: boolean }

/** skipped（未校验）≠ 通过：显示「已跳过」；其余 ok → done，失败 → failed */
export function checkStepState(c: Pick<CheckLike, "ok" | "skipped">): StepState {
  if (c.skipped) return "skipped";
  return c.ok ? "done" : "failed";
}

type Rule = { re: RegExp; zh: (m: RegExpMatchArray) => string; en: (m: RegExpMatchArray) => string };
const n1 = (s: string | undefined) => String(Number(s ?? 0) + 1);

/** 顺序有意义：先具体后宽泛 */
const RULES: Rule[] = [
  { re: /^bundle_hash$/, zh: () => "证据包哈希重算一致", en: () => "Bundle hash recomputes" },
  { re: /^bundle_signature$/, zh: () => "证据包由证明签名者签名", en: () => "Bundle signed by the attestation signer" },
  { re: /^evidence_raw_hash$/, zh: () => "每条证据都有原文哈希", en: () => "Every evidence record has a raw hash" },
  { re: /^registry_hash$/, zh: () => "资产登记表哈希一致", en: () => "Asset registry hash matches" },
  { re: /^policy_definition_hash$/, zh: () => "策略定义哈希一致", en: () => "Policy definition hash matches" },
  { re: /^effective_policy_hash$/, zh: () => "生效策略哈希一致", en: () => "Effective policy hash matches" },
  { re: /^report_v(\d+)_evidence_hash$/, zh: (m) => `报告 v${m[1]}：证据哈希重算一致`, en: (m) => `Report v${m[1]}: evidence hash recomputes` },
  { re: /^report_v(\d+)_hash$/, zh: (m) => `报告 v${m[1]}：报告哈希`, en: (m) => `Report v${m[1]}: report hash` },
  { re: /^report_v(\d+)_policy$/, zh: (m) => `报告 v${m[1]}：策略与证据包一致`, en: (m) => `Report v${m[1]}: policy matches the bundle` },
  { re: /^report_v(\d+)_rules$/, zh: (m) => `报告 v${m[1]}：规则重算结论一致`, en: (m) => `Report v${m[1]}: rules re-run to the same verdict` },
  { re: /^plan_.+_hash$/, zh: () => "规划报告哈希一致", en: () => "Plan report hash matches" },
  { re: /^plan_.+_evidence_present$/, zh: () => "规划引用的证据都在包里", en: () => "Every evidence the plan cites is bundled" },
  { re: /^cert_(\d+)_intent_digest$/, zh: (m) => `证书 ${n1(m[1])}：对应包内的交易意图`, en: (m) => `Certificate ${n1(m[1])}: matches a bundled intent` },
  { re: /^cert_(\d+)_evidence_hash$/, zh: (m) => `证书 ${n1(m[1])}：证据哈希对应包内报告`, en: (m) => `Certificate ${n1(m[1])}: evidence hash matches a report` },
  { re: /^cert_(\d+)_step_digest$/, zh: (m) => `证书 ${n1(m[1])}：对应包内的步骤`, en: (m) => `Certificate ${n1(m[1])}: matches a bundled step` },
  { re: /^cert_(\d+)_digest$/, zh: (m) => `证书 ${n1(m[1])}：摘要`, en: (m) => `Certificate ${n1(m[1])}: digest` },
  { re: /^cert_(\d+)_signature$/, zh: (m) => `证书 ${n1(m[1])}：签名`, en: (m) => `Certificate ${n1(m[1])}: signature` },
  { re: /^cert_(\d+)_shape$/, zh: (m) => `证书 ${n1(m[1])}：格式`, en: (m) => `Certificate ${n1(m[1])}: format` },
  { re: /^intent_(\d+)_(signature|owner|shape)$/, zh: (m) => `交易意图 ${n1(m[1])}：所有者签名`, en: (m) => `Trade intent ${n1(m[1])}: owner signature` },
  { re: /^mandate_digest$/, zh: () => "授权摘要与各步骤一致", en: () => "Mandate digest matches every step" },
  { re: /^mandate_signature$/, zh: () => "授权由所有者签名", en: () => "Mandate signed by the owner" },
  { re: /^mandate_shape$/, zh: () => "授权格式", en: () => "Mandate format" },
  { re: /^mandate_step_(\d+)_digest$/, zh: (m) => `第 ${m[1]} 步：步骤摘要`, en: (m) => `Step ${m[1]}: step digest` },
  { re: /^mandate_step_(\d+)_cert_signature$/, zh: (m) => `第 ${m[1]} 步：步骤证书签名`, en: (m) => `Step ${m[1]}: step certificate signature` },
  { re: /_fill_attribution$/, zh: () => "成交归因到对应步骤", en: () => "Fill attributed to its step" },
  { re: /^mandate_.+_step_.+_cert_binding$/, zh: () => "步骤证书与步骤绑定", en: () => "Step certificate bound to its step" },
  { re: /^mandate_.+_step_.+_digest$/, zh: () => "步骤摘要", en: () => "Step digest" },
  { re: /^mandate_.+_(digest|signature|shape)$/, zh: () => "授权摘要与签名", en: () => "Authorization digest and signature" },
  { re: /^permit_/, zh: () => "额度签名字段", en: () => "Allowance signature fields" },
  { re: /^run_hash_chain$/, zh: () => "轮次哈希链连续", en: () => "Run hash chain is continuous" },
  { re: /^run_/, zh: () => "轮次动作已记录", en: () => "Run action recorded" },
  { re: /^timeline_rows_ordered$/, zh: () => "时间线按顺序", en: () => "Timeline rows in order" },
  { re: /^timeline_/, zh: () => "时间线摘要一致", en: () => "Timeline digest matches" },
  { re: /^v3_base_mandate_included$/, zh: () => "包含基础授权", en: () => "Base mandate included" },
  { re: /conditions|scope|thesis|intents_|strategy_versions|condition_eval|task_/, zh: () => "任务条件与范围", en: () => "Task conditions and scope" },
  { re: /^receipt_/, zh: () => "链上回执", en: () => "On-chain receipt" },
  { re: /^event_/, zh: () => "链上事件对应包内报告", en: () => "On-chain event matches a bundled report" },
  { re: /^no_executions$/, zh: () => "没有链上执行", en: () => "No on-chain executions" },
];

/** 检查 id → 人话标题（原 id 放 title 与描述，开发者工具页允许） */
export function checkTitle(id: string, locale: Locale): string {
  for (const r of RULES) {
    const m = id.match(r.re);
    if (m) return locale === "zh" ? r.zh(m) : r.en(m);
  }
  return locale === "zh" ? "附加检查" : "Additional check";
}

/**
 * 检查项的说明文字：core 验证器的 detail 是英文原文，中文页不直出（原文进「技术细节」折叠与 title）；
 * 英文页直接用 detail。未校验 ≠ 通过。
 */
export function checkDetailText(c: CheckLike, locale: Locale): string {
  if (locale === "zh") {
    if (c.skipped) return "未校验：缺少期望的签名者或验证器，不代表通过。";
    return c.ok ? "通过。" : "未通过，展开技术细节查看原因。";
  }
  if (c.detail) return c.detail;
  if (c.skipped) return "Not verified (no expected signer or verifier); not a pass.";
  return c.ok ? "Passed." : "Failed.";
}

export function summarizeChecks(checks: readonly CheckLike[]): { total: number; passed: number; failed: number; skipped: number } {
  const skipped = checks.filter((c) => c.skipped).length;
  const failed = checks.filter((c) => !c.skipped && !c.ok).length;
  return { total: checks.length, passed: checks.length - skipped - failed, failed, skipped };
}

/** 任务证据包 v3 的检查分组（只在包里出现 v3 检查时显示）；与 v7 BundleVerifier 同一规则 */
export const V3_GROUPS: ReadonlyArray<{ key: string; zh: string; en: string; test: (id: string) => boolean }> = [
  { key: "mandates", zh: "授权签名与摘要", en: "Authorizations", test: (id) => /^mandate_.+_(digest|signature)$/.test(id) && !/_step_/.test(id) },
  { key: "steps", zh: "步骤与证书", en: "Steps & certificates", test: (id) => /^mandate_.+_step_.+_(digest|cert_binding|cert_signature)$/.test(id) },
  { key: "fills", zh: "成交归因", en: "Fill attribution", test: (id) => id.endsWith("_fill_attribution") },
  { key: "permits", zh: "额度签名", en: "Allowance signatures", test: (id) => id.startsWith("permit_") },
  { key: "runs", zh: "轮次哈希链", en: "Run hash chain", test: (id) => id.startsWith("run_") },
  { key: "timeline", zh: "时间线摘要", en: "Timeline digest", test: (id) => id.startsWith("timeline_") },
];
export function v3Groups(checks: readonly CheckLike[]): Array<{ key: string; zh: string; en: string; total: number; failed: number }> | null {
  if (!checks.some((c) => c.id.startsWith("timeline_"))) return null;
  return V3_GROUPS.map((g) => {
    const hit = checks.filter((c) => g.test(c.id));
    return { key: g.key, zh: g.zh, en: g.en, total: hit.length, failed: hit.filter((c) => !c.ok).length };
  }).filter((g) => g.total > 0);
}

/** 从服务加载失败 → 原因键（文案在 lib/i18n.execute） */
export function loadFailureKey(status: number): "bundle_not_yours" | "bundle_unauthorized" | "bundle_load_failed" {
  if (status === 404) return "bundle_not_yours";
  if (status === 401 || status === 403) return "bundle_unauthorized";
  return "bundle_load_failed";
}

/** ?job= / ?task= / ?mandate= 或输入框里的 id → 加载引用 */
export type BundleRef = { job?: string; task?: string; mandate?: string };
export function refFromId(id: string): BundleRef {
  const v = id.trim();
  return v.startsWith("job_") ? { job: v } : v.startsWith("tsk_") ? { task: v } : { mandate: v };
}
export function refFromParams(p: { get(name: string): string | null }): BundleRef | null {
  const job = p.get("job");
  const task = p.get("task");
  const mandate = p.get("mandate");
  return job ? { job } : task ? { task } : mandate ? { mandate } : null;
}
