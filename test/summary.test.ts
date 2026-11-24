import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { universe } from '../src/discovery/universe.js';
import { heliusCredits } from '../src/data/helius.js';
import { heliusKeyId } from '../src/data/heliusAlert.js';
import { positionsRepo } from '../src/engine/positionsRepo.js';
import { events } from '../src/engine/state.js';
import { getDb, openDb, setDb } from '../src/storage/db.js';
import { kv, wallets } from '../src/storage/repo.js';
import { buildDailySummary, collectSummaryData, localParts, maybeSendDailySummary } from '../src/summary.js';

let messages: string[] = [];
const onNotify = (m: string) => messages.push(m);

beforeEach(() => {
  setDb(openDb(':memory:'));
  config.DAILY_SUMMARY_HOUR = 9;
  config.SUMMARY_TIMEZONE = 'Europe/Istanbul';
  config.DISCOVERY_INTERVAL_HOURS = 24;
  config.HELIUS_API_KEY = 'anahtar-A';
  messages = [];
  events.on('notify', onNotify);
});
afterEach(() => events.off('notify', onNotify));

describe('saat dilimi', () => {
  it('İstanbul saatini doğru hesaplar (UTC+3)', () => {
    expect(localParts(Date.parse('2026-11-24T06:30:00Z'), 'Europe/Istanbul')).toMatchObject({ date: '2026-11-24', hour: 9 });
  });
  it('gece yarısı geçişinde tarih değişir', () => {
    expect(localParts(Date.parse('2026-11-24T22:30:00Z'), 'Europe/Istanbul')).toMatchObject({ date: '2026-11-25', hour: 1 });
  });
  it('geçersiz saat diliminde UTC kullanır', () => {
    expect(localParts(Date.parse('2026-11-24T06:30:00Z'), 'Gecersiz/Bolge')).toMatchObject({ hour: 6, timeZone: 'UTC' });
  });
});

describe('günlük özet zamanlaması', () => {
  const at = (iso: string) => Date.parse(iso);

  it('saatinden önce göndermez, saatinde bir kez gönderir, ertesi gün tekrar gönderir', () => {
    expect(maybeSendDailySummary(at('2026-11-24T05:50:00Z'))).toBe(false); // 08:50 İstanbul
    expect(maybeSendDailySummary(at('2026-11-24T06:00:00Z'))).toBe(true); // 09:00
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('Günlük özet');
    expect(maybeSendDailySummary(at('2026-11-24T06:10:00Z'))).toBe(false);
    expect(maybeSendDailySummary(at('2026-11-24T18:00:00Z'))).toBe(false);
    expect(maybeSendDailySummary(at('2026-11-25T06:05:00Z'))).toBe(true);
    expect(messages).toHaveLength(2);
  });

  it('bot o saatte kapalıysa aynı gün açılınca gönderir', () => {
    expect(maybeSendDailySummary(at('2026-11-24T11:00:00Z'))).toBe(true); // 14:00 İstanbul
  });

  it('kapalıyken (-1) hiç göndermez', () => {
    config.DAILY_SUMMARY_HOUR = -1;
    expect(maybeSendDailySummary(at('2026-11-24T06:00:00Z'))).toBe(false);
    expect(messages).toHaveLength(0);
  });

  it('kredi farkı sistem saati başka bir aydayken de doğru hesaplanır', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2027-03-15T12:00:00Z'));
    try {
      const key = (used: number) => kv.set(`helius_credits:${heliusCredits.period()}:${heliusKeyId()}`, used);
      key(200);
      maybeSendDailySummary(at('2027-03-15T06:00:00Z'));
      key(900);
      expect(collectSummaryData(at('2027-03-16T06:00:00Z')).credits.sinceLastSummary).toBe(700);
    } finally {
      vi.useRealTimers();
    }
  });

  it('kredi farkını bir önceki günlük özete göre hesaplar', () => {
    // sayaç gerçek saatin ayını kullanır: test hangi tarihte çalışırsa çalışsın aynı anahtar
    const key = (used: number) => kv.set(`helius_credits:${heliusCredits.period()}:${heliusKeyId()}`, used);
    key(1000);
    maybeSendDailySummary(at('2026-11-24T06:00:00Z'));
    key(4500);
    const d = collectSummaryData(at('2026-11-25T06:00:00Z'));
    expect(d.credits.used).toBe(4500);
    expect(d.credits.sinceLastSummary).toBe(3500);
    expect(buildDailySummary(d)).toContain('son özetten beri +3,500');
  });
});

describe('özet içeriği', () => {
  it('veritabanındaki kayıtlardan doğru sayıları çıkarır', () => {
    const now = Date.now();
    // dün kapanan kazançlı, 3 gün önce kapanan zararlı paper işlem; bir açık pozisyon
    const win = positionsRepo.open({ strategyId: 's', mode: 'paper', mint: 'a', priceSol: 1, costSol: 1, tokens: 1 });
    positionsRepo.recordSell(win, { tokens: 1, sol: 1.5, price: 1.5, reason: 'take_profit', tpHits: 1 });
    const loss = positionsRepo.open({ strategyId: 's', mode: 'paper', mint: 'b', priceSol: 1, costSol: 1, tokens: 1 });
    positionsRepo.recordSell(loss, { tokens: 1, sol: 0.4, price: 0.4, reason: 'stop_loss', tpHits: 0 });
    getDb().prepare('UPDATE positions SET closed_at = ? WHERE id = ?').run(now - 3 * 86400_000, loss);
    positionsRepo.open({ strategyId: 's', mode: 'paper', mint: 'c', priceSol: 1, costSol: 0.5, tokens: 1 });
    wallets.add('W1', 'discovered');
    wallets.add('W2', 'manual');
    wallets.markAnalyzed('W1', null);
    universe.insertMany([{ mint: 'u1', pool: 'p1', dex: null, createdAt: now, supply: 1, initialFdvUsd: 1, recordedAt: now }]);
    kv.set('discovery:lastCompleted', now - 5 * 3600_000);

    const d = collectSummaryData(now);
    expect(d.paper).toMatchObject({ closed24h: 1, wins24h: 1, closedTotal: 2, winsTotal: 1 });
    expect(d.paper.pnl24h).toBeCloseTo(0.5);
    expect(d.paper.pnlTotal).toBeCloseTo(-0.1);
    expect(d.live).toBeNull();
    expect(d.open).toEqual({ count: 1, costSol: 0.5 });
    expect(d.wallets).toEqual({ total: 2, eligible: 0, analyzed24h: 1 });
    expect(d.universe).toEqual({ added24h: 1, total: 1 });

    const text = buildDailySummary(d);
    expect(text).toContain('1 işlem kapandı, 1 kazanç, PnL +0.5000 SOL');
    expect(text).toContain('2 işlem, kazanma %50, PnL -0.1000 SOL');
    expect(text).toContain('Açık pozisyon: 1 (0.500 SOL maliyet)');
    expect(text).toContain('son başarılı 5 saat önce, sonraki ~19 saat sonra');
    expect(text).toContain('Aktif strateji: yok');
    expect(text).not.toContain('Canlı');
    expect(text).toContain('Helius: ✅ normal');
  });

  it('tarafsız evren hiç büyümüyorsa uyarır', () => {
    const text = buildDailySummary(collectSummaryData());
    expect(text).toContain('kayıt çalışmıyor olabilir');
  });
});
