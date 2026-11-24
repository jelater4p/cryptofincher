import { kv } from '../storage/repo.js';

/** Zamanlanmış keşfin kalıcı durumu (zamanlayıcı ve günlük özet ortak kullanır) */
export const DISCOVERY_KEYS = {
  completed: 'discovery:lastCompleted',
  attempt: 'discovery:lastAttempt',
  running: 'discovery:running',
  /** eski sürüm: sadece başlangıç zamanı */
  legacy: 'discovery:lastRun',
} as const;

/** Son BAŞARILI keşfin başlangıç zamanı (ms); hiç yoksa 0 */
export function lastDiscoveryCompleted(): number {
  const v = kv.get<number | null>(DISCOVERY_KEYS.completed, null);
  if (v !== null) return v;
  // eski sürüm sadece başlangıç zamanını tutuyordu: güncellemeden sonra gereksiz ikinci keşif çalışmasın
  return kv.get<number>(DISCOVERY_KEYS.legacy, 0);
}

export function isDiscoveryRunning(): boolean {
  return kv.get<boolean>(DISCOVERY_KEYS.running, false);
}
