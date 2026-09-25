/**
 * 钱包绑定的 API key（FIX-175 / CV-D17）：用户用钱包签一条消息 → 服务签发一把 key，调用方 = `agent:<钱包>`（代表该钱包，与网页同一批记录）。
 * 消息文本在这里生成，网页与服务共用同一份，逐字一致才能验签。只有 EOA（personal_sign / EIP-191）。
 */

export const API_KEY_MESSAGE_TITLE = "Chaconne Verify";
/** 签名里的 issuedAt 与服务器时钟最多相差这么多（毫秒） */
export const API_KEY_ISSUE_MAX_SKEW_MS = 10 * 60_000;
export const API_KEY_LABEL_MAX_CHARS = 40;
/** 一个钱包最多同时持有的有效 key */
export const API_KEY_MAX_ACTIVE_PER_OWNER = 20;

export interface ApiKeyIssueFields {
  /** 0x 小写地址 */
  owner: string;
  label: string;
  /** 16–64 位十六进制随机串（客户端生成；服务端做唯一约束防重放） */
  nonce: string;
  /** ISO 时间 */
  issuedAt: string;
}

const ADDR = /^0x[0-9a-f]{40}$/;
const NONCE = /^[0-9a-f]{16,64}$/;

export function normalizeApiKeyIssueFields(raw: unknown): { ok: true; fields: ApiKeyIssueFields } | { ok: false; field: string; code: string } {
  const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const owner = typeof b["ownerAddress"] === "string" ? b["ownerAddress"].toLowerCase() : typeof b["owner"] === "string" ? b["owner"].toLowerCase() : "";
  if (!ADDR.test(owner)) return { ok: false, field: "ownerAddress", code: "invalid_address" };
  const label = typeof b["label"] === "string" ? b["label"].trim() : "";
  if (!label || label.length > API_KEY_LABEL_MAX_CHARS || /[\r\n]/.test(label)) return { ok: false, field: "label", code: "invalid_label" };
  const nonce = typeof b["nonce"] === "string" ? b["nonce"].toLowerCase() : "";
  if (!NONCE.test(nonce)) return { ok: false, field: "nonce", code: "invalid_nonce" };
  const issuedAt = typeof b["issuedAt"] === "string" ? b["issuedAt"] : "";
  if (!issuedAt || Number.isNaN(Date.parse(issuedAt))) return { ok: false, field: "issuedAt", code: "invalid_issued_at" };
  return { ok: true, fields: { owner, label, nonce, issuedAt } };
}

/** 用户在钱包里看到并签署的文本（EIP-191 personal_sign）。改一个字符都会让旧签名失效——只追加，不改。 */
export function apiKeyIssueMessage(f: ApiKeyIssueFields): string {
  return [
    `${API_KEY_MESSAGE_TITLE}: issue an API key for this wallet.`,
    "",
    `Wallet: ${f.owner}`,
    `Key label: ${f.label}`,
    `Nonce: ${f.nonce}`,
    `Issued at: ${f.issuedAt}`,
    "",
    "The key lets an agent create tasks, submit trade intents and read records under this wallet — within what you have authorized on-chain. Signing this costs nothing and approves no transaction.",
  ].join("\n");
}

/** 网站钱包登录（会话）消息：证明控制该钱包，不授权任何交易 */
export function walletSignInMessage(f: { host: string; address: string; nonce: string; issuedAt: string }): string {
  return [
    `${f.host} wants you to sign in with your wallet.`,
    "",
    `Wallet: ${f.address.toLowerCase()}`,
    `Nonce: ${f.nonce}`,
    `Issued at: ${f.issuedAt}`,
    "",
    "This signature only proves you control this wallet. It approves no transaction and spends nothing.",
  ].join("\n");
}
