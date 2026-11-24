import { z } from 'zod';

export const TakeProfitSchema = z.object({
  /** giriş fiyatının katı (2 = %100 kâr) */
  multiple: z.number().gt(1),
  /** BAŞLANGIÇ pozisyonun yüzde kaçı satılacak (0-100) */
  sellPct: z.number().gt(0).lte(100),
});

export const StrategySpecSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  segment: z.enum(['memecoin', 'established']),
  createdAt: z.number(),
  source: z.object({
    method: z.enum(['cluster', 'wallets', 'manual']),
    wallets: z.array(z.string()),
    clusterId: z.number().optional(),
  }),
  entry: z.object({
    /** havuz yaşı aralığı (sn) */
    minPoolAgeSec: z.number().min(0),
    maxPoolAgeSec: z.number().positive(),
    mcapUsdMin: z.number().min(0),
    mcapUsdMax: z.number().positive(),
    minLiquidityUsd: z.number().min(0),
    /** son 5 dk fiyat değişimi aralığı (%). null = koşul yok */
    priceChange5mMin: z.number().nullable(),
    priceChange5mMax: z.number().nullable(),
    /** son 5 dk alım/satım sayısı oranı alt sınırı. null = koşul yok */
    minBuySellRatio5m: z.number().nullable(),
    /** DCA: girişi kaç parçaya böl, sonraki parçalar yüzde kaç düşüşte alınsın */
    dca: z.object({ tranches: z.number().int().min(1).max(4), dipPct: z.number().min(0) }).nullable(),
  }),
  sizing: z.object({
    /** özsermayenin yüzdesi (işlem başı) */
    pctOfEquity: z.number().gt(0).lte(100),
    maxOpenPositions: z.number().int().positive(),
  }),
  exit: z.object({
    takeProfits: z.array(TakeProfitSchema),
    /** giriş fiyatının katı (0.6 = %40 zarar) */
    stopLossMultiple: z.number().gt(0).lt(1),
    /** ilk TP'den sonra zirveden yüzde kaç düşüşte kalanı sat. null = yok */
    trailingStopPct: z.number().gt(0).lt(100).nullable(),
    maxHoldSec: z.number().positive(),
  }),
  execution: z.object({
    slippageBps: z.number().int().positive(),
  }),
  /** çıkarımda kullanılan istatistikler (bilgi amaçlı) */
  evidence: z.record(z.string(), z.union([z.number(), z.string(), z.null()])),
});

export type StrategySpec = z.infer<typeof StrategySpecSchema>;
export type TakeProfit = z.infer<typeof TakeProfitSchema>;
