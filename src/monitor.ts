import { config } from './config.js';
import { childLogger } from './core/logger.js';
import { helius, heliusCredits } from './data/helius.js';
import { alertMessage, heliusAlert, heliusKeyId } from './data/heliusAlert.js';
import { events } from './engine/state.js';
import { currentJob, fullPipeline, runJob } from './jobs.js';
import { kv } from './storage/repo.js';

const log = childLogger('monitor');
const TICK_MS = 10 * 60_000;

/**
 * Helius uyarısının durumunu günceller ve gerekiyorsa hatırlatma gönderir.
 * - Anahtar değiştiyse (yeni anahtarla yeniden başlatıldıysa) uyarı kalkar.
 * - Bütçe uyarısı, sayaç sınırın altına inince (yeni ay ya da yeni anahtar) kalkar.
 * - Sunucu tarafı uyarıda ucuz bir deneme isteği atılır; başarılı olursa uyarı kendiliğinden kalkar.
 * - Hâlâ sürüyorsa ALERT_REPEAT_HOURS'ta bir Telegram'a hatırlatma gider.
 */
export async function checkHeliusAlert(now = Date.now(), probe: () => Promise<unknown> = () => helius.rpc('getSlot', [], 'trading')) {
  const s = heliusAlert.get();
  if (!s) return;
  if (s.keyId !== heliusKeyId()) {
    heliusAlert.clear('yeni Helius anahtarı algılandı');
    return;
  }
  if (s.kind === 'budget') {
    if (heliusCredits.used() < heliusCredits.analysisAllowance()) {
      heliusAlert.clear('kredi sayacı sıfırlandı (yeni ay)');
      return;
    }
  } else {
    await probe().catch(() => undefined);
    if (!heliusAlert.get()) return; // deneme başarılı oldu, uyarı kalktı
  }
  const cur = heliusAlert.get()!;
  if (now - cur.lastNotified >= config.ALERT_REPEAT_HOURS * 3600_000) {
    events.emit('notify', alertMessage(cur, true));
    heliusAlert.markNotified();
  }
}

/** Hata ile biten keşiften sonra yeniden denemeden önce beklenecek süre */
export const DISCOVERY_RETRY_MS = 2 * 3600_000;

const K = {
  completed: 'discovery:lastCompleted',
  attempt: 'discovery:lastAttempt',
  running: 'discovery:running',
  legacy: 'discovery:lastRun',
};

function lastCompleted(): number {
  const v = kv.get<number | null>(K.completed, null);
  if (v !== null) return v;
  // eski sürüm sadece başlangıç zamanını tutuyordu: güncellemeden sonra gereksiz ikinci keşif çalışmasın
  return kv.get<number>(K.legacy, 0);
}

/**
 * Açılışta bir kez çağrılır: önceki süreç keşif sürerken kapandıysa (yeniden başlatma, çökme)
 * keşif tamamlanmış sayılmaz ve hemen yeniden çalışabilir.
 */
export function recoverInterruptedDiscovery(): boolean {
  if (!kv.get<boolean>(K.running, false)) return false;
  kv.set(K.running, false);
  kv.set(K.attempt, 0);
  log.warn('önceki keşif yarıda kalmış, yeniden çalışacak');
  events.emit('notify', '🔁 Önceki keşif yarıda kalmıştı (bot yeniden başladı). Keşif yeniden başlatılıyor.');
  return true;
}

/**
 * Zamanlanmış keşif.
 * - Sadece BAŞARIYLA biten keşif sayılır; aralık son başarılı keşfin başlangıcından ölçülür.
 * - Hata ile biten keşif DISCOVERY_RETRY_MS sonra yeniden denenir (sürekli hata kredi tüketmesin).
 * - Yarıda kalan keşif açılışta yeniden çalışır (recoverInterruptedDiscovery).
 * - Helius uyarısı varken ya da başka bir iş çalışırken atlanır.
 */
export function maybeRunDiscovery(now = Date.now(), run: () => Promise<unknown> = () => fullPipeline()): boolean {
  const hours = config.DISCOVERY_INTERVAL_HOURS;
  if (hours <= 0 || currentJob()) return false;
  if (heliusAlert.isActive()) return false;
  if (now - lastCompleted() < hours * 3600_000) return false;
  if (now - kv.get<number>(K.attempt, 0) < Math.min(DISCOVERY_RETRY_MS, hours * 3600_000)) return false;
  kv.set(K.attempt, now);
  log.info({ hours }, 'zamanlanmış keşif başlıyor');
  void runJob('zamanlanmış keşif', async () => {
    kv.set(K.running, true);
    try {
      const r = await run();
      kv.set(K.completed, now);
      return r;
    } finally {
      kv.set(K.running, false);
    }
  });
  return true;
}

export function startMonitor() {
  recoverInterruptedDiscovery();
  const tick = async () => {
    try {
      await checkHeliusAlert();
      maybeRunDiscovery();
    } catch (err) {
      log.warn({ err: String(err) }, 'izleme hatası');
    }
  };
  void tick();
  return setInterval(() => void tick(), TICK_MS);
}
