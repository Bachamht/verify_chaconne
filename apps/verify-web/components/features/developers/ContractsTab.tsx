"use client";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { Hash } from "@/components/kit/Hash";
import { Panel } from "@/components/kit/Panel";
import { useI18n } from "@/lib/i18n";
import { ADDRESSES, sourcifyUrl } from "./devNav";

const LINK = "text-brand-400 underline underline-offset-2 hover:text-brand-300";

/** 合约 tab：地址（完整显示、可复制、浏览器 / Sourcify）+ 信任边界 */
export function ContractsTab() {
  const { t, locale } = useI18n();
  const zh = locale === "zh";
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Panel id="addresses" className="scroll-mt-20">
        <Panel.Header title={zh ? "地址（X Layer 主网 · chainId 196）" : "Addresses (X Layer mainnet · chainId 196)"} />
        <Panel.Body>
          <dl className="divide-y divide-line">
            {ADDRESSES.map((a) => (
              <div key={a.key} className="flex min-w-0 flex-col gap-1 py-3 first:pt-0 md:flex-row md:items-center md:justify-between md:gap-4">
                <dt className="text-sm text-fg-2">{zh ? a.zh : a.en}</dt>
                <dd className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                  {/* 地址完整显示（head=42 不截断），窄屏允许折行 */}
                  <Hash value={a.value} kind="address" head={42} tail={0} className="flex-wrap [&>span]:break-all" />
                  {a.contract ? (
                    <a className="inline-flex items-center gap-0.5 text-xs text-fg-2 hover:text-fg-1" href={sourcifyUrl(a.value)} target="_blank" rel="noopener noreferrer">
                      Sourcify<ArrowUpRight className="size-3" aria-hidden="true" />
                    </a>
                  ) : null}
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-xs leading-5 text-fg-3">{zh ? "PlanGuard 合约 Sourcify 精确匹配；EIP-712 domain：ChaconneVerifyPlanGuard v1。当前 signer 与 epoch 也可从 GET /healthz 读取。" : "PlanGuard is a Sourcify exact match; EIP-712 domain: ChaconneVerifyPlanGuard v1. The current signer and epoch are also exposed by GET /healthz."}</p>
        </Panel.Body>
      </Panel>

      <Panel id="trust" className="scroll-mt-20">
        <Panel.Header title={zh ? "信任边界（如实）" : "Trust boundary (stated plainly)"} />
        <Panel.Body>
          <ul className="list-disc space-y-1.5 pl-5 text-sm leading-6 text-fg-2">
            <li>{zh ? "服务持有一把只签证明（VerificationCertificate / StepCertificate / bundleHash）的私钥；不持有用户资金私钥，不代签付款或交易，不做 relayer。" : "The service holds one attestation key that signs only certificates (VerificationCertificate / StepCertificate / bundleHash); it never holds user fund keys, never signs payments or trades, and runs no relayer."}</li>
            <li>{zh ? "PlanGuard 强制金额、最小到账、收款人、路由/选择器白名单、期限、nonce 与步序；它不知道链下股票参考是否正确：这是证明服务的判断，通过 evidenceHash 绑定，任何人可用证据包离线复核。" : "PlanGuard enforces amount, minimum output, recipient, route/selector allowlists, deadline, nonce and step order; it cannot know whether off-chain stock data was correct — that judgement is the attestation service's, bound by evidenceHash and re-checkable offline from the evidence bundle."}</li>
            <li>{zh ? "证明最长 60 秒，且不得比它依据的报价更久（通常约 30 秒）。管理员可暂停、轮换签名身份、改白名单；不能动用户资金。" : "A certificate lives at most 60 s and never longer than the quote it rests on (usually about 30 s). Admin can pause, rotate the signer and edit allowlists; it cannot move user funds."}</li>
            <li>{zh ? "证据里 kind=pyth_reference 是历史命名（CV-D01 泛化为「实时参考 tick」），provider 字段标明真实来源（finnhub）。" : "The evidence kind pyth_reference is a legacy name (generalized to “live reference tick” under CV-D01); the provider field states the real source (finnhub)."}</li>
          </ul>
          <p className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
            <Link className={LINK} href="/verify-bundle">{t("nav_verify_bundle")} →</Link>
          </p>
        </Panel.Body>
      </Panel>
    </div>
  );
}
