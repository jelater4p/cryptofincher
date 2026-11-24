import { Connection, VersionedTransaction, type Keypair } from '@solana/web3.js';
import { config } from '../config.js';
import { SOL_MINT } from '../core/constants.js';
import { childLogger } from '../core/logger.js';
import { helius } from '../data/helius.js';
import { jupiter, priceImpactPercent } from '../data/jupiter.js';
import { kv } from '../storage/repo.js';

const log = childLogger('executor');

export interface FillResult {
  solAmount: number;
  tokenAmount: number;
  priceSol: number;
  signature?: string;
  priceImpactPct: number;
}

export interface Executor {
  readonly mode: 'paper' | 'live';
  balanceSol(): Promise<number>;
  buy(mint: string, solAmount: number, slippageBps: number): Promise<FillResult>;
  sell(mint: string, tokenAmount: number, slippageBps: number): Promise<FillResult>;
}

const decimalsCache = new Map<string, number>();
async function decimalsOf(mint: string): Promise<number> {
  if (mint === SOL_MINT) return 9;
  const hit = decimalsCache.get(mint);
  if (hit !== undefined) return hit;
  const info = await helius.getMintInfo(mint);
  if (!info) throw new Error(`decimals alınamadı: ${mint}`);
  decimalsCache.set(mint, info.decimals);
  return info.decimals;
}

const toAtomic = (ui: number, decimals: number) => BigInt(Math.floor(ui * 10 ** decimals));

/**
 * Paper mod: gerçek Jupiter teklifini (fiyat etkisi dahil) kullanır ama işlem göndermez.
 * Bakiye veritabanında tutulur. Ek kayma payı olarak slippage'ın yarısı düşülür.
 */
export class PaperExecutor implements Executor {
  readonly mode = 'paper' as const;

  async balanceSol() {
    return kv.get<number>('paper:sol', config.PAPER_STARTING_SOL);
  }

  private setBalance(v: number) {
    kv.set('paper:sol', v);
  }

  async buy(mint: string, solAmount: number, slippageBps: number): Promise<FillResult> {
    const bal = await this.balanceSol();
    if (solAmount > bal) throw new Error('paper bakiye yetersiz');
    const dec = await decimalsOf(mint);
    const order = await jupiter.order({ inputMint: SOL_MINT, outputMint: mint, amount: toAtomic(solAmount, 9) });
    const haircut = 1 - slippageBps / 20000;
    const tokenAmount = (Number(order.outAmount) / 10 ** dec) * haircut;
    this.setBalance(bal - solAmount);
    return { solAmount, tokenAmount, priceSol: solAmount / tokenAmount, priceImpactPct: priceImpactPercent(order) };
  }

  async sell(mint: string, tokenAmount: number, slippageBps: number): Promise<FillResult> {
    const dec = await decimalsOf(mint);
    const order = await jupiter.order({ inputMint: mint, outputMint: SOL_MINT, amount: toAtomic(tokenAmount, dec) });
    const haircut = 1 - slippageBps / 20000;
    const solAmount = (Number(order.outAmount) / 1e9) * haircut;
    this.setBalance((await this.balanceSol()) + solAmount);
    return { solAmount, tokenAmount, priceSol: solAmount / tokenAmount, priceImpactPct: priceImpactPercent(order) };
  }
}

/**
 * Canlı mod: Jupiter Swap V2 /order (taker ile) → yerel imza → /execute.
 * Gerçekleşen miktarlar execute yanıtından alınır.
 */
export class LiveExecutor implements Executor {
  readonly mode = 'live' as const;
  private conn = new Connection(config.heliusRpcUrl, 'confirmed');

  constructor(private readonly keypair: Keypair) {}

  get address() {
    return this.keypair.publicKey.toBase58();
  }

  async balanceSol() {
    return helius.getBalanceSol(this.address);
  }

  private async swap(inputMint: string, outputMint: string, amount: bigint, slippageBps: number) {
    const order = await jupiter.order({ inputMint, outputMint, amount, taker: this.address, slippageBps });
    if (!order.transaction || !order.requestId) throw new Error(`Jupiter işlem oluşturamadı: ${order.errorMessage ?? 'bilinmiyor'}`);
    const impact = priceImpactPercent(order);
    if (impact > 15) throw new Error(`Fiyat etkisi çok yüksek: %${impact.toFixed(1)}`);
    const tx = VersionedTransaction.deserialize(Buffer.from(order.transaction, 'base64'));
    tx.sign([this.keypair]);
    const signed = Buffer.from(tx.serialize()).toString('base64');
    let res = await jupiter.execute(signed, order.requestId);
    // aynı istekle tekrar sormak güvenli: çift işlem olmaz
    for (let i = 0; i < 3 && res.status !== 'Success' && res.status !== 'Failed'; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      res = await jupiter.execute(signed, order.requestId);
    }
    if (res.status !== 'Success') throw new Error(`Swap başarısız: ${res.error ?? res.code ?? res.status} ${res.signature ?? ''}`);
    log.info({ sig: res.signature, inputMint, outputMint }, 'swap gerçekleşti');
    return {
      signature: res.signature,
      inAtomic: BigInt(res.inputAmountResult ?? res.totalInputAmount ?? order.inAmount),
      outAtomic: BigInt(res.outputAmountResult ?? res.totalOutputAmount ?? order.outAmount),
      impact,
    };
  }

  async buy(mint: string, solAmount: number, slippageBps: number): Promise<FillResult> {
    const bal = await this.balanceSol();
    if (solAmount > bal - config.RISK_SOL_RESERVE) throw new Error(`SOL bakiyesi yetersiz (${bal.toFixed(3)})`);
    const dec = await decimalsOf(mint);
    const r = await this.swap(SOL_MINT, mint, toAtomic(solAmount, 9), slippageBps);
    const spent = Number(r.inAtomic) / 1e9;
    const got = Number(r.outAtomic) / 10 ** dec;
    return { solAmount: spent, tokenAmount: got, priceSol: spent / got, signature: r.signature, priceImpactPct: r.impact };
  }

  async sell(mint: string, tokenAmount: number, slippageBps: number): Promise<FillResult> {
    const dec = await decimalsOf(mint);
    // zincirdeki gerçek bakiyeyi aşma (yuvarlama/transfer ücreti farkları)
    const onchain = await helius.getTokenBalance(this.address, mint);
    const qty = Math.min(tokenAmount, onchain);
    if (qty <= 0) throw new Error('satılacak token bakiyesi yok');
    const r = await this.swap(mint, SOL_MINT, toAtomic(qty, dec), slippageBps);
    const sold = Number(r.inAtomic) / 10 ** dec;
    const got = Number(r.outAtomic) / 1e9;
    return { solAmount: got, tokenAmount: sold, priceSol: got / sold, signature: r.signature, priceImpactPct: r.impact };
  }

  /** bağlantı testi */
  async ping() {
    return this.conn.getSlot();
  }
}
