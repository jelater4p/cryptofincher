import { config } from '../config.js';
import { childLogger } from '../core/logger.js';
import { dexscreener } from '../data/dexscreener.js';
import { helius, type SignatureInfo } from '../data/helius.js';
import { solPriceService } from '../data/solPrice.js';
import { getDb } from '../storage/db.js';
import { seen, swaps, tokens, transfers, tripContext, wallets } from '../storage/repo.js';
import { annotateTrips, computeWalletMetrics, type AnalyzedTrip, type WalletMetrics } from './metrics.js';
import { buildRoundTrips } from './positions.js';
import { computeFlags, isEligible, skillScore, type WalletFlag } from './scoring.js';
import { parseWalletTx } from './swapParser.js';
import type { SwapEvent, TransferEvent } from '../core/types.js';

const log = childLogger('analyzer');

export interface WalletReport {
  metrics: WalletMetrics;
  flags: WalletFlag[];
  score: number;
  eligible: boolean;
}

/**
 * Sadece imza listesine bakarak (getTransaction çağırmadan) bot ön elemesi.
 * Free planda kredinin büyük kısmını korur.
 */
export function prescreenSignatures(sigs: SignatureInfo[]): { ok: boolean; reason?: string; txPerDay: number } {
  const times = sigs.map((s) => s.blockTime).filter((t): t is number => t != null);
  if (times.length < 5) return { ok: false, reason: 'çok az işlem', txPerDay: 0 };
  const spanDays = Math.max((Math.max(...times) - Math.min(...times)) / 86400, 1 / 24);
  const txPerDay = times.length / spanDays;
  if (txPerDay > 500 && times.length >= 50) return { ok: false, reason: `günde ~${Math.round(txPerDay)} işlem (bot)`, txPerDay };
  return { ok: true, txPerDay };
}

/** Cüzdanın yeni işlemlerini çekip ayrıştırır ve kaydeder (artımlı). */
export async function syncWallet(address: string, maxTx = config.ANALYSIS_MAX_TX_PER_WALLET) {
  const w = wallets.get(address);
  const sigs = await helius.getAllSignatures(address, { until: w?.newest_signature ?? undefined, max: maxTx });
  if (!w?.newest_signature) {
    const pre = prescreenSignatures(sigs);
    if (!pre.ok) {
      log.info({ address, reason: pre.reason }, 'ön elemede elendi');
      return { fetched: 0, prescreenFailed: pre.reason };
    }
  }
  const todo = sigs.filter((s) => !s.err && !seen.has(address, s.signature));
  let fetched = 0;
  const swapBuf: SwapEvent[] = [];
  const xferBuf: TransferEvent[] = [];
  const processed: string[] = [];
  /**
   * Yarıda hata olursa (kredi bitti, ağ hatası) o ana kadar çekilenler yine kaydedilir: kredi boşa gitmesin.
   * Ama en yeni imza sadece tamamlanınca güncellenir; bir sonraki senkron kalanları alır, işlenmişleri atlar.
   */
  const flush = () => {
    swaps.insertMany(swapBuf.splice(0));
    transfers.insertMany(xferBuf.splice(0));
    seen.addMany(address, processed.splice(0));
  };
  try {
    for (const s of todo) {
      const tx = await helius.getTransaction(s.signature);
      fetched++;
      if (tx) {
        const r = parseWalletTx(tx, address, (ts) => solPriceService.at(ts));
        swapBuf.push(...r.swaps);
        xferBuf.push(...r.transfers);
      }
      processed.push(s.signature);
      if (fetched % 50 === 0) {
        flush();
        log.debug({ address, fetched, total: todo.length }, 'senkron');
      }
    }
  } finally {
    flush();
  }
  // hatalı (err) işlemler de görüldü sayılır
  seen.addMany(address, sigs.map((s) => s.signature));
  wallets.markAnalyzed(address, sigs[0]?.signature ?? null);
  return { fetched };
}

/** Eksik ya da eski token bilgilerini DexScreener'dan tamamlar */
export async function refreshTokenInfo(mints: string[], maxAgeMs = 6 * 3600_000) {
  const stale = mints.filter((m) => {
    const t = tokens.get(m);
    return !t || !t.updatedAt || Date.now() - t.updatedAt > maxAgeMs;
  });
  if (!stale.length) return;
  try {
    const infos = await dexscreener.tokens(stale);
    for (const info of infos.values()) tokens.upsert(info);
  } catch (err) {
    log.warn({ err: String(err) }, 'token bilgisi alınamadı');
  }
}

export function loadAnalyzedTrips(address: string): { trips: AnalyzedTrip[]; swapCount: number } {
  const sw = swaps.byWallet(address);
  const xf = transfers.byWallet(address);
  const trips = buildRoundTrips(sw, xf);
  const analyzed = annotateTrips(
    trips,
    (m) => tokens.get(m),
    (ts) => solPriceService.at(ts),
    (t) => tripContext.get(t.wallet, t.mint, t.openedAt),
  );
  return { trips: analyzed, swapCount: sw.length };
}

export function evaluateWallet(address: string): WalletReport {
  const { trips, swapCount } = loadAnalyzedTrips(address);
  const metrics = computeWalletMetrics(address, trips, swapCount);
  const flags = computeFlags(metrics, { minClosedTrips: config.ANALYSIS_MIN_CLOSED_POSITIONS });
  const score = skillScore(metrics, flags);
  const eligible = isEligible(flags);
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO wallet_metrics(address, computed_at, skill_score, eligible, flags, json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(address, Date.now(), score, eligible ? 1 : 0, JSON.stringify(flags), JSON.stringify(metrics));
  return { metrics, flags, score, eligible };
}

/** Senkron + token bilgisi + değerlendirme */
export async function analyzeWallet(address: string): Promise<WalletReport | { prescreenFailed: string }> {
  wallets.add(address, wallets.get(address)?.source ?? 'manual');
  const sync = await syncWallet(address);
  if ('prescreenFailed' in sync && sync.prescreenFailed) {
    wallets.setStatus(address, 'excluded');
    return { prescreenFailed: sync.prescreenFailed };
  }
  const mints = [...new Set(swaps.byWallet(address).map((s) => s.mint))];
  await refreshTokenInfo(mints);
  const report = evaluateWallet(address);
  const w = wallets.get(address);
  // manuel eklenen cüzdanlar hiçbir zaman otomatik dışlanmaz
  if (w?.source === 'discovered') wallets.setStatus(address, report.eligible ? 'active' : 'excluded');
  log.info(
    { address, score: report.score, eligible: report.eligible, flags: report.flags, closed: report.metrics.closedTrips },
    'cüzdan analiz edildi',
  );
  return report;
}

export function storedReports(): Array<WalletReport & { address: string }> {
  const rows = getDb().prepare('SELECT * FROM wallet_metrics ORDER BY skill_score DESC').all() as Array<{
    address: string;
    skill_score: number;
    eligible: number;
    flags: string;
    json: string;
  }>;
  return rows.map((r) => ({
    address: r.address,
    metrics: JSON.parse(r.json) as WalletMetrics,
    flags: JSON.parse(r.flags) as WalletFlag[],
    score: r.skill_score,
    eligible: !!r.eligible,
  }));
}
