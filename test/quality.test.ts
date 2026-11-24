import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WalletMetrics } from '../src/analysis/metrics.js';
import { computeFlags, isEligible, SCORING_VERSION, skillScore, wilsonLowerBound } from '../src/analysis/scoring.js';
import { reevaluateAll } from '../src/analysis/walletAnalyzer.js';
import { config } from '../src/config.js';
import { helius } from '../src/data/helius.js';
import { discoverFromToken } from '../src/discovery/discovery.js';
import { events } from '../src/engine/state.js';
import { reevaluateIfScoringChanged, selectWalletsToAnalyze } from '../src/jobs.js';
import { getDb, openDb, setDb } from '../src/storage/db.js';
import { kv, swaps, tokens, wallets, walletSources, type WalletRow } from '../src/storage/repo.js';
import { swap, swapTx } from './helpers.js';

let messages: string[] = [];
const onNotify = (m: string) => messages.push(m);
beforeEach(() => {
  setDb(openDb(':memory:'));
  messages = [];
  events.on('notify', onNotify);
});
afterEach(() => {
  events.off('notify', onNotify);
  vi.restoreAllMocks();
});

const metrics = (over: Partial<WalletMetrics>): WalletMetrics =>
  ({
    closedTrips: 10,
    winRate: 0.6,
    profitFactor: 3,
    weeklyPositiveRate: 1,
    activeWeeks: 2,
    activeDays: 14,
    roi: 0.5,
    pnlConcentration: 0.3,
    realizedPnlSol: 5,
    medianSizeSol: 1,
    tradesPerDay: 2,
    swapCount: 20,
    sameSlotRate: 0,
    transferInRate: 0,
    medianEntryDelaySec: 600,
    medianHoldSec: 1800,
    ...over,
  }) as WalletMetrics;

describe('istatistiksel güvenli skor', () => {
  it('Wilson alt sınırı az örnekte temkinlidir', () => {
    expect(wilsonLowerBound(6, 10)).toBeCloseTo(0.313, 2);
    expect(wilsonLowerBound(60, 100)).toBeCloseTo(0.502, 2);
    expect(wilsonLowerBound(0, 0)).toBe(0);
  });

  it('aynı oranlarla 10 işlemlik cüzdan 100 işlemlikten belirgin şekilde düşük skor alır', () => {
    const few = skillScore(metrics({ closedTrips: 10, activeWeeks: 2 }), []);
    const many = skillScore(metrics({ closedTrips: 100, activeWeeks: 12 }), []);
    expect(many - few).toBeGreaterThan(20);
    expect(few).toBeLessThan(55);
  });

  it('2 işlemde %100 kazanma yüksek skor almaz', () => {
    expect(skillScore(metrics({ closedTrips: 2, winRate: 1, activeWeeks: 1 }), [])).toBeLessThan(40);
  });
});

describe('toz ve düşük kâr filtresi', () => {
  const opts = { minClosedTrips: 8, minMedianSizeSol: 0.1, minPnlSol: 0.5 };
  it('küçük pozisyonlu cüzdanı eler', () => {
    const f = computeFlags(metrics({ medianSizeSol: 0.05 }), opts);
    expect(f).toContain('dust_trader');
    expect(isEligible(f)).toBe(false);
  });
  it('kârlı ama kârı çok küçük cüzdanı eler', () => {
    const f = computeFlags(metrics({ realizedPnlSol: 0.1 }), opts);
    expect(f).toContain('low_profit');
    expect(isEligible(f)).toBe(false);
  });
  it('zarardaki cüzdan "düşük kâr" değil "kârsız" sayılır', () => {
    const f = computeFlags(metrics({ realizedPnlSol: -1, profitFactor: 0.5 }), opts);
    expect(f).toContain('unprofitable');
    expect(f).not.toContain('low_profit');
  });
  it('eşikler verilmezse uygulanmaz (geriye dönük uyum)', () => {
    expect(computeFlags(metrics({ medianSizeSol: 0.01, realizedPnlSol: 0.01 }), { minClosedTrips: 8 })).toEqual([]);
  });
});

describe('çoklu kazanan sinyali', () => {
  const W = 'Wa11et1111111111111111111111111111111111111';
  const mint = (i: number) => `Win${i}`.padEnd(40, 'w') + 'pump';

  it('bilinen cüzdanın başka kazananlarda da görünmesini kaydeder', async () => {
    for (const i of [1, 2]) tokens.upsert({ mint: mint(i), pairAddress: `pool${i}` });
    vi.spyOn(helius, 'getOldestSignatures').mockImplementation(async (pool) => [
      { signature: `${pool}-s`, slot: 1, blockTime: 1_700_000_000, err: null },
    ]);
    vi.spyOn(helius, 'getTransaction').mockImplementation(async (sig) => {
      const i = sig.startsWith('pool1') ? 1 : 2;
      return swapTx({ side: 'BUY', sol: 1, tokens: 1000, wallet: W, mint: mint(i), newAccount: true });
    });
    await discoverFromToken(mint(1));
    await discoverFromToken(mint(2)); // cüzdan artık biliniyor: önceden hiç kaydedilmiyordu
    expect(wallets.list()).toHaveLength(1);
    expect(walletSources.winnerCounts().get(W)).toBe(2);
  });

  it('eski sürümden kalan ilk bulunma bilgisini de sayar, aynı tokenı iki kez saymaz', () => {
    wallets.add(W, 'discovered', { from: mint(1) });
    walletSources.record(W, mint(1), 'early');
    walletSources.record(W, mint(2), 'recent'); // aktif tüccar kaydı erken alıcı sayılmaz
    expect(walletSources.winnerCounts().get(W)).toBe(1);
    walletSources.record(W, mint(2), 'early');
    expect(walletSources.winnerCounts().get(W)).toBe(2);
  });

  it('analiz sırasında birden fazla kazananda görünen cüzdan öne geçer', () => {
    const row = (address: string, added_at: number): WalletRow => ({
      address,
      source: 'discovered',
      label: null,
      added_at,
      discovered_from: null,
      last_analyzed_at: null,
      newest_signature: null,
      status: 'active',
      history_max: null,
    });
    const out = selectWalletsToAnalyze([row('eski', 1), row('yeni-cok-kazanan', 5)], new Map(), {
      now: Date.now(),
      maxTx: 2000,
      limit: 10,
      winnerCounts: new Map([['yeni-cok-kazanan', 3]]),
    });
    expect(out.map((w) => w.address)).toEqual(['yeni-cok-kazanan', 'eski']);
  });
});

describe('yeniden değerlendirme', () => {
  const W = 'Dust11111111111111111111111111111111111111';

  beforeEach(() => {
    config.ANALYSIS_MIN_MEDIAN_SIZE_SOL = 0.1;
    config.ANALYSIS_MIN_PNL_SOL = 0.5;
    // 12 kârlı ama toz büyüklüğünde işlem (0.02 SOL)
    wallets.add(W, 'discovered', { from: 'x' });
    const evs = [];
    for (let i = 0; i < 12; i++) {
      const m = `D${i}`.padEnd(40, 'd') + 'pump';
      evs.push(swap({ wallet: W, side: 'BUY', sol: 0.02, tokens: 100, t: 1_700_000_000 + i * 86400, mint: m }));
      evs.push(swap({ wallet: W, side: 'SELL', sol: 0.04, tokens: 100, t: 1_700_000_000 + i * 86400 + 600, mint: m }));
    }
    swaps.insertMany(evs);
    // eski kurallarla "uygun" kaydedilmiş
    getDb()
      .prepare("INSERT INTO wallet_metrics(address, computed_at, skill_score, eligible, flags, json) VALUES (?, 0, 63, 1, '[]', ?)")
      .run(W, JSON.stringify({ closedTrips: 12 }));
  });

  it('kayıtlı cüzdanları kredi harcamadan güncel kurallarla değerlendirir ve durumu günceller', () => {
    const getTx = vi.spyOn(helius, 'getTransaction');
    const r = reevaluateAll();
    expect(r).toEqual({ total: 1, eligibleBefore: 1, eligibleAfter: 0 });
    expect(wallets.get(W)!.status).toBe('excluded');
    expect(getTx).not.toHaveBeenCalled();
  });

  it('puanlama sürümü değişince açılışta bir kez çalışır ve sonucu bildirir', () => {
    expect(reevaluateIfScoringChanged()).toBe(true);
    expect(kv.get('scoring:version', 0)).toBe(SCORING_VERSION);
    expect(messages.at(-1)).toContain('Uygun cüzdan: 1 → 0');
    expect(reevaluateIfScoringChanged()).toBe(false);
  });
});
