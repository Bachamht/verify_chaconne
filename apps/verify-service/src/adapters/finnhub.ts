/**
 * Finnhub 股票参考价适配（CV-D02：Pyth equity 授权自 2026-08-26 失效，现网 Hermes 401/403，
 * 本项目首版实时/收盘参考源改用 Finnhub，Chaconne 主站也早已用它做交叉核对）。
 *
 * GET /api/v1/quote?symbol=AAPL → { c: 最新价, pc: 前收, t: 最新成交 Unix 秒, h,l,o,d,dp }
 *  - t 是上游给的源时间（最新成交时间），不是我们收到响应的时间；
 *  - 休市时 c 停在收盘价、t 停在收盘瞬间（16:00 ET）。
 * 只做数据搬运与时间语义标注；分类（live / close）由证据构造层按日历判断。
 */
import { isoFromUnixSeconds, keccak256Utf8, type Bytes32, type EvidenceTime } from "@chaconne/core/verify";

export interface FinnhubQuote {
  current: number;
  previousClose: number;
  /** 最新成交 Unix 秒 */
  t: number;
  high: number;
  low: number;
  open: number;
}

export interface FinnhubCall {
  ok: boolean;
  status: number;
  data: FinnhubQuote | null;
  rawHash: Bytes32;
  time: EvidenceTime;
  endpoint: string;
}

export interface FinnhubCandle {
  /** 日线：每根 K 线的收盘价与其时间（Unix 秒，当日 00:00 UTC） */
  closes: number[];
  times: number[];
}
export interface FinnhubCandleCall {
  ok: boolean;
  status: number;
  data: FinnhubCandle | null;
  rawHash: Bytes32;
  time: EvidenceTime;
  endpoint: string;
}

export class FinnhubClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl = "https://finnhub.io/api/v1",
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async quote(symbol: string, timeoutMs = 10_000): Promise<FinnhubCall> {
    const requestedAt = this.clock().toISOString();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let status = 0;
    let text = "";
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/quote?symbol=${encodeURIComponent(symbol)}`, {
        headers: { "X-Finnhub-Token": this.apiKey },
        signal: ctrl.signal,
      });
      status = res.status;
      text = await res.text();
    } finally {
      clearTimeout(timer);
    }
    const receivedAt = this.clock().toISOString();
    let data: FinnhubQuote | null = null;
    try {
      const j = JSON.parse(text) as { c?: number; pc?: number; t?: number; h?: number; l?: number; o?: number };
      if (status === 200 && typeof j.c === "number" && typeof j.t === "number" && j.c > 0 && j.t > 0) {
        data = { current: j.c, previousClose: j.pc ?? 0, t: j.t, high: j.h ?? 0, low: j.l ?? 0, open: j.o ?? 0 };
      }
    } catch {
      data = null;
    }
    return {
      ok: data !== null,
      status,
      data,
      rawHash: keccak256Utf8(text),
      time: {
        requestedAt,
        receivedAt,
        sourcePublishedAt: data ? isoFromUnixSeconds(data.t) : null,
        sourceTimeKind: data ? "published" : "not_provided",
      },
      endpoint: `quote?symbol=${symbol}`,
    };
  }

  /**
   * 日线 K 线（收盘确认用，CV-D06）。v5 探针 2026-09-20：免费档返回 403 "You don't have access to this resource"，
   * 因此 ok=false 时调用方回退到"次日 pc 与已记录 last_tick 一致"的确认路径。
   */
  async candle(symbol: string, fromUnix: number, toUnix: number, timeoutMs = 10_000): Promise<FinnhubCandleCall> {
    const requestedAt = this.clock().toISOString();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let status = 0;
    let text = "";
    const endpoint = `stock/candle?symbol=${symbol}&resolution=D`;
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/stock/candle?symbol=${encodeURIComponent(symbol)}&resolution=D&from=${fromUnix}&to=${toUnix}`, {
        headers: { "X-Finnhub-Token": this.apiKey },
        signal: ctrl.signal,
      });
      status = res.status;
      text = await res.text();
    } finally {
      clearTimeout(timer);
    }
    const receivedAt = this.clock().toISOString();
    let data: FinnhubCandle | null = null;
    try {
      const j = JSON.parse(text) as { s?: string; c?: number[]; t?: number[] };
      if (status === 200 && j.s === "ok" && Array.isArray(j.c) && Array.isArray(j.t) && j.c.length === j.t.length) data = { closes: j.c, times: j.t };
    } catch {
      data = null;
    }
    return { ok: data !== null, status, data, rawHash: keccak256Utf8(text), time: { requestedAt, receivedAt, sourcePublishedAt: null, sourceTimeKind: "not_provided" }, endpoint };
  }
}
