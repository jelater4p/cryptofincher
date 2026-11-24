import { childLogger } from './core/logger.js';
import { enrichTrips } from './analysis/enrich.js';
import { analyzeWallet, loadAnalyzedTrips, storedReports } from './analysis/walletAnalyzer.js';
import { HeliusLimitError, heliusCredits } from './data/helius.js';
import { solPriceService } from './data/solPrice.js';
import { runDiscovery } from './discovery/discovery.js';
import { events } from './engine/state.js';
import { tokens, wallets, type WalletRow } from './storage/repo.js';
import { config } from './config.js';
import { universe } from './discovery/universe.js';
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

export const REFRESH_AFTER_MS = 3 * 86400_000;

/**
 * Analiz sırası (saf fonksiyon). Öncelik:
 * 1. elle eklenen cüzdanlar (hiç analiz edilmemiş ya da 3 günden eski)
 * 2. hiç analiz edilmemiş keşif cüzdanları, en eski eklenen önce (kuyruk adil erir)
 * 3. uygun (aktif) cüzdanların yenilenmesi (3 günden eski; sadece yeni işlemler çekilir, ucuz)
 * 4. sadece "yeterli veri yok" yüzünden elenmiş ve daha sığ geçmişle analiz edilmiş cüzdanlar:
 *    sınır büyüdüyse eksik eski geçmiş tamamlanır. Yeterli veriyle kârsız çıkanlara tekrar bakılmaz.
 */
export function selectWalletsToAnalyze(
  rows: WalletRow[],
  flagsByAddress: Map<string, string[]>,
  opts: { now: number; maxTx: number; limit: number; staleMs?: number },
): WalletRow[] {
  const staleMs = opts.staleMs ?? REFRESH_AFTER_MS;
  const byAdded = [...rows].sort((a, b) => a.added_at - b.added_at);
  const isStale = (w: WalletRow) => !w.last_analyzed_at || opts.now - w.last_analyzed_at > staleMs;
  const groups = [
    byAdded.filter((w) => w.source === 'manual' && isStale(w)),
    byAdded.filter((w) => w.source === 'discovered' && !w.last_analyzed_at),
    byAdded.filter((w) => w.source === 'discovered' && w.status === 'active' && w.last_analyzed_at && isStale(w)),
    byAdded.filter(
      (w) =>
        w.source === 'discovered' &&
        w.status === 'excluded' &&
        w.last_analyzed_at &&
        (w.history_max ?? 0) < opts.maxTx &&
        (flagsByAddress.get(w.address) ?? []).includes('insufficient_data'),
    ),
  ];
  const out: WalletRow[] = [];
  const seenAddr = new Set<string>();
  for (const g of groups)
    for (const w of g) {
      if (out.length >= opts.limit) return out;
      if (seenAddr.has(w.address)) continue;
      seenAddr.add(w.address);
      out.push(w);
    }
  return out;
}

/** Sıradaki cüzdanları analiz eder */
export async function analyzePending(limit = config.ANALYSIS_WALLETS_PER_RUN) {
  const flags = new Map(storedReports().map((r) => [r.address, r.flags as string[]]));
  const todo = selectWalletsToAnalyze(wallets.list(), flags, { now: Date.now(), maxTx: config.ANALYSIS_MAX_TX_PER_WALLET, limit });
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
  const a = await analyzePending(opts.analyzeLimit);
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
  const report = await runWalkForward(spec, { wallets: histories, tokens: tokens.all(), unbiasedTokens: universe.all() }, opts);
  walkforwards.save(report);
  return report;
}
