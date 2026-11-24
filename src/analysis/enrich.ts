import { childLogger } from '../core/logger.js';
import { geckoterminal } from '../data/geckoterminal.js';
import { tokens, tripContext, type Candle, type TripContext } from '../storage/repo.js';
import type { RoundTrip } from './positions.js';

const log = childLogger('enrich');

/** Mumlardan giriş öncesi momentum ve pozisyon süresince zirve/dip hesaplar (saf fonksiyon) */
export function contextFromCandles(trip: RoundTrip, candles: Candle[]): TripContext | undefined {
  const entryTs = trip.buys[0]?.ts;
  if (!entryTs || !candles.length) return undefined;
  const before = candles.filter((c) => c.ts < entryTs);
  const during = candles.filter((c) => c.ts >= entryTs - 60 && c.ts <= (trip.closedAt ?? entryTs + 3600));
  const priceAt = (ts: number) => {
    const c = [...before].reverse().find((x) => x.ts <= ts);
    return c?.c;
  };
  const entryPrice = before[before.length - 1]?.c ?? during[0]?.o;
  if (!entryPrice) return undefined;
  const p5 = priceAt(entryTs - 300);
  const p15 = priceAt(entryTs - 900);
  const vol15 = before.filter((c) => c.ts >= entryTs - 900).reduce((s, c) => s + c.v, 0);
  const vol60 = before.filter((c) => c.ts >= entryTs - 3600 && c.ts < entryTs - 900).reduce((s, c) => s + c.v, 0);
  const peak = during.length ? Math.max(...during.map((c) => c.h)) : undefined;
  const trough = during.length ? Math.min(...during.map((c) => c.l)) : undefined;
  return {
    preChange5m: p5 ? (entryPrice / p5 - 1) * 100 : undefined,
    preChange15m: p15 ? (entryPrice / p15 - 1) * 100 : undefined,
    volumeSurge: vol60 > 0 ? vol15 / 15 / (vol60 / 45) : undefined,
    peakMultiple: peak ? peak / entryPrice : undefined,
    troughMultiple: trough ? trough / entryPrice : undefined,
  };
}

/**
 * Kapanmış turları GeckoTerminal dakikalık mumlarıyla zenginleştirir.
 * Ücretsiz limit (~30/dk) nedeniyle `limit` ile sınırlanır; en büyük turlar önce.
 */
export async function enrichTrips(trips: RoundTrip[], limit = 40): Promise<number> {
  const todo = trips
    .filter((t) => t.status === 'closed' && !t.excluded && !tripContext.get(t.wallet, t.mint, t.openedAt))
    .sort((a, b) => b.costSol - a.costSol)
    .slice(0, limit);
  let done = 0;
  for (const t of todo) {
    const pool = tokens.get(t.mint)?.pairAddress;
    if (!pool) continue;
    const entry = t.buys[0]!.ts;
    const end = Math.min(t.closedAt ?? entry + 3600, entry + 6 * 3600);
    try {
      const span = end - (entry - 3600);
      const aggregate = span > 1000 * 60 ? 5 : 1;
      const cs = await geckoterminal.ohlcvRange(pool, 'minute', aggregate, entry - 3600, end);
      const ctx = contextFromCandles(t, cs);
      if (ctx) {
        tripContext.set(t.wallet, t.mint, t.openedAt, ctx);
        done++;
      }
    } catch (err) {
      log.debug({ mint: t.mint, err: String(err) }, 'mum alınamadı');
    }
  }
  return done;
}
