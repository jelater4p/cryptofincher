import bs58 from 'bs58';
import WebSocket from 'ws';
import { config } from '../config.js';
import { PUMPFUN_MINT_AUTHORITY, PUMPFUN_PROGRAM } from '../core/constants.js';
import { childLogger } from '../core/logger.js';

const log = childLogger('pumpfun');

export interface PumpCreateEvent {
  name: string;
  symbol: string;
  uri: string;
  mint: string;
  bondingCurve: string;
  creator: string;
}

/**
 * pump.fun CreateEvent (Anchor event) çözümü: 8 bayt ayırıcı + name/symbol/uri (u32 uzunluk + utf8)
 * + mint + bondingCurve + user (32'şer bayt). Sonraki alanlar sürüme göre değişebildiği için okunmaz.
 */
export function decodeCreateEvent(base64: string): PumpCreateEvent | null {
  try {
    const buf = Buffer.from(base64, 'base64');
    let o = 8;
    const str = () => {
      const len = buf.readUInt32LE(o);
      o += 4;
      if (len > 512) throw new Error('geçersiz uzunluk');
      const s = buf.subarray(o, o + len).toString('utf8');
      o += len;
      return s;
    };
    const key = () => {
      const k = bs58.encode(buf.subarray(o, o + 32));
      o += 32;
      return k;
    };
    const name = str();
    const symbol = str();
    const uri = str();
    const mint = key();
    const bondingCurve = key();
    const creator = key();
    if (o > buf.length) return null;
    return { name, symbol, uri, mint, bondingCurve, creator };
  } catch {
    return null;
  }
}

/** Bir işlemin loglarından yeni token oluşturma olayını çıkarır (create ve create_v2) */
export function extractCreate(logs: string[]): PumpCreateEvent | null {
  if (!logs.some((l) => l.includes('Instruction: Create'))) return null;
  for (const l of logs) {
    if (!l.startsWith('Program data: ')) continue;
    const ev = decodeCreateEvent(l.slice('Program data: '.length));
    // aynı işlemde başka olaylar da olabilir (örn. ilk alım): sadece tutarlı bir oluşturma olayı kabul edilir
    if (ev && ev.mint.endsWith('pump') && ev.symbol.length <= 64 && ev.name.length <= 128) return ev;
  }
  return null;
}

export type StreamMode = 'light' | 'full';

/** Hafif mod bu sürede hiç token göremezse tam moda geçilir; tam modda da göremezse bir kez uyarılır */
export const STREAM_WATCH_MS = 10 * 60_000;

/**
 * Akış bekçisi (ağdan bağımsız, test edilebilir). Bağlantıdan sonra STREAM_WATCH_MS içinde
 * hiç yeni token çözülemezse ne yapılacağına karar verir.
 */
export class StreamWatch {
  mode: StreamMode;
  connectedAt: number | null = null;
  messagesSinceConnect = 0;
  createsSinceConnect = 0;
  warnedNoCreates = false;
  /** son 24 saatteki oluşturma zamanları */
  private createTimes: number[] = [];

  constructor(mode: StreamMode = 'light') {
    this.mode = mode;
  }

  onConnect(now: number) {
    this.connectedAt = now;
    this.messagesSinceConnect = 0;
    this.createsSinceConnect = 0;
  }

  onDisconnect() {
    this.connectedAt = null;
  }

  onMessage() {
    this.messagesSinceConnect++;
  }

  onCreate(now: number) {
    this.createsSinceConnect++;
    this.createTimes.push(now);
    const cutoff = now - 86400_000;
    if (this.createTimes.length > 1000 && this.createTimes[0]! < cutoff) {
      this.createTimes = this.createTimes.filter((t) => t >= cutoff);
    }
  }

  countSince(ms: number): number {
    let n = 0;
    for (let i = this.createTimes.length - 1; i >= 0 && this.createTimes[i]! >= ms; i--) n++;
    return n;
  }

  /** 'switch_full': hafif mod çalışmıyor, tam moda geç; 'warn': tam modda da token çözülemiyor */
  check(now: number): 'switch_full' | 'warn' | null {
    if (this.connectedAt === null || now - this.connectedAt < STREAM_WATCH_MS || this.createsSinceConnect > 0) return null;
    if (this.mode === 'light') return 'switch_full';
    if (!this.warnedNoCreates) {
      this.warnedNoCreates = true;
      return 'warn';
    }
    return null;
  }
}

let activeWatch: StreamWatch | null = null;

export interface PumpfunStreamStats {
  enabled: boolean;
  connected: boolean;
  mode: StreamMode | null;
  createsLast10m: number;
  createsLast24h: number;
}

export function pumpfunStreamStats(now = Date.now()): PumpfunStreamStats {
  if (!activeWatch) return { enabled: false, connected: false, mode: null, createsLast10m: 0, createsLast24h: 0 };
  return {
    enabled: true,
    connected: activeWatch.connectedAt !== null,
    mode: activeWatch.mode,
    createsLast10m: activeWatch.countSince(now - 10 * 60_000),
    createsLast24h: activeWatch.countSince(now - 86400_000),
  };
}

/**
 * Helius WebSocket üzerinden yeni pump.fun tokenlarını dinler (logsSubscribe).
 * - Hafif mod: sadece token basma yetkilisinin geçtiği işlemler, yani neredeyse yalnızca yeni token oluşturmalar.
 * - Tam mod: pump.fun programının tüm işlemleri (her alım-satım dahil, bant genişliği yüksek).
 * Hafif mod 10 dakika içinde hiç token göremezse otomatik olarak tam moda geçer.
 */
export function startPumpfunStream(
  onCreate: (e: PumpCreateEvent) => void,
  notify: (msg: string) => void = () => {},
): () => void {
  const watch = new StreamWatch('light');
  activeWatch = watch;
  let ws: WebSocket | null = null;
  let stopped = false;
  let retry = 0;

  const connect = () => {
    const mention = watch.mode === 'light' ? PUMPFUN_MINT_AUTHORITY : PUMPFUN_PROGRAM;
    ws = new WebSocket(config.heliusWsUrl);
    ws.on('open', () => {
      retry = 0;
      watch.onConnect(Date.now());
      ws!.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'logsSubscribe',
          params: [{ mentions: [mention] }, { commitment: 'confirmed' }],
        }),
      );
      log.info({ mode: watch.mode }, 'pump.fun akışı bağlandı');
    });
    const ping = setInterval(() => ws?.readyState === WebSocket.OPEN && ws.ping(), 30_000);
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        const value = msg?.params?.result?.value;
        if (!value) return;
        watch.onMessage();
        if (value.err || !Array.isArray(value.logs)) return;
        const ev = extractCreate(value.logs);
        if (ev) {
          watch.onCreate(Date.now());
          onCreate(ev);
        }
      } catch {
        /* yoksay */
      }
    });
    ws.on('close', () => {
      clearInterval(ping);
      watch.onDisconnect();
      if (stopped) return;
      const wait = Math.min(30_000, 1000 * 2 ** retry++);
      log.warn({ wait }, 'pump.fun akışı koptu, yeniden bağlanılıyor');
      setTimeout(connect, wait);
    });
    ws.on('error', (err) => log.warn({ err: String(err) }, 'ws hatası'));
  };

  const watchdog = setInterval(() => {
    const action = watch.check(Date.now());
    if (action === 'switch_full') {
      log.warn('hafif modda 10 dakikadır yeni token görülmedi, tam moda geçiliyor');
      notify('ℹ️ pump.fun akışı hafif modda yeni token göremedi; pump.fun\'ın tüm işlemlerini dinleyen tam moda geçildi (daha yüksek bant genişliği).');
      watch.mode = 'full';
      ws?.close(); // kapanınca yeni modla yeniden bağlanır
    } else if (action === 'warn') {
      log.warn({ messages: watch.messagesSinceConnect }, 'tam modda da yeni token çözülemiyor');
      notify(
        watch.messagesSinceConnect > 0
          ? '⚠️ pump.fun akışı veri alıyor ama 10 dakikadır yeni token çözülemedi. pump.fun veri formatı değişmiş olabilir; tarama DexScreener ve yeni havuz listesiyle devam ediyor.'
          : '⚠️ pump.fun akışı bağlı ama hiç veri gelmiyor. Helius WebSocket erişimini kontrol et; tarama DexScreener ve yeni havuz listesiyle devam ediyor.',
      );
    }
  }, 60_000);

  connect();
  return () => {
    stopped = true;
    clearInterval(watchdog);
    activeWatch = null;
    ws?.close();
  };
}
