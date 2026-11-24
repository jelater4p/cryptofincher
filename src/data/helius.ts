import { config } from '../config.js';
import { fetchJson } from '../core/http.js';
import { RateLimiter } from '../core/rateLimiter.js';
import { childLogger } from '../core/logger.js';
import type { RawTx, TokenBalance } from '../core/types.js';
import { kv } from '../storage/repo.js';

const log = childLogger('helius');

/**
 * Kredi maliyetleri. Helius fiyatlandırması değişebilir; panelinizden (dashboard → usage)
 * gerçek değerleri kontrol edip env ile ezin. Varsayılanlar bilerek temkinli (yüksek) tutuldu.
 */
const CREDIT_COST: Record<string, number> = {
  getSignaturesForAddress: Number(process.env.HELIUS_CREDIT_GET_SIGNATURES ?? 10),
  getTransaction: Number(process.env.HELIUS_CREDIT_GET_TRANSACTION ?? 10),
  default: 1,
};

export class CreditBudgetExceeded extends Error {
  constructor(used: number, limit: number) {
    super(`Helius aylık kredi bütçesi doldu: ${used}/${limit}`);
  }
}

const monthKey = () => `helius_credits:${new Date().toISOString().slice(0, 7)}`;

export const heliusCredits = {
  used(): number {
    return kv.get<number>(monthKey(), 0);
  },
  limit(): number {
    return config.HELIUS_MONTHLY_CREDITS;
  },
  /** Analiz işleri bütçenin %95'ini geçemez; kalan %5 canlı işlemler için ayrılır */
  analysisAllowance(): number {
    return Math.floor(this.limit() * 0.95);
  },
  charge(method: string, priority: 'analysis' | 'trading') {
    const cost = CREDIT_COST[method] ?? CREDIT_COST.default!;
    const used = this.used();
    const cap = priority === 'trading' ? this.limit() : this.analysisAllowance();
    if (used + cost > cap) throw new CreditBudgetExceeded(used, cap);
    kv.set(monthKey(), used + cost);
  },
};

export interface SignatureInfo {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: unknown;
}

export class HeliusClient {
  private limiter = RateLimiter.perSecond(config.HELIUS_RPS);
  private id = 0;

  async rpc<T>(method: string, params: unknown[], priority: 'analysis' | 'trading' = 'analysis'): Promise<T> {
    if (!config.HELIUS_API_KEY && !config.HELIUS_RPC_URL) throw new Error('HELIUS_API_KEY tanımlı değil');
    heliusCredits.charge(method, priority);
    const res = await fetchJson<{ result?: T; error?: { code: number; message: string } }>(config.heliusRpcUrl, {
      body: { jsonrpc: '2.0', id: ++this.id, method, params },
      limiter: this.limiter,
    });
    if (res.error) throw new Error(`RPC ${method}: ${res.error.code} ${res.error.message}`);
    return res.result as T;
  }

  getSignaturesForAddress(address: string, opts: { before?: string; until?: string; limit?: number } = {}) {
    return this.rpc<SignatureInfo[]>('getSignaturesForAddress', [
      address,
      { limit: opts.limit ?? 1000, before: opts.before, until: opts.until, commitment: 'confirmed' },
    ]);
  }

  /**
   * Bir adresin imzalarını sayfalayarak getirir (yeniden eskiye).
   * `until` verilirse o imzaya kadar (artımlı senkron), `max` kadar.
   */
  async getAllSignatures(address: string, opts: { until?: string; max: number }): Promise<SignatureInfo[]> {
    const out: SignatureInfo[] = [];
    let before: string | undefined;
    while (out.length < opts.max) {
      const page = await this.getSignaturesForAddress(address, {
        before,
        until: opts.until,
        limit: Math.min(1000, opts.max - out.length),
      });
      if (!page.length) break;
      out.push(...page);
      before = page[page.length - 1]!.signature;
      if (page.length < 1000) break;
    }
    return out;
  }

  /**
   * Bir adresin en ESKİ imzalarını bulur (token/havuzun ilk alıcılarını bulmak için).
   * Free planda pahalıdır: çok aktif havuzlarda `maxPages` ile sınırlanır.
   */
  async getOldestSignatures(address: string, count: number, maxPages = 20): Promise<SignatureInfo[]> {
    let before: string | undefined;
    let last: SignatureInfo[] = [];
    let prev: SignatureInfo[] = [];
    for (let i = 0; i < maxPages; i++) {
      const page = await this.getSignaturesForAddress(address, { before, limit: 1000 });
      if (!page.length) break;
      prev = last;
      last = page;
      before = page[page.length - 1]!.signature;
      if (page.length < 1000) break;
      if (i === maxPages - 1) log.warn({ address }, 'havuzun başlangıcına ulaşılamadı, en eski erişilen sayfa kullanılıyor');
    }
    const combined = [...prev, ...last];
    return combined.slice(-count).reverse(); // eskiden yeniye
  }

  async getTransaction(signature: string, priority: 'analysis' | 'trading' = 'analysis'): Promise<RawTx | null> {
    const res = await this.rpc<RpcParsedTx | null>(
      'getTransaction',
      [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }],
      priority,
    );
    return res ? toRawTx(res) : null;
  }

  async getMintInfo(mint: string) {
    const res = await this.rpc<{ value: { data: { parsed?: { info: MintInfoParsed } }; owner: string } | null }>(
      'getAccountInfo',
      [mint, { encoding: 'jsonParsed' }],
      'trading',
    );
    const info = res.value?.data?.parsed?.info;
    if (!info) return null;
    return {
      decimals: info.decimals,
      supply: Number(info.supply) / 10 ** info.decimals,
      mintAuthority: info.mintAuthority ?? null,
      freezeAuthority: info.freezeAuthority ?? null,
      tokenProgram: res.value!.owner,
    };
  }

  async getBalanceSol(address: string): Promise<number> {
    const res = await this.rpc<{ value: number }>('getBalance', [address], 'trading');
    return res.value / 1e9;
  }

  async getTokenBalance(owner: string, mint: string): Promise<number> {
    const res = await this.rpc<{
      value: Array<{ account: { data: { parsed: { info: { tokenAmount: { uiAmount: number | null; amount: string; decimals: number } } } } } }>;
    }>('getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed' }], 'trading');
    let total = 0;
    for (const a of res.value) {
      const t = a.account.data.parsed.info.tokenAmount;
      total += Number(t.amount) / 10 ** t.decimals;
    }
    return total;
  }
}

interface MintInfoParsed {
  decimals: number;
  supply: string;
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
}

interface RpcTokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number; uiAmount: number | null };
}

interface RpcParsedTx {
  slot: number;
  blockTime: number | null;
  transaction: {
    signatures: string[];
    message: {
      accountKeys: Array<{ pubkey: string; signer: boolean; writable: boolean } | string>;
      instructions: Array<{ programId: string }>;
    };
  };
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: RpcTokenBalance[];
    postTokenBalances?: RpcTokenBalance[];
    innerInstructions?: Array<{ instructions: Array<{ programId: string }> }>;
  } | null;
}

function toTokenBalance(b: RpcTokenBalance): TokenBalance {
  return {
    accountIndex: b.accountIndex,
    mint: b.mint,
    owner: b.owner,
    decimals: b.uiTokenAmount.decimals,
    uiAmount: Number(b.uiTokenAmount.amount) / 10 ** b.uiTokenAmount.decimals,
  };
}

export function toRawTx(t: RpcParsedTx): RawTx {
  const keys = t.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey));
  const signers = t.transaction.message.accountKeys
    .filter((k): k is { pubkey: string; signer: boolean; writable: boolean } => typeof k !== 'string' && k.signer)
    .map((k) => k.pubkey);
  const programIds = new Set<string>();
  for (const ix of t.transaction.message.instructions) programIds.add(ix.programId);
  for (const inner of t.meta?.innerInstructions ?? []) for (const ix of inner.instructions) programIds.add(ix.programId);
  return {
    signature: t.transaction.signatures[0]!,
    slot: t.slot,
    blockTime: t.blockTime,
    accountKeys: keys,
    signers: signers.length ? signers : [keys[0]!],
    programIds: [...programIds],
    feePayer: keys[0]!,
    feeLamports: t.meta?.fee ?? 0,
    err: t.meta?.err ?? null,
    preBalances: t.meta?.preBalances ?? [],
    postBalances: t.meta?.postBalances ?? [],
    preTokenBalances: (t.meta?.preTokenBalances ?? []).map(toTokenBalance),
    postTokenBalances: (t.meta?.postTokenBalances ?? []).map(toTokenBalance),
  };
}

export const helius = new HeliusClient();
