/**
 * x402 买家端（官方客户端 SDK 薄封装）：402 → 用户自持签名者签 EIP-3009 授权 → 重发。
 * 只签授权、不广播交易；私钥永远在调用方手里（本包只拿到 signTypedData 函数）。
 */
import { x402Client, x402HTTPClient } from "@okxweb3/x402-core/client";
import { ExactEvmScheme, toClientEvmSigner } from "@okxweb3/x402-evm";

export type Hex = `0x${string}`;

/** 调用方提供的签名者（viem `privateKeyToAccount` 的实例即满足） */
export interface X402Signer {
  readonly address: Hex;
  signTypedData(message: { domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: Record<string, unknown> }): Promise<Hex>;
}

export interface X402Challenge {
  network: string;
  /** 最小单位金额（稳定币通常 6 位小数） */
  amountRaw: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number | null;
  /** 按 6 位小数估算的美元金额（X Layer 默认稳定币均为 6 位；仅供额度控制） */
  amountUsdEstimate: string;
}

export interface X402PayerOptions {
  signer: X402Signer;
  /** 允许付款的网络（CAIP-2）；默认 X Layer 主网 + 测试网 */
  networks?: string[];
  /** 付款前回调：返回 false 则不付款（用于额度控制）；默认允许 */
  onBeforePayment?: (c: X402Challenge) => Promise<boolean> | boolean;
  /** 付款头已生成（尚未发送）回调，用于记账 */
  onPayment?: (c: X402Challenge) => void;
}

export interface X402Payer {
  readonly address: Hex;
  /** 给定 402 响应，返回应附加到重试请求的头；拒绝/不支持时返回 null */
  pay(getHeader: (name: string) => string | null | undefined): Promise<{ headers: Record<string, string>; challenge: X402Challenge } | null>;
  parseSettle(getHeader: (name: string) => string | null | undefined): Record<string, unknown> | null;
}

export const DEFAULT_X402_NETWORKS = ["eip155:196", "eip155:1952"];

export function amountUsdEstimate(amountRaw: string, decimals = 6): string {
  const v = BigInt(amountRaw);
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export function createX402Payer(o: X402PayerOptions): X402Payer {
  const evmSigner = toClientEvmSigner({ address: o.signer.address, signTypedData: (m) => o.signer.signTypedData(m as never) });
  const networks = o.networks ?? DEFAULT_X402_NETWORKS;
  const client = x402Client.fromConfig({ schemes: networks.map((network) => ({ network: network as never, client: new ExactEvmScheme(evmSigner) })) });
  const http = new x402HTTPClient(client);
  return {
    address: o.signer.address,
    async pay(getHeader) {
      const required = http.getPaymentRequiredResponse(getHeader);
      const req = required.accepts.find((a) => networks.includes(String(a.network)));
      if (!req) return null;
      const challenge: X402Challenge = { network: String(req.network), amountRaw: String(req.amount), asset: String(req.asset), payTo: String(req.payTo), maxTimeoutSeconds: typeof req.maxTimeoutSeconds === "number" ? req.maxTimeoutSeconds : null, amountUsdEstimate: amountUsdEstimate(String(req.amount)) };
      if (o.onBeforePayment && !(await o.onBeforePayment(challenge))) return null;
      const payload = await http.createPaymentPayload({ ...required, accepts: [req] });
      o.onPayment?.(challenge);
      return { headers: http.encodePaymentSignatureHeader(payload), challenge };
    },
    parseSettle(getHeader) {
      try {
        return http.getPaymentSettleResponse(getHeader) as unknown as Record<string, unknown>;
      } catch {
        return null;
      }
    },
  };
}
