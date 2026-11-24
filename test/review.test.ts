import { Keypair } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../src/core/http.js';
import { annotateTrips } from '../src/analysis/metrics.js';
import { buildRoundTrips } from '../src/analysis/positions.js';
import { syncWallet } from '../src/analysis/walletAnalyzer.js';
import { dexscreener, launchTime, type DexPair } from '../src/data/dexscreener.js';
import { helius, HeliusQuotaError } from '../src/data/helius.js';
import { jupiter } from '../src/data/jupiter.js';
import { solPriceService } from '../src/data/solPrice.js';
import { isNoRouteError, TradingEngine } from '../src/engine/engine.js';
import { LiveExecutor, NoBalanceError, PaperExecutor, sellAmountAtomic, type Executor, type FillResult } from '../src/engine/executor.js';
import { positionsRepo } from '../src/engine/positionsRepo.js';
import { events } from '../src/engine/state.js';
import { openDb, setDb } from '../src/storage/db.js';
import { seen, swaps, tokens, wallets } from '../src/storage/repo.js';
import { strategies } from '../src/strategy/registry.js';
import { evaluateEntry } from '../src/strategy/rules.js';
import type { StrategySpec } from '../src/strategy/types.js';
import { isStartCommand } from '../src/telegram/bot.js';
import { swap, swapTx, WALLET } from './helpers.js';

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
  vi.useRealTimers();
});

const MINT = 'Tok1111111111111111111111111111111111pump';

const spec: StrategySpec = {
  id: 'st1',
  name: 'test',
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
  exit: { takeProfits: [{ multiple: 2, sellPct: 100 }], stopLossMultiple: 0.6, trailingStopPct: null, maxHoldSec: 3600 },
  execution: { slippageBps: 300 },
  evidence: {},
};

describe('satış miktarı (yuvarlama hatası)', () => {
  it('istenen miktar bakiyeye çok yakınsa ya da üstündeyse bakiyenin tamamını satar', () => {
    expect(sellAmountAtomic(1.0000001, 6, 1_000_000n)).toBe(1_000_000n);
    expect(sellAmountAtomic(0.9995, 6, 1_000_000n)).toBe(1_000_000n); // toz bırakma
  });
  it('kısmi satışta istenen miktarı satar', () => {
    expect(sellAmountAtomic(0.5, 6, 1_000_000n)).toBe(500_000n);
  });
  it('bakiye okunamazsa kayıttaki miktar, bakiye sıfırsa sıfır', () => {
    expect(sellAmountAtomic(0.5, 6, null)).toBe(500_000n);
    expect(sellAmountAtomic(0.5, 6, 0n)).toBe(0n);
  });
});

describe('canlı yürütücü', () => {
  const live = () => new LiveExecutor(Keypair.generate());
  beforeEach(() => tokens.upsert({ mint: MINT, decimals: 6 }));

  it('bakiyenin tamamını tam sayı olarak satar', async () => {
    vi.spyOn(helius, 'getTokenBalanceAtomic').mockResolvedValue(1_234_567n);
    const ex = live();
    const sw = vi.spyOn(ex as unknown as { swap: (...a: unknown[]) => Promise<unknown> }, 'swap').mockResolvedValue({
      signature: 's',
      inAtomic: 1_234_567n,
      outAtomic: 1_000_000_000n,
      impact: 0,
    });
    await ex.sell(MINT, 1.234567000001, 300);
    expect(sw.mock.calls[0]![2]).toBe(1_234_567n);
  });

  it('cüzdanda token yoksa NoBalanceError verir', async () => {
    vi.spyOn(helius, 'getTokenBalanceAtomic').mockResolvedValue(0n);
    await expect(live().sell(MINT, 5, 300)).rejects.toBeInstanceOf(NoBalanceError);
  });

  it('alımda yüksek fiyat etkisini reddeder, satışta (zarar kesme) reddetmez', async () => {
    vi.spyOn(helius, 'getBalanceSol').mockResolvedValue(10);
    vi.spyOn(helius, 'getTokenBalanceAtomic').mockResolvedValue(1_000_000n);
    // işlem ve istek kimliği var: kod fiyat etkisi kontrolünü geçerse imza aşamasına ilerler
    vi.spyOn(jupiter, 'order').mockResolvedValue({
      inputMint: '',
      outputMint: '',
      inAmount: '1',
      outAmount: '1',
      priceImpact: 40,
      transaction: 'AAAA',
      requestId: 'r1',
    });
    const ex = live();
    await expect(ex.buy(MINT, 1, 300)).rejects.toThrow(/Fiyat etkisi/);
    // satış fiyat etkisinde durmaz; sahte işlem imza aşamasında başka bir hatayla düşer
    const err = await ex.sell(MINT, 1, 300).then(
      () => null,
      (e: unknown) => String(e),
    );
    expect(err).not.toBeNull();
    expect(err).not.toMatch(/Fiyat etkisi/);
  });
});

describe('paper yürütücü', () => {
  it('canlıyla aynı şekilde yüksek fiyat etkili alımı reddeder', async () => {
    tokens.upsert({ mint: MINT, decimals: 6 });
    vi.spyOn(jupiter, 'order').mockResolvedValue({ inputMint: '', outputMint: '', inAmount: '1', outAmount: '1000000', priceImpact: 25 });
    await expect(new PaperExecutor().buy(MINT, 1, 300)).rejects.toThrow(/Fiyat etkisi/);
  });
});

describe('pozisyon yönetimi', () => {
  const fill = (over: Partial<FillResult> = {}): FillResult => ({ solAmount: 0.5, tokenAmount: 1000, priceSol: 0.0005, priceImpactPct: 0, ...over });
  const fakeExec = (sell: Executor['sell']): Executor => ({
    mode: 'paper',
    balanceSol: async () => 10,
    buy: async () => fill(),
    sell,
  });
  const openPosition = () => positionsRepo.open({ strategyId: 'st1', mode: 'paper', mint: MINT, symbol: 'TOK', priceSol: 0.001, costSol: 1, tokens: 1000 });

  beforeEach(() => {
    strategies.save(spec);
    vi.spyOn(solPriceService, 'now').mockResolvedValue(100);
  });

  it('DexScreener çökse bile Jupiter fiyatıyla zarar kesmeyi uygular', async () => {
    const id = openPosition();
    vi.spyOn(dexscreener, 'tokens').mockRejectedValue(new Error('DexScreener 503'));
    vi.spyOn(jupiter, 'prices').mockResolvedValue({ [MINT]: { usdPrice: 0.05 } }); // 0.0005 SOL = 0.5x
    const sell = vi.fn(async () => fill());
    await new TradingEngine({ paper: fakeExec(sell) }).positionTick();
    expect(sell).toHaveBeenCalledTimes(1);
    expect(positionsRepo.get(id)!.exit_reason).toBe('stop_loss');
  });

  it('fiyat hiç yoksa maksimum tutma süresi yine uygulanır', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000_000_000_000);
    const id = openPosition();
    vi.spyOn(dexscreener, 'tokens').mockResolvedValue(new Map());
    vi.spyOn(jupiter, 'prices').mockResolvedValue({});
    const sell = vi.fn(async () => fill());
    const engine = new TradingEngine({ paper: fakeExec(sell) });
    vi.setSystemTime(1_000_000_000_000 + 10 * 60_000);
    await engine.positionTick(); // fiyatsız ilk görülme
    vi.setSystemTime(1_000_000_000_000 + 21 * 60_000);
    await engine.positionTick();
    expect(sell).not.toHaveBeenCalled();
    expect(messages.filter((m) => m.includes('fiyat alınamıyor'))).toHaveLength(1);
    await engine.positionTick();
    expect(messages.filter((m) => m.includes('fiyat alınamıyor'))).toHaveLength(1); // tek uyarı
    vi.setSystemTime(1_000_000_000_000 + 3600_000);
    await engine.positionTick();
    expect(sell).toHaveBeenCalledTimes(1);
    expect(positionsRepo.get(id)!.exit_reason).toBe('max_hold');
  });

  it('cüzdanda token kalmadıysa pozisyonu kapatır, sonsuza kadar denemez', async () => {
    const id = openPosition();
    vi.spyOn(dexscreener, 'tokens').mockResolvedValue(new Map([[MINT, { mint: MINT, priceSol: 0.0001 }]]));
    const sell = vi.fn(async () => {
      throw new NoBalanceError('yok');
    });
    await new TradingEngine({ paper: fakeExec(sell) }).positionTick();
    expect(positionsRepo.get(id)).toMatchObject({ status: 'closed', exit_reason: 'no_balance' });
  });

  it('paper: 30 dakika "rota yok" ise 0 değerle kapatır; Jupiter çökmesi pozisyonu kapatmaz', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = 1_000_000_000_000;
    vi.setSystemTime(t0);
    const outage = openPosition();
    vi.spyOn(dexscreener, 'tokens').mockResolvedValue(new Map([[MINT, { mint: MINT, priceSol: 0.0001 }]]));
    const down = vi.fn(async () => {
      throw new HttpError(503, 'https://api.jup.ag', 'Service Unavailable');
    });
    const engineDown = new TradingEngine({ paper: fakeExec(down) });
    await engineDown.positionTick();
    vi.setSystemTime(t0 + 40 * 60_000);
    await engineDown.positionTick();
    expect(positionsRepo.get(outage)!.status).toBe('open');
    positionsRepo.forceClose(outage, 'test');

    vi.setSystemTime(t0);
    const rugged = openPosition();
    const noRoute = vi.fn(async () => {
      throw new Error('Jupiter order: Could not find any route');
    });
    const engine = new TradingEngine({ paper: fakeExec(noRoute) });
    await engine.positionTick();
    vi.setSystemTime(t0 + 29 * 60_000);
    await engine.positionTick();
    expect(positionsRepo.get(rugged)!.status).toBe('open');
    vi.setSystemTime(t0 + 31 * 60_000);
    await engine.positionTick();
    expect(positionsRepo.get(rugged)).toMatchObject({ status: 'closed', exit_reason: 'unsellable' });
  });

  it('rota hatası sınıflandırması', () => {
    expect(isNoRouteError(new Error('Jupiter order: Could not find any route'))).toBe(true);
    expect(isNoRouteError(new HttpError(400, 'u', '{"error":"TOKEN_NOT_TRADABLE"}'))).toBe(true);
    expect(isNoRouteError(new HttpError(503, 'u', 'route service down'))).toBe(false);
    expect(isNoRouteError(new Error('fetch failed'))).toBe(false);
  });
});

describe('token çıkış zamanı (pump.fun → PumpSwap geçişi)', () => {
  const pair = (dexId: string, created: number, liq: number): DexPair => ({
    chainId: 'solana',
    dexId,
    pairAddress: `${dexId}-pool`,
    baseToken: { address: MINT, name: 'T', symbol: 'T' },
    quoteToken: { address: 'So11111111111111111111111111111111111111112', name: 'SOL', symbol: 'SOL' },
    pairCreatedAt: created,
    liquidity: { usd: liq },
  });

  it('tüm havuzlar arasındaki en erken açılışı çıkış zamanı sayar', () => {
    expect(launchTime([pair('pumpswap', 5_000_000, 90_000), pair('pumpfun', 1_000_000, 0)], MINT)).toBe(1_000_000);
  });

  it('DexScreener sonucuna çıkış zamanını ekler, kayıtta sadece geriye gider', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([pair('pumpswap', 5_000_000, 90_000), pair('pumpfun', 1_000_000, 0)]))));
    const info = (await dexscreener.tokens([MINT])).get(MINT)!;
    expect(info.pairAddress).toBe('pumpswap-pool'); // fiyat için en likit havuz
    expect(info).toMatchObject({ pairCreatedAt: 5_000_000, launchedAt: 1_000_000 });
    tokens.upsert(info);
    tokens.upsert({ mint: MINT, launchedAt: 5_000_000 }); // sonraki sorguda eski havuz yok
    expect(tokens.get(MINT)!.launchedAt).toBe(1_000_000);
    vi.unstubAllGlobals();
  });

  it('erken alıcının giriş gecikmesi çıkışa göre hesaplanır (sniper diye yanlış elenmez)', () => {
    const trips = buildRoundTrips([swap({ side: 'BUY', sol: 1, tokens: 100, t: 1600 }), swap({ side: 'SELL', sol: 2, tokens: 100, t: 2000 })]);
    const a = annotateTrips(trips, () => ({ mint: MINT, pairCreatedAt: 5_000_000, launchedAt: 1_000_000, supply: 1e9 }), () => 100);
    expect(a[0]!.entryDelaySec).toBe(600);
  });

  it('canlı giriş kuralı token yaşını çıkıştan hesaplar', () => {
    const now = 10_000_000;
    // havuz yeni (1 sn) ama token 2,5 saattir piyasada: 1 saatlik yaş sınırını aşar
    expect(evaluateEntry(spec, { mint: MINT, pairCreatedAt: now - 1000, launchedAt: now - 9_000_000, marketCapUsd: 1 }, now).pass).toBe(false);
    expect(evaluateEntry(spec, { mint: MINT, pairCreatedAt: now - 1000, marketCapUsd: 1 }, now).pass).toBe(true);
  });
});

describe('cüzdan senkronu yarıda kalırsa', () => {
  it('o ana kadar çekilenleri kaydeder, en yeni imzayı güncellemez', async () => {
    wallets.add(WALLET, 'manual');
    vi.spyOn(helius, 'getAllSignatures').mockResolvedValue(
      Array.from({ length: 60 }, (_, i) => ({ signature: `sig-${i}`, slot: i, blockTime: 1_700_000_000 + i * 3600, err: null })),
    );
    let n = 0;
    vi.spyOn(helius, 'getTransaction').mockImplementation(async () => {
      if (++n === 3) throw new HeliusQuotaError('kredi bitti');
      return swapTx({ side: 'BUY', sol: 1, tokens: 1000 });
    });
    await expect(syncWallet(WALLET)).rejects.toBeInstanceOf(HeliusQuotaError);
    expect(swaps.byWallet(WALLET)).toHaveLength(2);
    expect(seen.has(WALLET, 'sig-0')).toBe(true);
    expect(seen.has(WALLET, 'sig-2')).toBe(false); // hata veren tekrar denenecek
    expect(wallets.get(WALLET)!.newest_signature).toBeNull();
  });
});

describe('Telegram', () => {
  it('gruplardaki /start@BotAdı biçimini tanır', () => {
    expect(isStartCommand('/start')).toBe(true);
    expect(isStartCommand('/start@CryptoFincherBot')).toBe(true);
    expect(isStartCommand('/start abc')).toBe(true);
    expect(isStartCommand('/starts')).toBe(false);
    expect(isStartCommand('/durum')).toBe(false);
  });
});
