/**
 * OKX DEX 路由 calldata 解析（签名服务侧第一层校验；Guard 的余额差是第二层）。
 * 目前已核验的选择器（X Layer 主网探针 2026-09-20；4byte.directory 唯一匹配 + openchain hasVerifiedContract）：
 *   0xf2c42696 dagSwapByOrderId(uint256 orderId, BaseRequest baseRequest, RouterPath[] paths)        ← 收款人 = 调用者
 *   0x0c307f76 dagSwapTo(uint256 orderId, address receiver, BaseRequest baseRequest, RouterPath[] paths) ← 显式收款人（须 = Guard）
 *   BaseRequest = (uint256 fromToken,address toToken,uint256 fromTokenAmount,uint256 minReturnAmount,uint256 deadLine)
 *   RouterPath  = (address[] mixAdapters,address[] assetTo,uint256[] rawData,bytes[] extraData,uint256 fromToken)
 * 未登记的选择器一律视为不支持（ROUTE_UNSUPPORTED），不猜测语义。
 */
import { decodeFunctionData, getAddress, type Hex } from "viem";

export const DAG_SWAP_BY_ORDER_ID_SELECTOR = "0xf2c42696" as const;
export const DAG_SWAP_TO_SELECTOR = "0x0c307f76" as const;

const DAG_SWAP_ABI = [
  {
    type: "function",
    name: "dagSwapByOrderId",
    stateMutability: "payable",
    inputs: [
      { name: "orderId", type: "uint256" },
      {
        name: "baseRequest",
        type: "tuple",
        components: [
          { name: "fromToken", type: "uint256" },
          { name: "toToken", type: "address" },
          { name: "fromTokenAmount", type: "uint256" },
          { name: "minReturnAmount", type: "uint256" },
          { name: "deadLine", type: "uint256" },
        ],
      },
      {
        name: "paths",
        type: "tuple[]",
        components: [
          { name: "mixAdapters", type: "address[]" },
          { name: "assetTo", type: "address[]" },
          { name: "rawData", type: "uint256[]" },
          { name: "extraData", type: "bytes[]" },
          { name: "fromToken", type: "uint256" },
        ],
      },
    ],
    outputs: [{ name: "returnAmount", type: "uint256" }],
  },
  {
    type: "function",
    name: "dagSwapTo",
    stateMutability: "payable",
    inputs: [
      { name: "orderId", type: "uint256" },
      { name: "receiver", type: "address" },
      {
        name: "baseRequest",
        type: "tuple",
        components: [
          { name: "fromToken", type: "uint256" },
          { name: "toToken", type: "address" },
          { name: "fromTokenAmount", type: "uint256" },
          { name: "minReturnAmount", type: "uint256" },
          { name: "deadLine", type: "uint256" },
        ],
      },
      {
        name: "paths",
        type: "tuple[]",
        components: [
          { name: "mixAdapters", type: "address[]" },
          { name: "assetTo", type: "address[]" },
          { name: "rawData", type: "uint256[]" },
          { name: "extraData", type: "bytes[]" },
          { name: "fromToken", type: "uint256" },
        ],
      },
    ],
    outputs: [{ name: "returnAmount", type: "uint256" }],
  },
] as const;

export interface DecodedRoute {
  selector: `0x${string}`;
  functionName: string;
  fromToken: `0x${string}`;
  toToken: `0x${string}`;
  fromTokenAmount: string;
  minReturnAmount: string;
  deadline: string;
  /** 显式收款人（dagSwapTo）；无则 null = 收款人为调用者 */
  receiver: `0x${string}` | null;
}

export const SUPPORTED_ROUTE_SELECTORS: ReadonlySet<string> = new Set([DAG_SWAP_BY_ORDER_ID_SELECTOR, DAG_SWAP_TO_SELECTOR]);

/** 解析并返回关键字段；不支持的选择器 → null（调用方标 ROUTE_UNSUPPORTED）。 */
export function decodeRouterCalldata(data: Hex): DecodedRoute | null {
  if (!/^0x[0-9a-fA-F]*$/.test(data) || data.length < 10) return null;
  const selector = data.slice(0, 10).toLowerCase() as `0x${string}`;
  if (!SUPPORTED_ROUTE_SELECTORS.has(selector)) return null;
  try {
    const d = decodeFunctionData({ abi: DAG_SWAP_ABI, data });
    let base: { fromToken: bigint; toToken: `0x${string}`; fromTokenAmount: bigint; minReturnAmount: bigint; deadLine: bigint };
    let receiver: `0x${string}` | null = null;
    if (d.functionName === "dagSwapByOrderId") {
      base = d.args[1];
    } else {
      receiver = getAddress(d.args[1]).toLowerCase() as `0x${string}`;
      base = d.args[2];
    }
    // fromToken 编码为 uint256：低 160 位是地址（高位可能带标志位）
    const fromAddr = `0x${(base.fromToken & ((1n << 160n) - 1n)).toString(16).padStart(40, "0")}` as `0x${string}`;
    return {
      selector,
      functionName: d.functionName,
      fromToken: getAddress(fromAddr).toLowerCase() as `0x${string}`,
      toToken: getAddress(base.toToken).toLowerCase() as `0x${string}`,
      fromTokenAmount: base.fromTokenAmount.toString(),
      minReturnAmount: base.minReturnAmount.toString(),
      deadline: base.deadLine.toString(),
      receiver,
    };
  } catch {
    return null;
  }
}

export interface RouteCheck {
  ok: boolean;
  reasons: string[];
  decoded: DecodedRoute | null;
}

/** 与意图逐字段比对：币种、金额、期限不早于证明期限；显式收款人必须是 Guard。 */
export function checkRouteAgainstIntent(
  data: Hex,
  intent: { inputToken: string; outputToken: string; amountInRaw: string; deadlineUnix: number; expectedReceiver?: string },
): RouteCheck {
  const decoded = decodeRouterCalldata(data);
  if (!decoded) return { ok: false, reasons: ["selector_unsupported"], decoded: null };
  const reasons: string[] = [];
  if (decoded.receiver !== null && intent.expectedReceiver && decoded.receiver !== intent.expectedReceiver.toLowerCase()) reasons.push("receiver_not_guard");
  if (decoded.fromToken !== intent.inputToken.toLowerCase()) reasons.push("from_token_mismatch");
  if (decoded.toToken !== intent.outputToken.toLowerCase()) reasons.push("to_token_mismatch");
  if (decoded.fromTokenAmount !== intent.amountInRaw) reasons.push("amount_mismatch");
  if (BigInt(decoded.deadline) < BigInt(intent.deadlineUnix)) reasons.push("router_deadline_before_certificate");
  return { ok: reasons.length === 0, reasons, decoded };
}
