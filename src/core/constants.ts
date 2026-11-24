export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDT_MINT = 'Es9vMFrzaCERmJfrF8H2UVEqYLmnQP2p6KJMyDnPjP2z';
export const LAMPORTS_PER_SOL = 1_000_000_000;

/** Swap'ta "ödeme aracı" sayılan varlıklar */
export const QUOTE_MINTS = new Set([SOL_MINT, USDC_MINT, USDT_MINT]);
export const STABLE_MINTS = new Set([USDC_MINT, USDT_MINT]);

/** DEX/launchpad program id'leri: sadece etiketleme için (ayrıştırma bakiye farklarından yapılır) */
export const DEX_PROGRAMS: Record<string, string> = {
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': 'pumpfun',
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: 'pumpswap',
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'raydium-amm',
  CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: 'raydium-cpmm',
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: 'raydium-clmm',
  LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj: 'raydium-launchlab',
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: 'meteora-dlmm',
  cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG: 'meteora-damm-v2',
  Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB: 'meteora-damm',
  dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN: 'meteora-dbc',
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: 'orca',
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: 'jupiter',
};

export const PUMPFUN_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

/**
 * pump.fun token basma yetkilisi (yaygın kullanılan adres; resmi kaynaktan doğrulanamadı).
 * Sadece yeni token oluşturma işlemlerinde geçtiği için akışı çok hafifletir. Yanlışsa akış
 * 10 dakika içinde hiç token göremez ve otomatik olarak programın tamamını dinlemeye geçer.
 */
export const PUMPFUN_MINT_AUTHORITY = 'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM';

/** pump.fun tokenlarının toplam arzı (6 ondalık, 1 milyar) */
export const PUMPFUN_TOTAL_SUPPLY = 1_000_000_000;
