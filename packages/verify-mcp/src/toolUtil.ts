/** MCP 工具共用：结果形状、HTTP → 工具结果映射（402 非错误）、参数 schema 片段 */
import { z } from "zod";
import { API_KEY_REQUIRED, type HttpResult } from "./client";

export type ToolResult = { content: Array<{ type: "text"; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };

export function ok(summary: string, data: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: summary }], structuredContent: data };
}

export function fail(code: string, message: string, extra: Record<string, unknown> = {}): ToolResult {
  return { content: [{ type: "text", text: `${code}: ${message}` }], structuredContent: { error: code, message, ...extra }, isError: true };
}

export function fromHttp(r: HttpResult, summaryOk: (b: Record<string, unknown>) => string): ToolResult {
  const body = (r.body ?? {}) as Record<string, unknown>;
  if (r.paid) body["autoPaid"] = r.paid;
  if (r.status === 402) {
    return {
      content: [{ type: "text", text: "Payment required (x402). Have the host wallet pay the challenge in `paymentRequired` and call again with `paymentSignature` (or enable agent-wallet mode). No charge happens until you do." }],
      structuredContent: { status: 402, paymentRequired: r.paymentRequired, body },
      isError: false,
    };
  }
  if (r.status === 401 && body["error"] === API_KEY_REQUIRED) {
    // 免 key 模式下的需 key 工具：不是错误，也不是数据（V-40）
    return { content: [{ type: "text", text: `not_available: ${String(body["message"])}` }], structuredContent: { status: "not_available", reason: API_KEY_REQUIRED, message: body["message"] }, isError: false };
  }
  if (r.status >= 200 && r.status < 300) {
    const data: Record<string, unknown> = { status: r.status, ...body };
    if (r.paymentResponse) data["paymentResponse"] = r.paymentResponse;
    return ok(summaryOk(body), data);
  }
  return {
    content: [{ type: "text", text: `verify-service returned ${r.status}: ${String(body["error"] ?? "")} ${String(body["message"] ?? "")}`.trim() }],
    structuredContent: { status: r.status, ...body },
    isError: true,
  };
}

export const ADDR = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "EVM address");
export const ASSET_KEY = z.string().regex(/^eip155:\d+:0x[0-9a-f]{40}$/, "eip155:<chainId>:<lowercase address>");
export const HEX32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "bytes32");
export const UINT = z.string().regex(/^(0|[1-9]\d*)$/, "decimal uint string");
