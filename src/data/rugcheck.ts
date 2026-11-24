import { config } from '../config.js';
import { fetchJson } from '../core/http.js';
import { RateLimiter } from '../core/rateLimiter.js';

const limiter = RateLimiter.perMinute(50);

export interface RugRisk {
  name: string;
  value?: string;
  description?: string;
  score?: number;
  level?: 'info' | 'warn' | 'danger' | string;
}

export interface RugSummary {
  score?: number;
  /** 0-100, yüksek = riskli */
  score_normalised?: number;
  risks?: RugRisk[];
  lpLockedPct?: number;
  tokenProgram?: string;
  tokenType?: string;
}

const cache = new Map<string, { at: number; value: RugSummary }>();
const TTL_MS = 5 * 60_000;

export const rugcheck = {
  async summary(mint: string): Promise<RugSummary> {
    const hit = cache.get(mint);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
    const value = await fetchJson<RugSummary>(`${config.RUGCHECK_BASE_URL}/tokens/${mint}/report/summary`, {
      limiter,
      retries: 2,
      timeoutMs: 10_000,
    });
    cache.set(mint, { at: Date.now(), value });
    return value;
  },
};
