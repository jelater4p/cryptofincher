import { config } from '../config.js';
import { fetchJson } from '../core/http.js';
import { RateLimiter } from '../core/rateLimiter.js';
import type { TokenInfo } from '../core/types.js';
import { SOL_MINT } from '../core/constants.js';

/** DexScreener limitleri: pair/token uç noktaları 300/dk, profil/boost 60/dk */
const pairLimiter = RateLimiter.perMinute(280);
const profileLimiter = RateLimiter.perMinute(55);

export interface DexPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceNative?: string;
  priceUsd?: string;
  txns?: Record<'m5' | 'h1' | 'h6' | 'h24', { buys: number; sells: number }>;
  volume?: Partial<Record<'m5' | 'h1' | 'h6' | 'h24', number>>;
  priceChange?: Partial<Record<'m5' | 'h1' | 'h6' | 'h24', number>>;
  liquidity?: { usd?: number; base?: number; quote?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
}

export interface DexTokenRef {
  chainId: string;
  tokenAddress: string;
  amount?: number;
  totalAmount?: number;
}

const base = () => config.DEXSCREENER_BASE_URL;

export function pairToTokenInfo(p: DexPair): TokenInfo {
  const quoteIsSol = p.quoteToken.address === SOL_MINT;
  return {
    mint: p.baseToken.address,
    symbol: p.baseToken.symbol,
    name: p.baseToken.name,
    pairAddress: p.pairAddress,
    dexId: p.dexId,
    pairCreatedAt: p.pairCreatedAt,
    priceUsd: p.priceUsd ? Number(p.priceUsd) : undefined,
    priceSol: quoteIsSol && p.priceNative ? Number(p.priceNative) : undefined,
    liquidityUsd: p.liquidity?.usd,
    marketCapUsd: p.marketCap,
    fdvUsd: p.fdv,
    volumeH1: p.volume?.h1,
    volumeH24: p.volume?.h24,
    priceChangeM5: p.priceChange?.m5,
    priceChangeH1: p.priceChange?.h1,
    priceChangeH24: p.priceChange?.h24,
    buysM5: p.txns?.m5?.buys,
    sellsM5: p.txns?.m5?.sells,
    buysH1: p.txns?.h1?.buys,
    sellsH1: p.txns?.h1?.sells,
  };
}

/** Bir token için en likit Solana çiftini seçer */
export function bestPair(pairs: DexPair[], mint: string): DexPair | undefined {
  return pairs
    .filter((p) => p.chainId === 'solana' && p.baseToken.address === mint)
    .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
}

export const dexscreener = {
  /** En fazla 30 adres/istek; fazlası otomatik bölünür */
  async tokens(mints: string[]): Promise<Map<string, TokenInfo>> {
    const out = new Map<string, TokenInfo>();
    for (let i = 0; i < mints.length; i += 30) {
      const chunk = mints.slice(i, i + 30);
      const pairs = await fetchJson<DexPair[]>(`${base()}/tokens/v1/solana/${chunk.join(',')}`, {
        limiter: pairLimiter,
      });
      for (const mint of chunk) {
        const p = bestPair(pairs ?? [], mint);
        if (p) out.set(mint, pairToTokenInfo(p));
      }
    }
    return out;
  },

  async tokenPairs(mint: string): Promise<DexPair[]> {
    return fetchJson<DexPair[]>(`${base()}/token-pairs/v1/solana/${mint}`, { limiter: pairLimiter });
  },

  async latestProfiles(): Promise<DexTokenRef[]> {
    const r = await fetchJson<DexTokenRef[]>(`${base()}/token-profiles/latest/v1`, { limiter: profileLimiter });
    return (r ?? []).filter((t) => t.chainId === 'solana');
  },

  async latestBoosts(): Promise<DexTokenRef[]> {
    const r = await fetchJson<DexTokenRef[]>(`${base()}/token-boosts/latest/v1`, { limiter: profileLimiter });
    return (r ?? []).filter((t) => t.chainId === 'solana');
  },

  async topBoosts(): Promise<DexTokenRef[]> {
    const r = await fetchJson<DexTokenRef[]>(`${base()}/token-boosts/top/v1`, { limiter: profileLimiter });
    return (r ?? []).filter((t) => t.chainId === 'solana');
  },

  async search(q: string): Promise<DexPair[]> {
    const r = await fetchJson<{ pairs: DexPair[] }>(`${base()}/latest/dex/search?q=${encodeURIComponent(q)}`, {
      limiter: pairLimiter,
    });
    return (r?.pairs ?? []).filter((p) => p.chainId === 'solana');
  },
};
