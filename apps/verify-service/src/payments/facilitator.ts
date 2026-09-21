/**
 * Facilitator 客户端工厂：okx（真实，OKX Onchain OS 凭据）| mock（测试/本地演示，禁止生产）。
 * mock 实现只用于可重复的异常注入测试（验收 §三：fixture 不能替代真实集成证据）。
 */
import { OKXFacilitatorClient } from "@okxweb3/x402-core";
import type { FacilitatorClient } from "@okxweb3/x402-core/server";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SettleStatusResponse,
  SupportedResponse,
  VerifyResponse,
} from "@okxweb3/x402-core/types";
import { hashCanonical } from "@chaconne/core/verify";
import type { VerifyConfig } from "../config";

export interface MockFacilitatorControl {
  /** verify 是否通过（默认 true） */
  verifyValid: boolean;
  /** settle 行为：success | pending | failed | throw | timeout */
  settleBehavior: "success" | "pending" | "failed" | "throw" | "timeout";
  /** getSettleStatus 返回状态（对账用） */
  statusBehavior: "success" | "pending" | "failed" | "throw";
  settleCalls: number;
  verifyCalls: number;
  statusCalls: number;
}

export function createMockControl(): MockFacilitatorControl {
  return { verifyValid: true, settleBehavior: "success", statusBehavior: "success", settleCalls: 0, verifyCalls: 0, statusCalls: 0 };
}

export class MockFacilitatorClient implements FacilitatorClient {
  constructor(
    private readonly network: Network,
    readonly control: MockFacilitatorControl = createMockControl(),
  ) {}

  async getSupported(): Promise<SupportedResponse> {
    return { kinds: [{ x402Version: 2, scheme: "exact", network: this.network }], extensions: [], signers: {} };
  }

  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    this.control.verifyCalls += 1;
    const inner = payload.payload as { authorization?: { from?: string; to?: string; value?: string } };
    const auth = inner.authorization;
    const bound =
      !!auth &&
      typeof auth.to === "string" &&
      auth.to.toLowerCase() === requirements.payTo.toLowerCase() &&
      auth.value === requirements.amount;
    if (!this.control.verifyValid || !bound) {
      return { isValid: false, invalidReason: bound ? "mock_rejected" : "requirements_mismatch" };
    }
    return { isValid: true, payer: auth.from };
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    this.control.settleCalls += 1;
    const inner = payload.payload as { authorization?: { from?: string } };
    const tx = hashCanonical({ mock: "settle", payload: payload.payload, amount: requirements.amount });
    const base = { payer: inner.authorization?.from, transaction: tx, network: requirements.network };
    switch (this.control.settleBehavior) {
      case "throw":
        throw new Error("mock facilitator unreachable");
      case "failed":
        return { ...base, success: false, errorReason: "insufficient_funds", transaction: "" };
      case "pending":
        return { ...base, success: true, status: "pending" };
      case "timeout":
        return { ...base, success: true, status: "timeout" };
      default:
        return { ...base, success: true, status: "success" };
    }
  }

  async getSettleStatus(txHash: string): Promise<SettleStatusResponse> {
    this.control.statusCalls += 1;
    if (this.control.statusBehavior === "throw") throw new Error("mock status unreachable");
    if (this.control.statusBehavior === "failed") return { success: false, status: "failed", transaction: txHash, network: this.network };
    if (this.control.statusBehavior === "pending") return { success: true, status: "pending", transaction: txHash, network: this.network };
    return { success: true, status: "success", transaction: txHash, network: this.network };
  }
}

/**
 * 观察器：SDK 会把 settle() 抛出的异常（网络/超时）也包装成 success:false，
 * 与 facilitator 明确拒绝无法区分。这里记录"本次结算是否发生异常"，供付费闸门判定 PAYMENT_UNKNOWN。
 */
export class ObservedFacilitator implements FacilitatorClient {
  private lastSettleException: unknown = null;
  constructor(private readonly inner: FacilitatorClient) {}
  getSupported() {
    return this.inner.getSupported();
  }
  verify(payload: PaymentPayload, requirements: PaymentRequirements) {
    return this.inner.verify(payload, requirements);
  }
  async settle(payload: PaymentPayload, requirements: PaymentRequirements) {
    try {
      return await this.inner.settle(payload, requirements);
    } catch (err) {
      this.lastSettleException = err;
      throw err;
    }
  }
  getSettleStatus(txHash: string) {
    if (!this.inner.getSettleStatus) throw new Error("facilitator 不支持状态查询");
    return this.inner.getSettleStatus(txHash);
  }
  /** 取走并清空最近一次结算异常（每次结算前先清） */
  consumeSettleException(): unknown {
    const e = this.lastSettleException;
    this.lastSettleException = null;
    return e;
  }
  reset(): void {
    this.lastSettleException = null;
  }
}

export function createFacilitator(cfg: VerifyConfig, mockControl?: MockFacilitatorControl): ObservedFacilitator {
  return new ObservedFacilitator(createInnerFacilitator(cfg, mockControl));
}

function createInnerFacilitator(cfg: VerifyConfig, mockControl?: MockFacilitatorControl): FacilitatorClient {
  if (cfg.PAYMENT_MODE === "mock") return new MockFacilitatorClient(cfg.PAYMENT_NETWORK, mockControl);
  return new OKXFacilitatorClient({
    apiKey: cfg.OKX_API_KEY,
    secretKey: cfg.OKX_SECRET_KEY,
    passphrase: cfg.OKX_PASSPHRASE,
    ...(cfg.OKX_FACILITATOR_BASE_URL ? { baseUrl: cfg.OKX_FACILITATOR_BASE_URL } : {}),
    syncSettle: cfg.SETTLE_SYNC === "true",
  });
}
