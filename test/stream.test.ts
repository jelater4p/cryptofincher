import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { extractCreate, STREAM_WATCH_MS, StreamWatch } from '../src/data/pumpfunStream.js';
import { startUniverseRecorder, type UniverseRow } from '../src/discovery/universe.js';
import { TradingEngine } from '../src/engine/engine.js';
import type { Executor } from '../src/engine/executor.js';
import { openDb, setDb } from '../src/storage/db.js';

beforeEach(() => setDb(openDb(':memory:')));
afterEach(() => vi.unstubAllGlobals());

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * Base58 gösterimi verilen sonekle biten 32 baytlık bir adres üretir (deterministik).
 * Sayının 58^k ile bölümünden kalanı, sonekin değeriyle değiştirilir.
 */
function addressEndingWith(suffix: string, seed: number): Buffer {
  let n = 0n;
  for (let i = 0; i < 32; i++) n = (n << 8n) | BigInt((seed * 31 + i * 17 + 1) % 256);
  n |= 1n << 255n; // ilk bayt sıfır olmasın (base58'de öndeki '1' sorununu önler)
  const mod = 58n ** BigInt(suffix.length);
  let v = 0n;
  for (const ch of suffix) v = v * 58n + BigInt(ALPHABET.indexOf(ch));
  n = n - (n % mod) + v;
  const out = Buffer.alloc(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

/** pump.fun CreateEvent verisi (8 bayt ayırıcı + name/symbol/uri + mint + bondingCurve + creator) */
function createEventData(mint: Buffer, symbol = 'TST'): string {
  const str = (x: string) => {
    const b = Buffer.from(x, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32LE(b.length);
    return Buffer.concat([len, b]);
  };
  return Buffer.concat([
    Buffer.alloc(8),
    str('Test Token'),
    str(symbol),
    str('https://x'),
    mint,
    Keypair.generate().publicKey.toBuffer(),
    Keypair.generate().publicKey.toBuffer(),
  ]).toString('base64');
}

describe('pump.fun log ayrıştırma', () => {
  const pumpMint = addressEndingWith('pump', 7);

  it('test yardımcısı gerçekten "pump" ile biten geçerli bir adres üretir', () => {
    const addr = bs58.encode(pumpMint);
    expect(addr.endsWith('pump')).toBe(true);
    expect(bs58.decode(addr)).toHaveLength(32);
  });

  it('create ve create_v2 talimatlarını tanır, önceki çözülemeyen verileri atlar', () => {
    const data = createEventData(pumpMint);
    for (const instr of ['Instruction: Create', 'Instruction: CreateV2']) {
      const ev = extractCreate([`Program log: ${instr}`, 'Program data: AAAA', `Program data: ${data}`]);
      expect(ev).not.toBeNull();
      expect(ev!.mint).toBe(bs58.encode(pumpMint));
      expect(ev!.symbol).toBe('TST');
    }
  });

  it('oluşturma talimatı olmayan işlemleri (alım-satım) yok sayar', () => {
    expect(extractCreate(['Program log: Instruction: Buy', `Program data: ${createEventData(pumpMint)}`])).toBeNull();
  });

  it('mint adresi pump ile bitmeyen olayı kabul etmez', () => {
    const other = Keypair.generate().publicKey.toBuffer();
    if (bs58.encode(other).endsWith('pump')) return;
    expect(extractCreate(['Program log: Instruction: Create', `Program data: ${createEventData(other)}`])).toBeNull();
  });
});

describe('akış bekçisi', () => {
  const t0 = 1_000_000;

  it('hafif mod 10 dakika içinde token göremezse tam moda geçmeyi ister', () => {
    const w = new StreamWatch('light');
    w.onConnect(t0);
    expect(w.check(t0 + STREAM_WATCH_MS - 1)).toBeNull();
    expect(w.check(t0 + STREAM_WATCH_MS)).toBe('switch_full');
  });

  it('token geliyorsa hiçbir şey yapmaz', () => {
    const w = new StreamWatch('light');
    w.onConnect(t0);
    w.onCreate(t0 + 1000);
    expect(w.check(t0 + 2 * STREAM_WATCH_MS)).toBeNull();
  });

  it('tam modda da token yoksa bir kez uyarır', () => {
    const w = new StreamWatch('full');
    w.onConnect(t0);
    expect(w.check(t0 + STREAM_WATCH_MS)).toBe('warn');
    expect(w.check(t0 + 2 * STREAM_WATCH_MS)).toBeNull();
  });

  it('bağlantı yokken karar vermez (sorun mod değil bağlantı)', () => {
    const w = new StreamWatch('light');
    w.onConnect(t0);
    w.onDisconnect();
    expect(w.check(t0 + 2 * STREAM_WATCH_MS)).toBeNull();
  });

  it('son 10 dakika ve 24 saatteki token sayısını verir', () => {
    const w = new StreamWatch('light');
    const now = 100 * 86400_000;
    w.onCreate(now - 2 * 86400_000);
    w.onCreate(now - 3600_000);
    w.onCreate(now - 60_000);
    expect(w.countSince(now - 10 * 60_000)).toBe(1);
    expect(w.countSince(now - 86400_000)).toBe(2);
  });
});

describe('tarama aday listesi', () => {
  const dummy = {} as Executor;

  it('üst sınırı ekleme anında uygular, en eskileri atar, tekrar ekleneni çoğaltmaz', () => {
    config.SCAN_MAX_CANDIDATES = 3;
    const e = new TradingEngine({ paper: dummy });
    for (const m of ['a', 'b', 'c', 'd', 'e']) e.addCandidate(m);
    e.addCandidate('e');
    expect(e.candidateCount()).toBe(3);
    // en eski 'a' ve 'b' atıldı: tekrar eklenince yeni sayılır, en eski 'c' atılır
    e.addCandidate('a');
    expect(e.candidateCount()).toBe(3);
    config.SCAN_MAX_CANDIDATES = 900;
  });

  it('yeni havuz kaydedicisi bulduğu tokenları taramaya verir', async () => {
    const pool = {
      attributes: { address: 'PoolX', pool_created_at: '2026-11-24T10:00:00Z', base_token_price_usd: '0.00005', fdv_usd: '50000' },
      relationships: { base_token: { data: { id: 'solana_Abc1111111111111111111111111111111111pump' } } },
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [pool] }), { status: 200 })));
    config.UNIVERSE_RECORDER_MINUTES = 2;
    const seen: UniverseRow[] = [];
    const timer = startUniverseRecorder((rows) => seen.push(...rows));
    try {
      await vi.waitFor(() => expect(seen).toHaveLength(1));
      expect(seen[0]!.mint).toBe('Abc1111111111111111111111111111111111pump');
    } finally {
      if (timer) clearInterval(timer);
    }
  });
});
