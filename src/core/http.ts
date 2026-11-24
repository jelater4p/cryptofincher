import { RateLimiter } from './rateLimiter.js';
import { childLogger } from './logger.js';

const log = childLogger('http');

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly body: string,
  ) {
    super(`HTTP ${status} ${redact(url)}: ${body.slice(0, 200)}`);
  }
}

/** URL içindeki api-key'i loglara yazmamak için */
export function redact(url: string) {
  return url.replace(/(api-key|apikey|key)=[^&]+/gi, '$1=***');
}

export interface FetchJsonOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  headers?: Record<string, string>;
  limiter?: RateLimiter;
  retries?: number;
  timeoutMs?: number;
  /** true dönerse yeniden denenmez (örn. kredi bittiğinde 429'u tekrar denemek boşuna) */
  noRetryIf?: (status: number, body: string) => boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Hız sınırı, timeout ve üstel geri çekilme ile JSON isteği.
 * 429 ve 5xx hatalarında yeniden dener, 4xx'te dener değil.
 */
export async function fetchJson<T>(url: string, opts: FetchJsonOptions = {}): Promise<T> {
  const retries = opts.retries ?? 4;
  let attempt = 0;
  for (;;) {
    if (opts.limiter) await opts.limiter.acquire();
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20_000);
    try {
      const res = await fetch(url, {
        method: opts.method ?? (opts.body ? 'POST' : 'GET'),
        headers: {
          accept: 'application/json',
          ...(opts.body ? { 'content-type': 'application/json' } : {}),
          ...opts.headers,
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const retryable = (res.status === 429 || res.status >= 500) && !opts.noRetryIf?.(res.status, text);
        if (retryable && attempt < retries) {
          const ra = Number(res.headers.get('retry-after'));
          const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 500 * 2 ** attempt;
          log.debug({ status: res.status, url: redact(url), wait }, 'yeniden deneniyor');
          attempt++;
          await sleep(wait);
          continue;
        }
        throw new HttpError(res.status, url, text);
      }
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (attempt < retries) {
        attempt++;
        await sleep(500 * 2 ** attempt);
        continue;
      }
      throw err;
    } finally {
      clearTimeout(t);
    }
  }
}
