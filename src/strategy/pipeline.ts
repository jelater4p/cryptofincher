import { childLogger } from '../core/logger.js';
import { loadAnalyzedTrips, storedReports } from '../analysis/walletAnalyzer.js';
import { extractStrategies, extractStrategy, type WalletInput } from './extractor.js';
import { strategies } from './registry.js';
import type { StrategySpec } from './types.js';
import { wallets } from '../storage/repo.js';

const log = childLogger('strategy');

function inputsFor(addresses?: string[]): WalletInput[] {
  const reports = storedReports();
  const manual = new Set(wallets.list().filter((w) => w.source === 'manual').map((w) => w.address));
  return reports
    .filter((r) => (addresses ? addresses.includes(r.address) : r.eligible))
    // manuel cüzdanlar için sadece "veri yetersiz" engeli uygulanır
    .filter((r) => r.eligible || (manual.has(r.address) && !r.flags.includes('insufficient_data')) || addresses)
    .map((r) => ({ address: r.address, score: r.score, metrics: r.metrics, trips: loadAnalyzedTrips(r.address).trips }));
}

/** Uygun tüm cüzdanları kümeleyip her kümeden strateji üretir ve kaydeder */
export function runExtraction(): { specs: StrategySpec[]; silhouette: number; walletCount: number } {
  const inputs = inputsFor();
  const { specs, silhouette } = extractStrategies(inputs);
  for (const s of specs) strategies.save(s);
  log.info({ wallets: inputs.length, strategies: specs.length, silhouette }, 'strateji çıkarımı');
  return { specs, silhouette, walletCount: inputs.length };
}

/** Belirli cüzdan(lar)dan doğrudan strateji üret (kümeleme yok) */
export function extractFromWallets(addresses: string[]): StrategySpec | null {
  const inputs = inputsFor(addresses);
  const spec = extractStrategy(inputs, { method: 'wallets' });
  if (spec) strategies.save(spec);
  return spec;
}
