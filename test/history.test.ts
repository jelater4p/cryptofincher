import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzeWallet, closedTripCount, SYNC_CHECK_EVERY, syncWallet } from '../src/analysis/walletAnalyzer.js';
import { helius, type SignatureInfo } from '../src/data/helius.js';
import { selectWalletsToAnalyze } from '../src/jobs.js';
import { openDb, setDb } from '../src/storage/db.js';
import { seen, wallets, type WalletRow } from '../src/storage/repo.js';
import { swapTx, WALLET } from './helpers.js';

beforeEach(() => setDb(openDb(':memory:')));
afterEach(() => vi.restoreAllMocks());

const T0 = 1_700_000_000;

/**
 * `pairs` adet kapanmış işlem turu üreten sahte cüzdan geçmişi (en yeniden eskiye).
 * Her tur: önce alım (daha eski), sonra satış (daha yeni). `extraNew` kadar en başa yeni tur eklenebilir.
 */
function history(pairs: number, prefix = 'p') {
  const sigs: SignatureInfo[] = [];
  const txs = new Map<string, ReturnType<typeof swapTx>>();
  for (let k = 0; k < pairs; k++) {
    const mint = `${prefix}${k}`.padEnd(40, 'x') + 'pump';
    const tSell = T0 + (pairs - k) * 7200; // k=0 en yeni
    const sell = `${prefix}-sell-${k}`;
    const buy = `${prefix}-buy-${k}`;
    sigs.push({ signature: sell, slot: tSell, blockTime: tSell, err: null });
    sigs.push({ signature: buy, slot: tSell - 3600, blockTime: tSell - 3600, err: null });
    txs.set(sell, { ...swapTx({ side: 'SELL', sol: 2, tokens: 1000, mint, blockTime: tSell }), signature: sell });
    txs.set(buy, { ...swapTx({ side: 'BUY', sol: 1, tokens: 1000, mint, blockTime: tSell - 3600, newAccount: true }), signature: buy });
  }
  return { sigs, txs };
}

function mockHelius(sigs: SignatureInfo[], txs: Map<string, ReturnType<typeof swapTx>>) {
  vi.spyOn(helius, 'getAllSignatures').mockImplementation(async (_a, o) => sigs.slice(0, o.max));
  return vi.spyOn(helius, 'getTransaction').mockImplementation(async (s) => txs.get(s) ?? null);
}

describe('derin geçmiş ve akıllı durma', () => {
  it('yeterli kapanmış işlem toplanınca daha eskiye inmez', async () => {
    wallets.add(WALLET, 'manual');
    const h = history(200); // 400 işlem
    const getTx = mockHelius(h.sigs, h.txs);
    const r = await syncWallet(WALLET, { maxTx: 2000, targetClosed: 10 });
    expect(r.stoppedEarly).toBe(true);
    expect(getTx).toHaveBeenCalledTimes(SYNC_CHECK_EVERY); // ilk kontrol noktasında 50 tur > 10
    expect(closedTripCount(WALLET)).toBe(50);
    // işlenmeyen eski işlemler "görüldü" sayılmaz: gerekirse sonra tamamlanabilir
    expect(seen.has(WALLET, h.sigs[399]!.signature)).toBe(false);
  });

  it('az işlem yapan cüzdanı sınıra kadar tarar', async () => {
    wallets.add(WALLET, 'manual');
    const h = history(20); // 40 işlem, hedef 60 tur
    const getTx = mockHelius(h.sigs, h.txs);
    const r = await syncWallet(WALLET, { maxTx: 2000, targetClosed: 60 });
    expect(r.stoppedEarly).toBe(false);
    expect(getTx).toHaveBeenCalledTimes(40);
    expect(closedTripCount(WALLET)).toBe(20);
  });

  it('sınır büyüyünce sadece eksik eski geçmişi çeker (işlenmişleri tekrar çekmez)', async () => {
    wallets.add(WALLET, 'manual');
    const h = history(100); // 200 işlem
    const getTx = mockHelius(h.sigs, h.txs);
    await syncWallet(WALLET, { maxTx: 50, targetClosed: 1000 });
    expect(getTx).toHaveBeenCalledTimes(50);
    expect(wallets.get(WALLET)!.history_max).toBe(50);
    getTx.mockClear();
    await syncWallet(WALLET, { maxTx: 200, targetClosed: 1000 });
    expect(getTx).toHaveBeenCalledTimes(150);
    expect(closedTripCount(WALLET)).toBe(100);
    expect(wallets.get(WALLET)!.history_max).toBe(200);
  });

  it('hedef zaten karşılanmış olsa da son analizden sonraki YENİ işlemleri her zaman alır', async () => {
    wallets.add(WALLET, 'manual');
    const old = history(100, 'old');
    const getTx = mockHelius(old.sigs, old.txs);
    await syncWallet(WALLET, { maxTx: 2000, targetClosed: 10 }); // erken durur
    // sonradan 3 yeni tur geldi (listenin başında, daha yeni zamanlı)
    const fresh = history(3, 'new');
    const shifted = fresh.sigs.map((s) => ({ ...s, blockTime: s.blockTime! + 10 * 86400 }));
    const all = [...shifted, ...old.sigs];
    const txs = new Map([...old.txs, ...fresh.txs]);
    getTx.mockClear();
    vi.spyOn(helius, 'getAllSignatures').mockImplementation(async (_a, o) => all.slice(0, o.max));
    await syncWallet(WALLET, { maxTx: 2000, targetClosed: 10 });
    // sadece 6 yeni işlem çekildi; eski işlenmemiş geçmişe inilmedi
    expect(getTx).toHaveBeenCalledTimes(6);
    expect(getTx.mock.calls.every(([s]) => String(s).startsWith('new-'))).toBe(true);
  });
});

describe('ön eleme', () => {
  it('bot diye elenen cüzdan analiz edildi sayılır, bir daha sıraya girmez', async () => {
    wallets.add('BotWallet1111111111111111111111111111111111', 'discovered');
    const sigs = Array.from({ length: 300 }, (_, i) => ({ signature: `b${i}`, slot: i, blockTime: T0 + i, err: null }));
    vi.spyOn(helius, 'getAllSignatures').mockResolvedValue(sigs);
    const r = await analyzeWallet('BotWallet1111111111111111111111111111111111');
    expect(r).toHaveProperty('prescreenFailed');
    const w = wallets.get('BotWallet1111111111111111111111111111111111')!;
    expect(w.status).toBe('excluded');
    expect(w.last_analyzed_at).not.toBeNull();
    expect(selectWalletsToAnalyze(wallets.list(), new Map(), { now: Date.now(), maxTx: 2000, limit: 60 })).toHaveLength(0);
  });
});

describe('analiz sırası', () => {
  const NOW = 1_800_000_000_000;
  const DAY = 86400_000;
  const row = (address: string, over: Partial<WalletRow>): WalletRow => ({
    address,
    source: 'discovered',
    label: null,
    added_at: 0,
    discovered_from: null,
    last_analyzed_at: null,
    newest_signature: null,
    status: 'active',
    history_max: null,
    ...over,
  });

  const rows = [
    row('yeni-2', { added_at: 2 }),
    row('yeni-1', { added_at: 1 }),
    row('elle', { source: 'manual', added_at: 9 }),
    row('aktif-eski', { last_analyzed_at: NOW - 4 * DAY }),
    row('aktif-taze', { last_analyzed_at: NOW - DAY }),
    row('veri-yok-sig', { status: 'excluded', last_analyzed_at: NOW - DAY, history_max: 250 }),
    row('veri-yok-derin', { status: 'excluded', last_analyzed_at: NOW - DAY, history_max: 2000 }),
    row('karsiz', { status: 'excluded', last_analyzed_at: NOW - DAY, history_max: 250 }),
    row('eski-surum', { status: 'excluded', last_analyzed_at: NOW - DAY, history_max: null }),
  ];
  const flags = new Map([
    ['veri-yok-sig', ['insufficient_data', 'unprofitable']],
    ['veri-yok-derin', ['insufficient_data']],
    ['karsiz', ['unprofitable']],
    ['eski-surum', ['insufficient_data']],
  ]);

  it('öncelik: elle → bekleyenler (en eski önce) → aktif yenileme → sığ geçmişle "veri yok" elenenler', () => {
    const out = selectWalletsToAnalyze(rows, flags, { now: NOW, maxTx: 2000, limit: 100 }).map((w) => w.address);
    expect(out).toEqual(['elle', 'yeni-1', 'yeni-2', 'aktif-eski', 'veri-yok-sig', 'eski-surum']);
    // yeterli veriyle kârsız çıkan, zaten derin taranmış ve taze aktif cüzdanlar alınmaz
    expect(out).not.toContain('karsiz');
    expect(out).not.toContain('veri-yok-derin');
    expect(out).not.toContain('aktif-taze');
  });

  it('tur başı sınıra uyar', () => {
    expect(selectWalletsToAnalyze(rows, flags, { now: NOW, maxTx: 2000, limit: 2 }).map((w) => w.address)).toEqual(['elle', 'yeni-1']);
  });
});
