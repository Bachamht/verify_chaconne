/** 代理调用方解析（FIX-175）：真实地址必须有登录会话；占位地址免登录；cookie 只记占位地址。 */
import { describe, expect, it } from "vitest";
import { ownerFromBody, PLACEHOLDER_OWNER, resolveCaller } from "../lib/proxyOwner";

const A = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";
const a = A.toLowerCase();
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("resolveCaller", () => {
  it("请求里的真实地址等于会话地址 → 当调用方；不等或没会话 → denied（401 wallet_signin_required）", () => {
    expect(resolveCaller({ sessionOwner: a, queryOwner: A }, { ownerSetter: false })).toEqual({ caller: a, persist: null, denied: null });
    expect(resolveCaller({ sessionOwner: a, pathOwner: A }, { ownerSetter: false })).toEqual({ caller: a, persist: null, denied: null });
    expect(resolveCaller({ sessionOwner: a, bodyOwner: A }, { ownerSetter: true })).toEqual({ caller: a, persist: null, denied: null });
    expect(resolveCaller({ queryOwner: A }, { ownerSetter: false })).toEqual({ caller: "", persist: null, denied: a });
    expect(resolveCaller({ sessionOwner: B, bodyOwner: A }, { ownerSetter: true })).toEqual({ caller: "", persist: null, denied: a });
    // cookie 记着别的真实地址也压不过会话
    expect(resolveCaller({ sessionOwner: a, cookieOwner: B, queryOwner: A }, { ownerSetter: false }).caller).toBe(a);
  });
  it("没写地址：用会话地址；没会话时 cookie 里的占位地址还算数，真实地址不算（denied 让浏览器登录后重试）", () => {
    expect(resolveCaller({ sessionOwner: a, cookieOwner: PLACEHOLDER_OWNER }, { ownerSetter: false })).toEqual({ caller: a, persist: null, denied: null });
    expect(resolveCaller({ cookieOwner: PLACEHOLDER_OWNER }, { ownerSetter: false })).toEqual({ caller: PLACEHOLDER_OWNER, persist: null, denied: null });
    expect(resolveCaller({ cookieOwner: B }, { ownerSetter: false })).toEqual({ caller: "", persist: null, denied: B });
    expect(resolveCaller({}, { ownerSetter: false })).toEqual({ caller: "", persist: null, denied: null });
    expect(resolveCaller({ cookieOwner: "junk", queryOwner: "0x12" }, { ownerSetter: false })).toEqual({ caller: "", persist: null, denied: null });
  });
  it("占位地址（无钱包模拟）免登录；建任务时只在没有会话的浏览器里记进 cookie；真实地址不再写 cookie", () => {
    expect(resolveCaller({ bodyOwner: PLACEHOLDER_OWNER }, { ownerSetter: true })).toEqual({ caller: PLACEHOLDER_OWNER, persist: PLACEHOLDER_OWNER, denied: null });
    expect(resolveCaller({ sessionOwner: a, bodyOwner: PLACEHOLDER_OWNER }, { ownerSetter: true })).toEqual({ caller: PLACEHOLDER_OWNER, persist: null, denied: null });
    expect(resolveCaller({ bodyOwner: PLACEHOLDER_OWNER }, { ownerSetter: false }).persist).toBeNull();
    expect(resolveCaller({ sessionOwner: a, bodyOwner: A }, { ownerSetter: true }).persist).toBeNull();
  });
});

describe("ownerFromBody", () => {
  it("按 ownerAddress / owner / goal.ownerAddress / typedData.message.owner 顺序取，坏 JSON 返回 null", () => {
    expect(ownerFromBody(JSON.stringify({ ownerAddress: A }))).toBe(A);
    expect(ownerFromBody(JSON.stringify({ owner: B }))).toBe(B);
    expect(ownerFromBody(JSON.stringify({ goal: { ownerAddress: A } }))).toBe(A);
    expect(ownerFromBody(JSON.stringify({ typedData: { message: { owner: B } } }))).toBe(B);
    expect(ownerFromBody(JSON.stringify({ ownerAddress: 5 }))).toBeNull();
    expect(ownerFromBody("{bad")).toBeNull();
    expect(ownerFromBody(undefined)).toBeNull();
  });
});
