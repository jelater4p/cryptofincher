import { EventEmitter } from 'node:events';
import { kv } from '../storage/repo.js';

/** Motor durumu: kalıcı (yeniden başlatmada korunur) */
export const engineState = {
  isHalted(): boolean {
    return kv.get('engine:halted', false);
  },
  halt(reason: string) {
    kv.set('engine:halted', true);
    kv.set('engine:haltReason', reason);
    events.emit('notify', `⛔ Motor durduruldu: ${reason}`);
  },
  resume() {
    kv.set('engine:halted', false);
    kv.set('engine:haltReason', null);
    events.emit('notify', '▶️ Motor devam ediyor');
  },
  haltReason(): string | null {
    return kv.get('engine:haltReason', null);
  },
  mode(): 'paper' | 'live' {
    return kv.get('engine:mode', 'paper');
  },
  setMode(m: 'paper' | 'live') {
    kv.set('engine:mode', m);
  },
};

/** Bildirim olayları (Telegram dinler) */
export const events = new EventEmitter();
