/**
 * Crew 台词模板（R-01）：每句只引用**真实响应字段**——模板变量必须是 `FIELDS[role]` 里声明的路径，
 * 且渲染时字段缺失就整句不出（返回 null），绝不用占位值补一句好听的话。
 * Scout = 上下文与事件调用；Planner = 规划/对照；Player = 执行（agent-wallet 或浏览器）；Auditor = 证据包验证。
 */
export type CrewRole = "scout" | "planner" | "player" | "auditor";

/** 每个角色可引用的响应字段（点路径），与 core contracts / api-v2 v6 类型一一对应 */
export const FIELDS: Record<CrewRole, readonly string[]> = {
  scout: ["context.session.label.value", "context.session.label.status", "context.packagedAt", "context.provenance.mode", "context.events.length", "impacts.length", "events.length", "nextEvent.name", "nextEvent.dateLocal", "nextEvent.status", "nextEvent.datePrecision"],
  planner: ["task.id", "task.playbookId", "task.status", "task.blockers.length", "task.nextCheckAt", "task.conditions.items.length", "comparison.evidenceSnapshotId", "comparison.variants.length", "comparison.mode"],
  player: ["task.executorPresence", "task.mandateIds.length", "step.stepIndex", "step.state", "step.txHash", "mandate.stepsDone", "mandate.maxSteps"],
  auditor: ["bundle.bundleHash", "verify.passed", "verify.total", "verify.ok", "recap.date", "recap.ledger.length", "recap.sections.trades.length"],
};

export interface LineTemplate {
  role: CrewRole;
  id: string;
  en: string;
  zh: string;
}

/** 模板；`{a.b.c}` 只能出现 FIELDS[role] 里的路径 */
export const LINES: LineTemplate[] = [
  { role: "scout", id: "session", en: "Session is {context.session.label.value} ({context.session.label.status}), packaged {context.packagedAt}.", zh: "时段 {context.session.label.value}（{context.session.label.status}），打包于 {context.packagedAt}。" },
  { role: "scout", id: "provenance", en: "Context provenance: {context.provenance.mode}.", zh: "上下文来源模式：{context.provenance.mode}。" },
  { role: "scout", id: "events", en: "{events.length} scheduled event(s) on supported assets in the next 48 h; {impacts.length} of them touch your holdings or tasks.", zh: "未来 48 小时内已支持资产上有 {events.length} 个已排期事件，其中 {impacts.length} 个与你的持仓或任务有关。" },
  { role: "scout", id: "next_event", en: "Next upcoming: {nextEvent.name} on {nextEvent.dateLocal} ({nextEvent.status}, {nextEvent.datePrecision} precision).", zh: "接下来最近的一个：{nextEvent.name}，{nextEvent.dateLocal}（{nextEvent.status}，精度 {nextEvent.datePrecision}）。" },
  { role: "planner", id: "task", en: "Task {task.id} ({task.playbookId}) is {task.status} with {task.blockers.length} blocker(s); next check {task.nextCheckAt}.", zh: "任务 {task.id}（{task.playbookId}）状态 {task.status}，{task.blockers.length} 个阻塞项；下次检查 {task.nextCheckAt}。" },
  { role: "planner", id: "conditions", en: "{task.conditions.items.length} condition(s) gate every certificate.", zh: "每张证书都要过 {task.conditions.items.length} 项条件。" },
  { role: "planner", id: "comparison", en: "Compared {comparison.variants.length} variants on snapshot {comparison.evidenceSnapshotId} ({comparison.mode}).", zh: "在快照 {comparison.evidenceSnapshotId} 上对照了 {comparison.variants.length} 个变体（{comparison.mode}）。" },
  { role: "player", id: "presence", en: "Executor: {task.executorPresence}; {task.mandateIds.length} authorization(s) attached.", zh: "执行器：{task.executorPresence}；挂了 {task.mandateIds.length} 份授权。" },
  { role: "player", id: "step", en: "Step {step.stepIndex} is {step.state} (tx {step.txHash}).", zh: "第 {step.stepIndex} 步 {step.state}（tx {step.txHash}）。" },
  { role: "player", id: "progress", en: "{mandate.stepsDone} of {mandate.maxSteps} steps confirmed.", zh: "{mandate.maxSteps} 步里已确认 {mandate.stepsDone} 步。" },
  { role: "auditor", id: "bundle", en: "Bundle {bundle.bundleHash}: {verify.passed}/{verify.total} checks, ok={verify.ok}.", zh: "证据包 {bundle.bundleHash}：{verify.passed}/{verify.total} 项通过，ok={verify.ok}。" },
  { role: "auditor", id: "recap", en: "Recap {recap.date}: {recap.sections.trades.length} confirmed trade(s), {recap.ledger.length} ledger line(s) — ledger equals timeline.", zh: "{recap.date} 的夜班日志：{recap.sections.trades.length} 笔确认成交，{recap.ledger.length} 条账目——账目与时间线一致。" },
];

export const VAR_RE = /\{([a-zA-Z0-9_.]+)\}/g;

export function templateVars(t: LineTemplate): string[] {
  return [...new Set([...t.en.matchAll(VAR_RE), ...t.zh.matchAll(VAR_RE)].map((m) => m[1]!))];
}

/** 点路径取值；`.length` 只对数组/字符串成立；undefined/null → 缺失 */
export function pick(data: unknown, path: string): unknown {
  let cur: unknown = data;
  for (const seg of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    if (seg === "length") {
      if (Array.isArray(cur) || typeof cur === "string") cur = cur.length;
      else return undefined;
      continue;
    }
    if (typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** 渲染一句台词：任一变量缺失 → null（不补、不猜） */
export function renderLine(t: LineTemplate, data: unknown, locale: "en" | "zh"): string | null {
  const src = locale === "zh" ? t.zh : t.en;
  let missing = false;
  const out = src.replace(VAR_RE, (_m, path: string) => {
    const v = pick(data, path);
    if (v === undefined || v === null || v === "") {
      missing = true;
      return "";
    }
    return typeof v === "string" ? (path.endsWith("packagedAt") || path.endsWith("nextCheckAt") ? v.replace("T", " ").replace(/\.\d+Z$/, "Z") : v.length > 20 && /^0x/.test(v) ? `${v.slice(0, 10)}…` : v) : String(v);
  });
  return missing ? null : out;
}

export function linesFor(role: CrewRole, data: unknown, locale: "en" | "zh"): string[] {
  return LINES.filter((l) => l.role === role).map((l) => renderLine(l, data, locale)).filter((x): x is string => x !== null);
}
