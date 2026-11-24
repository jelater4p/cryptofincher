import { config } from '../config.js';
import { childLogger } from '../core/logger.js';
import { median, round, stdev, mean } from '../core/stats.js';
import type { TokenInfo } from '../core/types.js';
import { computeWalletMetrics, type AnalyzedTrip } from '../analysis/metrics.js';
import { computeFlags, isEligible, skillScore } from '../analysis/scoring.js';
import { getDb } from '../storage/db.js';
import { extractStrategies, extractStrategy, type WalletInput } from '../strategy/extractor.js';
import type { StrategySpec } from '../strategy/types.js';
import { fmtDuration } from '../strategy/describe.js';
import {
  collectTrades,
  defaultFee,
  pickUniverse,
  universeWarnings,
  type CandleProvider,
  type CoverageStats,
  type TimeWindow,
  type UniversePick,
} from './runner.js';
import { simulatePortfolio, type SimTrade } from './simulator.js';

const log = childLogger('walkforward');
const DAY = 86400;

// ---------------------------------------------------------------- tipler

export interface WalkForwardOptions {
  /** öğrenme penceresi (gün) */
  trainDays: number;
  /** test penceresi (gün); pencere her turda bu kadar ileri kayar */
  testDays: number;
  /** rolling: sabit uzunlukta öğrenme penceresi; expanding: öğrenme hep baştan başlar */
  mode: 'rolling' | 'expanding';
  /** öğrenme penceresinde cüzdan başına gereken en az kapanmış işlem */
  minTrainTrips: number;
  /** canlı analizle aynı toz/düşük kâr eşikleri (öğrenme penceresinde uygulanır) */
  minMedianSizeSol: number;
  minPnlSol: number;
  /** bir turun geçerli sayılması için test penceresinde gereken en az işlem */
  minTradesPerFold: number;
  /** pencere başına backtest edilecek en fazla token (GeckoTerminal limiti için) */
  maxTokensPerWindow: number;
  feePctPerSide?: number;
}

export const DEFAULT_WF_OPTIONS: WalkForwardOptions = {
  trainDays: 14,
  testDays: 7,
  mode: 'rolling',
  minTrainTrips: 5,
  minMedianSizeSol: config.ANALYSIS_MIN_MEDIAN_SIZE_SOL,
  minPnlSol: config.ANALYSIS_MIN_PNL_SOL,
  minTradesPerFold: 3,
  maxTokensPerWindow: 25,
};

export interface WalletHistory {
  address: string;
  trips: AnalyzedTrip[];
}

export interface WalkForwardDeps {
  wallets: WalletHistory[];
  /** keşif ve cüzdan analizinde görülen tokenlar (yanlı olabilir) */
  tokens: TokenInfo[];
  /** açıldıkları anda kaydedilen tarafsız evren; yeterliyse tek başına kullanılır */
  unbiasedTokens?: TokenInfo[];
  candles?: CandleProvider;
  nowSec?: number;
}

export interface FoldWindow {
  index: number;
  train: TimeWindow;
  test: TimeWindow;
}

export interface PerfSummary {
  trades: number;
  winRate: number;
  totalReturnPct: number;
  profitFactor: number;
  maxDrawdownPct: number;
  avgPnlPct: number;
}

export interface SpecSummary {
  takeProfits: string;
  firstTakeProfit: number;
  stopLossMultiple: number;
  maxHoldSec: number;
  minPoolAgeSec: number;
  maxPoolAgeSec: number;
  mcapUsdMin: number;
  mcapUsdMax: number;
}

export interface WalletPersistence {
  /** öğrenme penceresinde seçilen (uygun) cüzdanlar */
  selected: number;
  selectedWithTestData: number;
  /** seçilenlerden test penceresinde de kârlı olanların oranı */
  selectedProfitableRate: number | null;
  /** seçilmeyenlerden (karşılaştırma grubu) test penceresinde kârlı olanların oranı */
  baselineWithTestData: number;
  baselineProfitableRate: number | null;
  trainWinRate: number | null;
  testWinRate: number | null;
}

export interface FoldResult {
  index: number;
  train: TimeWindow;
  test: TimeWindow;
  walletsWithTrainData: number;
  eligibleWallets: number;
  spec: SpecSummary | null;
  inSample: PerfSummary | null;
  outOfSample: PerfSummary | null;
  /** kayıtlı (sabit) stratejinin bu test penceresindeki sonucu: dönem tutarlılığı için */
  fixedSpecOos: PerfSummary | null;
  walletPersistence: WalletPersistence;
  /** test penceresinin evreni: tarafsız mı, kaç token, kaçında veri yok */
  testUniverse?: { source: UniversePick['source']; tokens: number; unbiasedAvailable: number; missingData: number };
  valid: boolean;
  note?: string;
}

export type WalkForwardVerdict = 'robust' | 'weak' | 'overfit' | 'insufficient_data';

export interface WalkForwardReport {
  target: string;
  targetName: string;
  createdAt: number;
  options: WalkForwardOptions;
  dataRange: TimeWindow;
  folds: FoldResult[];
  aggregate: {
    validFolds: number;
    isMedianReturnPct: number | null;
    oosMedianReturnPct: number | null;
    oosCompoundedReturnPct: number | null;
    isWinRate: number | null;
    oosWinRate: number | null;
    oosProfitFactor: number | null;
    oosProfitableFoldRate: number | null;
    oosTrades: number;
    /** test evreni tarafsız olan geçerli tur sayısı */
    unbiasedTestFolds: number;
    testCoverage: CoverageStats;
    /** parametre → kararlı mı */
    paramStability: Record<string, { value: number; stable: boolean }>;
    stabilityScore: number | null;
    /** seçilen cüzdanların test kârlılık oranı - seçilmeyenlerin (pozitif = seçim değer katıyor) */
    walletSelectionEdge: number | null;
  };
  verdict: WalkForwardVerdict;
  reasons: string[];
  warnings: string[];
}

// ---------------------------------------------------------------- saf yardımcılar

/** Zaman aralığını öğrenme/test pencerelerine böler. Test pencereleri çakışmaz. */
export function makeWindows(startSec: number, endSec: number, o: Pick<WalkForwardOptions, 'trainDays' | 'testDays' | 'mode'>): FoldWindow[] {
  const out: FoldWindow[] = [];
  const train = o.trainDays * DAY;
  const test = o.testDays * DAY;
  for (let testFrom = startSec + train, i = 0; testFrom + test <= endSec; testFrom += test, i++) {
    out.push({
      index: i,
      train: { from: o.mode === 'expanding' ? startSec : testFrom - train, to: testFrom },
      test: { from: testFrom, to: testFrom + test },
    });
  }
  return out;
}

/**
 * Pencere içinde açılıp pencere bitmeden KAPANMIŞ turlar. Pencere sonunda hâlâ açık olan
 * turlar alınmaz, çünkü sonuçları o an bilinmiyordu (geleceğe bakma olmaz).
 */
export function tripsInWindow(trips: AnalyzedTrip[], w: TimeWindow): AnalyzedTrip[] {
  return trips.filter((t) => t.status === 'closed' && t.openedAt >= w.from && t.closedAt !== null && t.closedAt < w.to);
}

export interface EvaluatedWallet extends WalletInput {
  eligible: boolean;
}

/** Cüzdanları sadece verilen penceredeki işlemlerine göre yeniden değerlendirir */
export function evaluateWalletsInWindow(
  histories: WalletHistory[],
  w: TimeWindow,
  minTrips: number,
  thresholds: Pick<WalkForwardOptions, 'minMedianSizeSol' | 'minPnlSol'> = { minMedianSizeSol: 0, minPnlSol: 0 },
): EvaluatedWallet[] {
  const out: EvaluatedWallet[] = [];
  for (const h of histories) {
    const trips = tripsInWindow(h.trips, w);
    if (!trips.length) continue;
    const swapCount = trips.reduce((s, t) => s + t.buys.length + t.sells.length, 0);
    const metrics = computeWalletMetrics(h.address, trips, swapCount);
    const flags = computeFlags(metrics, { minClosedTrips: minTrips, ...thresholds });
    out.push({ address: h.address, trips, metrics, score: skillScore(metrics, flags), eligible: isEligible(flags) });
  }
  return out;
}

export function summarize(spec: StrategySpec, trades: SimTrade[]): PerfSummary {
  const p = simulatePortfolio(spec, trades);
  return {
    trades: p.trades,
    winRate: round(p.winRate, 3),
    totalReturnPct: round(p.totalReturnPct, 2),
    profitFactor: round(p.profitFactor, 2),
    maxDrawdownPct: round(p.maxDrawdownPct, 2),
    avgPnlPct: round(p.avgPnlPct, 2),
  };
}

export function summarizeSpec(s: StrategySpec): SpecSummary {
  return {
    takeProfits: s.exit.takeProfits.map((t) => `${t.multiple}x/%${t.sellPct}`).join(' '),
    firstTakeProfit: s.exit.takeProfits[0]!.multiple,
    stopLossMultiple: s.exit.stopLossMultiple,
    maxHoldSec: s.exit.maxHoldSec,
    minPoolAgeSec: s.entry.minPoolAgeSec,
    maxPoolAgeSec: s.entry.maxPoolAgeSec,
    mcapUsdMin: s.entry.mcapUsdMin,
    mcapUsdMax: s.entry.mcapUsdMax,
  };
}

export function walletPersistence(selected: EvaluatedWallet[], testEval: EvaluatedWallet[], selectedSet: Set<string>): WalletPersistence {
  const withData = testEval.filter((w) => w.metrics.closedTrips >= 3);
  const sel = withData.filter((w) => selectedSet.has(w.address));
  const base = withData.filter((w) => !selectedSet.has(w.address));
  const profitable = (ws: EvaluatedWallet[]) => (ws.length ? ws.filter((w) => w.metrics.realizedPnlSol > 0).length / ws.length : null);
  return {
    selected: selected.length,
    selectedWithTestData: sel.length,
    selectedProfitableRate: profitable(sel),
    baselineWithTestData: base.length,
    baselineProfitableRate: profitable(base),
    trainWinRate: selected.length ? round(median(selected.map((w) => w.metrics.winRate)), 3) : null,
    testWinRate: sel.length ? round(median(sel.map((w) => w.metrics.winRate)), 3) : null,
  };
}

/** Parametre kararlılığı: oranlarda varyasyon katsayısı, süre/yaşlarda log10 standart sapması */
export function paramStability(specs: SpecSummary[]): { params: Record<string, { value: number; stable: boolean }>; score: number | null } {
  if (specs.length < 2) return { params: {}, score: null };
  const cv = (xs: number[]) => stdev(xs) / Math.abs(mean(xs));
  const logSd = (xs: number[]) => stdev(xs.map((x) => Math.log10(Math.max(x, 1))));
  const params: Record<string, { value: number; stable: boolean }> = {};
  const add = (name: string, value: number, limit: number) => (params[name] = { value: round(value, 3), stable: value <= limit });
  add('stopLossMultiple_cv', cv(specs.map((s) => s.stopLossMultiple)), 0.25);
  add('firstTakeProfit_cv', cv(specs.map((s) => s.firstTakeProfit)), 0.25);
  add('maxHoldSec_logsd', logSd(specs.map((s) => s.maxHoldSec)), 0.3);
  add('maxPoolAgeSec_logsd', logSd(specs.map((s) => s.maxPoolAgeSec)), 0.3);
  const vals = Object.values(params);
  return { params, score: round(vals.filter((v) => v.stable).length / vals.length, 2) };
}

/**
 * Karar kuralları:
 * - insufficient_data: 2'den az geçerli tur
 * - overfit: öğrenmede kârlı ama testte zararda, ya da kazanma oranı 20 puandan fazla düşüyor, ya da turların 1/3'ünden azı kârlı
 * - robust: turların en az 2/3'ü kârlı, test kâr faktörü ≥ 1.2, kazanma oranı düşüşü ≤ 10 puan, parametreler çoğunlukla kararlı
 * - weak: diğer durumlar
 */
export function decideVerdict(a: WalkForwardReport['aggregate']): { verdict: WalkForwardVerdict; reasons: string[] } {
  const reasons: string[] = [];
  if (a.validFolds < 2) {
    reasons.push(`Sadece ${a.validFolds} geçerli tur var (en az 2 gerekli). Daha uzun veri geçmişi ya da daha kısa pencereler gerekli.`);
    return { verdict: 'insufficient_data', reasons };
  }
  const wrDrop = a.isWinRate !== null && a.oosWinRate !== null ? a.isWinRate - a.oosWinRate : 0;
  const pct = (x: number | null) => (x === null ? '?' : `%${Math.round(x * 100)}`);
  const overfit: string[] = [];
  if ((a.isMedianReturnPct ?? 0) > 0 && (a.oosMedianReturnPct ?? 0) <= 0)
    overfit.push(`Öğrenme döneminde tur başı medyan %${a.isMedianReturnPct} kazanıyor, görülmemiş veride %${a.oosMedianReturnPct}.`);
  if (wrDrop > 0.2) overfit.push(`Kazanma oranı öğrenmede ${pct(a.isWinRate)}, testte ${pct(a.oosWinRate)}: ${Math.round(wrDrop * 100)} puan düşüş.`);
  if ((a.oosProfitableFoldRate ?? 0) < 0.34) overfit.push(`Test turlarının sadece ${pct(a.oosProfitableFoldRate)}'i kârlı.`);
  if (overfit.length) return { verdict: 'overfit', reasons: overfit };

  const checks: Array<[boolean, string]> = [
    [(a.oosProfitableFoldRate ?? 0) >= 0.66, `Test turlarının ${pct(a.oosProfitableFoldRate)}'i kârlı (hedef ≥ %66)`],
    [(a.oosProfitFactor ?? 0) >= 1.2, `Test kâr faktörü ${a.oosProfitFactor ?? '?'} (hedef ≥ 1.2)`],
    [wrDrop <= 0.1, `Kazanma oranı düşüşü ${Math.round(wrDrop * 100)} puan (hedef ≤ 10)`],
    [a.stabilityScore === null || a.stabilityScore >= 0.5, `Parametre kararlılığı ${pct(a.stabilityScore)} (hedef ≥ %50)`],
  ];
  for (const [ok, msg] of checks) reasons.push(`${ok ? '✓' : '✗'} ${msg}`);
  return { verdict: checks.every(([ok]) => ok) ? 'robust' : 'weak', reasons };
}

// ---------------------------------------------------------------- çalıştırıcı

/**
 * Walk-forward doğrulama.
 * - `target` bir strateji ise: her turda, stratejinin kaynak cüzdanlarından ÖĞRENME penceresinde uygun olanlarla
 *   strateji yeniden çıkarılır ve TEST penceresinde denenir.
 * - `target` '*' ise: tüm çıkarım yöntemi test edilir. Her turda uygun cüzdanlar kümelenir, öğrenme döneminde
 *   en iyi görünen strateji seçilir ve test penceresinde denenir (gerçekte senin yapacağın seçimin simülasyonu).
 */
export async function runWalkForward(
  target: StrategySpec | '*',
  deps: WalkForwardDeps,
  opts: Partial<WalkForwardOptions> = {},
): Promise<WalkForwardReport> {
  const o: WalkForwardOptions = { ...DEFAULT_WF_OPTIONS, ...opts };
  const nowSec = deps.nowSec ?? Math.floor(Date.now() / 1000);
  const allTrips = deps.wallets.flatMap((w) => w.trips.filter((t) => t.status === 'closed'));
  const start = allTrips.length ? Math.min(...allTrips.map((t) => t.openedAt)) : nowSec;
  const end = Math.min(nowSec, allTrips.length ? Math.max(...allTrips.map((t) => t.closedAt ?? t.openedAt)) + 1 : nowSec);
  const windows = makeWindows(start, end, o);
  const saved = target === '*' ? null : target;
  const sourceWallets = saved ? new Set(saved.source.wallets) : null;
  const histories = deps.wallets;

  const folds: FoldResult[] = [];
  const isTradesAll: SimTrade[] = [];
  const oosTradesAll: SimTrade[] = [];
  const specSummaries: SpecSummary[] = [];
  const testCoverage: CoverageStats = { attempted: 0, noCandles: 0, noSupply: 0 };

  for (const w of windows) {
    const trainEval = evaluateWalletsInWindow(histories, w.train, o.minTrainTrips, o);
    const testEval = evaluateWalletsInWindow(histories, w.test, 1);
    // strateji modunda sadece kaynak cüzdanlar; ama o dönemde uygun değillerse o dönemde seçilmezlerdi
    const pool = sourceWallets ? trainEval.filter((x) => sourceWallets.has(x.address)) : trainEval;
    const selected = pool.filter((x) => x.eligible);
    const fold: FoldResult = {
      index: w.index,
      train: w.train,
      test: w.test,
      walletsWithTrainData: pool.length,
      eligibleWallets: selected.length,
      spec: null,
      inSample: null,
      outOfSample: null,
      fixedSpecOos: null,
      walletPersistence: walletPersistence(selected, testEval, new Set(selected.map((x) => x.address))),
      valid: false,
    };

    let foldSpec: StrategySpec | null = null;
    let isTrades: SimTrade[] = [];
    if (selected.length) {
      if (saved) {
        foldSpec = extractStrategy(selected, { method: 'wallets' });
        if (foldSpec) {
          // boyutlandırma ve yürütme ayarları kullanıcıya ait: kayıtlı stratejiden alınır
          foldSpec = { ...foldSpec, sizing: saved.sizing, execution: saved.execution };
          isTrades = (await tradesFor(foldSpec, deps, w.train, o, nowSec)).trades;
        }
      } else {
        // en iyi görüneni seç: öğrenme döneminde en yüksek getirili strateji
        const { specs } = extractStrategies(selected);
        let best: { spec: StrategySpec; trades: SimTrade[]; ret: number } | null = null;
        for (const s of specs) {
          const tr = (await tradesFor(s, deps, w.train, o, nowSec)).trades;
          if (tr.length < o.minTradesPerFold) continue;
          const ret = simulatePortfolio(s, tr).totalReturnPct;
          if (!best || ret > best.ret) best = { spec: s, trades: tr, ret };
        }
        if (best) {
          foldSpec = best.spec;
          isTrades = best.trades;
        }
      }
    }

    if (!foldSpec) {
      fold.note = selected.length
        ? 'Öğrenme penceresinde strateji çıkarmaya yetecek işlem yok'
        : sourceWallets
          ? 'Kaynak cüzdanlar bu öğrenme döneminde uygun değildi (o tarihte seçilmezlerdi)'
          : 'Öğrenme penceresinde uygun cüzdan yok';
    } else {
      fold.spec = summarizeSpec(foldSpec);
      specSummaries.push(fold.spec);
      fold.inSample = summarize(foldSpec, isTrades);
      const oos = await tradesFor(foldSpec, deps, w.test, o, nowSec);
      const oosTrades = oos.trades;
      fold.testUniverse = {
        source: oos.pick.source,
        tokens: oos.pick.tokens.length,
        unbiasedAvailable: oos.pick.unbiasedAvailable,
        missingData: oos.stats.noCandles + oos.stats.noSupply,
      };
      testCoverage.attempted += oos.stats.attempted;
      testCoverage.noCandles += oos.stats.noCandles;
      testCoverage.noSupply += oos.stats.noSupply;
      fold.outOfSample = summarize(foldSpec, oosTrades);
      fold.valid = oosTrades.length >= o.minTradesPerFold;
      if (!fold.valid) fold.note = `Test penceresinde sadece ${oosTrades.length} işlem`;
      if (fold.valid) {
        isTradesAll.push(...isTrades);
        oosTradesAll.push(...oosTrades);
      }
    }
    if (saved) fold.fixedSpecOos = summarize(saved, (await tradesFor(saved, deps, w.test, o, nowSec)).trades);
    folds.push(fold);
    log.info({ fold: w.index, valid: fold.valid, oos: fold.outOfSample?.totalReturnPct }, 'tur tamamlandı');
  }

  const valid = folds.filter((f) => f.valid);
  // ortalama değil medyan: tek bir aşırı kârlı tur diğer turlardaki zararları gizlemesin
  const med = (xs: number[]) => (xs.length ? round(median(xs), 2) : null);
  const winRate = (ts: SimTrade[]) => (ts.length ? round(ts.filter((t) => t.multiple > 1).length / ts.length, 3) : null);
  const pf = (ts: SimTrade[]) => {
    const gw = ts.filter((t) => t.multiple > 1).reduce((s, t) => s + t.multiple - 1, 0);
    const gl = -ts.filter((t) => t.multiple <= 1).reduce((s, t) => s + t.multiple - 1, 0);
    return ts.length ? round(gl > 0 ? gw / gl : gw > 0 ? 99 : 0, 2) : null;
  };
  const compounded = valid.length
    ? round((valid.reduce((acc, f) => acc * (1 + f.outOfSample!.totalReturnPct / 100), 1) - 1) * 100, 2)
    : null;
  const stability = paramStability(specSummaries);
  const persist = folds.map((f) => f.walletPersistence).filter((p) => p.selectedProfitableRate !== null && p.baselineProfitableRate !== null);
  const aggregate: WalkForwardReport['aggregate'] = {
    validFolds: valid.length,
    isMedianReturnPct: med(valid.map((f) => f.inSample!.totalReturnPct)),
    oosMedianReturnPct: med(valid.map((f) => f.outOfSample!.totalReturnPct)),
    oosCompoundedReturnPct: compounded,
    isWinRate: winRate(isTradesAll),
    oosWinRate: winRate(oosTradesAll),
    oosProfitFactor: pf(oosTradesAll),
    oosProfitableFoldRate: valid.length ? round(valid.filter((f) => f.outOfSample!.totalReturnPct > 0).length / valid.length, 2) : null,
    oosTrades: oosTradesAll.length,
    unbiasedTestFolds: valid.filter((f) => f.testUniverse?.source === 'unbiased').length,
    testCoverage,
    paramStability: stability.params,
    stabilityScore: stability.score,
    walletSelectionEdge: persist.length
      ? round(mean(persist.map((p) => p.selectedProfitableRate! - p.baselineProfitableRate!)), 3)
      : null,
  };
  const { verdict, reasons } = decideVerdict(aggregate);
  const withUniverse = folds.filter((f) => f.testUniverse);
  const allUnbiased = valid.length > 0 && aggregate.unbiasedTestFolds === valid.length;
  const warnings = [
    'Cüzdanlar, aldıkları tokenlar sonradan yükseldiği için keşfedildi: test dönemleri bu seçimden tamamen bağımsız değil, sonuçlar hâlâ biraz iyimser olabilir.',
    ...universeWarnings(
      {
        source: allUnbiased ? 'unbiased' : 'mixed',
        unbiasedAvailable: withUniverse.length ? Math.min(...withUniverse.map((f) => f.testUniverse!.unbiasedAvailable)) : 0,
        tokens: valid.reduce((s, f) => s + (f.testUniverse?.tokens ?? 0), 0),
      },
      testCoverage,
      'windows',
    ),
  ];
  if (aggregate.walletSelectionEdge !== null && aggregate.walletSelectionEdge <= 0)
    warnings.push('Öğrenme döneminde seçilen cüzdanlar, test döneminde seçilmeyenlerden daha kârlı değil: "kazanan" cüzdanların başarısı kalıcı görünmüyor.');

  return {
    target: saved ? saved.id : '*',
    targetName: saved ? saved.name : 'Tüm çıkarım yöntemi',
    createdAt: Date.now(),
    options: o,
    dataRange: { from: start, to: end },
    folds,
    aggregate,
    verdict,
    reasons,
    warnings,
  };
}

async function tradesFor(spec: StrategySpec, deps: WalkForwardDeps, window: TimeWindow, o: WalkForwardOptions, nowSec: number) {
  const pick = pickUniverse(spec, deps.tokens, deps.unbiasedTokens ?? [], window, o.maxTokensPerWindow);
  const stats: CoverageStats = { attempted: 0, noCandles: 0, noSupply: 0 };
  const trades = await collectTrades(spec, pick.tokens, {
    feePctPerSide: o.feePctPerSide ?? defaultFee(spec),
    candles: deps.candles,
    window,
    nowSec,
    stats,
  });
  return { trades, pick, stats };
}

// ---------------------------------------------------------------- kalıcılık

export const walkforwards = {
  save(r: WalkForwardReport) {
    getDb()
      .prepare('INSERT INTO walkforwards(target, created_at, verdict, json) VALUES (?, ?, ?, ?)')
      .run(r.target, r.createdAt, r.verdict, JSON.stringify(r));
  },
  latest(target: string): WalkForwardReport | undefined {
    const row = getDb().prepare('SELECT json FROM walkforwards WHERE target = ? ORDER BY id DESC LIMIT 1').get(target) as
      | { json: string }
      | undefined;
    return row ? (JSON.parse(row.json) as WalkForwardReport) : undefined;
  },
};

// ---------------------------------------------------------------- biçimlendirme

export const VERDICT_LABEL: Record<WalkForwardVerdict, string> = {
  robust: '✅ SAĞLAM',
  weak: '🟡 ZAYIF',
  overfit: '⛔ AŞIRI UYUM (güvenilmez)',
  insufficient_data: '❔ VERİ YETERSİZ',
};

const day = (s: number) => new Date(s * 1000).toISOString().slice(5, 10);
const pctStr = (x: number | null | undefined, digits = 0) => (x === null || x === undefined ? '?' : `%${(x * 100).toFixed(digits)}`);

export function formatWalkForward(r: WalkForwardReport): string {
  const a = r.aggregate;
  const lines = [
    `🔁 Walk-forward: ${r.target === '*' ? r.targetName : `${r.target} (${r.targetName})`}`,
    `Sonuç: ${VERDICT_LABEL[r.verdict]}`,
    ...r.reasons.map((x) => `  ${x}`),
    '',
    `Pencere: ${r.options.trainDays} gün öğren → ${r.options.testDays} gün test (${r.options.mode === 'rolling' ? 'kayan' : 'genişleyen'}), ${r.folds.length} tur, ${a.validFolds} geçerli`,
    `Tur başı medyan getiri: öğrenme %${a.isMedianReturnPct ?? '?'} → test %${a.oosMedianReturnPct ?? '?'} | Test bileşik: %${a.oosCompoundedReturnPct ?? '?'}`,
    `Kazanma: öğrenme ${pctStr(a.isWinRate)} → test ${pctStr(a.oosWinRate)} | Test PF: ${a.oosProfitFactor ?? '?'} | Test işlem: ${a.oosTrades}`,
    `Parametre kararlılığı: ${pctStr(a.stabilityScore)}${
      Object.keys(a.paramStability).length
        ? ` (${Object.entries(a.paramStability).map(([k, v]) => `${k.split('_')[0]} ${v.stable ? '✓' : '✗'}`).join(', ')})`
        : ''
    }`,
    `Test evreni: ${a.validFolds ? `${a.unbiasedTestFolds}/${a.validFolds} geçerli turda tarafsız` : '?'}`,
    `Cüzdan seçiminin katkısı: ${a.walletSelectionEdge === null ? '?' : `${a.walletSelectionEdge > 0 ? '+' : ''}${Math.round(a.walletSelectionEdge * 100)} puan`}`,
    '',
    'Turlar (test dönemi: getiri / kazanma / işlem):',
  ];
  for (const f of r.folds) {
    const oos = f.outOfSample;
    const base = `${f.valid ? '•' : '◦'} ${day(f.test.from)}→${day(f.test.to)}: `;
    const perf = oos ? `%${oos.totalReturnPct} / ${pctStr(oos.winRate)} / ${oos.trades}` : '-';
    const spec = f.spec ? ` [TP ${f.spec.takeProfits}, SL ${f.spec.stopLossMultiple}x, max ${fmtDuration(f.spec.maxHoldSec)}]` : '';
    const fixed = f.fixedSpecOos ? ` | kayıtlı: %${f.fixedSpecOos.totalReturnPct}` : '';
    lines.push(base + perf + spec + fixed + (f.note ? ` (${f.note})` : ''));
  }
  lines.push('', ...r.warnings.map((w) => `⚠️ ${w}`));
  return lines.join('\n');
}

