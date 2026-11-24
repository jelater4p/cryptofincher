import type { WalletMetrics } from './metrics.js';

/** Kümeleme için davranış özellikleri. Performans değil, "nasıl" işlem yaptığı. */
export const FEATURE_NAMES = [
  'log_entry_delay',
  'log_hold',
  'log_entry_mcap',
  'log_first_exit_multiple',
  'partial_exit_rate',
  'entries_per_trip',
  'log_trades_per_day',
  'meme_share',
  'loss_exit_multiple',
] as const;

export function behaviourFeatures(m: WalletMetrics): number[] {
  return [
    Math.log10((m.medianEntryDelaySec ?? NaN) + 1),
    Math.log10(m.medianHoldSec + 1),
    Math.log10((m.medianEntryMcapUsd ?? NaN) + 1),
    Math.log(Math.max(m.firstExitMultipleMedian, 0.1)),
    m.partialExitRate,
    m.avgEntriesPerTrip,
    Math.log10(m.tradesPerDay + 0.1),
    m.memeShare,
    m.lossExitMultipleMedian,
  ];
}
