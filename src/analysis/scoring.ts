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
  | 'inconsistent'
  | 'dust_trader'
  | 'low_profit';

/** Bu bayraklardan biri varsa cüzdan strateji çıkarımına alınmaz */
export const HARD_FLAGS: WalletFlag[] = [
  'insufficient_data',
  'unprofitable',
  'bot_high_frequency',
  'sniper',
  'wash_or_mev',
  'insider_transfers',
  'dust_trader',
  'low_profit',
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
  dust_trader: 'Pozisyonlar çok küçük (toz işlemler): güvenilir örnek değil',
  low_profit: 'Toplam kâr çok düşük: yetenekle şansı ayırt etmeye yetmez',
};

/** Listelerde kısa gösterim */
export const FLAG_SHORT: Record<WalletFlag, string> = {
  insufficient_data: 'az işlem',
  unprofitable: 'kârsız',
  bot_high_frequency: 'bot',
  sniper: 'sniper',
  wash_or_mev: 'wash/MEV',
  insider_transfers: 'insider',
  lucky_outlier: 'tek şanslı işlem',
  inconsistent: 'tutarsız',
  dust_trader: 'toz işlem',
  low_profit: 'düşük kâr',
};

export interface FilterOptions {
  minClosedTrips: number;
  maxTradesPerDay?: number;
  minProfitFactor?: number;
  /** medyan pozisyon büyüklüğü alt sınırı (SOL); verilmezse uygulanmaz */
  minMedianSizeSol?: number;
  /** toplam gerçekleşen kâr alt sınırı (SOL); verilmezse uygulanmaz */
  minPnlSol?: number;
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
  if (opts.minMedianSizeSol !== undefined && m.closedTrips > 0 && m.medianSizeSol < opts.minMedianSizeSol) flags.push('dust_trader');
  // zararda olanlar zaten 'unprofitable'; bu bayrak kârlı ama kârı anlamsız derecede küçük olanlar için
  if (opts.minPnlSol !== undefined && m.realizedPnlSol > 0 && m.realizedPnlSol < opts.minPnlSol) flags.push('low_profit');
  return flags;
}

/**
 * Wilson alt sınırı: k/n başarı oranının %95 güvenle en az ne olduğu. Az örnekte çok temkinlidir:
 * 6/10 için ~0.31, 60/100 için ~0.50. Böylece 10 işlemlik şanslı seri yüksek skor alamaz.
 */
export function wilsonLowerBound(k: number, n: number, z = 1.96): number {
  if (n <= 0) return 0;
  const p = k / n;
  const z2 = z * z;
  return (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / (1 + z2 / n);
}

/** Puanlama kuralları değişince artırılır: kayıtlı tüm cüzdanlar açılışta yeniden değerlendirilir */
export const SCORING_VERSION = 2;

/**
 * 0-100 arası beceri skoru. Mutlak kâra değil işlemin kalitesine bakar, ama her bileşen örneklem
 * büyüklüğüne göre temkinlidir: az işlemli cüzdan, oranları iyi görünse de yüksek skor alamaz.
 * - kazanma: kazanma oranının Wilson alt sınırı (ham oran değil)
 * - kâr faktörü: az işlemde 1'e doğru çekilir (n / (n + 20))
 * - tutarlılık: kârlı hafta oranı, az haftada 0'a doğru çekilir (h / (h + 3))
 * - örneklem: log ölçekli; 10 işlem yarım, 100 işlem tam puan
 */
export function skillScore(m: WalletMetrics, flags: WalletFlag[]): number {
  const n = m.closedTrips;
  const wins = Math.round(m.winRate * n);
  const win = clamp((wilsonLowerBound(wins, n) - 0.25) / 0.35, 0, 1);
  const pfShrunk = 1 + (Math.max(m.profitFactor, 1) - 1) * (n / (n + 20));
  const pf = clamp(Math.log(pfShrunk) / Math.log(4), 0, 1);
  const weeks = m.activeWeeks ?? Math.max(1, Math.round(m.activeDays / 7));
  const consistency = clamp(m.weeklyPositiveRate, 0, 1) * (weeks / (weeks + 3));
  const roi = clamp(Math.log1p(Math.max(m.roi, 0)) / Math.log1p(2), 0, 1);
  const sample = clamp(Math.log10(Math.max(n, 1)) / 2, 0, 1);
  let score = 100 * (0.25 * win + 0.25 * pf + 0.15 * consistency + 0.15 * roi + 0.2 * sample);
  const concPenalty = clamp((m.pnlConcentration - 0.4) / 0.6, 0, 1) * 0.5;
  score *= 1 - concPenalty;
  if (flags.includes('inconsistent')) score *= 0.8;
  return Math.round(score * 10) / 10;
}

export function isEligible(flags: WalletFlag[]) {
  return !flags.some((f) => HARD_FLAGS.includes(f));
}
