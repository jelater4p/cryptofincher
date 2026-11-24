import bs58 from 'bs58';
import WebSocket from 'ws';
import { config } from '../config.js';
import { PUMPFUN_PROGRAM } from '../core/constants.js';
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

/**
 * Helius WebSocket üzerinden yeni pump.fun tokenlarını dinler (logsSubscribe).
 * Not: pump.fun programı çok yoğun; bant genişliği yüksektir. Bu yüzden varsayılan kapalıdır (PUMPFUN_STREAM=true ile açılır).
 */
export function startPumpfunStream(onCreate: (e: PumpCreateEvent) => void): () => void {
  let ws: WebSocket | null = null;
  let stopped = false;
  let retry = 0;

  const connect = () => {
    ws = new WebSocket(config.heliusWsUrl);
    ws.on('open', () => {
      retry = 0;
      ws!.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'logsSubscribe',
          params: [{ mentions: [PUMPFUN_PROGRAM] }, { commitment: 'confirmed' }],
        }),
      );
      log.info('pump.fun akışı bağlandı');
    });
    const ping = setInterval(() => ws?.readyState === WebSocket.OPEN && ws.ping(), 30_000);
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        const logs: string[] | undefined = msg?.params?.result?.value?.logs;
        if (!logs || msg.params.result.value.err) return;
        if (!logs.some((l) => /Instruction: Create/.test(l))) return;
        for (const l of logs) {
          if (!l.startsWith('Program data: ')) continue;
          const ev = decodeCreateEvent(l.slice('Program data: '.length));
          if (ev && ev.mint.endsWith('pump')) {
            onCreate(ev);
            break;
          }
        }
      } catch {
        /* yoksay */
      }
    });
    ws.on('close', () => {
      clearInterval(ping);
      if (stopped) return;
      const wait = Math.min(30_000, 1000 * 2 ** retry++);
      log.warn({ wait }, 'pump.fun akışı koptu, yeniden bağlanılıyor');
      setTimeout(connect, wait);
    });
    ws.on('error', (err) => log.warn({ err: String(err) }, 'ws hatası'));
  };
  connect();
  return () => {
    stopped = true;
    ws?.close();
  };
}
