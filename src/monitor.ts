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

/**
 * Zamanlanmış keşif. Son çalışma zamanı veritabanında tutulur: yeniden başlatmalar ek keşif tetiklemez,
 * ilk keşif açılıştan kısa süre sonra çalışır. Helius uyarısı varken atlanır.
 */
export function maybeRunDiscovery(now = Date.now(), run: () => Promise<unknown> = () => fullPipeline()): boolean {
  const hours = config.DISCOVERY_INTERVAL_HOURS;
  if (hours <= 0 || currentJob()) return false;
  if (heliusAlert.isActive()) return false;
  const last = kv.get<number>('discovery:lastRun', 0);
  if (now - last < hours * 3600_000) return false;
  kv.set('discovery:lastRun', now);
  log.info({ hours }, 'zamanlanmış keşif başlıyor');
  void runJob('zamanlanmış keşif', run);
  return true;
}

export function startMonitor() {
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
