import { clamp } from '../core/stats.js';
import type { WalletMetrics } from './metrics.js';

export type WalletFlag =
  | 'insufficient_data'
  | 'unprofitable'
  | 'bot_high_frequency'
  | 'sniper'
  | 'wash_or_mev'
  | 'insider_transfers'
  | 'lucky_outlier'
  | 'inconsistent';

/** Bu bayraklardan biri varsa cüzdan strateji çıkarımına alınmaz */
export const HARD_FLAGS: WalletFlag[] = [
  'insufficient_data',
  'unprofitable',
  'bot_high_frequency',
  'sniper',
  'wash_or_mev',
  'insider_transfers',
];

export const FLAG_DESCRIPTIONS: Record<WalletFlag, string> = {
  insufficient_data: 'Yeterli kapanmış işlem yok',
  unprofitable: 'Kârlı değil ya da kâr faktörü düşük',
  bot_high_frequency: 'Günde çok fazla işlem: muhtemelen bot',
  sniper: 'Blok-0 sniper: altyapı avantajı, taklit edilemez',
  wash_or_mev: 'Aynı slotta al-sat: wash trade / MEV',
  insider_transfers: 'Tokenların önemli kısmı transferle gelmiş (insider/bundle şüphesi)',
  lucky_outlier: 'Kârın çoğu tek bir işlemden: şans olabilir',
  inconsistent: 'Haftalık sonuçlar tutarsız',
};

export interface FilterOptions {
  minClosedTrips: number;
  maxTradesPerDay?: number;
  minProfitFactor?: number;
}

export function computeFlags(m: WalletMetrics, opts: FilterOptions): WalletFlag[] {
  const flags: WalletFlag[] = [];
  if (m.closedTrips < opts.minClosedTrips) flags.push('insufficient_data');
  if (m.realizedPnlSol <= 0 || m.profitFactor < (opts.minProfitFactor ?? 1.3)) flags.push('unprofitable');
  if (m.tradesPerDay > (opts.maxTradesPerDay ?? 150) && m.swapCount >= 30) flags.push('bot_high_frequency');
  if (Number.isFinite(m.medianEntryDelaySec) && m.medianEntryDelaySec < 3 && m.medianHoldSec < 90) flags.push('sniper');
  if (m.sameSlotRate > 0.2) flags.push('wash_or_mev');
  if (m.transferInRate > 0.3) flags.push('insider_transfers');
  if (m.pnlConcentration > 0.6 && m.winRate < 0.4) flags.push('lucky_outlier');
  if (m.weeklyPositiveRate < 0.4 && m.activeDays > 21) flags.push('inconsistent');
  return flags;
}

/**
 * 0-100 arası beceri skoru. Kazanma oranı, kâr faktörü, tutarlılık, getiri ve örneklem
 * büyüklüğünü birleştirir; şans/tutarsızlık bayraklarında ceza uygular.
 */
export function skillScore(m: WalletMetrics, flags: WalletFlag[]): number {
  const win = clamp((m.winRate - 0.3) / 0.4, 0, 1);
  const pf = clamp(Math.log(Math.max(m.profitFactor, 1)) / Math.log(5), 0, 1);
  const consistency = clamp(m.weeklyPositiveRate, 0, 1);
  const roi = clamp(Math.log1p(Math.max(m.roi, 0)) / Math.log1p(3), 0, 1);
  const sample = clamp(m.closedTrips / 50, 0, 1);
  let score = 100 * (0.25 * win + 0.25 * pf + 0.2 * consistency + 0.15 * roi + 0.15 * sample);
  const concPenalty = clamp((m.pnlConcentration - 0.4) / 0.6, 0, 1) * 0.5;
  score *= 1 - concPenalty;
  if (flags.includes('inconsistent')) score *= 0.8;
  return Math.round(score * 10) / 10;
}

export function isEligible(flags: WalletFlag[]) {
  return !flags.some((f) => HARD_FLAGS.includes(f));
}
