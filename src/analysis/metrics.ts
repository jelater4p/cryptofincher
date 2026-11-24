import { mean, median, quantile, stdev, sum } from '../core/stats.js';
import { tokenLaunchMs, type TokenInfo } from '../core/types.js';
import type { TripContext } from '../storage/repo.js';
import type { RoundTrip } from './positions.js';

export interface AnalyzedTrip extends RoundTrip {
  /** havuz açılışından ilk alıma kadar geçen süre (sn) */
  entryDelaySec?: number;
  /** ilk alım anındaki tahmini market cap (USD) */
  entryMcapUsd?: number;
  isMeme: boolean;
  ctx?: TripContext;
}

export interface WalletMetrics {
  address: string;
  computedAt: number;
  periodStart: number;
  periodEnd: number;
  activeDays: number;
  swapCount: number;
  tradesPerDay: number;

  closedTrips: number;
  openTrips: number;
  excludedTrips: number;

  // --- performans ---
  winRate: number;
  realizedPnlSol: number;
  totalCostSol: number;
  roi: number;
  profitFactor: number;
  medianRoi: number;
  avgWinRoi: number;
  avgLossRoi: number;
  /** kazançların kaçta kaçı en az 2x */
  bigWinRate: number;
  /** en büyük kazancın toplam kazançlara oranı (şans göstergesi) */
  pnlConcentration: number;
  /** kârlı haftaların oranı (tutarlılık) */
  weeklyPositiveRate: number;
  maxDrawdownSol: number;

  // --- davranış ---
  medianHoldSec: number;
  p25HoldSec: number;
  p75HoldSec: number;
  medianWinHoldSec: number;
  medianLossHoldSec: number;
  medianSizeSol: number;
  sizeCv: number;
  avgEntriesPerTrip: number;
  dcaRate: number;
  /** ardışık alımlarda ikinci alımın ilkine göre fiyat farkı (negatif = düşüşte ekleme) */
  medianDcaPriceChange: number;
  partialExitRate: number;
  avgExitsPerTrip: number;
  /** kazanan turlarda ilk satışın katı ve oranı */
  firstExitMultipleMedian: number;
  firstExitFractionMedian: number;
  /** kazanan turlarda son satışın katı */
  finalExitMultipleMedian: number;
  /** kaybeden turlarda satış katı (zarar kesme seviyesi) */
  lossExitMultipleMedian: number;
  medianEntryDelaySec: number;
  medianEntryMcapUsd: number;
  p25EntryMcapUsd: number;
  p75EntryMcapUsd: number;
  memeShare: number;
  dexMix: Record<string, number>;
  hourHistogram: number[];
  sameSlotRate: number;
  transferInRate: number;

  // --- bağlam (zenginleştirme yapıldıysa) ---
  enrichedTrips: number;
  medianPreChange5m: number;
  medianPreChange15m: number;
  medianVolumeSurge: number;
  /** çıkış katı / görülen zirve katı: hareketin ne kadarını yakaladı */
  medianCaptureRatio: number;
  medianPeakMultiple: number;
  /** kaybedenlerde dip: SL'den önce ne kadar düşüşe dayanıyor */
  medianLossTrough: number;
}

const isMemeMint = (mint: string, token?: TokenInfo, dex?: string) =>
  mint.endsWith('pump') ||
  mint.endsWith('bonk') ||
  dex === 'pumpfun' ||
  dex === 'pumpswap' ||
  dex === 'raydium-launchlab' ||
  dex === 'meteora-dbc' ||
  (token?.marketCapUsd !== undefined && token.marketCapUsd < 5_000_000);

/** Token bilgisi ve SOL fiyatıyla turlara giriş bağlamı ekler */
export function annotateTrips(
  trips: RoundTrip[],
  tokenLookup: (mint: string) => TokenInfo | undefined,
  solUsdAt: (ts: number) => number | undefined,
  ctxLookup?: (t: RoundTrip) => TripContext | undefined,
): AnalyzedTrip[] {
  return trips.map((t) => {
    const tok = tokenLookup(t.mint);
    const firstBuy = t.buys[0];
    let entryDelaySec: number | undefined;
    // çıkış zamanına göre: pump.fun tokenı PumpSwap'a geçince en likit havuzun açılışı girişten SONRA olur
    // ve erken alıcılar yanlışlıkla "0 saniyede girmiş" (sniper) görünürdü
    const launch = tok ? tokenLaunchMs(tok) : undefined;
    if (launch && firstBuy) entryDelaySec = Math.max(0, firstBuy.ts - launch / 1000);
    let entryMcapUsd: number | undefined;
    const supply = tok?.supply ?? (tok?.marketCapUsd && tok.priceUsd ? tok.marketCapUsd / tok.priceUsd : undefined);
    const solUsd = firstBuy ? solUsdAt(firstBuy.ts) : undefined;
    if (supply && firstBuy && solUsd) entryMcapUsd = firstBuy.price * supply * solUsd;
    return { ...t, entryDelaySec, entryMcapUsd, isMeme: isMemeMint(t.mint, tok, t.dex), ctx: ctxLookup?.(t) };
  });
}

function nanSafe(x: number, def = 0) {
  return Number.isFinite(x) ? x : def;
}

function maxDrawdown(pnls: number[]): number {
  let peak = 0;
  let cum = 0;
  let dd = 0;
  for (const p of pnls) {
    cum += p;
    peak = Math.max(peak, cum);
    dd = Math.max(dd, peak - cum);
  }
  return dd;
}

export function computeWalletMetrics(address: string, trips: AnalyzedTrip[], swapCount: number): WalletMetrics {
  const all = trips;
  const closed = all.filter((t) => t.status === 'closed' && !t.excluded);
  const open = all.filter((t) => t.status === 'open');
  const excluded = all.filter((t) => t.excluded);
  const wins = closed.filter((t) => t.realizedPnlSol > 0);
  const losses = closed.filter((t) => t.realizedPnlSol <= 0);

  const times = all.flatMap((t) => [...t.buys, ...t.sells].map((f) => f.ts));
  const periodStart = times.length ? Math.min(...times) : 0;
  const periodEnd = times.length ? Math.max(...times) : 0;
  // en az 1 saat: kısa sürede çok işlem yapan botlar seyreltilmesin
  const activeDays = Math.max(1 / 24, (periodEnd - periodStart) / 86400);

  const grossWin = sum(wins.map((t) => t.realizedPnlSol));
  const grossLoss = -sum(losses.map((t) => t.realizedPnlSol));
  const realizedPnlSol = sum(closed.map((t) => t.realizedPnlSol));
  const totalCostSol = sum(closed.map((t) => t.costSol));

  // haftalık tutarlılık
  const weekly = new Map<number, number>();
  for (const t of closed) {
    const w = Math.floor((t.closedAt ?? t.openedAt) / (7 * 86400));
    weekly.set(w, (weekly.get(w) ?? 0) + t.realizedPnlSol);
  }
  const weeks = [...weekly.values()];

  const holds = closed.map((t) => t.holdSec ?? 0);
  const sizes = closed.map((t) => t.costSol);
  const winnerFirstExits = wins.map((t) => t.exits[0]).filter(Boolean) as NonNullable<AnalyzedTrip['exits'][0]>[];
  const winnerFinalExits = wins.map((t) => t.exits[t.exits.length - 1]).filter(Boolean) as typeof winnerFirstExits;
  // kaybedenlerde çıkış katı = ağırlıklı ortalama satış fiyatı / giriş
  const lossExitMultiples = losses.filter((t) => t.costSol > 0).map((t) => t.proceedsSol / t.costSol);

  const dcaChanges = closed
    .filter((t) => t.buys.length > 1)
    .map((t) => t.buys[1]!.price / t.buys[0]!.price - 1);

  const dexMix: Record<string, number> = {};
  for (const t of all) dexMix[t.dex] = (dexMix[t.dex] ?? 0) + 1;

  const hourHistogram = new Array<number>(24).fill(0);
  for (const t of all) for (const b of t.buys) hourHistogram[new Date(b.ts * 1000).getUTCHours()]! += 1;

  const delays = closed.map((t) => t.entryDelaySec).filter((x): x is number => x !== undefined);
  const mcaps = closed.map((t) => t.entryMcapUsd).filter((x): x is number => x !== undefined && x > 0);
  const enriched = closed.filter((t) => t.ctx);
  const ctxVals = (f: (c: TripContext) => number | undefined) =>
    enriched.map((t) => f(t.ctx!)).filter((x): x is number => x !== undefined && Number.isFinite(x));
  const capture = wins
    .filter((t) => t.ctx?.peakMultiple && t.exits.length)
    .map((t) => {
      const realizedMultiple = t.proceedsSol / t.costSol;
      return realizedMultiple / t.ctx!.peakMultiple!;
    });

  const largestWin = wins.length ? Math.max(...wins.map((t) => t.realizedPnlSol)) : 0;

  return {
    address,
    computedAt: Date.now(),
    periodStart,
    periodEnd,
    activeDays,
    swapCount,
    tradesPerDay: swapCount / activeDays,
    closedTrips: closed.length,
    openTrips: open.length,
    excludedTrips: excluded.length,

    winRate: closed.length ? wins.length / closed.length : 0,
    realizedPnlSol,
    totalCostSol,
    roi: totalCostSol > 0 ? realizedPnlSol / totalCostSol : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0,
    medianRoi: nanSafe(median(closed.map((t) => t.roi))),
    avgWinRoi: nanSafe(mean(wins.map((t) => t.roi))),
    avgLossRoi: nanSafe(mean(losses.map((t) => t.roi))),
    bigWinRate: wins.length ? wins.filter((t) => t.roi >= 1).length / wins.length : 0,
    pnlConcentration: grossWin > 0 ? largestWin / grossWin : 1,
    weeklyPositiveRate: weeks.length ? weeks.filter((w) => w > 0).length / weeks.length : 0,
    maxDrawdownSol: maxDrawdown(closed.map((t) => t.realizedPnlSol)),

    medianHoldSec: nanSafe(median(holds)),
    p25HoldSec: nanSafe(quantile(holds, 0.25)),
    p75HoldSec: nanSafe(quantile(holds, 0.75)),
    medianWinHoldSec: nanSafe(median(wins.map((t) => t.holdSec ?? 0))),
    medianLossHoldSec: nanSafe(median(losses.map((t) => t.holdSec ?? 0))),
    medianSizeSol: nanSafe(median(sizes)),
    sizeCv: sizes.length > 1 ? nanSafe(stdev(sizes) / mean(sizes)) : 0,
    avgEntriesPerTrip: nanSafe(mean(closed.map((t) => t.buys.length)), 1),
    dcaRate: closed.length ? closed.filter((t) => t.buys.length > 1).length / closed.length : 0,
    medianDcaPriceChange: nanSafe(median(dcaChanges)),
    partialExitRate: closed.length ? closed.filter((t) => t.sells.length > 1).length / closed.length : 0,
    avgExitsPerTrip: nanSafe(mean(closed.map((t) => t.sells.length)), 1),
    firstExitMultipleMedian: nanSafe(median(winnerFirstExits.map((e) => e.multiple)), 1),
    firstExitFractionMedian: nanSafe(median(winnerFirstExits.map((e) => e.fraction)), 1),
    finalExitMultipleMedian: nanSafe(median(winnerFinalExits.map((e) => e.multiple)), 1),
    lossExitMultipleMedian: nanSafe(median(lossExitMultiples), 0.5),
    medianEntryDelaySec: nanSafe(median(delays), NaN),
    medianEntryMcapUsd: nanSafe(median(mcaps), NaN),
    p25EntryMcapUsd: nanSafe(quantile(mcaps, 0.25), NaN),
    p75EntryMcapUsd: nanSafe(quantile(mcaps, 0.75), NaN),
    memeShare: all.length ? all.filter((t) => t.isMeme).length / all.length : 0,
    dexMix,
    hourHistogram,
    sameSlotRate: closed.length ? closed.filter((t) => t.sameSlotRoundTrip).length / closed.length : 0,
    transferInRate: all.length ? all.filter((t) => t.transferIn > 0).length / all.length : 0,

    enrichedTrips: enriched.length,
    medianPreChange5m: nanSafe(median(ctxVals((c) => c.preChange5m)), NaN),
    medianPreChange15m: nanSafe(median(ctxVals((c) => c.preChange15m)), NaN),
    medianVolumeSurge: nanSafe(median(ctxVals((c) => c.volumeSurge)), NaN),
    medianCaptureRatio: nanSafe(median(capture), NaN),
    medianPeakMultiple: nanSafe(median(ctxVals((c) => c.peakMultiple)), NaN),
    medianLossTrough: nanSafe(
      median(losses.filter((t) => t.ctx?.troughMultiple).map((t) => t.ctx!.troughMultiple!)),
      NaN,
    ),
  };
}
