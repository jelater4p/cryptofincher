import { config } from '../config.js';
import { fetchJson } from '../core/http.js';
import { RateLimiter } from '../core/rateLimiter.js';

const limiter = RateLimiter.perMinute(config.JUPITER_RPM);

const headers = (): Record<string, string> => (config.JUPITER_API_KEY ? { 'x-api-key': config.JUPITER_API_KEY } : {});

export interface JupOrder {
  requestId?: string;
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  /** Jupiter bazı sürümlerde priceImpactPct (string), bazılarında priceImpact (number) döner */
  priceImpactPct?: string;
  priceImpact?: number;
  slippageBps?: number;
  /** taker verilmezse null */
  transaction?: string | null;
  lastValidBlockHeight?: number | string;
  errorMessage?: string;
  error?: string;
}

export interface JupExecuteResult {
  status: 'Success' | 'Failed' | string;
  signature?: string;
  code?: number;
  error?: string;
  inputAmountResult?: string;
  outputAmountResult?: string;
  totalInputAmount?: string;
  totalOutputAmount?: string;
}

export interface JupPrice {
  usdPrice: number;
  decimals?: number;
  priceChange24h?: number;
}

export function priceImpactPercent(o: JupOrder): number {
  if (typeof o.priceImpact === 'number') return Math.abs(o.priceImpact);
  if (o.priceImpactPct) return Math.abs(Number(o.priceImpactPct) * 100);
  return 0;
}

export const jupiter = {
  /**
   * Swap V2 /order. `amount` atomik birimde (lamport / token taban birimi).
   * `taker` verilirse imzalanmaya hazır işlem döner; verilmezse sadece fiyat teklifi (paper mod için ideal).
   */
  async order(p: { inputMint: string; outputMint: string; amount: bigint | string; taker?: string; slippageBps?: number }) {
    const q = new URLSearchParams({ inputMint: p.inputMint, outputMint: p.outputMint, amount: String(p.amount) });
    if (p.taker) q.set('taker', p.taker);
    if (p.slippageBps !== undefined) q.set('slippageBps', String(p.slippageBps));
    const res = await fetchJson<JupOrder>(`${config.JUPITER_BASE_URL}/swap/v2/order?${q}`, {
      limiter,
      headers: headers(),
      retries: 2,
    });
    if (res.errorMessage || res.error) throw new Error(`Jupiter order: ${res.errorMessage ?? res.error}`);
    return res;
  },

  /** İmzalı işlemi Jupiter'in yönetilen gönderimine iletir. Aynı istekle tekrar çağırmak güvenli (çift işlem olmaz). */
  async execute(signedTransaction: string, requestId: string) {
    return fetchJson<JupExecuteResult>(`${config.JUPITER_BASE_URL}/swap/v2/execute`, {
      body: { signedTransaction, requestId },
      limiter,
      headers: headers(),
      retries: 1,
      timeoutMs: 60_000,
    });
  },

  async prices(mints: string[]): Promise<Record<string, JupPrice>> {
    const out: Record<string, JupPrice> = {};
    for (let i = 0; i < mints.length; i += 50) {
      const chunk = mints.slice(i, i + 50);
      const res = await fetchJson<Record<string, JupPrice | null>>(
        `${config.JUPITER_BASE_URL}/price/v3?ids=${chunk.join(',')}`,
        { limiter, headers: headers() },
      );
      for (const [k, v] of Object.entries(res ?? {})) if (v) out[k] = v;
    }
    return out;
  },
};
