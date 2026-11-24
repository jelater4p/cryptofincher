import type { SwapEvent, TransferEvent } from '../core/types.js';

export interface Fill {
  ts: number;
  slot?: number;
  side: 'BUY' | 'SELL';
  tokens: number;
  sol: number;
  price: number;
}

export interface ExitPoint {
  /** çıkış fiyatı / ortalama giriş fiyatı */
  multiple: number;
  /** pozisyonun zirve token miktarına oranla satılan kısım */
  fraction: number;
  /** girişten bu yana geçen süre (sn) */
  afterSec: number;
}

/** Bir tokenda açılıp kapanan tek bir pozisyon turu */
export interface RoundTrip {
  wallet: string;
  mint: string;
  dex: string;
  status: 'closed' | 'open';
  openedAt: number;
  closedAt: number | null;
  buys: Fill[];
  sells: Fill[];
  costSol: number;
  proceedsSol: number;
  tokensBought: number;
  tokensSold: number;
  peakTokens: number;
  avgEntryPrice: number;
  /** kapalı: getiri - maliyet; açık: satılan kısmın gerçekleşen kârı */
  realizedPnlSol: number;
  /** kapalı turlarda getiri/maliyet - 1 */
  roi: number;
  holdSec: number | null;
  exits: ExitPoint[];
  /** transferle gelen token var: maliyet bilinmiyor, PnL metriklerinden hariç tutulur */
  transferIn: number;
  transferOut: number;
  excluded: boolean;
  /** aynı slotta alıp satma (wash/MEV belirtisi) */
  sameSlotRoundTrip: boolean;
}

const CLOSE_RATIO = 0.01;

function newTrip(wallet: string, mint: string, ts: number, dex: string): RoundTrip {
  return {
    wallet,
    mint,
    dex,
    status: 'open',
    openedAt: ts,
    closedAt: null,
    buys: [],
    sells: [],
    costSol: 0,
    proceedsSol: 0,
    tokensBought: 0,
    tokensSold: 0,
    peakTokens: 0,
    avgEntryPrice: 0,
    realizedPnlSol: 0,
    roi: 0,
    holdSec: null,
    exits: [],
    transferIn: 0,
    transferOut: 0,
    excluded: false,
    sameSlotRoundTrip: false,
  };
}

function finalize(t: RoundTrip) {
  t.avgEntryPrice = t.tokensBought > 0 ? t.costSol / t.tokensBought : 0;
  t.exits = t.sells.map((s) => ({
    multiple: t.avgEntryPrice > 0 ? s.price / t.avgEntryPrice : 0,
    fraction: t.peakTokens > 0 ? s.tokens / t.peakTokens : 0,
    afterSec: s.ts - t.openedAt,
  }));
  const knownTokens = t.tokensBought + t.transferIn;
  const transferShare = knownTokens > 0 ? t.transferIn / knownTokens : 0;
  t.excluded = transferShare > 0.1 || t.transferOut > t.peakTokens * 0.1 || t.costSol <= 0;
  if (t.status === 'closed') {
    t.realizedPnlSol = t.proceedsSol - t.costSol;
    t.roi = t.costSol > 0 ? t.proceedsSol / t.costSol - 1 : 0;
    t.holdSec = (t.closedAt ?? t.openedAt) - t.openedAt;
  } else {
    const soldFraction = t.tokensBought > 0 ? Math.min(1, t.tokensSold / t.tokensBought) : 0;
    t.realizedPnlSol = t.proceedsSol - t.costSol * soldFraction;
    t.roi = 0;
  }
  const firstBuy = t.buys[0];
  const firstSell = t.sells[0];
  t.sameSlotRoundTrip = !!(firstBuy && firstSell && firstBuy.slot !== undefined && firstBuy.slot === firstSell.slot);
}

/**
 * Swap ve transferlerden pozisyon turlarını yeniden kurar.
 * Bakiye sıfıra (zirvenin %1'i altına) indiğinde tur kapanır; sonraki alım yeni tur açar.
 */
export function buildRoundTrips(swaps: SwapEvent[], transfers: TransferEvent[] = []): RoundTrip[] {
  type Ev = { ts: number; slot: number; kind: 'swap'; s: SwapEvent } | { ts: number; slot: number; kind: 'xfer'; t: TransferEvent };
  const byMint = new Map<string, Ev[]>();
  for (const s of swaps) {
    const list = byMint.get(s.mint) ?? [];
    list.push({ ts: s.blockTime, slot: s.slot, kind: 'swap', s });
    byMint.set(s.mint, list);
  }
  for (const t of transfers) {
    const list = byMint.get(t.mint) ?? [];
    list.push({ ts: t.blockTime, slot: 0, kind: 'xfer', t });
    byMint.set(t.mint, list);
  }

  const trips: RoundTrip[] = [];
  for (const [mint, events] of byMint) {
    events.sort((a, b) => a.ts - b.ts || a.slot - b.slot);
    let cur: RoundTrip | null = null;
    let balance = 0;
    for (const ev of events) {
      if (ev.kind === 'xfer') {
        const t = ev.t;
        if (t.direction === 'IN') {
          if (!cur) cur = newTrip(t.wallet, mint, t.blockTime, 'transfer');
          cur.transferIn += t.amount;
          balance += t.amount;
          cur.peakTokens = Math.max(cur.peakTokens, balance);
        } else if (cur) {
          cur.transferOut += t.amount;
          balance = Math.max(0, balance - t.amount);
        }
      } else {
        const s = ev.s;
        if (s.side === 'BUY') {
          if (!cur) cur = newTrip(s.wallet, mint, s.blockTime, s.dex);
          if (cur.dex === 'transfer') cur.dex = s.dex;
          cur.buys.push({ ts: s.blockTime, slot: s.slot, side: 'BUY', tokens: s.tokenAmount, sol: s.solValue, price: s.priceSol });
          cur.costSol += s.solValue;
          cur.tokensBought += s.tokenAmount;
          balance += s.tokenAmount;
          cur.peakTokens = Math.max(cur.peakTokens, balance);
        } else {
          if (!cur) continue; // geçmişi alınmamış bir pozisyonun satışı
          cur.sells.push({ ts: s.blockTime, slot: s.slot, side: 'SELL', tokens: s.tokenAmount, sol: s.solValue, price: s.priceSol });
          cur.proceedsSol += s.solValue;
          cur.tokensSold += s.tokenAmount;
          balance = Math.max(0, balance - s.tokenAmount);
        }
      }
      if (cur && balance <= cur.peakTokens * CLOSE_RATIO && (cur.sells.length > 0 || cur.transferOut > 0)) {
        cur.status = 'closed';
        cur.closedAt = ev.ts;
        finalize(cur);
        trips.push(cur);
        cur = null;
        balance = 0;
      }
    }
    if (cur) {
      finalize(cur);
      trips.push(cur);
    }
  }
  return trips.sort((a, b) => a.openedAt - b.openedAt);
}
