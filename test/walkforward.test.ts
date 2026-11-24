import { beforeEach, describe, expect, it } from 'vitest';
import { buildRoundTrips } from '../src/analysis/positions.js';
import { annotateTrips, type AnalyzedTrip } from '../src/analysis/metrics.js';
import {
  decideVerdict,
  formatWalkForward,
  makeWindows,
  paramStability,
  runWalkForward,
  tripsInWindow,
  walkforwards,
  type WalletHistory,
} from '../src/backtest/walkforward.js';
import type { CandleProvider } from '../src/backtest/runner.js';
import type { TokenInfo } from '../src/core/types.js';
import { openDb, setDb } from '../src/storage/db.js';
import { extractStrategy } from '../src/strategy/extractor.js';
import { computeWalletMetrics } from '../src/analysis/metrics.js';
import { swap } from './helpers.js';

const DAY = 86400;
const T0 = 1_700_000_000;
const SPAN_DAYS = 56;

beforeEach(() => setDb(openDb(':memory:')));

describe('pencereler', () => {
  it('kayan pencerede test dönemleri çakışmaz ve öğrenme hemen öncesindedir', () => {
    const w = makeWindows(0, 56 * DAY, { trainDays: 14, testDays: 7, mode: 'rolling' });
    expect(w).toHaveLength(6);
    for (const f of w) {
      expect(f.train.to).toBe(f.test.from);
      expect(f.train.to - f.train.from).toBe(14 * DAY);
    }
    for (let i = 1; i < w.length; i++) expect(w[i]!.test.from).toBe(w[i - 1]!.test.to);
  });

  it('genişleyen pencerede öğrenme hep baştan başlar', () => {
    const w = makeWindows(0, 56 * DAY, { trainDays: 14, testDays: 7, mode: 'expanding' });
    expect(w.every((f) => f.train.from === 0)).toBe(true);
    expect(w[w.length - 1]!.train.to).toBe(49 * DAY);
  });

  it('pencere bitiminden sonra kapanan ve açık turlar alınmaz (geleceğe bakma yok)', () => {
    const trips = buildRoundTrips([
      swap({ side: 'BUY', sol: 1, tokens: 100, t: 100, mint: 'a' }),
      swap({ side: 'SELL', sol: 2, tokens: 100, t: 200, mint: 'a' }), // pencere içinde kapanır
      swap({ side: 'BUY', sol: 1, tokens: 100, t: 300, mint: 'b' }),
      swap({ side: 'SELL', sol: 2, tokens: 100, t: 1500, mint: 'b' }), // pencereden sonra kapanır
      swap({ side: 'BUY', sol: 1, tokens: 100, t: 400, mint: 'c' }), // hiç kapanmaz
    ]) as AnalyzedTrip[];
    const inW = tripsInWindow(trips, { from: 0, to: 1000 });
    expect(inW.map((t) => t.mint)).toEqual(['a']);
  });
});

describe('karar ve kararlılık', () => {
  const base = {
    validFolds: 5,
    isMedianReturnPct: 10,
    oosMedianReturnPct: 8,
    oosCompoundedReturnPct: 40,
    isWinRate: 0.6,
    oosWinRate: 0.55,
    oosProfitFactor: 1.6,
    oosProfitableFoldRate: 0.8,
    oosTrades: 60,
    paramStability: {},
    stabilityScore: 0.75,
    walletSelectionEdge: 0.2,
  };
  it('sağlam', () => expect(decideVerdict(base).verdict).toBe('robust'));
  it('öğrenmede kârlı, testte zararda → aşırı uyum', () =>
    expect(decideVerdict({ ...base, oosMedianReturnPct: -5 }).verdict).toBe('overfit'));
  it('kazanma oranı çok düşüyorsa → aşırı uyum', () => expect(decideVerdict({ ...base, oosWinRate: 0.35 }).verdict).toBe('overfit'));
  it('kârlı ama tutarsız → zayıf', () => expect(decideVerdict({ ...base, oosProfitableFoldRate: 0.5 }).verdict).toBe('weak'));
  it('az tur → veri yetersiz', () => expect(decideVerdict({ ...base, validFolds: 1 }).verdict).toBe('insufficient_data'));

  it('parametreler turdan tura çok değişiyorsa kararsız sayılır', () => {
    const s = (sl: number, tp: number, hold: number) => ({
      takeProfits: '',
      firstTakeProfit: tp,
      stopLossMultiple: sl,
      maxHoldSec: hold,
      minPoolAgeSec: 0,
      maxPoolAgeSec: 600,
      mcapUsdMin: 0,
      mcapUsdMax: 1,
    });
    expect(paramStability([s(0.6, 2, 3600), s(0.62, 2, 3600), s(0.61, 2, 4000)]).score).toBe(1);
    const unstable = paramStability([s(0.3, 1.5, 300), s(0.9, 5, 86400), s(0.5, 2, 3600)]);
    expect(unstable.params.stopLossMultiple_cv!.stable).toBe(false);
    expect(unstable.params.maxHoldSec_logsd!.stable).toBe(false);
  });
});

// ------------------------------------------------------------------ uçtan uca senaryo

/** Her 8 saatte bir işlem: 2x'te yarısı, 4x'te kalanı; her 3 işlemden biri 0.65x'te zarar kesme */
function walletHistory(address: string, kind: 'skilled' | 'loser'): WalletHistory {
  const sw = [];
  const created = new Map<string, number>();
  let i = 0;
  for (let t = T0; t < T0 + SPAN_DAYS * DAY; t += 8 * 3600, i++) {
    const mint = `${address}${i}`.padEnd(40, 'x') + 'pump';
    const price = (0.8 + (i % 8) * 0.1) * 1e-6; // $80K-$150K mcap (arz 1e9, SOL $100)
    created.set(mint, t - (300 + (i % 7) * 100)); // havuz açılışından 5-15 dk sonra giriş
    sw.push(swap({ wallet: address, side: 'BUY', sol: price * 1000, tokens: 1000, t, mint }));
    if (kind === 'loser' || i % 3 === 0) {
      sw.push(swap({ wallet: address, side: 'SELL', sol: price * 1000 * (kind === 'loser' ? 0.5 : 0.65), tokens: 1000, t: t + 1800, mint }));
    } else {
      sw.push(swap({ wallet: address, side: 'SELL', sol: price * 2 * 500, tokens: 500, t: t + 900, mint }));
      sw.push(swap({ wallet: address, side: 'SELL', sol: price * 4 * 500, tokens: 500, t: t + 1800, mint }));
    }
  }
  const trips = annotateTrips(
    buildRoundTrips(sw),
    (m) => ({ mint: m, pairCreatedAt: created.get(m)! * 1000, supply: 1e9 }),
    () => 100,
  );
  return { address, trips };
}

/** Backtest evreni: her 6 saatte bir yeni token. `dumpAfter` sonrası açılan tokenlar yükselmek yerine düşer. */
function universe(dumpAfterSec: number | null) {
  const tokens: TokenInfo[] = [];
  const meta = new Map<string, { created: number; dump: boolean }>();
  for (let t = T0, i = 0; t < T0 + SPAN_DAYS * DAY; t += 6 * 3600, i++) {
    const mint = `U${i}`.padEnd(40, 'u') + 'pump';
    const pool = `pool${i}`;
    tokens.push({ mint, pairAddress: pool, pairCreatedAt: t * 1000, supply: 1e9 });
    meta.set(pool, { created: t, dump: dumpAfterSec !== null && t >= dumpAfterSec });
  }
  // 20. dakikaya kadar $100K'da yatay, sonra 20 dakikada 5x'e çıkar ya da 0.3x'e düşer
  const candles: CandleProvider = async (pool, _tf, aggregate, from, to) => {
    const m = meta.get(pool)!;
    const out = [];
    for (let ts = from; ts <= to; ts += 60 * aggregate) {
      const min = (ts - m.created) / 60;
      const k = Math.min(1, Math.max(0, (min - 20) / 20));
      const c = 1e-4 * (m.dump ? 1 - 0.7 * k : 1 + 4 * k);
      out.push({ ts, o: c, h: c * 1.02, l: c * 0.98, c, v: 1 });
    }
    return out;
  };
  return { tokens, candles };
}

describe('walk-forward uçtan uca', () => {
  const skilled = ['WalA', 'WalB', 'WalC'].map((a) => walletHistory(a, 'skilled'));
  const loser = walletHistory('Lose', 'loser');
  const histories = [...skilled, loser];
  const saved = extractStrategy(
    skilled.map((h) => ({ address: h.address, score: 70, trips: h.trips, metrics: computeWalletMetrics(h.address, h.trips, 100) })),
    { method: 'wallets' },
  )!;
  const nowSec = T0 + (SPAN_DAYS + 5) * DAY;

  it('piyasa davranışı değişmezse strateji SAĞLAM çıkar', async () => {
    const u = universe(null);
    const r = await runWalkForward(saved, { wallets: histories, tokens: u.tokens, candles: u.candles, nowSec });
    // veri 56. günden hemen önce bitiyor: 14→21, 21→28, ..., 42→49 = 5 tur
    expect(r.folds).toHaveLength(5);
    expect(r.aggregate.validFolds).toBe(5);
    expect(r.aggregate.oosProfitableFoldRate).toBe(1);
    expect(r.aggregate.stabilityScore).toBe(1);
    // seçilen yetenekli cüzdanlar testte de kârlı, kaybeden cüzdan değil
    expect(r.aggregate.walletSelectionEdge).toBeCloseTo(1);
    expect(r.verdict).toBe('robust');
    // her turda strateji SADECE öğrenme penceresinden çıkarıldı: kaybeden cüzdan hiç seçilmedi
    expect(r.folds.every((f) => f.eligibleWallets === 3)).toBe(true);
    expect(formatWalkForward(r)).toContain('SAĞLAM');
  });

  it('öğrenilen davranış sonraki dönemde çalışmıyorsa AŞIRI UYUM çıkar (tek büyük kazançlı tur bunu gizleyemez)', async () => {
    const u = universe(T0 + 21 * DAY);
    const r = await runWalkForward(saved, { wallets: histories, tokens: u.tokens, candles: u.candles, nowSec });
    expect(r.aggregate.oosMedianReturnPct!).toBeLessThan(0);
    expect(r.verdict).toBe('overfit');
    // ilk tur (test: 14-21. gün) hâlâ kârlı, sonrakiler zararda
    expect(r.folds[0]!.outOfSample!.totalReturnPct).toBeGreaterThan(0);
    expect(r.folds[4]!.outOfSample!.totalReturnPct).toBeLessThan(0);
  });

  it('tüm çıkarım yöntemi modu: her turda öğrenmede en iyi görünen stratejiyi seçip test eder', async () => {
    const u = universe(null);
    const r = await runWalkForward('*', { wallets: histories, tokens: u.tokens, candles: u.candles, nowSec });
    expect(r.target).toBe('*');
    expect(r.aggregate.validFolds).toBeGreaterThanOrEqual(5);
    expect(r.verdict).toBe('robust');
  });

  it('yetersiz geçmişte veri yetersiz der', async () => {
    const u = universe(null);
    const short = histories.map((h) => ({ ...h, trips: h.trips.filter((t) => t.openedAt < T0 + 18 * DAY) }));
    const r = await runWalkForward(saved, { wallets: short, tokens: u.tokens, candles: u.candles, nowSec }, { trainDays: 14, testDays: 7 });
    expect(r.verdict).toBe('insufficient_data');
  });

  it('tarafsız evren yeterliyse test pencerelerinde sadece onu kullanır ve bunu raporlar', async () => {
    const u = universe(null);
    // pencere başına 7 gün × 4 token = 28 tarafsız token (≥ 20)
    const r = await runWalkForward(saved, { wallets: histories, tokens: [], unbiasedTokens: u.tokens, candles: u.candles, nowSec });
    expect(r.aggregate.validFolds).toBe(5);
    expect(r.folds.every((f) => f.testUniverse?.source === 'unbiased')).toBe(true);
    expect(r.aggregate.unbiasedTestFolds).toBe(5);
    expect(r.warnings.join(' ')).toContain('Tüm test pencerelerinde tarafsız evren kullanıldı');
    expect(r.warnings.join(' ')).not.toContain('survivorship');
    expect(formatWalkForward(r)).toContain('5/5 geçerli turda tarafsız');
  });

  it('tarafsız evren yokken yanlılık uyarısı verir', async () => {
    const u = universe(null);
    const r = await runWalkForward(saved, { wallets: histories, tokens: u.tokens, candles: u.candles, nowSec });
    expect(r.aggregate.unbiasedTestFolds).toBe(0);
    expect(r.warnings.join(' ')).toContain('survivorship');
  });

  it('sonuç kaydedilir ve en son sonuç okunur', async () => {
    const u = universe(null);
    const r = await runWalkForward(saved, { wallets: histories, tokens: u.tokens, candles: u.candles, nowSec });
    walkforwards.save(r);
    expect(walkforwards.latest(saved.id)?.verdict).toBe('robust');
    expect(walkforwards.latest('yok')).toBeUndefined();
  });
});
