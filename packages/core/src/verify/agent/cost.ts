/**
 * 托管 Agent 成本折算（开发计划 §2.6「成本与节流」，在 verify-service 执行）。
 * 价格（美元 / 百万 token）来自 verify-service 的 env，按官方价目填，不写死；任一缺失 → null（托管 Agent 不启用并告警）。
 * 金额一律整数微美元（十进制串）；向上取整，宁可多记不少记。
 */
export interface AgentPrices {
  /** 美元 / 百万 token（十进制串） */
  inputPerMTokUsd: string;
  outputPerMTokUsd: string;
  cacheReadPerMTokUsd: string;
  /** 写缓存价（可选；缺省按输入价计） */
  cacheWritePerMTokUsd?: string;
}
export interface AgentUsage {
  /** 未命中缓存的普通输入 */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** 写缓存的输入（可选；旧上报没有该字段 = 0，写缓存当时计在 inputTokens 里） */
  cacheWriteTokens?: number;
}

const DEC_RE = /^\d+(\.\d+)?$/;
const SCALE = 1_000_000n;

/** 十进制串 → ×1e6 的整数（多余小数位向上进位） */
export function decimalToMicros(s: string): bigint {
  if (!DEC_RE.test(s)) throw new Error(`invalid decimal: ${s}`);
  const [w, f = ""] = s.split(".");
  const head = (f + "000000").slice(0, 6);
  const tail = f.slice(6);
  let v = BigInt(w!) * SCALE + BigInt(head);
  if (/[1-9]/.test(tail)) v += 1n;
  return v;
}

/** 三个价格都给了且是合法十进制 → AgentPrices；否则 null */
export function parseAgentPrices(env: { input?: string | null; output?: string | null; cacheRead?: string | null; cacheWrite?: string | null }): AgentPrices | null {
  const vals = [env.input, env.output, env.cacheRead].map((x) => (typeof x === "string" ? x.trim() : ""));
  if (vals.some((v) => !v || !DEC_RE.test(v))) return null;
  const w = typeof env.cacheWrite === "string" ? env.cacheWrite.trim() : "";
  if (w && !DEC_RE.test(w)) return null;
  return { inputPerMTokUsd: vals[0]!, outputPerMTokUsd: vals[1]!, cacheReadPerMTokUsd: vals[2]!, ...(w ? { cacheWritePerMTokUsd: w } : {}) };
}

/** usage → 微美元：tokens × (USD / 1e6 tokens) = tokens × 价格 µUSD；向上取整 */
export function costUsdMicros(usage: AgentUsage, prices: AgentPrices): string {
  const part = (tokens: number, price: string): bigint => {
    if (!Number.isSafeInteger(tokens) || tokens < 0) throw new Error(`invalid token count: ${tokens}`);
    const num = BigInt(tokens) * decimalToMicros(price); // = µUSD × 1e6
    return (num + SCALE - 1n) / SCALE;
  };
  return (
    part(usage.inputTokens, prices.inputPerMTokUsd) +
    part(usage.outputTokens, prices.outputPerMTokUsd) +
    part(usage.cacheReadTokens, prices.cacheReadPerMTokUsd) +
    part(usage.cacheWriteTokens ?? 0, prices.cacheWritePerMTokUsd ?? prices.inputPerMTokUsd)
  ).toString();
}

/** 美元上限（十进制串）→ 微美元 */
export function usdCapMicros(capUsd: string): bigint {
  return decimalToMicros(capUsd);
}

/** 只认非负安全整数；其它字段丢弃 */
export function sanitizeUsage(raw: unknown): AgentUsage {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const n = (k: string) => (typeof o[k] === "number" && Number.isSafeInteger(o[k]) && (o[k] as number) >= 0 ? (o[k] as number) : 0);
  return { inputTokens: n("inputTokens"), outputTokens: n("outputTokens"), cacheReadTokens: n("cacheReadTokens"), cacheWriteTokens: n("cacheWriteTokens") };
}

export function addUsage(a: AgentUsage, b: AgentUsage): AgentUsage {
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens, cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens, cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0) };
}
