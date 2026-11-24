import { config } from '../config.js';
import { childLogger } from '../core/logger.js';
import type { TokenInfo } from '../core/types.js';
import { dexscreener } from '../data/dexscreener.js';
import { helius, HeliusLimitError } from '../data/helius.js';
import { parseWalletTx } from '../analysis/swapParser.js';
import { solPriceService } from '../data/solPrice.js';
import { tokens, wallets } from '../storage/repo.js';

const log = childLogger('discovery');

export interface WinnerTokenCriteria {
  minLiquidityUsd: number;
  minPriceChangeH24: number;
  minAgeHours: number;
  maxAgeHours: number;
}

const DEFAULT_CRITERIA: WinnerTokenCriteria = {
  minLiquidityUsd: 20_000,
  minPriceChangeH24: 100,
  minAgeHours: 3,
  maxAgeHours: 24 * 7,
};

/** "Kazanan" token: likit, güçlü yükselmiş, çok yeni değil (erken alıcılar belirginleşmiş) */
export function isWinnerToken(t: TokenInfo, c = DEFAULT_CRITERIA, now = Date.now()) {
  if (!t.pairAddress || !t.pairCreatedAt) return false;
  const ageH = (now - t.pairCreatedAt) / 3600_000;
  return (
    (t.liquidityUsd ?? 0) >= c.minLiquidityUsd &&
    ageH >= c.minAgeHours &&
    ageH <= c.maxAgeHours &&
    (t.priceChangeH24 ?? t.priceChangeH1 ?? 0) >= c.minPriceChangeH24
  );
}

/** DexScreener'daki trend/boost listelerinden kazanan token adayları */
export async function findWinnerTokens(max = 5): Promise<TokenInfo[]> {
  const refs = [
    ...(await dexscreener.topBoosts().catch(() => [])),
    ...(await dexscreener.latestBoosts().catch(() => [])),
    ...(await dexscreener.latestProfiles().catch(() => [])),
  ];
  const mints = [...new Set(refs.map((r) => r.tokenAddress))];
  const infos = await dexscreener.tokens(mints);
  for (const i of infos.values()) tokens.upsert(i);
  return [...infos.values()].filter((t) => isWinnerToken(t)).slice(0, max);
}

/**
 * Bir tokenın havuzundaki ilk işlemleri tarayıp erken ALICI cüzdanları bulur.
 * Aynı zamanda son işlemlerden aktif tüccarları da ekler.
 */
export async function discoverFromToken(mint: string, opts: { earlyBuyers?: number; recent?: number } = {}) {
  let info = tokens.get(mint);
  if (!info?.pairAddress) {
    const m = await dexscreener.tokens([mint]);
    const i = m.get(mint);
    if (!i) throw new Error(`Token bulunamadı: ${mint}`);
    info = tokens.upsert(i);
  }
  const pool = info.pairAddress!;
  const earlyCount = opts.earlyBuyers ?? config.DISCOVERY_EARLY_BUYERS_PER_TOKEN;
  const early = await helius.getOldestSignatures(pool, earlyCount * 2, 8);
  const recent = opts.recent ? await helius.getSignaturesForAddress(pool, { limit: opts.recent }) : [];
  const found = new Map<string, 'early' | 'recent'>();
  const scan = async (sigs: typeof early, kind: 'early' | 'recent', cap: number) => {
    for (const s of sigs) {
      if (s.err) continue;
      if ([...found.values()].filter((v) => v === kind).length >= cap) break;
      const tx = await helius.getTransaction(s.signature);
      if (!tx) continue;
      const r = parseWalletTx(tx, tx.feePayer, (ts) => solPriceService.at(ts));
      const buy = r.swaps.find((x) => x.mint === mint && x.side === 'BUY');
      if (buy && !found.has(buy.wallet)) found.set(buy.wallet, kind);
    }
  };
  await scan(early, 'early', earlyCount);
  if (recent.length) await scan(recent, 'recent', opts.recent!);
  for (const addr of found.keys()) {
    if (!wallets.get(addr)) wallets.add(addr, 'discovered', { from: mint });
  }
  log.info({ mint, symbol: info.symbol, found: found.size }, 'cüzdan keşfi');
  return [...found.keys()];
}

export async function runDiscovery(maxTokens = 3) {
  const winners = await findWinnerTokens(maxTokens);
  const all: string[] = [];
  for (const t of winners) {
    try {
      all.push(...(await discoverFromToken(t.mint)));
    } catch (err) {
      if (err instanceof HeliusLimitError) throw err;
      log.warn({ mint: t.mint, err: String(err) }, 'keşif başarısız');
    }
  }
  return { tokens: winners, wallets: [...new Set(all)] };
}
