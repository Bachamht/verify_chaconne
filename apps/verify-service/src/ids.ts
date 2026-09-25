import { randomBytes } from "node:crypto";

/** 前缀 + 96 bit 随机 hex（不可猜、URL 安全） */
export function newId(prefix: "job" | "ord" | "pay" | "exe" | "rfd" | "ev" | "pln" | "mnd" | "evl" | "stp" | "sim" | "tpl" | "shr" | "cand" | "bgp" | "bal" | "ovr" | "nch" | "ntf" | "hb" | "rbp" | "rbl" | "rpl" | /* v6 Lane B */ "ctx" | "tsk" | "ths" | "evt" | /* CV-D16 */ "int" | /* FIX-175 */ "key"): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}
