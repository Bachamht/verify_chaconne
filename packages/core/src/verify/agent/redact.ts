/**
 * 密钥扫描（SEC-05）：轮次预览（argsPreview / resultPreview ≤ 2 KB）、日志摘要、通知载荷在写入前过一遍。
 * 目标：私钥、助记词、API key、Bearer 令牌、原始交易（长 hex）不得出现在任何对外或落库的预览里。
 * bytes32 哈希（证据哈希、交易哈希）是正常数据，只有出现在「密钥类」字段名 / 上下文里时才遮掉。
 */
export const PREVIEW_MAX_BYTES = 2048;
export const REDACTED = "[redacted]";

const SECRET_KEY_NAME = /(private|secret|mnemonic|seed|passphrase|api[_-]?key|apikey|token|authorization|password|signature)/i;
const PATTERNS: Array<[RegExp, string]> = [
  // 模型 / 云厂商风格的 key（sk-…、sk-ant-…）
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, REDACTED],
  // 本服务签发的 API key（vk_…）
  [/\bvk_[A-Za-z0-9_-]{8,}\b/g, REDACTED],
  // Bearer 令牌
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED}`],
  // 原始交易 / calldata 级的长 hex（> 66 hex，即长于 bytes32）
  [/\b0x[0-9a-fA-F]{130,}\b/g, `0x${REDACTED}`],
  // 紧跟在密钥类词语后面的 64 hex（private key: 0x…）
  [/((?:private|secret|seed|signing)[\s_-]*key["'\s:=]*)(0x)?[0-9a-fA-F]{64}\b/gi, `$1${REDACTED}`],
];
// 助记词不做文本形态匹配（会误伤正常英文理由）；助记词形态的 env 在各进程启动护栏里就被拒绝

/** 文本扫描：命中即替换 */
export function redactText(s: string): string {
  let out = s;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

/** 结构化扫描：键名像密钥的字段值整体遮掉，其余字符串走 redactText */
export function redactValue(v: unknown, depth = 0): unknown {
  if (depth > 12) return REDACTED;
  if (typeof v === "string") return redactText(v);
  if (Array.isArray(v)) return v.map((x) => redactValue(x, depth + 1));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = SECRET_KEY_NAME.test(k) && x !== null && x !== undefined && typeof x !== "boolean" && typeof x !== "number" ? REDACTED : redactValue(x, depth + 1);
    return out;
  }
  return v;
}

/** 预览：扫描后序列化，截到 ≤ 2 KB（按字节，不切坏多字节字符） */
export function previewOf(v: unknown, maxBytes = PREVIEW_MAX_BYTES): string {
  const red = redactValue(v);
  let s: string;
  try {
    s = typeof red === "string" ? red : JSON.stringify(red);
  } catch {
    s = String(red);
  }
  s = redactText(s ?? "");
  const enc = new TextEncoder();
  if (enc.encode(s).length <= maxBytes) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (enc.encode(s.slice(0, mid)).length + 3 <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  let cut = s.slice(0, lo);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/** 测试与自检：文本里是否仍有密钥形态 */
export function containsSecretShape(s: string): boolean {
  return PATTERNS.some(([re]) => {
    re.lastIndex = 0;
    const hit = re.test(s);
    re.lastIndex = 0;
    return hit;
  });
}
