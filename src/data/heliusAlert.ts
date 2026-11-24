import crypto from 'node:crypto';
import { config } from '../config.js';
import { childLogger } from '../core/logger.js';
import { events } from '../engine/state.js';
import { kv } from '../storage/repo.js';

const log = childLogger('helius-alert');

/**
 * budget: botun kendi aylık kredi sayacı doldu (analiz durur, işlemler %5 rezervle sürer)
 * quota:  Helius isteği reddediyor (kredi/limit bitti)
 * auth:   anahtar geçersiz, tanımsız ya da yetkisiz
 */
export type HeliusAlertKind = 'budget' | 'quota' | 'auth';

export interface HeliusAlertState {
  kind: HeliusAlertKind;
  detail: string;
  since: number;
  lastNotified: number;
  /** uyarının hangi anahtar için verildiği: anahtar değişince uyarı kalkar */
  keyId: string;
}

const KEY = 'alert:helius';

/** Anahtarın kendisini saklamadan tanımak için kısa özet */
export function heliusKeyId(): string {
  const src = config.HELIUS_RPC_URL ?? config.HELIUS_API_KEY;
  return crypto.createHash('sha256').update(src).digest('hex').slice(0, 8);
}

const TITLES: Record<HeliusAlertKind, string> = {
  budget: 'Helius aylık kredi bütçesi doldu (botun sayacı)',
  quota: 'Helius istekleri reddediyor: kredi ya da limit bitti',
  auth: 'Helius API anahtarı geçersiz ya da yetkisiz',
};

const IMPACT: Record<HeliusAlertKind, string> = {
  budget: 'Keşif ve cüzdan analizi durdu. İşlem motoru ayrılmış %5 kredi ile çalışmaya devam ediyor.',
  quota:
    'Keşif, analiz ve token güvenlik kontrolleri çalışmıyor: yeni alım yapılmaz. Açık pozisyonların satışı Jupiter üzerinden denenmeye devam eder.',
  auth: 'Helius kullanan hiçbir özellik çalışmıyor: yeni alım yapılmaz. Açık pozisyonların satışı Jupiter üzerinden denenmeye devam eder.',
};

const HOWTO = [
  'Yeni anahtar girmek için VPS\'te:',
  '1) cd ~/cryptofincher && nano .env',
  '2) HELIUS_API_KEY= satırına yeni anahtarı yaz, Ctrl+O, Enter, Ctrl+X',
  '3) docker compose up -d --force-recreate',
].join('\n');

const fmtSince = (ms: number) => {
  const min = Math.round((Date.now() - ms) / 60_000);
  return min < 90 ? `${min} dk` : `${(min / 60).toFixed(1)} saat`;
};

export function alertMessage(s: HeliusAlertState, reminder: boolean): string {
  return [
    `${reminder ? '🔁 HATIRLATMA: ' : ''}⛔ ${TITLES[s.kind]}`,
    `Ayrıntı: ${s.detail}`,
    `Süre: ${fmtSince(s.since)}`,
    '',
    IMPACT[s.kind],
    '',
    HOWTO,
  ].join('\n');
}

export const heliusAlert = {
  get(): HeliusAlertState | null {
    return kv.get<HeliusAlertState | null>(KEY, null);
  },

  isActive(kind?: HeliusAlertKind): boolean {
    const s = this.get();
    return !!s && (!kind || s.kind === kind);
  },

  /** Uyarıyı başlatır. Aynı anahtar için zaten aktifse tekrar mesaj atmaz (hatırlatmaları döngü yapar). */
  raise(kind: HeliusAlertKind, detail: string) {
    const cur = this.get();
    const keyId = heliusKeyId();
    if (cur && cur.keyId === keyId) {
      // daha ağır tür öncelikli: auth > quota > budget
      const rank = { budget: 0, quota: 1, auth: 2 };
      if (rank[kind] > rank[cur.kind]) kv.set(KEY, { ...cur, kind, detail });
      return;
    }
    const s: HeliusAlertState = { kind, detail, since: Date.now(), lastNotified: Date.now(), keyId };
    kv.set(KEY, s);
    log.warn({ kind, detail }, 'Helius uyarısı');
    events.emit('notify', alertMessage(s, false));
  },

  clear(reason: string) {
    const cur = this.get();
    if (!cur) return;
    kv.set(KEY, null);
    log.info({ reason }, 'Helius uyarısı kalktı');
    events.emit('notify', `✅ Helius tekrar kullanılabilir: ${reason}`);
  },

  markNotified() {
    const cur = this.get();
    if (cur) kv.set(KEY, { ...cur, lastNotified: Date.now() });
  },
};
