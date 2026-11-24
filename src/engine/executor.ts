import { Connection, VersionedTransaction, type Keypair } from '@solana/web3.js';
import { config } from '../config.js';
import { SOL_MINT } from '../core/constants.js';
import { childLogger } from '../core/logger.js';
import { helius, HeliusLimitError } from '../data/helius.js';
import { jupiter, priceImpactPercent } from '../data/jupiter.js';
import { kv, tokens } from '../storage/repo.js';

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
/** Ondalık bilgisi veritabanında da saklanır: Helius erişilemezken ya da yeniden başlatmadan sonra satış yapılabilsin */
async function decimalsOf(mint: string): Promise<number> {
  if (mint === SOL_MINT) return 9;
  const hit = decimalsCache.get(mint) ?? tokens.get(mint)?.decimals;
  if (hit !== undefined) {
    decimalsCache.set(mint, hit);
    return hit;
  }
  const info = await helius.getMintInfo(mint);
  if (!info) throw new Error(`decimals alınamadı: ${mint}`);
  decimalsCache.set(mint, info.decimals);
  tokens.upsert({ mint, decimals: info.decimals });
  return info.decimals;
}

const toAtomic = (ui: number, decimals: number) => BigInt(Math.floor(ui * 10 ** decimals));

/** Alımda kabul edilen en yüksek fiyat etkisi (%). Satışta sınır yok: zarar kesme her koşulda denenmeli. */
export const MAX_BUY_PRICE_IMPACT_PCT = 15;

/** Cüzdanda satılacak token kalmadı: pozisyon kapatılmalı, satış tekrar denenmemeli */
export class NoBalanceError extends Error {}

/**
 * Satılacak taban birim miktar. İstenen miktar zincirdeki bakiyeye çok yakınsa ya da üstündeyse
 * bakiyenin TAMAMI satılır: ondalık yuvarlaması bakiyeyi aşıp işlemi düşürmesin, geride toz kalmasın.
 */
export function sellAmountAtomic(requestedUi: number, decimals: number, onchain: bigint | null): bigint {
  const requested = toAtomic(requestedUi, decimals);
  if (onchain === null) return requested; // bakiye okunamadı: kayıttaki miktar
  if (onchain <= 0n) return 0n;
  // %0.1 tolerans: kayıttaki miktar ile zincir arasında küçük farklar olabilir (transfer ücreti, yuvarlama)
  if (requested >= onchain || requested * 1000n >= onchain * 999n) return onchain;
  return requested;
}

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
    // canlı modla aynı kural: aksi halde paper, canlıda yapılamayacak alımları yapıp iyimser sonuç verir
    const impact = priceImpactPercent(order);
    if (impact > MAX_BUY_PRICE_IMPACT_PCT) throw new Error(`Fiyat etkisi çok yüksek: %${impact.toFixed(1)}`);
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

  private async swap(inputMint: string, outputMint: string, amount: bigint, slippageBps: number, maxImpactPct = Infinity) {
    const order = await jupiter.order({ inputMint, outputMint, amount, taker: this.address, slippageBps });
    const impact = priceImpactPercent(order);
    if (impact > maxImpactPct) throw new Error(`Fiyat etkisi çok yüksek: %${impact.toFixed(1)}`);
    if (!order.transaction || !order.requestId) throw new Error(`Jupiter işlem oluşturamadı: ${order.errorMessage ?? 'bilinmiyor'}`);
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
    const r = await this.swap(SOL_MINT, mint, toAtomic(solAmount, 9), slippageBps, MAX_BUY_PRICE_IMPACT_PCT);
    const spent = Number(r.inAtomic) / 1e9;
    const got = Number(r.outAtomic) / 10 ** dec;
    return { solAmount: spent, tokenAmount: got, priceSol: spent / got, signature: r.signature, priceImpactPct: r.impact };
  }

  async sell(mint: string, tokenAmount: number, slippageBps: number): Promise<FillResult> {
    const dec = await decimalsOf(mint);
    // zincirdeki gerçek bakiye (taban birimde). Helius erişilemezse kayıttaki miktarla denenir:
    // Jupiter yetersiz bakiyede işlemi zaten oluşturmaz.
    let onchain: bigint | null = null;
    try {
      onchain = await helius.getTokenBalanceAtomic(this.address, mint);
    } catch (err) {
      if (!(err instanceof HeliusLimitError)) throw err;
      log.warn({ mint }, 'Helius erişilemiyor: zincir bakiyesi yerine kayıttaki miktarla satılıyor');
    }
    const amount = sellAmountAtomic(tokenAmount, dec, onchain);
    if (amount <= 0n) throw new NoBalanceError('cüzdanda satılacak token yok');
    // satışta fiyat etkisi sınırı yok: likiditesi çöken tokenda zarar kesme engellenmemeli
    const r = await this.swap(mint, SOL_MINT, amount, slippageBps);
    const sold = Number(r.inAtomic) / 10 ** dec;
    const got = Number(r.outAtomic) / 1e9;
    return { solAmount: got, tokenAmount: sold, priceSol: got / sold, signature: r.signature, priceImpactPct: r.impact };
  }

  /** bağlantı testi */
  async ping() {
    return this.conn.getSlot();
  }
}
