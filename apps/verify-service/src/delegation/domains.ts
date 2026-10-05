/**
 * permit 域配置（v7 §2.3，CV-D20）：config/permit-domains.xlayer.json。
 *   - 只有 status 缺省或为 "approved" 的文件才生效（草案 "draft_pending_operator_approval" 一律视为未核实 → 该代币回退 approve 路径并如实计数）；
 *   - 启动时对每条重算域分隔符，并经 RPC 读一次链上 DOMAIN_SEPARATOR() 比对；任一不等即对该代币关闭 permit（permit_domain_unverified）并告警。
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { permitDomainSeparator, type PermitDomain, type PermitDomainEntry, type PermitDomainsFile } from "@chaconne/core/verify";
import type { ServiceChain } from "../execution/chain";
import { log } from "../log";

export class PermitDomains {
  private readonly entries = new Map<string, PermitDomainEntry>();
  private readonly disabled = new Map<string, string>();
  readonly approved: boolean;
  constructor(
    file: (PermitDomainsFile & { status?: string }) | null,
    readonly chainId: number,
  ) {
    this.approved = !!file && (file.status === undefined || file.status === "approved");
    if (!file) return;
    for (const e of file.entries ?? []) {
      const token = e.token.toLowerCase();
      this.entries.set(token, e);
      const recomputed = permitDomainSeparator({ name: e.name, version: e.version, chainId: file.chainId, verifyingContract: token as `0x${string}` });
      if (file.chainId !== chainId) this.disabled.set(token, "chain_mismatch");
      else if (recomputed.toLowerCase() !== e.domainSeparator.toLowerCase()) this.disabled.set(token, "recomputed_mismatch");
    }
  }

  static load(path: string, chainId: number): PermitDomains {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const p = isAbsolute(path) ? path : join(root, path);
    if (!existsSync(p)) {
      log.warn("permit 域配置不存在：全部代币回退 approve 路径", { path: p });
      return new PermitDomains(null, chainId);
    }
    const f = JSON.parse(readFileSync(p, "utf8")) as PermitDomainsFile & { status?: string };
    const d = new PermitDomains(f, chainId);
    if (!d.approved) log.warn("permit 域配置未经运营者批准（status ≠ approved）：permit 关闭", { path: p, status: f.status });
    return d;
  }

  /** 启动时经 RPC 读链上 DOMAIN_SEPARATOR 比对；不等或读不到 → 关闭该代币 permit */
  async verifyOnChain(chain: ServiceChain): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const [token, e] of this.entries) {
      try {
        const onchain = (await chain.domainSeparator(token as `0x${string}`)).toLowerCase();
        if (onchain !== e.domainSeparator.toLowerCase()) {
          this.disabled.set(token, "onchain_mismatch");
          log.error("permit 域与链上 DOMAIN_SEPARATOR 不等：关闭该代币 permit", { token });
        }
      } catch (err) {
        this.disabled.set(token, "onchain_unreadable");
        log.warn("读取链上 DOMAIN_SEPARATOR 失败：暂时关闭该代币 permit", { token, error: err instanceof Error ? err.message.slice(0, 160) : String(err) });
      }
      out[token] = this.disabled.get(token) ?? "ok";
    }
    return out;
  }

  supported(token: string): boolean {
    const t = token.toLowerCase();
    return this.approved && this.entries.has(t) && !this.disabled.has(t);
  }
  domain(token: string): PermitDomain | null {
    const e = this.entries.get(token.toLowerCase());
    if (!e || !this.supported(token)) return null;
    return { name: e.name, version: e.version, chainId: this.chainId, verifyingContract: token.toLowerCase() as `0x${string}` };
  }
  status(): Array<{ token: string; supported: boolean; reason: string | null }> {
    return [...this.entries.keys()].map((t) => ({ token: t, supported: this.supported(t), reason: !this.approved ? "not_approved" : (this.disabled.get(t) ?? null) }));
  }
}
