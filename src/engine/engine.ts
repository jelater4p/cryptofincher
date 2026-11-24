import { config } from '../config.js';
import { HttpError } from '../core/http.js';
import { childLogger } from '../core/logger.js';
import type { TokenInfo } from '../core/types.js';
import { dexscreener } from '../data/dexscreener.js';
import { jupiter } from '../data/jupiter.js';
import { startPumpfunStream } from '../data/pumpfunStream.js';
import { solPriceService } from '../data/solPrice.js';
import { kv, tokens as tokenRepo } from '../storage/repo.js';
import { strategies } from '../strategy/registry.js';
import { decideExit, evaluateEntry } from '../strategy/rules.js';
import type { StrategySpec } from '../strategy/types.js';
import { NoBalanceError, type Executor } from './executor.js';
import { positionsRepo, type PositionRow } from './positionsRepo.js';
import { checkTokenSafety } from './safety.js';
import { engineState, events } from './state.js';

const log = childLogger('engine');

/** Jupiter "bu token için rota/likidite yok" hatası mı (ağ ve sunucu hataları hariç) */
export function isNoRouteError(err: unknown): boolean {
  if (err instanceof HttpError && (err.status >= 500 || err.status === 429)) return false;
  const msg = err instanceof HttpError ? err.body : String(err);
  return /route|not.?tradable|no liquidity|insufficient liquidity/i.test(msg);
}

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
  /** satışın ilk başarısız olduğu an: paper modda uzun süre satılamayan pozisyon kapatılır */
  private sellFailSince = new Map<number, number>();
  /** fiyatın ilk alınamadığı an ve uyarı gönderilip gönderilmediği */
  private noPriceSince = new Map<number, number>();
  private noPriceNotified = new Set<number>();

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
      this.stopStream = startPumpfunStream(
        (e) => this.addCandidate(e.mint),
        (msg) => events.emit('notify', msg),
      );
    }
    log.info({ mode: engineState.mode() }, 'motor başladı');
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.stopStream?.();
  }

  /**
   * Taramaya aday ekler. Liste ekleme anında sınırlanır: pump.fun akışı günde on binlerce token
   * getirebilir ve aktif strateji yokken tarama (ve onun temizliği) çalışmaz. Map ekleme sırasını
   * koruduğu için en eski adaylar baştadır.
   */
  addCandidate(mint: string, now = Date.now()) {
    if (this.candidates.has(mint)) return;
    this.candidates.set(mint, now);
    const cap = config.SCAN_MAX_CANDIDATES;
    for (const oldest of this.candidates.keys()) {
      if (this.candidates.size <= cap) break;
      this.candidates.delete(oldest);
    }
  }

  candidateCount(): number {
    return this.candidates.size;
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
    const watch = new Set(this.watchlist());
    for (const [m, at] of this.candidates) if (now - at > maxAgeMs && !watch.has(m)) this.candidates.delete(m);
    // üst sınır addCandidate'te uygulanıyor (SCAN_MAX_CANDIDATES)
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

  /**
   * Açık pozisyonların fiyatı: önce DexScreener, alınamazsa Jupiter. Biri çökse bile pozisyonlar yönetilir.
   */
  private async positionPrices(mints: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const infos = await dexscreener.tokens(mints).catch((err) => {
      log.warn({ err: String(err) }, 'DexScreener fiyatı alınamadı, Jupiter deneniyor');
      return new Map<string, TokenInfo>();
    });
    const solUsd = await solPriceService.now().catch(() => undefined);
    for (const [mint, info] of infos) {
      tokenRepo.upsert(info);
      const price = info.priceSol ?? (info.priceUsd && solUsd ? info.priceUsd / solUsd : undefined);
      if (price && price > 0) out.set(mint, price);
    }
    const missing = mints.filter((m) => !out.has(m));
    if (missing.length && solUsd) {
      const jp = await jupiter.prices(missing).catch(() => ({}) as Record<string, { usdPrice: number }>);
      for (const m of missing) {
        const usd = jp[m]?.usdPrice;
        if (usd && usd > 0) out.set(m, usd / solUsd);
      }
    }
    return out;
  }

  async positionTick() {
    if (this.busy.positions) return;
    const open = positionsRepo.listOpen();
    if (!open.length) return;
    this.busy.positions = true;
    try {
      const prices = await this.positionPrices([...new Set(open.map((p) => p.mint))]);
      for (const p of open) {
        const price = prices.get(p.mint);
        if (price === undefined) {
          await this.handleNoPrice(p);
          continue;
        }
        this.noPriceSince.delete(p.id);
        this.noPriceNotified.delete(p.id);
        await this.manage(p, price);
      }
    } catch (err) {
      log.warn({ err: String(err) }, 'pozisyon kontrol hatası');
    } finally {
      this.busy.positions = false;
    }
  }

  /**
   * Fiyat hiçbir kaynaktan alınamıyor (rug, listeden çıkma, kaynakların çökmesi). Zarar kesme fiyatsız
   * çalışamaz; ama maksimum tutma süresi yine uygulanır ve 10 dakikayı geçerse bir kez uyarılır.
   */
  private async handleNoPrice(p: PositionRow, now = Date.now()) {
    const spec = strategies.get(p.strategy_id)?.spec;
    if (spec && now - p.opened_at >= spec.exit.maxHoldSec * 1000) {
      await this.sell(p, p.remaining_tokens, 'max_hold', p.tp_hits, spec.execution.slippageBps);
      return;
    }
    const since = this.noPriceSince.get(p.id) ?? now;
    this.noPriceSince.set(p.id, since);
    if (now - since >= 10 * 60_000 && !this.noPriceNotified.has(p.id)) {
      this.noPriceNotified.add(p.id);
      events.emit(
        'notify',
        `⚠️ ${p.mode === 'paper' ? '[PAPER] ' : ''}${p.symbol ?? p.mint.slice(0, 6)} için 10 dakikadır fiyat alınamıyor (rug olmuş ya da listeden çıkmış olabilir). ` +
          `Fiyat yokken zarar kesme çalışamaz; maksimum tutma süresi dolunca satış denenecek. Hemen çıkmak için /panik.`,
      );
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
      this.sellFailSince.delete(p.id);
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
      if (err instanceof NoBalanceError) {
        // cüzdanda token kalmamış (elle satılmış, transfer edilmiş ya da toz): satışı sonsuza kadar denemek anlamsız
        if (positionsRepo.forceClose(p.id, 'no_balance'))
          events.emit('notify', `ℹ️ ${p.symbol ?? p.mint.slice(0, 6)}: cüzdanda token kalmadığı için pozisyon kapatıldı.`);
        return;
      }
      // sadece "rota/likidite yok" hataları sayılır; Jupiter'in çökmesi ya da ağ hatası sağlam pozisyonu sıfırlamamalı
      const failSince = isNoRouteError(err) ? (this.sellFailSince.get(p.id) ?? Date.now()) : undefined;
      if (failSince !== undefined) this.sellFailSince.set(p.id, failSince);
      if (p.mode === 'paper' && failSince !== undefined && Date.now() - failSince >= 30 * 60_000) {
        // paper'da 30 dk boyunca satılamayan token (likidite yok/rug) gerçekte de satılamazdı: 0 değerle kapat
        this.sellFailSince.delete(p.id);
        if (positionsRepo.forceClose(p.id, 'unsellable'))
          events.emit('notify', `🔴 [PAPER] ${p.symbol ?? p.mint.slice(0, 6)} 30 dakikadır satılamıyor (likidite yok ya da rug). Kalan tokenlar 0 değerle kapatıldı.`);
        return;
      }
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
