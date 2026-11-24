import { childLogger } from '../core/logger.js';
import type { TokenInfo } from '../core/types.js';
import { geckoterminal, type Timeframe } from '../data/geckoterminal.js';
import { getDb } from '../storage/db.js';
import { tokens as tokenRepo, type Candle } from '../storage/repo.js';
import type { StrategySpec } from '../strategy/types.js';
import { simulatePortfolio, simulateToken, type PortfolioResult, type SimTrade } from './simulator.js';

const log = childLogger('backtest');

export interface BacktestReport extends PortfolioResult {
  strategyId: string;
  universe: number;
  tokensWithSignal: number;
  feePctPerSide: number;
  warnings: string[];
  sampleTrades: SimTrade[];
}

/** Mum kaynağı: testlerde sentetik veriyle değiştirilebilir */
export type CandleProvider = (pool: string, tf: Timeframe, aggregate: number, fromSec: number, toSec: number) => Promise<Candle[]>;

export const geckoCandles: CandleProvider = (pool, tf, aggregate, from, to) => geckoterminal.ohlcvRange(pool, tf, aggregate, from, to);

export interface TimeWindow {
  /** saniye, dahil */
  from: number;
  /** saniye, hariç */
  to: number;
}

const isMemeToken = (mint: string, mcap?: number) => mint.endsWith('pump') || (mcap !== undefined && mcap < 5_000_000);

/** Uzun vadeli stratejilerde (havuz yaşı sınırı > 7 gün) tokenın açılışı değil, belirli bir dönemin mumları kullanılır */
export const isLongHorizon = (spec: StrategySpec) => spec.entry.maxPoolAgeSec > 7 * 86400;

export const defaultFee = (spec: StrategySpec) => (spec.segment === 'memecoin' ? 1.5 : 0.4);

/**
 * Backtest evreni. Pencere verilirse kısa vadeli stratejilerde sadece o pencerede açılan tokenlar,
 * uzun vadelilerde pencere bitmeden açılmış tüm tokenlar alınır.
 */
export function selectUniverse(spec: StrategySpec, all: TokenInfo[], window?: TimeWindow, max = 60): TokenInfo[] {
  return all
    .filter((t) => t.pairAddress && t.pairCreatedAt)
    .filter((t) => (spec.segment === 'memecoin') === isMemeToken(t.mint, t.marketCapUsd))
    .filter((t) => {
      if (!window) return true;
      const created = t.pairCreatedAt! / 1000;
      return isLongHorizon(spec) ? created < window.to : created >= window.from && created < window.to;
    })
    .sort((a, b) => (b.pairCreatedAt ?? 0) - (a.pairCreatedAt ?? 0))
    .slice(0, max);
}

/**
 * Evrendeki her token için tek pozisyon simülasyonu. Pencere verilirse giriş pencerenin içinde olmalı;
 * pencere içinde açılan pozisyonların çıkışı pencere bitse de izlenir.
 */
export async function collectTrades(
  spec: StrategySpec,
  universe: TokenInfo[],
  opts: { feePctPerSide: number; candles?: CandleProvider; window?: TimeWindow; nowSec?: number },
): Promise<SimTrade[]> {
  const provider = opts.candles ?? geckoCandles;
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const trades: SimTrade[] = [];
  for (const t of universe) {
    const created = Math.floor(t.pairCreatedAt! / 1000);
    const supply = t.supply ?? (t.marketCapUsd && t.priceUsd ? t.marketCapUsd / t.priceUsd : undefined);
    if (!supply) continue;
    let from: number;
    let to: number;
    if (isLongHorizon(spec)) {
      from = opts.window ? Math.max(opts.window.from, created) : nowSec - 30 * 86400;
      to = Math.min(nowSec, opts.window ? opts.window.to + spec.exit.maxHoldSec : nowSec);
    } else {
      from = created;
      to = Math.min(nowSec, created + spec.entry.maxPoolAgeSec + spec.exit.maxHoldSec);
    }
    if (to <= from) continue;
    try {
      const span = to - from;
      const candles = isLongHorizon(spec)
        ? await provider(t.pairAddress!, 'hour', 1, from, to)
        : await provider(t.pairAddress!, 'minute', span > 2 * 86400 ? 15 : span > 12 * 3600 ? 5 : 1, from, to);
      const r = simulateToken(spec, { mint: t.mint, pairCreatedAtSec: created, supply }, candles, { feePctPerSide: opts.feePctPerSide });
      if (!r) continue;
      if (opts.window && (r.entryTs < opts.window.from || r.entryTs >= opts.window.to)) continue;
      trades.push(r);
    } catch (err) {
      log.debug({ mint: t.mint, err: String(err) }, 'mum alınamadı');
    }
  }
  return trades;
}

/**
 * Yerel veritabanındaki token evreni üzerinde backtest. Evren: keşif ve cüzdan analizinde
 * görülen tüm tokenlar (cüzdanların dokunmadıkları dahil). Mumlar GeckoTerminal'den çekilir ve önbelleklenir.
 */
export async function runBacktest(spec: StrategySpec, opts: { maxTokens?: number; feePctPerSide?: number } = {}): Promise<BacktestReport> {
  const fee = opts.feePctPerSide ?? defaultFee(spec);
  const universe = selectUniverse(spec, tokenRepo.all(), undefined, opts.maxTokens ?? 60);
  const trades = await collectTrades(spec, universe, { feePctPerSide: fee });
  const portfolio = simulatePortfolio(spec, trades);
  const warnings = [
    'Evren, DexScreener trend listeleri ve analiz edilen cüzdanların tokenlarından oluşur: hayatta kalan tokenlara doğru yanlılık (survivorship bias) var, gerçek sonuçlar daha kötü olabilir.',
    'Likidite ve alım/satım sayısı koşulları mum verisinde olmadığı için backtest\'te uygulanmadı.',
    'Strateji büyük ölçüde aynı dönemin verisinden çıkarıldı: bu sonuç iyimserdir. Görülmemiş veride test için /walkforward kullanın.',
  ];
  if (trades.length < 20) warnings.push(`Sadece ${trades.length} işlem: istatistiksel olarak zayıf. Daha fazla keşif/veri gerekli.`);
  const report: BacktestReport = {
    strategyId: spec.id,
    universe: universe.length,
    tokensWithSignal: trades.length,
    feePctPerSide: fee,
    warnings,
    sampleTrades: trades.slice(0, 10),
    ...portfolio,
  };
  getDb()
    .prepare('INSERT INTO backtests(strategy_id, created_at, json) VALUES (?, ?, ?)')
    .run(spec.id, Date.now(), JSON.stringify({ ...report, equityCurve: report.equityCurve.slice(-200) }));
  return report;
}
