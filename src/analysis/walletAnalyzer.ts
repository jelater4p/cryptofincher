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

/** Eski geçmişe inerken her bu kadar işlemde bir "yeterli veri toplandı mı" kontrol edilir */
export const SYNC_CHECK_EVERY = 100;

/** PnL'e dahil kapanmış tur sayısı (yerel veriden, kredi harcamaz) */
export function closedTripCount(address: string): number {
  return buildRoundTrips(swaps.byWallet(address), transfers.byWallet(address)).filter((t) => t.status === 'closed' && !t.excluded)
    .length;
}

/**
 * Cüzdanın işlemlerini çekip ayrıştırır ve kaydeder.
 *
 * - Her seferinde en yeniden itibaren `maxTx` imza listelenir (ucuz: 1000 imza tek çağrı) ve zaten işlenmiş
 *   olanlar atlanır. Böylece hem yeni işlemler alınır hem de sınır büyüdüğünde eksik eski geçmiş tamamlanır.
 * - Son analizden sonraki YENİ işlemler her zaman işlenir.
 * - Daha ESKİ işlemlere inerken `targetClosed` kapanmış işleme ulaşılınca durulur: çok işlem yapan cüzdanlar
 *   gereksiz yere derin taranmaz, az işlem yapanlar `maxTx`'e kadar taranır.
 */
export async function syncWallet(
  address: string,
  opts: { maxTx?: number; targetClosed?: number } = {},
): Promise<{ fetched: number; stoppedEarly?: boolean; prescreenFailed?: string }> {
  const maxTx = opts.maxTx ?? config.ANALYSIS_MAX_TX_PER_WALLET;
  const targetClosed = opts.targetClosed ?? config.ANALYSIS_TARGET_CLOSED_TRIPS;
  const w = wallets.get(address);
  const sigs = await helius.getAllSignatures(address, { max: maxTx });
  if (!w?.last_analyzed_at) {
    const pre = prescreenSignatures(sigs);
    if (!pre.ok) {
      log.info({ address, reason: pre.reason }, 'ön elemede elendi');
      return { fetched: 0, prescreenFailed: pre.reason };
    }
  }
  // listenin başındaki bu kadar imza son analizden sonra gelmiş (yeni); bulunamazsa hepsi yeni sayılır
  const prevIdx = w?.newest_signature ? sigs.findIndex((s) => s.signature === w.newest_signature) : 0;
  const newCount = prevIdx < 0 ? sigs.length : prevIdx;

  let fetched = 0;
  let sinceCheck = 0;
  let checked = false;
  let stoppedEarly = false;
  const swapBuf: SwapEvent[] = [];
  const xferBuf: TransferEvent[] = [];
  const processed: string[] = [];
  /**
   * Yarıda hata olursa (kredi bitti, ağ hatası) o ana kadar çekilenler yine kaydedilir: kredi boşa gitmesin.
   * İşlenmeyen imzalar "görüldü" sayılmaz; bir sonraki analizde kaldığı yerden devam edilir.
   */
  const flush = () => {
    swaps.insertMany(swapBuf.splice(0));
    transfers.insertMany(xferBuf.splice(0));
    seen.addMany(address, processed.splice(0));
  };
  try {
    for (let i = 0; i < sigs.length; i++) {
      const s = sigs[i]!;
      if (i >= newCount && (!checked || sinceCheck >= SYNC_CHECK_EVERY)) {
        flush();
        checked = true;
        sinceCheck = 0;
        if (closedTripCount(address) >= targetClosed) {
          stoppedEarly = true;
          break;
        }
      }
      if (s.err) {
        processed.push(s.signature); // başarısız işlem: ayrıştırılacak bir şey yok
        continue;
      }
      if (seen.has(address, s.signature)) continue;
      const tx = await helius.getTransaction(s.signature);
      fetched++;
      sinceCheck++;
      if (tx) {
        const r = parseWalletTx(tx, address, (ts) => solPriceService.at(ts));
        swapBuf.push(...r.swaps);
        xferBuf.push(...r.transfers);
      }
      processed.push(s.signature);
      if (fetched % 50 === 0) {
        flush();
        log.debug({ address, fetched, total: sigs.length }, 'senkron');
      }
    }
  } finally {
    flush();
  }
  wallets.markAnalyzed(address, sigs[0]?.signature ?? null, maxTx);
  return { fetched, stoppedEarly };
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
  if (sync.prescreenFailed) {
    wallets.setStatus(address, 'excluded');
    // analiz edildi olarak işaretle: aksi halde her turda yeniden sıraya girip kota harcıyordu
    wallets.markAnalyzed(address, null, config.ANALYSIS_MAX_TX_PER_WALLET);
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
