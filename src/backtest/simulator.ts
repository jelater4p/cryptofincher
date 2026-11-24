import { mean, sum } from '../core/stats.js';
import type { Candle } from '../storage/repo.js';
import { decideExit, evaluateEntry, type PositionState } from '../strategy/rules.js';
import type { StrategySpec } from '../strategy/types.js';

export interface SimCosts {
  /** her alım/satımda fiyat aleyhine kayma + DEX ücreti (%) */
  feePctPerSide: number;
}

export interface SimTrade {
  mint: string;
  entryTs: number;
  exitTs: number;
  entryPrice: number;
  /** ağırlıklı ortalama çıkış fiyatı / ortalama giriş (ücretler dahil) */
  multiple: number;
  pnlPct: number;
  exitReasons: string[];
}

export interface TokenMeta {
  mint: string;
  /** mumların ait olduğu havuzun açılışı (sn) */
  pairCreatedAtSec: number;
  /** tokenın piyasaya çıkışı (sn); token yaşı buna göre hesaplanır, yoksa havuz açılışı */
  launchedAtSec?: number;
  supply: number;
}

/**
 * Bir token için tek pozisyon simülasyonu. Lookahead yok: sinyal mumun kapanışında,
 * giriş bir sonraki mumun açılışında. Aynı mumda hem SL hem TP mümkünse önce SL varsayılır.
 * Not: mumlarda likidite ve alım/satım sayısı olmadığından bu iki koşul backtest'te atlanır.
 */
export function simulateToken(spec: StrategySpec, meta: TokenMeta, candles: Candle[], costs: SimCosts): SimTrade | null {
  if (candles.length < 7) return null;
  const btSpec: StrategySpec = { ...spec, entry: { ...spec.entry, minBuySellRatio5m: null, minLiquidityUsd: 0 } };
  const fee = costs.feePctPerSide / 100;
  const stepSec = candles[1]!.ts - candles[0]!.ts || 60;
  const lookback = Math.max(1, Math.round(300 / stepSec));

  let entryIdx = -1;
  for (let i = lookback; i < candles.length - 1; i++) {
    const c = candles[i]!;
    const prev = candles[i - lookback]!;
    const snap = {
      mint: meta.mint,
      pairCreatedAt: meta.pairCreatedAtSec * 1000,
      launchedAt: (meta.launchedAtSec ?? meta.pairCreatedAtSec) * 1000,
      marketCapUsd: c.c * meta.supply,
      liquidityUsd: Infinity,
      priceChangeM5: prev.c > 0 ? (c.c / prev.c - 1) * 100 : 0,
    };
    if (evaluateEntry(btSpec, snap, (c.ts + stepSec) * 1000).pass) {
      entryIdx = i + 1;
      break;
    }
  }
  if (entryIdx < 0) return null;

  const tranches = spec.entry.dca?.tranches ?? 1;
  const dipPct = spec.entry.dca?.dipPct ?? 0;
  const entryCandle = candles[entryIdx]!;
  const firstPrice = entryCandle.o * (1 + fee);
  let spent = 1 / tranches; // birim sermaye
  let tokens = spent / firstPrice;
  let tranchesBought = 1;
  const pos: PositionState = {
    entryPrice: firstPrice,
    initialTokens: tokens,
    remainingTokens: tokens,
    peakPrice: entryCandle.o,
    tpHits: 0,
    openedAtMs: entryCandle.ts * 1000,
  };
  let proceeds = 0;
  const reasons: string[] = [];
  let exitTs = entryCandle.ts;

  const sell = (qty: number, price: number, reason: string, ts: number) => {
    const q = Math.min(qty, pos.remainingTokens);
    proceeds += q * price * (1 - fee);
    pos.remainingTokens -= q;
    reasons.push(reason);
    exitTs = ts;
  };

  for (let i = entryIdx; i < candles.length && pos.remainingTokens > 1e-12; i++) {
    const c = candles[i]!;
    // DCA: düşüşte ek alım (sadece TP gelmeden)
    // canlı motorla aynı kural: güncel ortalama girişin dipPct altına inince sonraki parça
    while (tranchesBought < tranches && pos.tpHits === 0 && c.l <= pos.entryPrice * (1 - dipPct / 100)) {
      const px = Math.min(c.o, pos.entryPrice * (1 - dipPct / 100));
      const add = 1 / tranches / px;
      spent += 1 / tranches;
      tokens += add;
      pos.remainingTokens += add;
      pos.initialTokens += add;
      pos.entryPrice = spent / tokens;
      tranchesBought++;
    }
    const nowMs = c.ts * 1000;
    // 1) düşük fiyat: SL / trailing
    const slLevel = pos.entryPrice * spec.exit.stopLossMultiple;
    let d = decideExit(spec, pos, c.l, nowMs);
    if (d.reason === 'stop_loss') {
      sell(d.sellTokens, Math.min(c.o, slLevel), 'stop_loss', c.ts);
      break;
    }
    if (d.reason === 'trailing_stop') {
      const trail = pos.peakPrice * (1 - (spec.exit.trailingStopPct ?? 0) / 100);
      sell(d.sellTokens, Math.min(c.o, trail), 'trailing_stop', c.ts);
      break;
    }
    if (d.reason === 'max_hold') {
      sell(d.sellTokens, c.o, 'max_hold', c.ts);
      break;
    }
    // 2) yüksek fiyat: TP'ler
    d = decideExit(spec, pos, c.h, nowMs);
    if (d.reason === 'take_profit') {
      const tpLevel = spec.exit.takeProfits[d.newTpHits - 1]!.multiple * pos.entryPrice;
      sell(d.sellTokens, tpLevel, `tp${d.newTpHits}`, c.ts);
      pos.tpHits = d.newTpHits;
    }
    pos.peakPrice = Math.max(pos.peakPrice, c.h);
  }
  if (pos.remainingTokens > 1e-12) {
    const last = candles[candles.length - 1]!;
    sell(pos.remainingTokens, last.c, 'end_of_data', last.ts);
  }
  const multiple = proceeds / spent;
  return {
    mint: meta.mint,
    entryTs: entryCandle.ts,
    exitTs,
    entryPrice: pos.entryPrice,
    multiple,
    pnlPct: (multiple - 1) * 100,
    exitReasons: reasons,
  };
}

export interface PortfolioResult {
  trades: number;
  skippedForCapacity: number;
  winRate: number;
  avgPnlPct: number;
  totalReturnPct: number;
  maxDrawdownPct: number;
  profitFactor: number;
  exitReasonCounts: Record<string, number>;
  equityCurve: Array<{ ts: number; equity: number }>;
}

/** Token bazlı sonuçları zaman sırasına koyup sermaye/eşzamanlı pozisyon limitleriyle portföy simülasyonu */
export function simulatePortfolio(spec: StrategySpec, trades: SimTrade[], startEquity = 1): PortfolioResult {
  const sorted = [...trades].sort((a, b) => a.entryTs - b.entryTs);
  let cash = startEquity;
  const open: Array<{ t: SimTrade; stake: number }> = [];
  const taken: SimTrade[] = [];
  let skipped = 0;
  const curve: Array<{ ts: number; equity: number }> = [{ ts: sorted[0]?.entryTs ?? 0, equity: startEquity }];
  let peak = startEquity;
  let maxDd = 0;

  const closeUntil = (ts: number) => {
    open.sort((a, b) => a.t.exitTs - b.t.exitTs);
    while (open.length && open[0]!.t.exitTs <= ts) {
      const o = open.shift()!;
      cash += o.stake * o.t.multiple;
      const equity = cash + open.reduce((s, x) => s + x.stake, 0);
      curve.push({ ts: o.t.exitTs, equity });
      peak = Math.max(peak, equity);
      maxDd = Math.max(maxDd, (peak - equity) / peak);
    }
  };

  for (const t of sorted) {
    closeUntil(t.entryTs);
    if (open.length >= spec.sizing.maxOpenPositions) {
      skipped++;
      continue;
    }
    const equity = cash + open.reduce((s, x) => s + x.stake, 0);
    const stake = Math.min(cash, (equity * spec.sizing.pctOfEquity) / 100);
    if (stake <= 1e-9) {
      skipped++;
      continue;
    }
    cash -= stake;
    open.push({ t, stake });
    taken.push(t);
  }
  closeUntil(Infinity);

  const wins = taken.filter((t) => t.multiple > 1);
  const gw = sum(wins.map((t) => t.multiple - 1));
  const gl = -sum(taken.filter((t) => t.multiple <= 1).map((t) => t.multiple - 1));
  const reasonCounts: Record<string, number> = {};
  for (const t of taken) for (const r of t.exitReasons) reasonCounts[r] = (reasonCounts[r] ?? 0) + 1;
  return {
    trades: taken.length,
    skippedForCapacity: skipped,
    winRate: taken.length ? wins.length / taken.length : 0,
    avgPnlPct: taken.length ? mean(taken.map((t) => t.pnlPct)) : 0,
    totalReturnPct: (cash / startEquity - 1) * 100,
    maxDrawdownPct: maxDd * 100,
    profitFactor: gl > 0 ? gw / gl : gw > 0 ? 99 : 0,
    exitReasonCounts: reasonCounts,
    equityCurve: curve,
  };
}
