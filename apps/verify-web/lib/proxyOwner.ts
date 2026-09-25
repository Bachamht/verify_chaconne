/**
 * 网页代理的调用方地址（x-verify-caller）解析。纯函数，路由与测试共用。
 *
 * 规则（修复「不填地址试玩后，浏览器被记成共用占位地址，之后查自己的任务被拒」）：
 * 1. 请求里明确写了地址（?owner= / 组合路径 / body 的 ownerAddress|owner|goal.ownerAddress|typedData.message.owner）→ 按那个地址当调用方，
 *    不再让浏览器 cookie 压过它；服务端仍按 owner 鉴权，这与此前「没有 cookie 时按 ?owner= 当调用方」一样，不放宽任何边界。
 * 2. 没写地址才用 cookie 记住的地址。
 * 3. 占位地址（无钱包模拟 / 试玩用的 0x…0001）不会覆盖 cookie 里已经记住的真实地址：只有浏览器还没记过任何真实地址时
 *    才写占位地址（新浏览器不填地址跑「第一分钟」后，打开那条任务的详情仍要能读到）。
 */
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** 与 TaskForm.PLACEHOLDER_OWNER / onboarding SIMULATION_OWNER / PlayClient 缺省 owner 同一个值 */
export const PLACEHOLDER_OWNER = "0x0000000000000000000000000000000000000001";

export interface CallerInput {
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
}

const norm = (v: string | null | undefined) => (typeof v === "string" && ADDRESS.test(v) ? v.toLowerCase() : "");

export function resolveCaller(input: CallerInput, opts: { ownerSetter: boolean }): CallerResult {
  const explicit = norm(input.bodyOwner) || norm(input.queryOwner) || norm(input.pathOwner);
  const remembered = norm(input.cookieOwner);
  const caller = explicit || remembered;
  const rememberedReal = remembered !== "" && remembered !== PLACEHOLDER_OWNER;
  const persist = opts.ownerSetter && explicit && !(explicit === PLACEHOLDER_OWNER && rememberedReal) ? explicit : null;
  return { caller, persist };
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
