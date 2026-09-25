/** 代理调用方解析：请求里的地址优先于 cookie；占位地址不覆盖已记住的真实地址（修「试玩不填地址后查自己任务被拒」）。 */
import { describe, expect, it } from "vitest";
import { ownerFromBody, PLACEHOLDER_OWNER, resolveCaller } from "../lib/proxyOwner";

const A = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";
const a = A.toLowerCase();
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("resolveCaller", () => {
  it("cookie 记了占位地址后，用自己的地址查任务 / 事件 / 组合都按自己的地址当调用方", () => {
    expect(resolveCaller({ cookieOwner: PLACEHOLDER_OWNER, queryOwner: A }, { ownerSetter: false })).toEqual({ caller: a, persist: null });
    expect(resolveCaller({ cookieOwner: PLACEHOLDER_OWNER, pathOwner: A }, { ownerSetter: false })).toEqual({ caller: a, persist: null });
    expect(resolveCaller({ cookieOwner: B, bodyOwner: A }, { ownerSetter: false })).toEqual({ caller: a, persist: null });
  });
  it("没写地址才用 cookie；什么都没有就不带调用方", () => {
    expect(resolveCaller({ cookieOwner: B }, { ownerSetter: false })).toEqual({ caller: B, persist: null });
    expect(resolveCaller({ cookieOwner: PLACEHOLDER_OWNER }, { ownerSetter: false })).toEqual({ caller: PLACEHOLDER_OWNER, persist: null });
    expect(resolveCaller({}, { ownerSetter: false })).toEqual({ caller: "", persist: null });
    expect(resolveCaller({ cookieOwner: "junk", queryOwner: "0x12" }, { ownerSetter: false })).toEqual({ caller: "", persist: null });
  });
  it("建任务等路径用真实地址 → 写 cookie；用占位地址只在浏览器还没记过真实地址时才写", () => {
    expect(resolveCaller({ bodyOwner: A }, { ownerSetter: true })).toEqual({ caller: a, persist: a });
    expect(resolveCaller({ cookieOwner: B, bodyOwner: A }, { ownerSetter: true })).toEqual({ caller: a, persist: a });
    expect(resolveCaller({ bodyOwner: PLACEHOLDER_OWNER }, { ownerSetter: true })).toEqual({ caller: PLACEHOLDER_OWNER, persist: PLACEHOLDER_OWNER });
    expect(resolveCaller({ cookieOwner: PLACEHOLDER_OWNER, bodyOwner: PLACEHOLDER_OWNER }, { ownerSetter: true })).toEqual({ caller: PLACEHOLDER_OWNER, persist: PLACEHOLDER_OWNER });
    // 关键：已经记住真实地址 B 的浏览器去试玩不填地址，不会被改记成占位地址
    expect(resolveCaller({ cookieOwner: B, bodyOwner: PLACEHOLDER_OWNER }, { ownerSetter: true })).toEqual({ caller: PLACEHOLDER_OWNER, persist: null });
  });
  it("非 owner-setter 的 POST 不写 cookie，即便 body 有地址", () => {
    expect(resolveCaller({ cookieOwner: B, bodyOwner: A }, { ownerSetter: false }).persist).toBeNull();
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
