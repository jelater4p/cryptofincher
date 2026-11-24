import { config } from '../config.js';
import { childLogger } from '../core/logger.js';
import type { TokenInfo } from '../core/types.js';
import { dexscreener } from '../data/dexscreener.js';
import { startPumpfunStream } from '../data/pumpfunStream.js';
import { solPriceService } from '../data/solPrice.js';
import { kv, tokens as tokenRepo } from '../storage/repo.js';
import { strategies } from '../strategy/registry.js';
import { decideExit, evaluateEntry } from '../strategy/rules.js';
import type { StrategySpec } from '../strategy/types.js';
import type { Executor } from './executor.js';
import { positionsRepo, type PositionRow } from './positionsRepo.js';
import { checkTokenSafety } from './safety.js';
import { engineState, events } from './state.js';

const log = childLogger('engine');

/** Pozisyon büyüklüğü: özsermayenin yüzdesi, rezerv ve bakiye ile sınırlı (saf) */
export function positionSize(spec: StrategySpec, equitySol: number, freeSol: number, reserveSol: number): number {
  const target = (equitySol * spec.sizing.pctOfEquity) / 100;
  const firstTranche = spec.entry.dca ? target / spec.entry.dca.tranches : target;
  return Math.max(0, Math.min(firstTranche, freeSol - reserveSol));
}

export class TradingEngine {
  /** izlenen aday tokenlar: mint → ilk görülme */
  private candidates = new Map<string, number>();
  private timers: NodeJS.Timeout[] = [];
  private stopStream: (() => void) | null = null;
  private busy = { scan: false, positions: false };
  /** güvenlik kontrolünden geçemeyen tokenlar tekrar sorgulanmaz */
  private rejected = new Map<string, number>();
  /** başarısız satış bildirimlerini seyreltmek için: pozisyon id → son bildirim */
  private sellFailNotified = new Map<number, number>();

  constructor(
    private executors: { paper: Executor; live?: Executor },
  ) {}

  get executor(): Executor {
    const mode = engineState.mode();
    if (mode === 'live') {
      if (!this.executors.live) throw new Error('Canlı mod için keystore yüklenmedi');
      return this.executors.live;
    }
    return this.executors.paper;
  }

  canGoLive() {
    return !!this.executors.live;
  }

  start() {
    this.timers.push(setInterval(() => void this.scanTick(), config.SCAN_INTERVAL_SEC * 1000));
    this.timers.push(setInterval(() => void this.positionTick(), config.POSITION_CHECK_INTERVAL_SEC * 1000));
    if (config.PUMPFUN_STREAM) {
      this.stopStream = startPumpfunStream((e) => this.addCandidate(e.mint));
    }
    log.info({ mode: engineState.mode() }, 'motor başladı');
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.stopStream?.();
  }

  addCandidate(mint: string) {
    if (!this.candidates.has(mint)) this.candidates.set(mint, Date.now());
  }

  watchlist(): string[] {
    return kv.get<string[]>('watchlist', []);
  }

  private async collectCandidates() {
    const refs = await Promise.all([
      dexscreener.latestProfiles().catch(() => []),
      dexscreener.latestBoosts().catch(() => []),
    ]);
    for (const r of refs.flat()) this.addCandidate(r.tokenAddress);
    for (const m of this.watchlist()) this.addCandidate(m);
    // aktif stratejilerin izin verdiği en büyük havuz yaşına göre eski adayları at
    const maxAgeMs = Math.max(3600_000, ...strategies.active().map((s) => s.entry.maxPoolAgeSec * 1000));
    const now = Date.now();
    for (const [m, at] of this.candidates) if (now - at > maxAgeMs && !this.watchlist().includes(m)) this.candidates.delete(m);
    // en yeni 900 aday (30'luk 30 istek)
    if (this.candidates.size > 900) {
      const sorted = [...this.candidates.entries()].sort((a, b) => b[1] - a[1]).slice(0, 900);
      this.candidates = new Map(sorted);
    }
  }

  async scanTick() {
    if (this.busy.scan || engineState.isHalted()) return;
    const specs = strategies.active();
    if (!specs.length) return;
    this.busy.scan = true;
    try {
      await this.collectCandidates();
      const infos = await dexscreener.tokens([...this.candidates.keys()]);
      for (const info of infos.values()) tokenRepo.upsert(info);
      for (const spec of specs) {
        for (const info of infos.values()) {
          if (engineState.isHalted()) return;
          await this.tryEnter(spec, info);
        }
      }
    } catch (err) {
      log.warn({ err: String(err) }, 'tarama hatası');
    } finally {
      this.busy.scan = false;
    }
  }

  private async tryEnter(spec: StrategySpec, info: TokenInfo) {
    if (positionsRepo.hasOpenForMint(info.mint)) return;
    if (positionsRepo.recentlyTraded(info.mint, 6 * 3600_000)) return;
    if (positionsRepo.countOpen(spec.id) >= spec.sizing.maxOpenPositions) return;
    if (positionsRepo.countOpen() >= config.RISK_MAX_OPEN_POSITIONS) return;
    const rej = this.rejected.get(info.mint);
    if (rej && Date.now() - rej < 30 * 60_000) return;
    const d = evaluateEntry(spec, info);
    if (!d.pass) return;

    const safety = await checkTokenSafety(info.mint);
    if (!safety.ok) {
      this.rejected.set(info.mint, Date.now());
      log.info({ mint: info.mint, symbol: info.symbol, reasons: safety.reasons }, 'güvenlik filtresi reddetti');
      return;
    }

    const ex = this.executor;
    const free = await ex.balanceSol();
    const solUsd = await solPriceService.now().catch(() => undefined);
    const openValue = await this.openValueSol(ex.mode, solUsd);
    const size = positionSize(spec, free + openValue, free, config.RISK_SOL_RESERVE);
    if (size < 0.005) return;

    try {
      const fill = await ex.buy(info.mint, size, spec.execution.slippageBps);
      const id = positionsRepo.open({
        strategyId: spec.id,
        mode: ex.mode,
        mint: info.mint,
        symbol: info.symbol,
        priceSol: fill.priceSol,
        costSol: fill.solAmount,
        tokens: fill.tokenAmount,
      });
      positionsRepo.recordBuyFill(id, { tokens: fill.tokenAmount, sol: fill.solAmount, price: fill.priceSol, signature: fill.signature });
      events.emit(
        'notify',
        `🟢 ${ex.mode === 'paper' ? '[PAPER] ' : ''}ALIM ${info.symbol ?? info.mint.slice(0, 6)}\n` +
          `Strateji: ${spec.name}\nMiktar: ${fill.solAmount.toFixed(3)} SOL\nMcap: $${Math.round(info.marketCapUsd ?? 0).toLocaleString()}\n` +
          `RugCheck: ${safety.rugScore ?? '?'}  Fiyat etkisi: %${fill.priceImpactPct.toFixed(2)}\n` +
          `https://dexscreener.com/solana/${info.pairAddress ?? info.mint}`,
      );
    } catch (err) {
      log.warn({ mint: info.mint, err: String(err) }, 'alım başarısız');
      this.rejected.set(info.mint, Date.now());
    }
  }

  private async openValueSol(mode: 'paper' | 'live', solUsd?: number) {
    const open = positionsRepo.listOpen(mode);
    let v = 0;
    for (const p of open) {
      const t = tokenRepo.get(p.mint);
      const price = t?.priceSol ?? (t?.priceUsd && solUsd ? t.priceUsd / solUsd : p.entry_price_sol);
      v += p.remaining_tokens * price;
    }
    return v;
  }

  async positionTick() {
    if (this.busy.positions) return;
    const open = positionsRepo.listOpen();
    if (!open.length) return;
    this.busy.positions = true;
    try {
      const infos = await dexscreener.tokens([...new Set(open.map((p) => p.mint))]);
      const solUsd = await solPriceService.now().catch(() => undefined);
      for (const p of open) {
        const info = infos.get(p.mint);
        if (!info) continue;
        tokenRepo.upsert(info);
        const price = info.priceSol ?? (info.priceUsd && solUsd ? info.priceUsd / solUsd : undefined);
        if (!price) continue;
        await this.manage(p, price);
      }
    } catch (err) {
      log.warn({ err: String(err) }, 'pozisyon kontrol hatası');
    } finally {
      this.busy.positions = false;
    }
  }

  private executorFor(p: PositionRow): Executor | undefined {
    return p.mode === 'live' ? this.executors.live : this.executors.paper;
  }

  private async manage(p: PositionRow, price: number) {
    const spec = strategies.get(p.strategy_id)?.spec;
    if (!spec) return;
    positionsRepo.updatePeak(p.id, price);
    const d = decideExit(
      spec,
      {
        entryPrice: p.entry_price_sol,
        initialTokens: p.token_amount,
        remainingTokens: p.remaining_tokens,
        peakPrice: Math.max(p.peak_price_sol, price),
        tpHits: p.tp_hits,
        openedAtMs: p.opened_at,
      },
      price,
      Date.now(),
    );
    if (!d.reason || d.sellTokens <= 0) {
      await this.maybeDca(p, spec, price);
      return;
    }
    await this.sell(p, d.sellTokens, d.reason, d.newTpHits, spec.execution.slippageBps);
  }

  /** Strateji kademeli alım içeriyorsa düşüşte sonraki parçayı al */
  private async maybeDca(p: PositionRow, spec: StrategySpec, price: number) {
    const dca = spec.entry.dca;
    if (!dca || p.tp_hits > 0 || engineState.isHalted()) return;
    const bought = positionsRepo.buyFillCount(p.id);
    if (bought >= dca.tranches) return;
    // backtest ile aynı kural: güncel ortalama girişin dipPct altı
    if (price > p.entry_price_sol * (1 - dca.dipPct / 100)) return;
    const ex = this.executorFor(p);
    if (!ex) return;
    try {
      const tranche = p.cost_sol / bought;
      const free = await ex.balanceSol();
      const size = Math.min(tranche, free - config.RISK_SOL_RESERVE);
      if (size < 0.005) return;
      const fill = await ex.buy(p.mint, size, spec.execution.slippageBps);
      positionsRepo.addBuy(p.id, { tokens: fill.tokenAmount, sol: fill.solAmount, price: fill.priceSol, signature: fill.signature });
      events.emit('notify', `🔵 ${p.mode === 'paper' ? '[PAPER] ' : ''}DCA ${p.symbol ?? p.mint.slice(0, 6)}: +${fill.solAmount.toFixed(3)} SOL`);
    } catch (err) {
      log.warn({ id: p.id, err: String(err) }, 'DCA alımı başarısız');
    }
  }

  private async sell(p: PositionRow, tokens: number, reason: string, tpHits: number, slippageBps: number) {
    const ex = this.executorFor(p);
    if (!ex) {
      log.error({ id: p.id }, 'pozisyonun modu için yürütücü yok');
      return;
    }
    try {
      const fill = await ex.sell(p.mint, tokens, slippageBps);
      positionsRepo.recordSell(p.id, { tokens: fill.tokenAmount, sol: fill.solAmount, price: fill.priceSol, signature: fill.signature, reason, tpHits });
      const after = positionsRepo.get(p.id)!;
      const pnl = after.status === 'closed' ? after.proceeds_sol - after.cost_sol : null;
      events.emit(
        'notify',
        `${reason === 'stop_loss' ? '🔴' : '🟡'} ${p.mode === 'paper' ? '[PAPER] ' : ''}SATIŞ ${p.symbol ?? p.mint.slice(0, 6)} (${reason})\n` +
          `${fill.tokenAmount.toFixed(0)} token → ${fill.solAmount.toFixed(4)} SOL (x${(fill.priceSol / p.entry_price_sol).toFixed(2)})` +
          (pnl !== null ? `\nPozisyon kapandı. PnL: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL` : ''),
      );
    } catch (err) {
      log.warn({ id: p.id, err: String(err) }, 'satış başarısız');
      // pozisyon her 5 sn'de yeniden denenir: aynı pozisyon için en fazla 15 dk'da bir bildirim
      const last = this.sellFailNotified.get(p.id) ?? 0;
      if (Date.now() - last >= 15 * 60_000) {
        this.sellFailNotified.set(p.id, Date.now());
        events.emit('notify', `⚠️ Satış başarısız: ${p.symbol ?? p.mint} (${reason}): ${String(err).slice(0, 200)}\nYeniden deneniyor.`);
      }
    }
  }

  /** Acil durum: yeni girişleri durdur ve tüm açık pozisyonları sat */
  async panicSellAll(): Promise<number> {
    engineState.halt('PANİK: tüm pozisyonlar satılıyor');
    const open = positionsRepo.listOpen();
    for (const p of open) {
      const spec = strategies.get(p.strategy_id)?.spec;
      await this.sell(p, p.remaining_tokens, 'panic', p.tp_hits, Math.max(spec?.execution.slippageBps ?? 500, 1000));
    }
    return open.length;
  }
}
