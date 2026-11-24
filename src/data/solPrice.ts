import { config } from '../config.js';
import { SOL_MINT } from '../core/constants.js';
import { childLogger } from '../core/logger.js';
import { solPrice as repo } from '../storage/repo.js';
import { geckoterminal } from './geckoterminal.js';
import { jupiter } from './jupiter.js';

const log = childLogger('solPrice');
const dayOf = (tsSec: number) => Math.floor(tsSec / 86400);

let live: { at: number; usd: number } | null = null;

export const solPriceService = {
  /** Günlük SOL/USD geçmişini GeckoTerminal'den çekip önbelleğe yazar (bir kez yeterli, sonra günlük) */
  async syncHistory() {
    try {
      const rows = await geckoterminal.ohlcv(config.SOL_USDC_POOL, 'day', { limit: 1000 });
      repo.setMany(rows.map((r) => ({ day: dayOf(r.ts), usd: r.c })));
      log.info({ days: rows.length }, 'SOL fiyat geçmişi güncellendi');
    } catch (err) {
      log.warn({ err: String(err) }, 'SOL fiyat geçmişi alınamadı');
    }
  },

  /** Verilen zamandaki SOL/USD (günlük kapanış). Veri yoksa en yakın gün. */
  at(tsSec: number): number | undefined {
    return repo.get(dayOf(tsSec)) ?? repo.nearest(dayOf(tsSec));
  },

  async now(): Promise<number> {
    if (live && Date.now() - live.at < 60_000) return live.usd;
    try {
      const p = await jupiter.prices([SOL_MINT]);
      const usd = p[SOL_MINT]?.usdPrice;
      if (usd) {
        live = { at: Date.now(), usd };
        return usd;
      }
    } catch (err) {
      log.warn({ err: String(err) }, 'canlı SOL fiyatı alınamadı');
    }
    const fallback = this.at(Date.now() / 1000);
    if (!fallback) throw new Error('SOL fiyatı bilinmiyor');
    return fallback;
  },
};
