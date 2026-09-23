/**
 * C5 Recap 服务：GET /v1/recaps?owner&date、GET /v1/recaps/:id、POST /v1/recaps/:id/share、GET /pub/recaps/:shareId。
 * 生成门槛 = 纽约实际收盘 + 45 min（window.ts）；没到门槛回 200 {status:"pending"}，不提前编内容。
 */
import { randomBytes } from "node:crypto";
import { NYSE_CALENDAR, type MarketCalendar } from "@chaconne/core";
import { HttpError } from "../jobs/service";
import { buildRecap, publicRecapView, recapId } from "./build";
import type { RecapSources } from "./sources";
import type { RecapStore } from "./store";
import type { Recap, RecapPending } from "./types";
import { latestDueRecapDate, recapWindow } from "./window";

export interface RecapsDeps {
  sources: RecapSources;
  store: RecapStore;
  now?: () => Date;
  calendar?: MarketCalendar;
}

const OWNER_RE = /^0x[0-9a-fA-F]{40}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class RecapsService {
  private readonly now: () => Date;
  private readonly cal: MarketCalendar;
  constructor(private readonly d: RecapsDeps) {
    this.now = d.now ?? (() => new Date());
    this.cal = d.calendar ?? NYSE_CALENDAR;
  }

  /** owner 鉴权：web 通配 caller 形如 `web:<addr>` 必须与 owner 一致；固定 API key 调用方只能看自己登记的数据（数据源按 callerId 过滤） */
  private assertOwner(callerId: string, owner: string): void {
    if (!OWNER_RE.test(owner)) throw new HttpError(400, "owner_required", "owner must be an EVM address");
    const idx = callerId.lastIndexOf(":");
    const tail = idx >= 0 ? callerId.slice(idx + 1) : "";
    if (OWNER_RE.test(tail) && tail.toLowerCase() !== owner.toLowerCase()) throw new HttpError(403, "owner_mismatch", "recaps are only visible to their owner");
  }

  async forOwner(callerId: string, owner: string, date?: string, refresh = false): Promise<Recap | RecapPending> {
    this.assertOwner(callerId, owner);
    const now = this.now();
    const ownerLc = owner.toLowerCase();
    if (date !== undefined && !DATE_RE.test(date)) throw new HttpError(400, "bad_date", "date must be YYYY-MM-DD (America/New_York trading day)");
    const target = date ?? latestDueRecapDate(now, this.cal);
    if (!target) throw new HttpError(503, "calendar_uncovered", "no due trading day within the calendar coverage");
    const w = recapWindow(target, this.cal);
    if (!w.tradingDay || !w.generateAfterUtc || w.generateAfterUtc.getTime() > now.getTime()) {
      return {
        status: "pending",
        owner: ownerLc,
        date: target,
        tz: "America/New_York",
        closeAtUtc: w.closeAtUtc?.toISOString() ?? null,
        earlyClose: w.earlyClose,
        generateAfterUtc: w.generateAfterUtc?.toISOString() ?? null,
        tradingDay: w.tradingDay,
        note: w.tradingDay ? `Recap is generated ${w.earlyClose ? "after the 13:00 ET early close" : "after the 16:00 ET close"} + 45 minutes (America/New_York, DST-aware).` : "Not a US trading day (weekend or NYSE holiday); no recap is generated.",
      };
    }
    const id = recapId(callerId, ownerLc, target);
    if (!refresh) {
      const cached = await this.d.store.get(id);
      if (cached) return cached.recap;
    }
    const mandates = await this.d.sources.mandatesForOwner(callerId, ownerLc, w.dayStartUtc, w.dayEndUtc);
    const tasks = this.d.sources.tasksForOwner ? await this.d.sources.tasksForOwner(callerId, ownerLc) : null;
    const events = this.d.sources.eventsBetween ? await this.d.sources.eventsBetween(w.dayStartUtc, w.dayEndUtc) : null;
    const prev = refresh ? await this.d.store.get(id) : null;
    const recap = buildRecap({ id, owner: ownerLc, window: w, now, mandates, evidenceMode: this.d.sources.evidenceMode(), tasks, eventsAvailable: events !== null });
    if (prev) recap.share = prev.recap.share; // 刷新内容不改分享设置
    await this.d.store.put(callerId, recap);
    return recap;
  }

  async byId(callerId: string, id: string): Promise<Recap> {
    const s = await this.d.store.get(id);
    if (!s || s.callerId !== callerId) throw new HttpError(404, "recap_not_found", "recap not found, or it belongs to another caller");
    return s.recap;
  }

  /** R-04：默认私密；公开可隐藏资产与金额；owner 永远不出现在公开视图 */
  async setShare(callerId: string, id: string, raw: unknown): Promise<Recap["share"]> {
    const recap = await this.byId(callerId, id);
    const b = (raw ?? {}) as Record<string, unknown>;
    const isPublic = b["public"] === true;
    const share: Recap["share"] = {
      public: isPublic,
      hideAssets: b["hideAssets"] === undefined ? recap.share.hideAssets : b["hideAssets"] !== false,
      hideAmounts: b["hideAmounts"] === undefined ? recap.share.hideAmounts : b["hideAmounts"] !== false,
      shareId: recap.share.shareId ?? (isPublic ? `rsh_${randomBytes(12).toString("hex")}` : null),
      publicUrl: null,
    };
    share.publicUrl = isPublic && share.shareId ? `/pub/recaps/${share.shareId}` : null;
    recap.share = share;
    await this.d.store.put(callerId, recap);
    return share;
  }

  async publicView(shareId: string): Promise<Record<string, unknown>> {
    const s = await this.d.store.byShareId(shareId);
    if (!s || !s.recap.share.public) throw new HttpError(404, "share_not_found", "this recap is private or does not exist");
    return publicRecapView(s.recap);
  }
}

export { publicRecapView, recapId };
