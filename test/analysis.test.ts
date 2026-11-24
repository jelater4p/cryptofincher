import { describe, expect, it } from 'vitest';
import { parseWalletTx } from '../src/analysis/swapParser.js';
import { buildRoundTrips } from '../src/analysis/positions.js';
import { annotateTrips, computeWalletMetrics } from '../src/analysis/metrics.js';
import { computeFlags, isEligible, skillScore } from '../src/analysis/scoring.js';
import { prescreenSignatures } from '../src/analysis/walletAnalyzer.js';
import { contextFromCandles } from '../src/analysis/enrich.js';
import { MINT, WALLET, swap, swapTx } from './helpers.js';
import { USDC_MINT } from '../src/core/constants.js';

describe('swapParser', () => {
  it('SOL ile alımı ayrıştırır; işlem ücreti ve ATA kirası değerden ayıklanır', () => {
    const r = parseWalletTx(swapTx({ side: 'BUY', sol: 1.5, tokens: 1_000_000, newAccount: true }), WALLET);
    expect(r.swaps).toHaveLength(1);
    const s = r.swaps[0]!;
    expect(s.side).toBe('BUY');
    expect(s.mint).toBe(MINT);
    expect(s.solValue).toBeCloseTo(1.5, 6);
    expect(s.priceSol).toBeCloseTo(1.5e-6, 12);
    expect(s.dex).toBe('pumpfun');
  });

  it('satış ve hesap kapatma kirası iadesini doğru hesaplar', () => {
    const r = parseWalletTx(swapTx({ side: 'SELL', sol: 3, tokens: 1_000_000, closeAccount: true }), WALLET);
    expect(r.swaps[0]!.side).toBe('SELL');
    expect(r.swaps[0]!.solValue).toBeCloseTo(3, 6);
  });

  it('cüzdanın imzalamadığı token girişi transfer sayılır (airdrop/insider)', () => {
    const r = parseWalletTx(swapTx({ side: 'BUY', sol: 0, tokens: 5000, signer: false }), WALLET);
    expect(r.swaps).toHaveLength(0);
    expect(r.transfers[0]).toMatchObject({ direction: 'IN', amount: 5000 });
  });

  it('başarısız işlemleri yok sayar', () => {
    const tx = { ...swapTx({ side: 'BUY', sol: 1, tokens: 10 }), err: { InstructionError: [0, 'x'] } };
    expect(parseWalletTx(tx, WALLET).swaps).toHaveLength(0);
  });

  it('USDC ile alımı o günün SOL fiyatıyla SOL değerine çevirir', () => {
    const tx = swapTx({ side: 'BUY', sol: 0, tokens: 1000 });
    tx.preTokenBalances.push({ accountIndex: 3, mint: USDC_MINT, owner: WALLET, uiAmount: 500, decimals: 6 });
    tx.postTokenBalances.push({ accountIndex: 3, mint: USDC_MINT, owner: WALLET, uiAmount: 300, decimals: 6 });
    const r = parseWalletTx(tx, WALLET, () => 200);
    expect(r.swaps[0]!.quoteMint).toBe(USDC_MINT);
    expect(r.swaps[0]!.solValue).toBeCloseTo(1, 6);
  });

  it('SOL fiyatı bilinmiyorsa stablecoin swapı atlanır', () => {
    const tx = swapTx({ side: 'BUY', sol: 0, tokens: 1000 });
    tx.preTokenBalances.push({ accountIndex: 3, mint: USDC_MINT, owner: WALLET, uiAmount: 500, decimals: 6 });
    tx.postTokenBalances.push({ accountIndex: 3, mint: USDC_MINT, owner: WALLET, uiAmount: 300, decimals: 6 });
    expect(parseWalletTx(tx, WALLET).skipped).toBe(true);
  });
});

describe('buildRoundTrips', () => {
  it('kısmi satışlarla kapanan turu ve çıkış katlarını çıkarır', () => {
    const trips = buildRoundTrips([
      swap({ side: 'BUY', sol: 1, tokens: 1000, t: 100 }),
      swap({ side: 'SELL', sol: 1, tokens: 500, t: 200 }), // 2x, %50
      swap({ side: 'SELL', sol: 2, tokens: 500, t: 400 }), // 4x, %50
    ]);
    expect(trips).toHaveLength(1);
    const t = trips[0]!;
    expect(t.status).toBe('closed');
    expect(t.realizedPnlSol).toBeCloseTo(2);
    expect(t.roi).toBeCloseTo(2);
    expect(t.holdSec).toBe(300);
    expect(t.exits.map((e) => e.multiple)).toEqual([2, 4]);
    expect(t.exits.map((e) => e.fraction)).toEqual([0.5, 0.5]);
  });

  it('sıfıra indikten sonraki alım yeni tur açar; açık tur kalır', () => {
    const trips = buildRoundTrips([
      swap({ side: 'BUY', sol: 1, tokens: 1000, t: 100 }),
      swap({ side: 'SELL', sol: 0.5, tokens: 1000, t: 200 }),
      swap({ side: 'BUY', sol: 1, tokens: 800, t: 300 }),
    ]);
    expect(trips).toHaveLength(2);
    expect(trips[0]!.realizedPnlSol).toBeCloseTo(-0.5);
    expect(trips[1]!.status).toBe('open');
  });

  it('transferle gelen tokenlı turları PnL dışı bırakır', () => {
    const trips = buildRoundTrips(
      [swap({ side: 'BUY', sol: 0.1, tokens: 100, t: 100 }), swap({ side: 'SELL', sol: 5, tokens: 1100, t: 200 })],
      [{ signature: 'x', blockTime: 150, wallet: WALLET, mint: MINT, direction: 'IN', amount: 1000 }],
    );
    expect(trips[0]!.excluded).toBe(true);
  });

  it('aynı slotta al-sat işaretlenir', () => {
    const trips = buildRoundTrips([
      swap({ side: 'BUY', sol: 1, tokens: 1000, t: 100, slot: 7 }),
      swap({ side: 'SELL', sol: 1.01, tokens: 1000, t: 100, slot: 7 }),
    ]);
    expect(trips[0]!.sameSlotRoundTrip).toBe(true);
  });
});

function tradingHistory(n: number, opts: { winEvery: number; winMult: number; lossMult: number; gapSec?: number }) {
  const out = [];
  let t = 1_700_000_000;
  for (let i = 0; i < n; i++) {
    const mint = `M${i}`.padEnd(40, 'x') + 'pump';
    const win = i % opts.winEvery !== 0;
    out.push(swap({ side: 'BUY', sol: 1, tokens: 1000, t, mint }));
    if (win) {
      out.push(swap({ side: 'SELL', sol: (opts.winMult * 1) / 2, tokens: 500, t: t + 600, mint }));
      out.push(swap({ side: 'SELL', sol: (opts.winMult * 1.5) / 2, tokens: 500, t: t + 1800, mint }));
    } else {
      out.push(swap({ side: 'SELL', sol: opts.lossMult, tokens: 1000, t: t + 900, mint }));
    }
    t += opts.gapSec ?? 86400 / 3;
  }
  return out;
}

describe('metrikler ve skor', () => {
  it('kârlı, tutarlı bir cüzdanı uygun bulur ve davranışını doğru ölçer', () => {
    const trips = buildRoundTrips(tradingHistory(30, { winEvery: 3, winMult: 2, lossMult: 0.6 }));
    const analyzed = annotateTrips(
      trips,
      () => ({ mint: MINT, pairCreatedAt: (1_700_000_000 - 600) * 1000, supply: 1e9 }),
      () => 150,
    );
    const m = computeWalletMetrics(WALLET, analyzed, 90);
    expect(m.closedTrips).toBe(30);
    expect(m.winRate).toBeCloseTo(20 / 30, 3);
    expect(m.partialExitRate).toBeCloseTo(20 / 30, 3);
    expect(m.lossExitMultipleMedian).toBeCloseTo(0.6, 6);
    expect(m.firstExitMultipleMedian).toBeCloseTo(2, 6);
    expect(m.firstExitFractionMedian).toBeCloseTo(0.5, 6);
    expect(m.finalExitMultipleMedian).toBeCloseTo(3, 6);
    expect(m.memeShare).toBe(1);
    const flags = computeFlags(m, { minClosedTrips: 8 });
    expect(isEligible(flags)).toBe(true);
    expect(skillScore(m, flags)).toBeGreaterThan(50);
  });

  it('günde yüzlerce işlem yapan cüzdanı bot olarak işaretler', () => {
    const trips = buildRoundTrips(tradingHistory(30, { winEvery: 3, winMult: 2, lossMult: 0.6, gapSec: 60 }));
    const m = computeWalletMetrics(WALLET, annotateTrips(trips, () => undefined, () => 150), 90);
    expect(computeFlags(m, { minClosedTrips: 8 })).toContain('bot_high_frequency');
  });

  it('zarar eden cüzdanı uygun bulmaz', () => {
    const trips = buildRoundTrips(tradingHistory(30, { winEvery: 1, winMult: 2, lossMult: 0.5 }));
    const m = computeWalletMetrics(WALLET, annotateTrips(trips, () => undefined, () => 150), 30);
    const flags = computeFlags(m, { minClosedTrips: 8 });
    expect(flags).toContain('unprofitable');
    expect(isEligible(flags)).toBe(false);
  });

  it('imza listesinden bot ön elemesi yapar', () => {
    const fast = Array.from({ length: 100 }, (_, i) => ({ signature: `${i}`, slot: i, blockTime: 1000 + i * 5, err: null }));
    expect(prescreenSignatures(fast).ok).toBe(false);
    const slow = Array.from({ length: 100 }, (_, i) => ({ signature: `${i}`, slot: i, blockTime: 1000 + i * 3600, err: null }));
    expect(prescreenSignatures(slow).ok).toBe(true);
  });
});

describe('zenginleştirme', () => {
  it('giriş öncesi momentum ve pozisyon zirvesini hesaplar', () => {
    const trip = buildRoundTrips([
      swap({ side: 'BUY', sol: 1, tokens: 1000, t: 10_000 }),
      swap({ side: 'SELL', sol: 2, tokens: 1000, t: 10_600 }),
    ])[0]!;
    const candles = [];
    for (let ts = 10_000 - 1200; ts <= 10_600; ts += 60) {
      const price = ts < 10_000 ? 1 + (ts - 8800) / 1200 : 2 + (ts - 10_000) / 600; // 1 → 2 öncesi, 2 → 3 sonrası
      candles.push({ ts, o: price, h: price * 1.01, l: price * 0.99, c: price, v: 10 });
    }
    const ctx = contextFromCandles(trip, candles)!;
    expect(ctx.preChange5m).toBeGreaterThan(10);
    expect(ctx.peakMultiple).toBeGreaterThan(1.4);
  });
});
