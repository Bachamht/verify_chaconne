"use client";
/**
 * 连接钱包的按钮状态：busy + 最近一次错误（原始错误，由调用方决定怎么说）。页头钱包按钮与钱包门共用。
 * 连接本身完全交给 lib/wallet 的 connect / forgetWallet。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { connect, forgetWallet } from "@/lib/wallet";

export function useConnect() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  /** force = 更换钱包：先忘掉记住的钱包，再弹出选择 */
  const run = useCallback(async (force = false): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      if (force) forgetWallet();
      await connect({ force });
      return true;
    } catch (e) {
      if (alive.current) setError(e ?? new Error("connect failed"));
      return false;
    } finally {
      if (alive.current) setBusy(false);
    }
  }, []);
  return { busy, error, connect: run };
}
