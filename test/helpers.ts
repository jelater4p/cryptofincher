import type { RawTx, SwapEvent } from '../src/core/types.js';
import { SOL_MINT } from '../src/core/constants.js';

export const WALLET = 'Wa11et1111111111111111111111111111111111111';
export const POOL = 'Poo11111111111111111111111111111111111111111';
export const MINT = 'Mint111111111111111111111111111111111111pump';

let sigN = 0;

/** Bir cüzdanın SOL ile token aldığı/sattığı sentetik işlem */
export function swapTx(opts: {
  side: 'BUY' | 'SELL';
  sol: number;
  tokens: number;
  preTokens?: number;
  newAccount?: boolean;
  closeAccount?: boolean;
  wallet?: string;
  signer?: boolean;
  mint?: string;
  blockTime?: number;
  slot?: number;
  feeLamports?: number;
}): RawTx {
  const wallet = opts.wallet ?? WALLET;
  const mint = opts.mint ?? MINT;
  const fee = opts.feeLamports ?? 5000;
  const rent = 0.00203928;
  const preTok = opts.preTokens ?? (opts.side === 'BUY' ? 0 : opts.tokens);
  const postTok = opts.side === 'BUY' ? preTok + opts.tokens : preTok - opts.tokens;
  let solDelta = opts.side === 'BUY' ? -opts.sol : opts.sol;
  if (opts.newAccount) solDelta -= rent;
  if (opts.closeAccount) solDelta += rent;
  const preLamports = 100 * 1e9;
  const postLamports = preLamports + Math.round(solDelta * 1e9) - fee;
  const pre = opts.newAccount ? [] : [{ accountIndex: 2, mint, owner: wallet, uiAmount: preTok, decimals: 6 }];
  const post = opts.closeAccount ? [] : [{ accountIndex: 2, mint, owner: wallet, uiAmount: postTok, decimals: 6 }];
  return {
    signature: `sig${++sigN}`,
    slot: opts.slot ?? 1000 + sigN,
    blockTime: opts.blockTime ?? 1_700_000_000 + sigN,
    accountKeys: [wallet, POOL, 'tokacc', '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'],
    signers: opts.signer === false ? ['someone'] : [wallet],
    programIds: ['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'],
    feePayer: opts.signer === false ? 'someone' : wallet,
    feeLamports: fee,
    err: null,
    preBalances: [preLamports, 0, 0, 0],
    postBalances: [postLamports, 0, 0, 0],
    preTokenBalances: [...pre, { accountIndex: 1, mint: SOL_MINT, owner: POOL, uiAmount: 50, decimals: 9 }],
    postTokenBalances: [...post, { accountIndex: 1, mint: SOL_MINT, owner: POOL, uiAmount: 50, decimals: 9 }],
  };
}

export function swap(p: Partial<SwapEvent> & { side: 'BUY' | 'SELL'; sol: number; tokens: number; t: number }): SwapEvent {
  return {
    signature: `s${++sigN}`,
    slot: p.slot ?? sigN,
    blockTime: p.t,
    wallet: p.wallet ?? WALLET,
    mint: p.mint ?? MINT,
    side: p.side,
    tokenAmount: p.tokens,
    quoteMint: SOL_MINT,
    quoteAmount: p.sol,
    solValue: p.sol,
    priceSol: p.sol / p.tokens,
    dex: p.dex ?? 'pumpfun',
  };
}
