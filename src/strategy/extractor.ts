import crypto from 'node:crypto';
import { config } from '../config.js';
import { clamp, niceMultiple, round, weightedQuantile } from '../core/stats.js';
import { FEATURE_NAMES, behaviourFeatures } from '../analysis/features.js';
import { autoKMeans, standardize } from '../analysis/kmeans.js';
import type { AnalyzedTrip, WalletMetrics } from '../analysis/metrics.js';
import { describeStrategy, nameStrategy } from './describe.js';
import { StrategySpecSchema, type StrategySpec, type TakeProfit } from './types.js';

export interface WalletInput {
  address: string;
  score: number;
  metrics: WalletMetrics;
  trips: AnalyzedTrip[];
}

export interface ClusterResult {
  clusterId: number;
  wallets: WalletInput[];
  centroid: Record<string, number>;
}

/** Uygun cüzdanları davranış özelliklerine göre gruplar */
export function clusterWallets(inputs: WalletInput[], seed = 42): { clusters: ClusterResult[]; silhouette: number } {
  if (!inputs.length) return { clusters: [], silhouette: 0 };
  const raw = inputs.map((w) => behaviourFeatures(w.metrics));
  const z = standardize(raw);
  const km = autoKMeans(z, 6, seed);
  const clusters: ClusterResult[] = [];
  for (let c = 0; c < km.k; c++) {
    const members = inputs.filter((_, i) => km.labels[i] === c);
    if (!members.length) continue;
    const centroid: Record<string, number> = {};
    FEATURE_NAMES.forEach((name, j) => (centroid[name] = round(km.centroids[c]![j]!, 3)));
    clusters.push({ clusterId: c, wallets: members, centroid });
  }
  return { clusters, silhouette: km.silhouette };
}

interface Weighted<T> {
  v: T;
  w: number;
}

export interface ExitStep {
  multiple: number;
  fraction: number;
}

export const MAX_TP_LEVELS = 3;

/**
 * Bir turun satışlarını `n` sıralı dilime indirger. Satış sayısı n'den fazlaysa ardışık satışlar
 * sayıca eşit gruplanır (grup katı = miktar ağırlıklı ortalama); azsa son satış her zaman son dilime gider
 * (son satış = "kalanı sat"). Oranlar turun toplam satışına göre normalize edilir.
 */
export function toTranches(exits: ExitStep[], n: number): Array<ExitStep | undefined> {
  const m = exits.length;
  const groups: Array<ExitStep[]> = Array.from({ length: n }, () => []);
  if (m >= n) exits.forEach((e, j) => groups[Math.floor((j * n) / m)]!.push(e));
  else {
    exits.slice(0, -1).forEach((e, j) => groups[j]!.push(e));
    groups[n - 1]!.push(exits[m - 1]!);
  }
  const total = exits.reduce((s, e) => s + e.fraction, 0);
  return groups.map((g) => {
    if (!g.length) return undefined;
    const f = g.reduce((s, e) => s + e.fraction, 0);
    return { multiple: g.reduce((s, e) => s + e.multiple * e.fraction, 0) / f, fraction: f / total };
  });
}

/**
 * Kazanan turların satışlarından kâr alma merdiveni çıkarır.
 * 1. Kısmi satış nadirse tek TP: turların ortalama çıkış katının ağırlıklı medyanı.
 * 2. Değilse tipik satış sayısı (en fazla 3) kadar seviye. Her seviyenin katı ve satış oranı, tüm turlarda
 *    o sıradaki satışın ağırlıklı medyanıdır ("ilk satış genelde 2x'te %50" gibi).
 */
export function deriveTakeProfits(winnerTrips: Weighted<ExitStep[]>[], partialExitRate: number): TakeProfit[] {
  const trips = winnerTrips
    .map((t) => ({ w: t.w, exits: t.v.filter((e) => e.multiple > 1.05 && e.fraction > 0) }))
    .filter((t) => t.exits.length > 0);
  if (!trips.length) return [{ multiple: 2, sellPct: 100 }];

  const counts = trips.map((t) => t.exits.length);
  const n = Math.max(1, Math.min(MAX_TP_LEVELS, Math.round(weightedQuantile(counts, trips.map((t) => t.w), 0.5))));
  if (partialExitRate < 0.35 || n === 1) {
    const avgMultiple = trips.map((t) => {
      const f = t.exits.reduce((s, e) => s + e.fraction, 0);
      return t.exits.reduce((s, e) => s + e.multiple * e.fraction, 0) / f;
    });
    const m = weightedQuantile(avgMultiple, trips.map((t) => t.w), 0.5);
    return [{ multiple: niceMultiple(Math.max(1.2, m)), sellPct: 100 }];
  }

  const perTrip = trips.map((t) => ({ w: t.w, tranches: toTranches(t.exits, n) }));
  const levels: ExitStep[] = [];
  for (let k = 0; k < n; k++) {
    const rows = perTrip.filter((t) => t.tranches[k]).map((t) => ({ w: t.w, s: t.tranches[k]! }));
    if (!rows.length) continue;
    const ws = rows.map((r) => r.w);
    levels.push({
      multiple: niceMultiple(Math.max(1.2, weightedQuantile(rows.map((r) => r.s.multiple), ws, 0.5))),
      fraction: weightedQuantile(rows.map((r) => r.s.fraction), ws, 0.5),
    });
  }

  // katlar artan olmalı: yuvarlama sonrası aynı ya da düşük kalan seviye bir öncekiyle birleşir
  const merged: ExitStep[] = [];
  for (const l of levels) {
    const last = merged[merged.length - 1];
    if (last && l.multiple <= last.multiple) last.fraction += l.fraction;
    else merged.push({ ...l });
  }
  const totalFrac = merged.reduce((s, l) => s + l.fraction, 0);
  const tps: TakeProfit[] = merged.map((l) => ({ multiple: l.multiple, sellPct: Math.round((100 * l.fraction) / totalFrac) }));
  // yuvarlamada %0'a düşen seviye bir sonrakine katılır; son seviye kalanı alır
  const out: TakeProfit[] = [];
  let carry = 0;
  for (let i = 0; i < tps.length; i++) {
    const tp = tps[i]!;
    if (i < tps.length - 1 && tp.sellPct + carry < 1) {
      carry += tp.sellPct;
      continue;
    }
    out.push({ multiple: tp.multiple, sellPct: tp.sellPct + carry });
    carry = 0;
  }
  const used = out.slice(0, -1).reduce((s, t) => s + t.sellPct, 0);
  out[out.length - 1]!.sellPct = 100 - used;
  return out;
}

/** Bir cüzdan grubundan parametreli strateji üretir */
export function extractStrategy(
  group: WalletInput[],
  meta: { method: 'cluster' | 'wallets'; clusterId?: number },
): StrategySpec | null {
  const tripsW: Weighted<AnalyzedTrip>[] = group.flatMap((w) =>
    w.trips.filter((t) => t.status === 'closed' && !t.excluded).map((t) => ({ v: t, w: Math.max(1, w.score) })),
  );
  if (tripsW.length < 5) return null;
  const wq = (vals: Weighted<number | undefined>[], q: number) => {
    const ok = vals.filter((x): x is Weighted<number> => x.v !== undefined && Number.isFinite(x.v));
    return ok.length ? weightedQuantile(ok.map((x) => x.v), ok.map((x) => x.w), q) : NaN;
  };
  const winners = tripsW.filter((t) => t.v.realizedPnlSol > 0);
  const losers = tripsW.filter((t) => t.v.realizedPnlSol <= 0);
  const memeShare = tripsW.filter((t) => t.v.isMeme).length / tripsW.length;
  const segment = memeShare >= 0.5 ? 'memecoin' : 'established';

  // ---- Giriş ----
  const delays = tripsW.map((t) => ({ v: t.v.entryDelaySec, w: t.w }));
  const mcaps = tripsW.map((t) => ({ v: t.v.entryMcapUsd, w: t.w }));
  const delayLo = wq(delays, 0.1);
  const delayHi = wq(delays, 0.8);
  const mcapLo = wq(mcaps, 0.15);
  const mcapHi = wq(mcaps, 0.85);
  const enrichedW = tripsW.filter((t) => t.v.ctx?.preChange5m !== undefined);
  const enoughCtx = enrichedW.length >= 8;
  const pre5Lo = enoughCtx ? wq(enrichedW.map((t) => ({ v: t.v.ctx!.preChange5m, w: t.w })), 0.15) : NaN;
  const pre5Hi = enoughCtx ? wq(enrichedW.map((t) => ({ v: t.v.ctx!.preChange5m, w: t.w })), 0.85) : NaN;

  const dcaTrips = tripsW.filter((t) => t.v.buys.length > 1);
  const dcaRate = dcaTrips.length / tripsW.length;
  const dcaDip = dcaTrips.length
    ? -wq(dcaTrips.map((t) => ({ v: (t.v.buys[1]!.price / t.v.buys[0]!.price - 1) * 100, w: t.w })), 0.5)
    : 0;

  // ---- Çıkış ----
  const winnerExits = winners.map((t) => ({ v: t.v.exits.map((e) => ({ multiple: e.multiple, fraction: e.fraction })), w: t.w }));
  const partialExitRate = tripsW.filter((t) => t.v.sells.length > 1).length / tripsW.length;
  const takeProfits = deriveTakeProfits(winnerExits, partialExitRate);
  const lossMultiple = wq(losers.map((t) => ({ v: t.v.proceedsSol / t.v.costSol, w: t.w })), 0.5);
  const stopLossMultiple = round(clamp(Number.isFinite(lossMultiple) ? lossMultiple : 0.6, 0.3, 0.92), 2);
  const holdHi = wq(tripsW.map((t) => ({ v: t.v.holdSec ?? undefined, w: t.w })), 0.85);
  const capture = winners
    .filter((t) => t.v.ctx?.peakMultiple)
    .map((t) => ({ v: t.v.proceedsSol / t.v.costSol / t.v.ctx!.peakMultiple!, w: t.w }));
  const captureMed = capture.length >= 5 ? wq(capture, 0.5) : NaN;
  // hareketin büyük kısmını yakalayanlar = zirveye yakın satıyorlar → sıkı trailing
  const trailingStopPct =
    partialExitRate >= 0.35
      ? round(clamp(Number.isFinite(captureMed) ? (1 - captureMed) * 100 : (1 - stopLossMultiple) * 80, 10, 50), 0)
      : null;

  const winRate = winners.length / tripsW.length;
  const isMeme = segment === 'memecoin';
  const spec: StrategySpec = {
    id: crypto.createHash('sha1').update(group.map((g) => g.address).sort().join(',') + meta.method).digest('hex').slice(0, 8),
    name: '',
    description: '',
    segment,
    createdAt: Date.now(),
    source: { method: meta.method, wallets: group.map((g) => g.address), clusterId: meta.clusterId },
    entry: {
      minPoolAgeSec: Math.round(Number.isFinite(delayLo) ? Math.max(0, delayLo) : isMeme ? 60 : 0),
      maxPoolAgeSec: Math.round(Number.isFinite(delayHi) ? Math.max(delayHi, 300) : isMeme ? 6 * 3600 : 365 * 86400),
      mcapUsdMin: Math.round(Number.isFinite(mcapLo) ? mcapLo : isMeme ? 10_000 : 5_000_000),
      mcapUsdMax: Math.round(Number.isFinite(mcapHi) ? Math.max(mcapHi, mcapLo * 1.5) : isMeme ? 5_000_000 : 1e12),
      minLiquidityUsd: isMeme ? 8_000 : 250_000,
      priceChange5mMin: Number.isFinite(pre5Lo) ? round(pre5Lo, 1) : null,
      priceChange5mMax: Number.isFinite(pre5Hi) ? round(pre5Hi, 1) : null,
      minBuySellRatio5m: isMeme ? 1 : null,
      dca: dcaRate >= 0.4 ? { tranches: 2, dipPct: round(clamp(dcaDip, 5, 50), 0) } : null,
    },
    sizing: {
      pctOfEquity: config.RISK_PCT_PER_TRADE,
      maxOpenPositions: config.RISK_MAX_OPEN_POSITIONS,
    },
    exit: {
      takeProfits,
      stopLossMultiple,
      trailingStopPct,
      maxHoldSec: Math.round(Number.isFinite(holdHi) ? Math.max(holdHi * 1.25, 120) : isMeme ? 4 * 3600 : 7 * 86400),
    },
    execution: { slippageBps: isMeme ? Math.max(config.RISK_MAX_SLIPPAGE_BPS, 300) : 100 },
    evidence: {
      wallets: group.length,
      trips: tripsW.length,
      enrichedTrips: enrichedW.length,
      winRate: round(winRate, 3),
      memeShare: round(memeShare, 2),
      partialExitRate: round(partialExitRate, 2),
      dcaRate: round(dcaRate, 2),
      medianHoldSec: Math.round(wq(tripsW.map((t) => ({ v: t.v.holdSec ?? undefined, w: t.w })), 0.5)),
      medianEntryDelaySec: Number.isFinite(wq(delays, 0.5)) ? Math.round(wq(delays, 0.5)) : null,
      medianEntryMcapUsd: Number.isFinite(wq(mcaps, 0.5)) ? Math.round(wq(mcaps, 0.5)) : null,
      medianPreChange5m: enoughCtx ? round(wq(enrichedW.map((t) => ({ v: t.v.ctx!.preChange5m, w: t.w })), 0.5), 1) : null,
      medianCaptureRatio: Number.isFinite(captureMed) ? round(captureMed, 2) : null,
      avgWalletScore: round(group.reduce((s, g) => s + g.score, 0) / group.length, 1),
    },
  };
  spec.name = nameStrategy(spec);
  spec.description = describeStrategy(spec);
  return StrategySpecSchema.parse(spec);
}

/** Tüm uygun cüzdanlar → kümeler → her kümeden bir strateji */
export function extractStrategies(inputs: WalletInput[], minWalletsPerCluster = 2) {
  const { clusters, silhouette } = clusterWallets(inputs);
  const specs: StrategySpec[] = [];
  for (const c of clusters) {
    if (c.wallets.length < Math.min(minWalletsPerCluster, inputs.length)) continue;
    const s = extractStrategy(c.wallets, { method: 'cluster', clusterId: c.clusterId });
    if (s) specs.push(s);
  }
  return { specs, clusters, silhouette };
}
