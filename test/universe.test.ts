import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parsePool, recordNewPools, universe } from '../src/discovery/universe.js';
import {
  collectTrades,
  fillCandleGaps,
  MIN_UNBIASED,
  pickUniverse,
  spreadSample,
  universeWarnings,
  type CandleProvider,
  type CoverageStats,
} from '../src/backtest/runner.js';
import type { GtPool } from '../src/data/geckoterminal.js';
import type { TokenInfo } from '../src/core/types.js';
import { openDb, setDb } from '../src/storage/db.js';
import type { StrategySpec } from '../src/strategy/types.js';

beforeEach(() => setDb(openDb(':memory:')));
afterEach(() => vi.unstubAllGlobals());

const MINT = 'Abc1111111111111111111111111111111111pump';

function gtPool(over: Partial<{ mint: string; pool: string; created: string | null; price: string | null; fdv: string | null }> = {}): GtPool {
  return {
    id: `solana_${over.pool ?? 'Pool111'}`,
    attributes: {
      address: over.pool ?? 'Pool111',
      name: 'ABC / SOL',
      pool_created_at: over.created === undefined ? '2026-11-24T10:00:00Z' : over.created,
      base_token_price_usd: over.price === undefined ? '0.00005' : over.price,
      fdv_usd: over.fdv === undefined ? '50000' : over.fdv,
      market_cap_usd: null,
    },
    relationships: {
      base_token: { data: { id: `solana_${over.mint ?? MINT}` } },
      quote_token: { data: { id: 'solana_So11111111111111111111111111111111111111112' } },
      dex: { data: { id: 'pump-fun' } },
    },
  };
}

describe('GeckoTerminal yeni havuz ayrıştırma', () => {
  it('havuz, token, açılış zamanı ve arzı çıkarır', () => {
    const r = parsePool(gtPool(), 0)!;
    expect(r).toMatchObject({ mint: MINT, pool: 'Pool111', dex: 'pump-fun', createdAt: Date.parse('2026-11-24T10:00:00Z') });
    expect(r.supply).toBeCloseTo(1e9); // 50000 / 0.00005
    expect(r.initialFdvUsd).toBe(50000);
  });

  it('fiyat yoksa pump.fun tokenı için standart arzı kullanır, açılış yoksa ilk görülme zamanını', () => {
    const r = parsePool(gtPool({ price: null, created: null }), 12345)!;
    expect(r.supply).toBe(1e9);
    expect(r.createdAt).toBe(12345);
  });

  it('pump.fun dışı tokenda arz bilinmiyorsa boş bırakır (backtest bunu "veri yok" sayar)', () => {
    const r = parsePool(gtPool({ mint: 'Xyz111111111111111111111111111111111111111', price: null }), 0)!;
    expect(r.supply).toBeNull();
  });

  it('eksik ya da ters çevrilmiş (taban SOL) kayıtları atlar', () => {
    expect(parsePool({ attributes: { address: 'P' } }, 0)).toBeNull();
    expect(parsePool(gtPool({ mint: 'So11111111111111111111111111111111111111112' }), 0)).toBeNull();
  });
});

describe('evren kaydı', () => {
  const respond = (pools: GtPool[]) => vi.fn(async () => new Response(JSON.stringify({ data: pools }), { status: 200 }));

  it('yeni havuzları kaydeder; aynı token tekrar gelirse ilk (açılış) havuzu korunur', async () => {
    vi.stubGlobal('fetch', respond([gtPool({ pool: 'Launch' }), gtPool({ mint: 'Def111111111111111111111111111111111pump', pool: 'P2' })]));
    expect(await recordNewPools(1000)).toMatchObject({ fetched: 2, parsed: 2, added: 2 });
    // token sonradan başka bir DEX'e taşındı
    vi.stubGlobal('fetch', respond([gtPool({ pool: 'Migrated' })]));
    expect((await recordNewPools(2000)).added).toBe(0);
    const row = universe.all().find((t) => t.mint === MINT)!;
    expect(row.pairAddress).toBe('Launch');
    expect(universe.total()).toBe(2);
    expect(universe.countSince(1500)).toBe(0);
  });

  it('saklama süresini aşan kayıtları temizler', () => {
    universe.insertMany([
      { mint: 'a', pool: 'pa', dex: null, createdAt: 1000, supply: 1, initialFdvUsd: 1, recordedAt: 1000 },
      { mint: 'b', pool: 'pb', dex: null, createdAt: 5000, supply: 1, initialFdvUsd: 1, recordedAt: 5000 },
    ]);
    expect(universe.prune(3000)).toBe(1);
    expect(universe.all().map((t) => t.mint)).toEqual(['b']);
  });
});

const memeSpec = { segment: 'memecoin', entry: { maxPoolAgeSec: 3600 } } as unknown as StrategySpec;
const tok = (i: number, prefix = 'U'): TokenInfo => ({
  mint: `${prefix}${i}`.padEnd(40, 'x') + 'pump',
  pairAddress: `${prefix}pool${i}`,
  pairCreatedAt: (1_000_000 + i * 3600) * 1000,
  supply: 1e9,
});

describe('evren seçimi', () => {
  it('eşit yayılmış örneklem alır', () => {
    expect(spreadSample([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 4)).toEqual([0, 3, 6, 9]);
    expect(spreadSample([1, 2], 5)).toEqual([1, 2]);
  });

  it('tarafsız evren yeterliyse sadece onu kullanır', () => {
    const unbiased = Array.from({ length: MIN_UNBIASED + 5 }, (_, i) => tok(i));
    const observed = Array.from({ length: 10 }, (_, i) => tok(i, 'O'));
    const p = pickUniverse(memeSpec, observed, unbiased, undefined, 60);
    expect(p.source).toBe('unbiased');
    expect(p.tokens.every((t) => t.mint.startsWith('U'))).toBe(true);
    expect(p.unbiasedAvailable).toBe(MIN_UNBIASED + 5);
  });

  it('yetersizse birleştirir; aynı tokenda tarafsız (açılış) kaydı önceliklidir', () => {
    const unbiased = [tok(1), tok(2)];
    const observedDup = { ...tok(1), pairAddress: 'baska-havuz' };
    const p = pickUniverse(memeSpec, [observedDup, tok(3, 'O')], unbiased, undefined, 60);
    expect(p.source).toBe('mixed');
    expect(p.tokens).toHaveLength(3);
    expect(p.tokens.find((t) => t.mint === tok(1).mint)!.pairAddress).toBe('Upool1');
  });

  it('pencere dışındaki tokenları almaz', () => {
    const unbiased = Array.from({ length: 50 }, (_, i) => tok(i));
    const from = 1_000_000 + 10 * 3600;
    const p = pickUniverse(memeSpec, [], unbiased, { from, to: from + 30 * 3600 }, 100);
    expect(p.tokens).toHaveLength(30);
    expect(p.tokens.every((t) => t.pairCreatedAt! / 1000 >= from && t.pairCreatedAt! / 1000 < from + 30 * 3600)).toBe(true);
  });
});

describe('mum boşlukları ve kapsam', () => {
  it('boşlukları önceki kapanışla doldurur ve seriyi sona kadar uzatır', () => {
    const c = (ts: number, p: number) => ({ ts, o: p, h: p, l: p, c: p, v: 1 });
    const out = fillCandleGaps([c(0, 1), c(180, 2)], 60, 300);
    expect(out.map((x) => x.ts)).toEqual([0, 60, 120, 180, 240, 300]);
    expect(out[1]).toMatchObject({ c: 1, v: 0 });
    expect(out[5]).toMatchObject({ c: 2, v: 0 });
  });

  it('fiyat verisi olmayan tokenları sayar ve uyarı üretir', async () => {
    const spec = {
      segment: 'memecoin',
      entry: { minPoolAgeSec: 0, maxPoolAgeSec: 600, mcapUsdMin: 0, mcapUsdMax: 1e12, minLiquidityUsd: 0, priceChange5mMin: null, priceChange5mMax: null, minBuySellRatio5m: null, dca: null },
      exit: { takeProfits: [{ multiple: 2, sellPct: 100 }], stopLossMultiple: 0.5, trailingStopPct: null, maxHoldSec: 600 },
    } as unknown as StrategySpec;
    const empty: CandleProvider = async () => [];
    const stats: CoverageStats = { attempted: 0, noCandles: 0, noSupply: 0 };
    const tokens = [tok(1), tok(2), { ...tok(3), supply: undefined }];
    await collectTrades(spec, tokens, { feePctPerSide: 1, candles: empty, stats, nowSec: 2_000_000 });
    expect(stats).toEqual({ attempted: 3, noCandles: 2, noSupply: 1 });
    const w = universeWarnings({ source: 'mixed', unbiasedAvailable: 3, tokens: 3 }, stats);
    expect(w.join(' ')).toContain('survivorship');
    expect(w.join(' ')).toContain('fiyat/arz verisi bulunamadı');
  });
});
