import { config } from '../config.js';
import { fetchJson } from '../core/http.js';
import { RateLimiter } from '../core/rateLimiter.js';
import { candles as candleRepo, type Candle } from '../storage/repo.js';

/** Ücretsiz GeckoTerminal API: ~30 istek/dk */
const limiter = RateLimiter.perMinute(config.GECKOTERMINAL_RPM);

export type Timeframe = 'minute' | 'hour' | 'day';

interface OhlcvResponse {
  data?: { attributes?: { ohlcv_list?: Array<[number, number, number, number, number, number]> } };
}

export const geckoterminal = {
  /**
   * OHLCV mumları (USD). `aggregate`: minute için 1/5/15, hour için 1/4/12, day için 1.
   * Sonuçlar önbelleğe yazılır. Eskiden yeniye sıralı döner.
   */
  async ohlcv(
    pool: string,
    tf: Timeframe,
    opts: { aggregate?: number; beforeTs?: number; limit?: number } = {},
  ): Promise<Candle[]> {
    const params = new URLSearchParams({
      aggregate: String(opts.aggregate ?? 1),
      limit: String(opts.limit ?? 1000),
      currency: 'usd',
    });
    if (opts.beforeTs) params.set('before_timestamp', String(opts.beforeTs));
    const url = `${config.GECKOTERMINAL_BASE_URL}/networks/solana/pools/${pool}/ohlcv/${tf}?${params}`;
    const res = await fetchJson<OhlcvResponse>(url, { limiter });
    const list = res.data?.attributes?.ohlcv_list ?? [];
    const rows: Candle[] = list
      .map(([ts, o, h, l, c, v]) => ({ ts, o, h, l, c, v }))
      .sort((a, b) => a.ts - b.ts);
    const tfKey = `${tf}${opts.aggregate ?? 1}`;
    if (rows.length) candleRepo.insertMany(pool, tfKey, rows);
    return rows;
  },

  /** Önbellekten okur, eksikse API'den tamamlar */
  async ohlcvRange(pool: string, tf: Timeframe, aggregate: number, fromTs: number, toTs: number): Promise<Candle[]> {
    const tfKey = `${tf}${aggregate}`;
    const cached = candleRepo.range(pool, tfKey, fromTs, toTs);
    const stepSec = (tf === 'minute' ? 60 : tf === 'hour' ? 3600 : 86400) * aggregate;
    const expected = Math.floor((toTs - fromTs) / stepSec);
    if (cached.length >= expected * 0.9) return cached;
    let before = toTs + stepSec;
    const out = new Map<number, Candle>();
    for (let i = 0; i < 10; i++) {
      const page = await this.ohlcv(pool, tf, { aggregate, beforeTs: before, limit: 1000 });
      if (!page.length) break;
      for (const c of page) out.set(c.ts, c);
      const oldest = page[0]!.ts;
      if (oldest <= fromTs || page.length < 1000) break;
      before = oldest;
    }
    return [...out.values()].filter((c) => c.ts >= fromTs && c.ts <= toTs).sort((a, b) => a.ts - b.ts);
  },
};
