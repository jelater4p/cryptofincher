import { DEX_PROGRAMS, LAMPORTS_PER_SOL, QUOTE_MINTS, SOL_MINT, STABLE_MINTS } from '../core/constants.js';
import type { RawTx, SwapEvent, TransferEvent } from '../core/types.js';

/** Yeni token hesabı (ATA) açılışında ödenen kira; swap değerinden ayıklanır */
export const TOKEN_ACCOUNT_RENT_SOL = 0.00203928;
const DUST_SOL = 0.001;
const EPS = 1e-9;

export interface ParseResult {
  swaps: SwapEvent[];
  transfers: TransferEvent[];
  /** sınıflandırılamayan (LP ekleme, çoklu token vb.) */
  skipped: boolean;
}

export function detectDex(programIds: string[]): string {
  let jupiter = false;
  for (const p of programIds) {
    const name = DEX_PROGRAMS[p];
    if (name === 'jupiter') jupiter = true;
    else if (name) return name;
  }
  return jupiter ? 'jupiter' : 'unknown';
}

/**
 * Bir işlemi, verilen cüzdan açısından ayrıştırır. DEX'e özel talimat çözmek yerine
 * cüzdanın SOL ve token bakiye farklarına bakar; bu sayede tüm DEX'ler ve aggregator'lar
 * (pump.fun, Raydium, Meteora, Orca, Jupiter...) aynı mantıkla çalışır.
 *
 * @param solUsdAt USDC/USDT ile yapılan swapları SOL'e çevirmek için (yoksa bu swaplar atlanır)
 */
export function parseWalletTx(
  tx: RawTx,
  wallet: string,
  solUsdAt?: (tsSec: number) => number | undefined,
): ParseResult {
  const empty: ParseResult = { swaps: [], transfers: [], skipped: false };
  if (tx.err || tx.blockTime == null) return empty;
  const idx = tx.accountKeys.indexOf(wallet);
  if (idx < 0) return empty;

  // --- Token bakiye farkları (cüzdanın sahip olduğu tüm token hesapları) ---
  const deltas = new Map<string, number>();
  const preAccounts = new Set<string>();
  const postAccounts = new Set<string>();
  for (const b of tx.preTokenBalances) {
    if (b.owner !== wallet) continue;
    deltas.set(b.mint, (deltas.get(b.mint) ?? 0) - b.uiAmount);
    preAccounts.add(`${b.accountIndex}:${b.mint}`);
  }
  for (const b of tx.postTokenBalances) {
    if (b.owner !== wallet) continue;
    deltas.set(b.mint, (deltas.get(b.mint) ?? 0) + b.uiAmount);
    postAccounts.add(`${b.accountIndex}:${b.mint}`);
  }

  // --- SOL farkı: işlem ücreti ve token hesabı kirası ayıklanır ---
  let solDelta = ((tx.postBalances[idx] ?? 0) - (tx.preBalances[idx] ?? 0)) / LAMPORTS_PER_SOL;
  if (tx.feePayer === wallet) solDelta += tx.feeLamports / LAMPORTS_PER_SOL;
  for (const key of postAccounts) {
    const mint = key.split(':')[1]!;
    if (!preAccounts.has(key) && mint !== SOL_MINT) solDelta += TOKEN_ACCOUNT_RENT_SOL; // hesap açıldı
  }
  for (const key of preAccounts) {
    const mint = key.split(':')[1]!;
    if (!postAccounts.has(key) && mint !== SOL_MINT) solDelta -= TOKEN_ACCOUNT_RENT_SOL; // hesap kapatıldı
  }
  // WSOL de SOL sayılır
  solDelta += deltas.get(SOL_MINT) ?? 0;
  deltas.delete(SOL_MINT);

  const stableDeltas: Array<[string, number]> = [];
  for (const m of STABLE_MINTS) {
    const d = deltas.get(m);
    if (d !== undefined && Math.abs(d) > 0.01) stableDeltas.push([m, d]);
    deltas.delete(m);
  }

  const tokenDeltas = [...deltas.entries()].filter(([m, d]) => !QUOTE_MINTS.has(m) && Math.abs(d) > EPS);
  const isSigner = tx.signers.includes(wallet);
  const blockTime = tx.blockTime;

  const toTransfers = (): TransferEvent[] =>
    tokenDeltas.map(([mint, d]) => ({
      signature: tx.signature,
      blockTime,
      wallet,
      mint,
      direction: d > 0 ? 'IN' : 'OUT',
      amount: Math.abs(d),
    }));

  if (tokenDeltas.length === 0) return empty;
  if (tokenDeltas.length > 1 || !isSigner) {
    // token-token swap, LP işlemi veya cüzdanın imzalamadığı gelen transfer
    return { swaps: [], transfers: toTransfers(), skipped: tokenDeltas.length > 1 };
  }

  const [mint, tokenDelta] = tokenDeltas[0]!;
  const side = tokenDelta > 0 ? 'BUY' : 'SELL';

  // Ödeme aracını seç: önce SOL, yoksa stablecoin. Yönü token ile ters olmalı.
  let quoteMint: string | null = null;
  let quoteAmount = 0;
  let solValue = 0;
  const solOpposite = side === 'BUY' ? solDelta < -DUST_SOL : solDelta > DUST_SOL;
  if (solOpposite) {
    quoteMint = SOL_MINT;
    quoteAmount = Math.abs(solDelta);
    solValue = quoteAmount;
  } else {
    const st = stableDeltas.find(([, d]) => (side === 'BUY' ? d < 0 : d > 0));
    if (st) {
      const solUsd = solUsdAt?.(blockTime);
      if (!solUsd) return { swaps: [], transfers: [], skipped: true };
      quoteMint = st[0];
      quoteAmount = Math.abs(st[1]);
      solValue = quoteAmount / solUsd;
    }
  }

  if (!quoteMint) {
    // karşılığında ödeme olmayan token hareketi = transfer (airdrop, başka cüzdana gönderim)
    return { swaps: [], transfers: toTransfers(), skipped: false };
  }
  if (solValue < DUST_SOL) return empty;

  const tokenAmount = Math.abs(tokenDelta);
  return {
    swaps: [
      {
        signature: tx.signature,
        slot: tx.slot,
        blockTime,
        wallet,
        mint,
        side,
        tokenAmount,
        quoteMint,
        quoteAmount,
        solValue,
        priceSol: solValue / tokenAmount,
        dex: detectDex(tx.programIds),
      },
    ],
    transfers: [],
    skipped: false,
  };
}
