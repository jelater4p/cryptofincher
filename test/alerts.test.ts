import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../src/config.js';
import { CreditBudgetExceeded, helius, heliusCredits, HeliusLimitError, HeliusQuotaError } from '../src/data/helius.js';
import { heliusAlert, heliusKeyId } from '../src/data/heliusAlert.js';
import { events } from '../src/engine/state.js';
import { checkHeliusAlert, DISCOVERY_RETRY_MS, maybeRunDiscovery, recoverInterruptedDiscovery } from '../src/monitor.js';
import { openDb, setDb } from '../src/storage/db.js';
import { kv } from '../src/storage/repo.js';

let messages: string[] = [];
const onNotify = (m: string) => messages.push(m);
const HOUR = 3600_000;

beforeEach(() => {
  setDb(openDb(':memory:'));
  config.HELIUS_API_KEY = 'anahtar-A';
  config.ALERT_REPEAT_HOURS = 2;
  config.DISCOVERY_INTERVAL_HOURS = 24;
  messages = [];
  events.on('notify', onNotify);
});

afterEach(() => {
  events.off('notify', onNotify);
  vi.unstubAllGlobals();
});

const failingProbe = () => Promise.reject(new Error('hâlâ kapalı'));

describe('Helius limit uyarısı', () => {
  it('ilk seferde bir kez bildirir, aynı anahtar için tekrar tekrar mesaj atmaz', () => {
    heliusAlert.raise('quota', 'max usage reached');
    heliusAlert.raise('quota', 'max usage reached');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('kredi ya da limit bitti');
    expect(messages[0]).toContain('docker compose up -d --force-recreate');
  });

  it('sürdükçe ALERT_REPEAT_HOURS aralıklarla hatırlatır', async () => {
    heliusAlert.raise('quota', 'max usage reached');
    const t0 = heliusAlert.get()!.lastNotified;
    await checkHeliusAlert(t0 + 1 * HOUR, failingProbe);
    expect(messages).toHaveLength(1);
    await checkHeliusAlert(t0 + 2 * HOUR + 1, failingProbe);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toContain('HATIRLATMA');
    // hatırlatma sonrası sayaç yeniden başlar
    const t1 = heliusAlert.get()!.lastNotified;
    await checkHeliusAlert(t1 + 1 * HOUR, failingProbe);
    expect(messages).toHaveLength(2);
  });

  it('yeni anahtarla açılınca uyarı kalkar', async () => {
    heliusAlert.raise('auth', 'HTTP 401');
    config.HELIUS_API_KEY = 'anahtar-B';
    await checkHeliusAlert(Date.now(), failingProbe);
    expect(heliusAlert.get()).toBeNull();
    expect(messages.at(-1)).toContain('yeni Helius anahtarı');
  });

  it('deneme isteği başarılı olursa (limit sıfırlandıysa) uyarı kalkar', async () => {
    heliusAlert.raise('quota', 'max usage reached');
    await checkHeliusAlert(Date.now(), async () => heliusAlert.clear('Helius istekleri tekrar yanıtlanıyor'));
    expect(heliusAlert.get()).toBeNull();
    expect(messages.at(-1)).toContain('✅');
  });
});

describe('kredi sayacı anahtar başına', () => {
  it('bütçe dolunca uyarır; yeni anahtar sıfırdan başlar', async () => {
    const month = new Date().toISOString().slice(0, 7);
    kv.set(`helius_credits:${month}:${heliusKeyId()}`, heliusCredits.analysisAllowance());
    expect(() => heliusCredits.charge('getTransaction', 'analysis')).toThrow(CreditBudgetExceeded);
    expect(heliusAlert.get()?.kind).toBe('budget');

    config.HELIUS_API_KEY = 'anahtar-B';
    expect(heliusCredits.used()).toBe(0);
    expect(() => heliusCredits.charge('getTransaction', 'analysis')).not.toThrow();
    await checkHeliusAlert(Date.now(), failingProbe);
    expect(heliusAlert.get()).toBeNull();
  });
});

describe('Helius cevaplarının tanınması', () => {
  const respond = (status: number, body: unknown) =>
    vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));

  it('kredi bitti (429 + mesaj): yeniden denemez, kota uyarısı verir', async () => {
    const f = respond(429, '{"jsonrpc":"2.0","error":{"code":-32429,"message":"max usage reached"}}');
    vi.stubGlobal('fetch', f);
    await expect(helius.rpc('getSlot', [], 'trading')).rejects.toBeInstanceOf(HeliusQuotaError);
    expect(f).toHaveBeenCalledTimes(1);
    expect(heliusAlert.get()?.kind).toBe('quota');
  });

  it('geçersiz anahtar (401): anahtar uyarısı verir', async () => {
    vi.stubGlobal('fetch', respond(401, 'Unauthorized'));
    await expect(helius.rpc('getSlot', [], 'trading')).rejects.toBeInstanceOf(HeliusLimitError);
    expect(heliusAlert.get()?.kind).toBe('auth');
  });

  it('JSON-RPC içinde kredi hatası: kota uyarısı verir', async () => {
    vi.stubGlobal('fetch', respond(200, { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'Out of credits, upgrade your plan' } }));
    await expect(helius.rpc('getSlot', [], 'trading')).rejects.toBeInstanceOf(HeliusQuotaError);
    expect(heliusAlert.get()?.kind).toBe('quota');
  });

  it('istekler tekrar başarılı olunca kota uyarısı kendiliğinden kalkar', async () => {
    heliusAlert.raise('quota', 'max usage reached');
    vi.stubGlobal('fetch', respond(200, { jsonrpc: '2.0', id: 1, result: 123 }));
    await expect(helius.rpc('getSlot', [], 'trading')).resolves.toBe(123);
    expect(heliusAlert.get()).toBeNull();
    expect(messages.at(-1)).toContain('✅');
  });

  it('anahtar boşsa anahtar uyarısı verir', async () => {
    config.HELIUS_API_KEY = '';
    await expect(helius.rpc('getSlot', [], 'trading')).rejects.toBeInstanceOf(HeliusLimitError);
    expect(heliusAlert.get()?.kind).toBe('auth');
  });
});

describe('zamanlanmış keşif', () => {
  const flush = () => new Promise((r) => setImmediate(r));

  it('açılışta çalışır, aralık dolmadan tekrar çalışmaz (yeniden başlatma dahil)', async () => {
    const run = vi.fn(async () => undefined);
    const t0 = 1_000_000_000_000;
    expect(maybeRunDiscovery(t0, run)).toBe(true);
    await flush();
    expect(maybeRunDiscovery(t0 + 23 * HOUR, run)).toBe(false);
    expect(maybeRunDiscovery(t0 + 24 * HOUR, run)).toBe(true);
    await flush();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('Helius uyarısı varken atlanır, kapalıyken hiç çalışmaz', () => {
    const run = vi.fn(async () => undefined);
    heliusAlert.raise('quota', 'x');
    expect(maybeRunDiscovery(Date.now(), run)).toBe(false);
    heliusAlert.clear('test');
    config.DISCOVERY_INTERVAL_HOURS = 0;
    expect(maybeRunDiscovery(Date.now(), run)).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('hata ile biten keşif tamamlanmış sayılmaz; 2 saat sonra yeniden denenir', async () => {
    const run = vi.fn(async () => {
      throw new Error('ağ hatası');
    });
    const t0 = 1_000_000_000_000;
    expect(maybeRunDiscovery(t0, run)).toBe(true);
    await flush();
    expect(maybeRunDiscovery(t0 + 1 * HOUR, run)).toBe(false);
    expect(maybeRunDiscovery(t0 + DISCOVERY_RETRY_MS, run)).toBe(true);
    await flush();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('keşif sürerken bot kapandıysa açılışta yeniden çalışır', async () => {
    const t0 = 1_000_000_000_000;
    // önceki sürecin veritabanında bıraktığı durum: keşif başlamış, hiç bitmemiş
    kv.set('discovery:lastAttempt', t0);
    kv.set('discovery:running', true);
    // kurtarma olmadan 2 saatlik bekleme yüzünden çalışmazdı
    const run = vi.fn(async () => undefined);
    expect(maybeRunDiscovery(t0 + 5 * 60_000, run)).toBe(false);

    expect(recoverInterruptedDiscovery()).toBe(true);
    expect(messages.at(-1)).toContain('yarıda kalmıştı');
    expect(maybeRunDiscovery(t0 + 5 * 60_000, run)).toBe(true);
    await flush();
    expect(run).toHaveBeenCalledTimes(1);
    expect(kv.get('discovery:running', true)).toBe(false);
    // normal açılışta (yarıda kalan iş yoksa) bir şey yapmaz
    expect(recoverInterruptedDiscovery()).toBe(false);
  });

  it('eski sürümden kalan kayıt dikkate alınır: güncelleme sonrası ikinci keşif çalışmaz', () => {
    const t0 = 1_000_000_000_000;
    kv.set('discovery:lastRun', t0);
    const run = vi.fn(async () => undefined);
    expect(maybeRunDiscovery(t0 + 3 * HOUR, run)).toBe(false);
    expect(maybeRunDiscovery(t0 + 24 * HOUR, run)).toBe(true);
  });
});
