import { describe, expect, it } from 'vitest';
import { buildRoundTrips } from '../src/analysis/positions.js';
import { annotateTrips, computeWalletMetrics } from '../src/analysis/metrics.js';
import { autoKMeans, kmeans, standardize } from '../src/analysis/kmeans.js';
import { deriveTakeProfits, extractStrategies, extractStrategy, type WalletInput } from '../src/strategy/extractor.js';
import { decideExit, evaluateEntry } from '../src/strategy/rules.js';
import { simulatePortfolio, simulateToken } from '../src/backtest/simulator.js';
import { positionSize } from '../src/engine/engine.js';
import type { StrategySpec } from '../src/strategy/types.js';
import { swap } from './helpers.js';

/** Sentetik cüzdan: TP ladder (2x %50, 4x %50), SL ~slMult, belirli tutma süresi */
function wallet(address: string, o: { n: number; slMult: number; holdSec: number; entryDelay: number; mcapPrice: number }): WalletInput {
  const sw = [];
  let t = 1_700_000_000;
  for (let i = 0; i < o.n; i++) {
    const mint = `${address.slice(0, 4)}${i}`.padEnd(40, 'x') + 'pump';
    const tokens = 1000;
    const price = o.mcapPrice;
    sw.push(swap({ wallet: address, side: 'BUY', sol: price * tokens, tokens, t, mint }));
    if (i % 3 === 0) {
      sw.push(swap({ wallet: address, side: 'SELL', sol: price * tokens * o.slMult, tokens, t: t + o.holdSec, mint }));
    } else {
      sw.push(swap({ wallet: address, side: 'SELL', sol: price * 2 * 500, tokens: 500, t: t + o.holdSec / 2, mint }));
      sw.push(swap({ wallet: address, side: 'SELL', sol: price * 4 * 500, tokens: 500, t: t + o.holdSec, mint }));
    }
    t += 8 * 3600;
  }
  const created = (m: string) => ({ mint: m, pairCreatedAt: 0, supply: 1e9 });
  const trips = annotateTrips(buildRoundTrips(sw), created, () => 100);
  // havuz açılış zamanı: her turun girişinden entryDelay önce
  for (const tr of trips) tr.entryDelaySec = o.entryDelay;
  const metrics = computeWalletMetrics(address, trips, sw.length);
  metrics.medianEntryDelaySec = o.entryDelay;
  return { address, score: 70, metrics, trips };
}

const baseSpec = (over: Partial<StrategySpec['exit']> = {}): StrategySpec => ({
  id: 'test',
  name: 't',
  description: '',
  segment: 'memecoin',
  createdAt: 0,
  source: { method: 'manual', wallets: [] },
  entry: {
    minPoolAgeSec: 0,
    maxPoolAgeSec: 3600,
    mcapUsdMin: 0,
    mcapUsdMax: 1e12,
    minLiquidityUsd: 0,
    priceChange5mMin: null,
    priceChange5mMax: null,
    minBuySellRatio5m: null,
    dca: null,
  },
  sizing: { pctOfEquity: 10, maxOpenPositions: 5 },
  exit: {
    takeProfits: [
      { multiple: 2, sellPct: 50 },
      { multiple: 4, sellPct: 50 },
    ],
    stopLossMultiple: 0.6,
    trailingStopPct: null,
    maxHoldSec: 7200,
    ...over,
  },
  execution: { slippageBps: 300 },
  evidence: {},
});

describe('k-means', () => {
  it('iki belirgin grubu ayırır', () => {
    const data = [
      [0, 0],
      [0.1, 0.2],
      [0.2, 0.1],
      [10, 10],
      [10.1, 9.9],
      [9.8, 10.2],
    ];
    const r = autoKMeans(standardize(data));
    expect(r.k).toBe(2);
    expect(new Set(r.labels.slice(0, 3)).size).toBe(1);
    expect(r.labels[0]).not.toBe(r.labels[3]);
  });

  it('tohum ile tekrarlanabilir', () => {
    const data = Array.from({ length: 20 }, (_, i) => [i % 5, Math.floor(i / 5)]);
    expect(kmeans(data, 3, 7).labels).toEqual(kmeans(data, 3, 7).labels);
  });
});

describe('strateji çıkarımı', () => {
  const trip = (...exits: Array<[number, number]>) => ({ v: exits.map(([multiple, fraction]) => ({ multiple, fraction })), w: 1 });

  it('satış oranlarını olduğu gibi korur: 2x\'te %50, 4x\'te %50', () => {
    const tps = deriveTakeProfits([trip([2, 0.5], [4, 0.5]), trip([2.1, 0.5], [3.9, 0.5]), trip([1.9, 0.5], [4.1, 0.5])], 0.8);
    expect(tps).toEqual([
      { multiple: 2, sellPct: 50 },
      { multiple: 4, sellPct: 50 },
    ]);
  });

  it('eşit olmayan oranları korur: 1.5x\'te %25, 3x\'te kalan %75', () => {
    const tps = deriveTakeProfits([trip([1.5, 0.25], [3, 0.75]), trip([1.5, 0.25], [3, 0.75]), trip([1.6, 0.2], [2.9, 0.8])], 0.9);
    expect(tps).toEqual([
      { multiple: 1.5, sellPct: 25 },
      { multiple: 3, sellPct: 75 },
    ]);
  });

  it('üç kademeli satışı üç TP seviyesine çevirir', () => {
    const tps = deriveTakeProfits(
      [trip([2, 0.3], [3, 0.3], [5, 0.4]), trip([1.9, 0.3], [3.1, 0.3], [5.2, 0.4]), trip([2.1, 0.3], [2.9, 0.3], [4.8, 0.4])],
      0.9,
    );
    expect(tps).toEqual([
      { multiple: 2, sellPct: 30 },
      { multiple: 3, sellPct: 30 },
      { multiple: 5, sellPct: 40 },
    ]);
  });

  it('çok sayıda küçük satışı en fazla 3 seviyeye toplar, toplam her zaman %100', () => {
    const many = trip([1.5, 0.2], [2, 0.2], [2.5, 0.2], [3, 0.2], [4, 0.2]);
    const tps = deriveTakeProfits([many, many, many, many], 0.9);
    expect(tps.length).toBe(3);
    expect(tps.reduce((s, t) => s + t.sellPct, 0)).toBe(100);
    for (let i = 1; i < tps.length; i++) expect(tps[i]!.multiple).toBeGreaterThan(tps[i - 1]!.multiple);
  });

  it('satış sayısı farklı turlarda son satış "kalanı sat" seviyesine gider', () => {
    // çoğunluk 2 kademe; tek satışlık tur sadece son seviyenin katını etkiler
    const tps = deriveTakeProfits([trip([2, 0.5], [4, 0.5]), trip([2, 0.5], [4, 0.5]), trip([4, 1])], 0.7);
    expect(tps).toEqual([
      { multiple: 2, sellPct: 50 },
      { multiple: 4, sellPct: 50 },
    ]);
  });

  it('tek satış yapan cüzdanlarda tek TP üretir', () => {
    expect(deriveTakeProfits([trip([3, 1])], 0.1)).toEqual([{ multiple: 3, sellPct: 100 }]);
    expect(deriveTakeProfits([trip([3, 1]), trip([3.2, 1])], 0.9)).toEqual([{ multiple: 3, sellPct: 100 }]);
  });

  it('cüzdan davranışını strateji parametrelerine çevirir', () => {
    const w = wallet('AAAA1111', { n: 30, slMult: 0.65, holdSec: 1800, entryDelay: 600, mcapPrice: 1e-6 });
    const s = extractStrategy([w], { method: 'wallets' })!;
    expect(s).not.toBeNull();
    expect(s.segment).toBe('memecoin');
    expect(s.exit.stopLossMultiple).toBeCloseTo(0.65, 2);
    // cüzdan 2x'te yarısını, 4x'te kalanını satıyor: strateji bunu birebir almalı
    expect(s.exit.takeProfits).toEqual([
      { multiple: 2, sellPct: 50 },
      { multiple: 4, sellPct: 50 },
    ]);
    expect(s.description).toContain("2x'te %50, 4x'te %50");
    expect(s.entry.maxPoolAgeSec).toBeGreaterThanOrEqual(600);
    expect(s.exit.maxHoldSec).toBeGreaterThanOrEqual(1800);
    // mcap: 1e-6 SOL * 1e9 arz * 100 $/SOL = $100K
    expect(s.entry.mcapUsdMin).toBeCloseTo(100_000, -3);
    expect(s.description).toContain('Kâr alma');
  });

  it('farklı davranışlı cüzdan gruplarından ayrı stratejiler çıkarır', () => {
    const scalpers = ['S1', 'S2', 'S3', 'S4'].map((a) =>
      wallet(a.padEnd(8, 'x'), { n: 20, slMult: 0.85, holdSec: 300, entryDelay: 60, mcapPrice: 2e-7 }),
    );
    const swingers = ['W1', 'W2', 'W3', 'W4'].map((a) =>
      wallet(a.padEnd(8, 'y'), { n: 20, slMult: 0.5, holdSec: 2 * 86400, entryDelay: 5 * 86400, mcapPrice: 5e-5 }),
    );
    const { specs } = extractStrategies([...scalpers, ...swingers]);
    expect(specs.length).toBe(2);
    const holds = specs.map((s) => s.exit.maxHoldSec).sort((a, b) => a - b);
    expect(holds[0]!).toBeLessThan(3600);
    expect(holds[1]!).toBeGreaterThan(86400);
  });
});

describe('kurallar', () => {
  const pos = { entryPrice: 1, initialTokens: 100, remainingTokens: 100, peakPrice: 1, tpHits: 0, openedAtMs: 0 };

  it('stop loss', () => {
    expect(decideExit(baseSpec(), pos, 0.59, 1000).reason).toBe('stop_loss');
  });

  it('kademeli kâr alma', () => {
    const d = decideExit(baseSpec(), pos, 2.1, 1000);
    expect(d).toMatchObject({ reason: 'take_profit', sellTokens: 50, newTpHits: 1 });
    const d2 = decideExit(baseSpec(), { ...pos, remainingTokens: 50, tpHits: 1 }, 4.2, 1000);
    expect(d2).toMatchObject({ reason: 'take_profit', sellTokens: 50, newTpHits: 2 });
  });

  it('fiyat iki TP seviyesini birden geçerse ikisini birden uygular', () => {
    expect(decideExit(baseSpec(), pos, 5, 1000)).toMatchObject({ sellTokens: 100, newTpHits: 2 });
  });

  it('ilk TP sonrası trailing stop', () => {
    const spec = baseSpec({ trailingStopPct: 25 });
    const d = decideExit(spec, { ...pos, remainingTokens: 50, tpHits: 1, peakPrice: 3 }, 2.2, 1000);
    expect(d.reason).toBe('trailing_stop');
  });

  it('maksimum tutma süresi', () => {
    expect(decideExit(baseSpec(), pos, 1.1, 7200 * 1000 + 1).reason).toBe('max_hold');
  });

  it('giriş koşulları', () => {
    const spec = baseSpec();
    spec.entry = { ...spec.entry, minPoolAgeSec: 60, mcapUsdMin: 50_000, mcapUsdMax: 500_000, minLiquidityUsd: 10_000, minBuySellRatio5m: 1 };
    const now = 1_000_000;
    const ok = { mint: 'x', pairCreatedAt: now - 300_000, marketCapUsd: 100_000, liquidityUsd: 20_000, buysM5: 30, sellsM5: 10 };
    expect(evaluateEntry(spec, ok, now).pass).toBe(true);
    expect(evaluateEntry(spec, { ...ok, marketCapUsd: 1e7 }, now).pass).toBe(false);
    expect(evaluateEntry(spec, { ...ok, pairCreatedAt: now - 10_000 }, now).pass).toBe(false);
    expect(evaluateEntry(spec, { ...ok, sellsM5: 50 }, now).pass).toBe(false);
  });

  it('pozisyon büyüklüğü rezerv ve DCA parçasına göre sınırlanır', () => {
    const spec = baseSpec();
    expect(positionSize(spec, 10, 10, 0.05)).toBeCloseTo(1);
    expect(positionSize(spec, 10, 0.5, 0.05)).toBeCloseTo(0.45);
    spec.entry.dca = { tranches: 2, dipPct: 20 };
    expect(positionSize(spec, 10, 10, 0.05)).toBeCloseTo(0.5);
  });
});

describe('backtest simülatörü', () => {
  const meta = { mint: 'm', pairCreatedAtSec: 0, supply: 1e9 };
  const series = (prices: number[]) => prices.map((p, i) => ({ ts: i * 60, o: p, h: p * 1.02, l: p * 0.98, c: p, v: 1 }));

  it('TP merdivenini uygular ve ücretleri düşer', () => {
    const prices = [1, 1, 1, 1, 1, 1, 1, 1.5, 2.2, 3, 4.5, 4.5];
    const r = simulateToken(baseSpec(), meta, series(prices), { feePctPerSide: 1 })!;
    expect(r.exitReasons).toEqual(['tp1', 'tp2']);
    // ~ (0.5*2 + 0.5*4) = 3x, ücretlerle biraz altı
    expect(r.multiple).toBeGreaterThan(2.8);
    expect(r.multiple).toBeLessThan(3.05);
  });

  it('stop loss ile çıkar', () => {
    const prices = [1, 1, 1, 1, 1, 1, 1, 0.8, 0.5, 0.4];
    const r = simulateToken(baseSpec(), meta, series(prices), { feePctPerSide: 1 })!;
    expect(r.exitReasons).toEqual(['stop_loss']);
    expect(r.multiple).toBeLessThan(0.62);
  });

  it('portföy: eşzamanlı pozisyon sınırı ve özsermaye yüzdesi', () => {
    const spec = baseSpec();
    spec.sizing = { pctOfEquity: 50, maxOpenPositions: 1 };
    const trades = [
      { mint: 'a', entryTs: 0, exitTs: 100, entryPrice: 1, multiple: 2, pnlPct: 100, exitReasons: ['tp'] },
      { mint: 'b', entryTs: 50, exitTs: 150, entryPrice: 1, multiple: 0.5, pnlPct: -50, exitReasons: ['sl'] },
      { mint: 'c', entryTs: 200, exitTs: 300, entryPrice: 1, multiple: 0.5, pnlPct: -50, exitReasons: ['sl'] },
    ];
    const r = simulatePortfolio(spec, trades);
    expect(r.trades).toBe(2);
    expect(r.skippedForCapacity).toBe(1);
    // 1 → +0.5 = 1.5 → -0.375 = 1.125
    expect(r.totalReturnPct).toBeCloseTo(12.5, 5);
    expect(r.maxDrawdownPct).toBeCloseTo(25, 5);
  });
});
