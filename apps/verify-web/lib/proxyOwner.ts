/**
 * 网页代理的调用方地址（x-verify-caller）解析。纯函数，路由与测试共用。
 *
 * 规则（FIX-175：调用方地址必须有钱包签名的会话，堵住「请求里自报任意地址」）：
 * 1. 请求里明确写了地址（?owner= / 组合路径 / body 的 ownerAddress|owner|goal.ownerAddress|typedData.message.owner）：
 *    - 是占位地址（无钱包模拟 / 试玩用的 0x…0001）→ 直接当调用方，不需要登录；
 *    - 是真实地址 → 必须等于会话里登录的地址，否则 denied（代理回 401 wallet_signin_required，浏览器端自动弹登录签名再重试）。
 * 2. 没写地址：有会话用会话地址；没有会话时只有 cookie 记住的占位地址还算数（真实地址不再靠 cookie 记，靠会话）。
 * 3. cookie 只再用来记占位地址（新浏览器不填地址跑「第一分钟」后，打开那条任务的详情仍要能读到）。
 */
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** 与 TaskForm.PLACEHOLDER_OWNER / onboarding SIMULATION_OWNER / PlayClient 缺省 owner 同一个值 */
export const PLACEHOLDER_OWNER = "0x0000000000000000000000000000000000000001";

export interface CallerInput {
  /** 钱包登录会话里的地址（代理已验签） */
  sessionOwner?: string | null;
  cookieOwner?: string | null;
  queryOwner?: string | null;
  pathOwner?: string | null;
  /** 建任务等路径的 body 地址；不是 owner-setter 的 POST 也可以传（事件台动作 body.owner） */
  bodyOwner?: string | null;
}
export interface CallerResult {
  /** 发给服务的 x-verify-caller；"" = 不带 */
  caller: string;
  /** 响应成功后要写进 cookie 的地址；null = 不写（保持原样） */
  persist: string | null;
  /** 请求想以这个真实地址行事但没有它的登录会话 → 代理回 401 wallet_signin_required */
  denied: string | null;
}

const norm = (v: string | null | undefined) => (typeof v === "string" && ADDRESS.test(v) ? v.toLowerCase() : "");

export function resolveCaller(input: CallerInput, opts: { ownerSetter: boolean }): CallerResult {
  const explicit = norm(input.bodyOwner) || norm(input.queryOwner) || norm(input.pathOwner);
  const session = norm(input.sessionOwner);
  const remembered = norm(input.cookieOwner);
  if (explicit) {
    if (explicit === PLACEHOLDER_OWNER) return { caller: PLACEHOLDER_OWNER, persist: opts.ownerSetter && !session ? PLACEHOLDER_OWNER : null, denied: null };
    if (explicit === session) return { caller: explicit, persist: null, denied: null };
    return { caller: "", persist: null, denied: explicit };
  }
  if (session) return { caller: session, persist: null, denied: null };
  if (remembered === PLACEHOLDER_OWNER) return { caller: PLACEHOLDER_OWNER, persist: null, denied: null };
  // cookie 里记着的真实地址（旧规则留下的）没有会话不算数：让浏览器端登录后重试
  if (remembered) return { caller: "", persist: null, denied: remembered };
  return { caller: "", persist: null, denied: null };
}

/** 从 POST/PUT body 里取出可能的 owner 字段（解析失败交给服务校验） */
export function ownerFromBody(bodyText: string | undefined): string | null {
  try {
    const b = JSON.parse(bodyText || "{}") as { ownerAddress?: unknown; owner?: unknown; goal?: { ownerAddress?: unknown }; typedData?: { message?: { owner?: unknown } } };
    const cand = b.ownerAddress ?? b.owner ?? b.goal?.ownerAddress ?? b.typedData?.message?.owner;
    return typeof cand === "string" ? cand : null;
  } catch {
    return null;
  }
}
