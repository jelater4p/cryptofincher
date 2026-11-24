export type Side = 'BUY' | 'SELL';

export interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiAmount: number;
  decimals: number;
}

/** RPC'den gelen işlemin, ayrıştırıcının ihtiyaç duyduğu sade hali */
export interface RawTx {
  signature: string;
  slot: number;
  blockTime: number | null;
  accountKeys: string[];
  signers: string[];
  programIds: string[];
  feePayer: string;
  feeLamports: number;
  err: unknown;
  preBalances: number[];
  postBalances: number[];
  preTokenBalances: TokenBalance[];
  postTokenBalances: TokenBalance[];
}

export interface SwapEvent {
  signature: string;
  slot: number;
  blockTime: number;
  wallet: string;
  mint: string;
  side: Side;
  /** token miktarı (ui, ondalıklı) */
  tokenAmount: number;
  quoteMint: string;
  /** ödeme aracı miktarı (ui) */
  quoteAmount: number;
  /** SOL cinsinden değer (USDC/USDT swaplarında o günün SOL fiyatıyla çevrilir) */
  solValue: number;
  /** token başına SOL fiyatı */
  priceSol: number;
  dex: string;
}

export interface TransferEvent {
  signature: string;
  blockTime: number;
  wallet: string;
  mint: string;
  direction: 'IN' | 'OUT';
  amount: number;
}

export interface TokenInfo {
  mint: string;
  symbol?: string;
  name?: string;
  decimals?: number;
  supply?: number;
  pairAddress?: string;
  dexId?: string;
  pairCreatedAt?: number; // ms
  priceUsd?: number;
  priceSol?: number;
  liquidityUsd?: number;
  marketCapUsd?: number;
  fdvUsd?: number;
  volumeH1?: number;
  volumeH24?: number;
  priceChangeM5?: number;
  priceChangeH1?: number;
  priceChangeH24?: number;
  buysM5?: number;
  sellsM5?: number;
  buysH1?: number;
  sellsH1?: number;
  updatedAt?: number;
}

export type MarketSegment = 'memecoin' | 'established';
