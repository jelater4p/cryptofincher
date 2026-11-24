import { childLogger } from './core/logger.js';
import { enrichTrips } from './analysis/enrich.js';
import { analyzeWallet, loadAnalyzedTrips, storedReports } from './analysis/walletAnalyzer.js';
import { HeliusLimitError, heliusCredits } from './data/helius.js';
import { solPriceService } from './data/solPrice.js';
import { runDiscovery } from './discovery/discovery.js';
import { events } from './engine/state.js';
import { tokens, wallets } from './storage/repo.js';
import { runExtraction } from './strategy/pipeline.js';
import { strategies } from './strategy/registry.js';
import { runWalkForward, walkforwards, type WalkForwardOptions, type WalkForwardReport } from './backtest/walkforward.js';

const log = childLogger('jobs');

let running: string | null = null;

/** Aynı anda tek ağır iş (kredi ve rate limit için) */
export async function runJob<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  if (running) {
    events.emit('notify', `⏳ Zaten çalışan iş var: ${running}`);
    return undefined;
  }
  running = name;
  try {
    return await fn();
  } catch (err) {
    // ayrıntılı uyarı ve hatırlatmalar heliusAlert tarafından gönderiliyor
    if (err instanceof HeliusLimitError) events.emit('notify', `⏸ ${name} durdu: ${err.message}`);
    else events.emit('notify', `❌ ${name} hatası: ${String(err).slice(0, 300)}`);
    log.error({ err: String(err) }, `${name} hatası`);
    return undefined;
  } finally {
    running = null;
  }
}

export const currentJob = () => running;

/** Analiz edilmemiş (veya eski) cüzdanları analiz eder */
export async function analyzePending(limit = 20, staleMs = 3 * 86400_000) {
  const todo = wallets
    .list()
    .filter((w) => w.status === 'active' || w.source === 'manual' || !w.last_analyzed_at)
    .filter((w) => !w.last_analyzed_at || Date.now() - w.last_analyzed_at > staleMs)
    .slice(0, limit);
  let eligible = 0;
  for (const w of todo) {
    try {
      const r = await analyzeWallet(w.address);
      if ('eligible' in r && r.eligible) eligible++;
    } catch (err) {
      if (err instanceof HeliusLimitError) throw err;
      log.warn({ address: w.address, err: String(err) }, 'analiz başarısız');
    }
  }
  return { analyzed: todo.length, eligible };
}

export async function enrichEligible(perWallet = 15) {
  let n = 0;
  for (const r of storedReports().filter((x) => x.eligible)) {
    n += await enrichTrips(loadAnalyzedTrips(r.address).trips, perWallet);
  }
  return n;
}

/** Uçtan uca: keşif → analiz → zenginleştirme → strateji çıkarımı */
export async function fullPipeline(opts: { discoverTokens?: number; analyzeLimit?: number } = {}) {
  await solPriceService.syncHistory();
  const d = await runDiscovery(opts.discoverTokens ?? 3);
  events.emit('notify', `🔎 Keşif: ${d.tokens.length} kazanan token, ${d.wallets.length} aday cüzdan`);
  const a = await analyzePending(opts.analyzeLimit ?? 25);
  events.emit('notify', `🧪 Analiz: ${a.analyzed} cüzdan, ${a.eligible} uygun. Kredi: ${heliusCredits.used().toLocaleString()}/${heliusCredits.limit().toLocaleString()}`);
  const e = await enrichEligible();
  const x = runExtraction();
  events.emit('notify', `🧠 ${e} işlem zenginleştirildi. ${x.walletCount} cüzdandan ${x.specs.length} strateji çıkarıldı (silüet ${x.silhouette.toFixed(2)}). /stratejiler`);
  return { discovery: d, analysis: a, enriched: e, extraction: x };
}

/** Walk-forward: veritabanındaki tüm cüzdan geçmişleri ve token evreniyle */
export async function walkForwardJob(target: string, opts: Partial<WalkForwardOptions> = {}): Promise<WalkForwardReport> {
  const spec = target === '*' ? '*' : strategies.get(target)?.spec;
  if (!spec) throw new Error(`Strateji yok: ${target}`);
  const histories = wallets.list().map((w) => ({ address: w.address, trips: loadAnalyzedTrips(w.address).trips }));
  const report = await runWalkForward(spec, { wallets: histories, tokens: tokens.all() }, opts);
  walkforwards.save(report);
  return report;
}
