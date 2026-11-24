import { childLogger } from '../core/logger.js';
import { geckoterminal } from '../data/geckoterminal.js';
import { getDb } from '../storage/db.js';
import { tokens as tokenRepo } from '../storage/repo.js';
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

const isMemeToken = (mint: string, mcap?: number) => mint.endsWith('pump') || (mcap !== undefined && mcap < 5_000_000);

/**
 * Yerel veritabanındaki token evreni üzerinde backtest. Evren: keşif ve cüzdan analizinde
 * görülen tüm tokenlar (cüzdanların dokunmadıkları dahil). Mumlar GeckoTerminal'den çekilir ve önbelleklenir.
 */
export async function runBacktest(spec: StrategySpec, opts: { maxTokens?: number; feePctPerSide?: number } = {}): Promise<BacktestReport> {
  const fee = opts.feePctPerSide ?? (spec.segment === 'memecoin' ? 1.5 : 0.4);
  const universe = tokenRepo
    .all()
    .filter((t) => t.pairAddress && t.pairCreatedAt)
    .filter((t) => (spec.segment === 'memecoin') === isMemeToken(t.mint, t.marketCapUsd))
    .sort((a, b) => (b.pairCreatedAt ?? 0) - (a.pairCreatedAt ?? 0))
    .slice(0, opts.maxTokens ?? 60);

  const trades: SimTrade[] = [];
  const nowSec = Math.floor(Date.now() / 1000);
  for (const t of universe) {
    const created = Math.floor(t.pairCreatedAt! / 1000);
    const supply = t.supply ?? (t.marketCapUsd && t.priceUsd ? t.marketCapUsd / t.priceUsd : undefined);
    if (!supply) continue;
    const longHorizon = spec.entry.maxPoolAgeSec > 7 * 86400;
    const from = longHorizon ? nowSec - 30 * 86400 : created;
    const to = Math.min(nowSec, from + (longHorizon ? 30 * 86400 : spec.entry.maxPoolAgeSec + spec.exit.maxHoldSec));
    try {
      const span = to - from;
      const candles = longHorizon
        ? await geckoterminal.ohlcvRange(t.pairAddress!, 'hour', 1, from, to)
        : await geckoterminal.ohlcvRange(t.pairAddress!, 'minute', span > 2 * 86400 ? 15 : span > 12 * 3600 ? 5 : 1, from, to);
      const r = simulateToken(spec, { mint: t.mint, pairCreatedAtSec: created, supply }, candles, { feePctPerSide: fee });
      if (r) trades.push(r);
    } catch (err) {
      log.debug({ mint: t.mint, err: String(err) }, 'mum alınamadı');
    }
  }
  const portfolio = simulatePortfolio(spec, trades);
  const warnings = [
    'Evren, DexScreener trend listeleri ve analiz edilen cüzdanların tokenlarından oluşur: hayatta kalan tokenlara doğru yanlılık (survivorship bias) var, gerçek sonuçlar daha kötü olabilir.',
    'Likidite ve alım/satım sayısı koşulları mum verisinde olmadığı için backtest\'te uygulanmadı.',
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
