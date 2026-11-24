import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { assessSafety } from '../src/engine/safety.js';
import { decodeCreateEvent } from '../src/data/pumpfunStream.js';
import { loadKeystore, saveKeystore } from '../src/wallet/keystore.js';
import { RateLimiter } from '../src/core/rateLimiter.js';
import { openDb, setDb } from '../src/storage/db.js';
import { kv } from '../src/storage/repo.js';
import { heliusCredits, CreditBudgetExceeded } from '../src/data/helius.js';
import { heliusKeyId } from '../src/data/heliusAlert.js';
import { strategies } from '../src/strategy/registry.js';
import { positionsRepo } from '../src/engine/positionsRepo.js';

beforeEach(() => setDb(openDb(':memory:')));

describe('güvenlik filtresi (zorunlu)', () => {
  const clean = { mintAuthority: null, freezeAuthority: null };
  it('temiz token geçer', () => {
    expect(assessSafety(clean, { score_normalised: 10, risks: [] }, 50).ok).toBe(true);
  });
  it('mint veya freeze authority varsa reddeder', () => {
    expect(assessSafety({ ...clean, mintAuthority: 'X' }, { score_normalised: 1 }, 50).ok).toBe(false);
    expect(assessSafety({ ...clean, freezeAuthority: 'X' }, { score_normalised: 1 }, 50).ok).toBe(false);
  });
  it('yüksek RugCheck skoru reddedilir', () => {
    expect(assessSafety(clean, { score_normalised: 80 }, 50).ok).toBe(false);
  });
  it('veri alınamazsa reddeder (fail-closed)', () => {
    expect(assessSafety(null, { score_normalised: 1 }, 50).ok).toBe(false);
    expect(assessSafety(clean, null, 50).ok).toBe(false);
  });
});

describe('keystore', () => {
  it('şifreler, çözer ve yanlış parolayı reddeder', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ks-'));
    const file = path.join(dir, 'k.json');
    const kp = Keypair.generate();
    saveKeystore(file, kp, 'çok-gizli-parola');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file, 'utf8')).not.toContain(bs58.encode(kp.secretKey));
    expect(loadKeystore(file, 'çok-gizli-parola').publicKey.toBase58()).toBe(kp.publicKey.toBase58());
    expect(() => loadKeystore(file, 'yanlış-parola-123')).toThrow(/Parola yanlış/);
    expect(() => saveKeystore(file, kp, 'çok-gizli-parola')).toThrow(/zaten var/);
  });
});

describe('pump.fun CreateEvent', () => {
  it('olay verisini çözer', () => {
    const str = (s: string) => {
      const b = Buffer.from(s, 'utf8');
      const len = Buffer.alloc(4);
      len.writeUInt32LE(b.length);
      return Buffer.concat([len, b]);
    };
    const mint = Keypair.generate().publicKey;
    const curve = Keypair.generate().publicKey;
    const user = Keypair.generate().publicKey;
    const buf = Buffer.concat([Buffer.alloc(8), str('Test'), str('TST'), str('https://x'), mint.toBuffer(), curve.toBuffer(), user.toBuffer(), Buffer.alloc(16)]);
    const e = decodeCreateEvent(buf.toString('base64'))!;
    expect(e).toMatchObject({ name: 'Test', symbol: 'TST', uri: 'https://x', mint: mint.toBase58(), creator: user.toBase58() });
  });
  it('bozuk veride null döner', () => {
    expect(decodeCreateEvent('AAAA')).toBeNull();
  });
});

describe('altyapı', () => {
  it('rate limiter kapasiteyi aşınca bekletir', async () => {
    const rl = new RateLimiter(2, 20);
    const t0 = Date.now();
    await Promise.all([rl.acquire(), rl.acquire(), rl.acquire(), rl.acquire()]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(80);
  });

  it('Helius kredi bütçesi: analiz %95 sınırında durur, işlemler devam eder', () => {
    const month = `helius_credits:${new Date().toISOString().slice(0, 7)}:${heliusKeyId()}`;
    kv.set(month, heliusCredits.analysisAllowance()); // analiz sınırında: bir çağrı daha aşar
    expect(() => heliusCredits.charge('getTransaction', 'analysis')).toThrow(CreditBudgetExceeded);
    expect(() => heliusCredits.charge('getTransaction', 'trading')).not.toThrow();
  });

  it('strateji parametresi doğrulanarak güncellenir', () => {
    strategies.save({
      id: 'abc',
      name: 'x',
      description: '',
      segment: 'memecoin',
      createdAt: 1,
      source: { method: 'manual', wallets: [] },
      entry: { minPoolAgeSec: 0, maxPoolAgeSec: 10, mcapUsdMin: 0, mcapUsdMax: 1, minLiquidityUsd: 0, priceChange5mMin: null, priceChange5mMax: null, minBuySellRatio5m: null, dca: null },
      sizing: { pctOfEquity: 10, maxOpenPositions: 1 },
      exit: { takeProfits: [{ multiple: 2, sellPct: 100 }], stopLossMultiple: 0.5, trailingStopPct: null, maxHoldSec: 60 },
      execution: { slippageBps: 100 },
      evidence: {},
    });
    expect(strategies.setParam('abc', 'exit.stopLossMultiple', 0.7).exit.stopLossMultiple).toBe(0.7);
    expect(() => strategies.setParam('abc', 'exit.stopLossMultiple', 1.5)).toThrow();
    expect(() => strategies.setParam('abc', 'exit.nope', 1)).toThrow(/Geçersiz/);
    strategies.setActive('abc', true);
    expect(strategies.active()).toHaveLength(1);
  });

  it('pozisyon deposu: kısmi satış ve kapanış', () => {
    const id = positionsRepo.open({ strategyId: 's', mode: 'paper', mint: 'm', priceSol: 0.001, costSol: 1, tokens: 1000 });
    positionsRepo.recordSell(id, { tokens: 500, sol: 1, price: 0.002, reason: 'take_profit', tpHits: 1 });
    expect(positionsRepo.get(id)!.status).toBe('open');
    positionsRepo.recordSell(id, { tokens: 500, sol: 2, price: 0.004, reason: 'take_profit', tpHits: 2 });
    const p = positionsRepo.get(id)!;
    expect(p.status).toBe('closed');
    expect(positionsRepo.summary('paper').realizedPnlSol).toBeCloseTo(2);
  });
});
