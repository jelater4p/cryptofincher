import type { TokenInfo } from '../core/types.js';
import type { StrategySpec } from './types.js';

export interface EntryDecision {
  pass: boolean;
  reasons: string[];
}

/** Canlı token anlık görüntüsüne göre giriş koşulları (backtest'te mumlardan türetilen görüntü kullanılır) */
export function evaluateEntry(spec: StrategySpec, t: TokenInfo, nowMs = Date.now()): EntryDecision {
  const r: string[] = [];
  const e = spec.entry;
  if (t.pairCreatedAt === undefined) r.push('havuz yaşı bilinmiyor');
  else {
    const age = (nowMs - t.pairCreatedAt) / 1000;
    if (age < e.minPoolAgeSec) r.push(`havuz çok yeni (${Math.round(age)}sn)`);
    if (age > e.maxPoolAgeSec) r.push(`havuz çok eski (${Math.round(age)}sn)`);
  }
  const mcap = t.marketCapUsd ?? t.fdvUsd;
  if (mcap === undefined) r.push('mcap bilinmiyor');
  else if (mcap < e.mcapUsdMin || mcap > e.mcapUsdMax) r.push(`mcap aralık dışı (${Math.round(mcap)})`);
  if ((t.liquidityUsd ?? 0) < e.minLiquidityUsd) r.push(`likidite düşük (${Math.round(t.liquidityUsd ?? 0)})`);
  if (e.priceChange5mMin !== null || e.priceChange5mMax !== null) {
    const ch = t.priceChangeM5;
    if (ch === undefined) r.push('5dk değişim bilinmiyor');
    else {
      if (e.priceChange5mMin !== null && ch < e.priceChange5mMin) r.push(`5dk değişim düşük (${ch}%)`);
      if (e.priceChange5mMax !== null && ch > e.priceChange5mMax) r.push(`5dk değişim yüksek (${ch}%)`);
    }
  }
  if (e.minBuySellRatio5m !== null) {
    const b = t.buysM5 ?? 0;
    const s = t.sellsM5 ?? 0;
    const ratio = s === 0 ? (b > 0 ? Infinity : 0) : b / s;
    if (ratio < e.minBuySellRatio5m) r.push(`alım baskısı zayıf (${b}/${s})`);
  }
  return { pass: r.length === 0, reasons: r };
}

export interface PositionState {
  entryPrice: number;
  /** başlangıç token miktarı */
  initialTokens: number;
  remainingTokens: number;
  peakPrice: number;
  tpHits: number;
  openedAtMs: number;
}

export interface ExitDecision {
  /** satılacak token miktarı (0 = bekle) */
  sellTokens: number;
  reason: 'stop_loss' | 'take_profit' | 'trailing_stop' | 'max_hold' | null;
  /** TP vurulduysa yeni tpHits */
  newTpHits: number;
}

/**
 * Tek bir fiyat gözlemi için çıkış kararı. Backtest'te bir mumun düşük/yüksek değeriyle
 * çağrılır (önce düşük: SL, sonra yüksek: TP) böylece temkinli simülasyon olur.
 */
export function decideExit(spec: StrategySpec, p: PositionState, price: number, nowMs: number): ExitDecision {
  const none: ExitDecision = { sellTokens: 0, reason: null, newTpHits: p.tpHits };
  if (p.remainingTokens <= 0) return none;
  const x = spec.exit;
  const mult = price / p.entryPrice;
  if (mult <= x.stopLossMultiple) return { sellTokens: p.remainingTokens, reason: 'stop_loss', newTpHits: p.tpHits };
  if (nowMs - p.openedAtMs >= x.maxHoldSec * 1000)
    return { sellTokens: p.remainingTokens, reason: 'max_hold', newTpHits: p.tpHits };
  if (p.tpHits > 0 && x.trailingStopPct !== null) {
    const peak = Math.max(p.peakPrice, price);
    if (price <= peak * (1 - x.trailingStopPct / 100))
      return { sellTokens: p.remainingTokens, reason: 'trailing_stop', newTpHits: p.tpHits };
  }
  // birden fazla TP aynı anda vurulabilir
  let hits = p.tpHits;
  let pct = 0;
  while (hits < x.takeProfits.length && mult >= x.takeProfits[hits]!.multiple) {
    pct += x.takeProfits[hits]!.sellPct;
    hits++;
  }
  if (hits > p.tpHits) {
    const isLast = hits >= x.takeProfits.length;
    const tokens = isLast ? p.remainingTokens : Math.min(p.remainingTokens, (p.initialTokens * pct) / 100);
    return { sellTokens: tokens, reason: 'take_profit', newTpHits: hits };
  }
  return none;
}
