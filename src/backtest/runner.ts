import { childLogger } from '../core/logger.js';
import { tokenLaunchMs, type TokenInfo } from '../core/types.js';
import { geckoterminal, type Timeframe } from '../data/geckoterminal.js';
import { getDb } from '../storage/db.js';
import { tokens as tokenRepo, type Candle } from '../storage/repo.js';
import { universe as universeRepo } from '../discovery/universe.js';
import type { StrategySpec } from '../strategy/types.js';
import { simulatePortfolio, simulateToken, type PortfolioResult, type SimTrade } from './simulator.js';

const log = childLogger('backtest');

export interface BacktestReport extends PortfolioResult {
  strategyId: string;
  universe: number;
  universeSource: 'unbiased' | 'mixed';
  unbiasedAvailable: number;
  coverage: CoverageStats;
  tokensWithSignal: number;
  feePctPerSide: number;
  warnings: string[];
  sampleTrades: SimTrade[];
}

/** Mum kaynağı: testlerde sentetik veriyle değiştirilebilir */
export type CandleProvider = (pool: string, tf: Timeframe, aggregate: number, fromSec: number, toSec: number) => Promise<Candle[]>;

export const geckoCandles: CandleProvider = (pool, tf, aggregate, from, to) => geckoterminal.ohlcvRange(pool, tf, aggregate, from, to);

export interface TimeWindow {
  /** saniye, dahil */
  from: number;
  /** saniye, hariç */
  to: number;
}

const isMemeToken = (mint: string, mcap?: number) => mint.endsWith('pump') || (mcap !== undefined && mcap < 5_000_000);

/** Uzun vadeli stratejilerde (havuz yaşı sınırı > 7 gün) tokenın açılışı değil, belirli bir dönemin mumları kullanılır */
export const isLongHorizon = (spec: StrategySpec) => spec.entry.maxPoolAgeSec > 7 * 86400;

export const defaultFee = (spec: StrategySpec) => (spec.segment === 'memecoin' ? 1.5 : 0.4);

/**
 * Stratejiye uygun tokenlar. Pencere verilirse kısa vadeli stratejilerde sadece o pencerede açılan tokenlar,
 * uzun vadelilerde pencere bitmeden açılmış tüm tokenlar alınır. Açılış zamanına göre eskiden yeniye sıralı.
 */
export function filterUniverse(spec: StrategySpec, all: TokenInfo[], window?: TimeWindow): TokenInfo[] {
  return all
    .filter((t) => t.pairAddress && t.pairCreatedAt)
    .filter((t) => (spec.segment === 'memecoin') === isMemeToken(t.mint, t.marketCapUsd))
    .filter((t) => {
      if (!window) return true;
      const created = tokenLaunchMs(t)! / 1000;
      return isLongHorizon(spec) ? created < window.to : created >= window.from && created < window.to;
    })
    .sort((a, b) => (tokenLaunchMs(a) ?? 0) - (tokenLaunchMs(b) ?? 0));
}

/**
 * Listeden zamana eşit yayılmış n öğe seçer (deterministik). Sadece en yenileri almak dönemin
 * son birkaç saatine yığılırdı; yayılmış örneklem dönemin tamamını temsil eder.
 */
export function spreadSample<T>(sorted: T[], n: number): T[] {
  if (sorted.length <= n) return sorted;
  if (n <= 0) return [];
  if (n === 1) return [sorted[Math.floor(sorted.length / 2)]!];
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(sorted[Math.round((i * (sorted.length - 1)) / (n - 1))]!);
  return out;
}

/** Tarafsız evrenin tek başına kullanılması için gereken en az token sayısı */
export const MIN_UNBIASED = 20;

export interface UniversePick {
  tokens: TokenInfo[];
  /** unbiased: sadece açılış anında kaydedilen tokenlar; mixed: trend/cüzdan tokenları da dahil */
  source: 'unbiased' | 'mixed';
  unbiasedAvailable: number;
}

/**
 * Backtest evreni seçimi. Tarafsız evrende yeterli token varsa SADECE onlar kullanılır
 * (trend/cüzdan tokenlarıyla karıştırmak yanlılığı geri getirir). Yoksa ikisi birleştirilir,
 * aynı token iki listede varsa tarafsız kaydı (açılış havuzu) öncelikli olur.
 */
export function pickUniverse(
  spec: StrategySpec,
  observed: TokenInfo[],
  unbiased: TokenInfo[],
  window: TimeWindow | undefined,
  max: number,
): UniversePick {
  const u = filterUniverse(spec, unbiased, window);
  if (u.length >= MIN_UNBIASED) return { tokens: spreadSample(u, max), source: 'unbiased', unbiasedAvailable: u.length };
  const seen = new Set(u.map((t) => t.mint));
  const merged = [...u, ...filterUniverse(spec, observed, window).filter((t) => !seen.has(t.mint))].sort(
    (a, b) => (tokenLaunchMs(a) ?? 0) - (tokenLaunchMs(b) ?? 0),
  );
  return { tokens: spreadSample(merged, max), source: 'mixed', unbiasedAvailable: u.length };
}

/**
 * İşlem olmayan dakikalarda mum gelmez. Boşluklar bir önceki kapanışla (hacim 0) doldurulur ve
 * seri `toSec`'e kadar uzatılır; böylece "5 dk önce" ve tutma süresi hesapları kaymaz.
 */
export function fillCandleGaps(candles: Candle[], stepSec: number, toSec: number): Candle[] {
  if (!candles.length) return candles;
  const out: Candle[] = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    const prev = out[out.length - 1];
    if (prev) {
      for (let ts = prev.ts + stepSec; ts < c.ts; ts += stepSec) out.push({ ts, o: prev.c, h: prev.c, l: prev.c, c: prev.c, v: 0 });
    }
    out.push(c);
  }
  const last = out[out.length - 1]!;
  for (let ts = last.ts + stepSec; ts <= toSec; ts += stepSec) out.push({ ts, o: last.c, h: last.c, l: last.c, c: last.c, v: 0 });
  return out;
}

/** Backtest kapsam istatistikleri: fiyat verisi bulunamayan tokenlar yanlılık kaynağıdır */
export interface CoverageStats {
  attempted: number;
  noCandles: number;
  noSupply: number;
}

/**
 * Evrendeki her token için tek pozisyon simülasyonu. Pencere verilirse giriş pencerenin içinde olmalı;
 * pencere içinde açılan pozisyonların çıkışı pencere bitse de izlenir.
 */
export async function collectTrades(
  spec: StrategySpec,
  universe: TokenInfo[],
  opts: { feePctPerSide: number; candles?: CandleProvider; window?: TimeWindow; nowSec?: number; stats?: CoverageStats },
): Promise<SimTrade[]> {
  const provider = opts.candles ?? geckoCandles;
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const trades: SimTrade[] = [];
  for (const t of universe) {
    const created = Math.floor(t.pairCreatedAt! / 1000);
    // giriş penceresi token yaşına göre (çıkıştan itibaren); mumlar ise havuzun açılışından başlar
    const launched = Math.floor((tokenLaunchMs(t) ?? t.pairCreatedAt!) / 1000);
    const supply = t.supply ?? (t.marketCapUsd && t.priceUsd ? t.marketCapUsd / t.priceUsd : undefined);
    if (opts.stats) opts.stats.attempted++;
    if (!supply) {
      if (opts.stats) opts.stats.noSupply++;
      continue;
    }
    let from: number;
    let to: number;
    if (isLongHorizon(spec)) {
      from = opts.window ? Math.max(opts.window.from, created) : nowSec - 30 * 86400;
      to = Math.min(nowSec, opts.window ? opts.window.to + spec.exit.maxHoldSec : nowSec);
    } else {
      from = created;
      to = Math.min(nowSec, launched + spec.entry.maxPoolAgeSec + spec.exit.maxHoldSec);
    }
    if (to <= from) continue;
    try {
      const span = to - from;
      const tf = isLongHorizon(spec) ? 'hour' : 'minute';
      const aggregate = isLongHorizon(spec) ? 1 : span > 2 * 86400 ? 15 : span > 12 * 3600 ? 5 : 1;
      const raw = await provider(t.pairAddress!, tf, aggregate, from, to);
      if (!raw.length) {
        if (opts.stats) opts.stats.noCandles++;
        continue;
      }
      const candles = fillCandleGaps(raw, (tf === 'hour' ? 3600 : 60) * aggregate, to);
      const r = simulateToken(spec, { mint: t.mint, pairCreatedAtSec: created, launchedAtSec: launched, supply }, candles, {
        feePctPerSide: opts.feePctPerSide,
      });
      if (!r) continue;
      if (opts.window && (r.entryTs < opts.window.from || r.entryTs >= opts.window.to)) continue;
      trades.push(r);
    } catch (err) {
      if (opts.stats) opts.stats.noCandles++;
      log.debug({ mint: t.mint, err: String(err) }, 'mum alınamadı');
    }
  }
  return trades;
}

/**
 * Kapsam ve evren kaynağına göre dürüst uyarılar.
 * `scope: 'windows'` walk-forward içindir: unbiasedAvailable pencere başına en düşük değerdir,
 * `tokens` tüm pencerelerde kullanılan toplam token sayısıdır.
 */
export function universeWarnings(
  u: { source: UniversePick['source']; unbiasedAvailable: number; tokens: number },
  stats: CoverageStats,
  scope: 'backtest' | 'windows' = 'backtest',
): string[] {
  const w: string[] = [];
  if (u.source === 'unbiased') {
    w.push(
      scope === 'backtest'
        ? `Tarafsız evren kullanıldı: ${u.tokens} token (uygun ${u.unbiasedAvailable} token içinden), açıldıkları anda performanslarına bakılmadan kaydedildi.`
        : `Tüm test pencerelerinde tarafsız evren kullanıldı: toplam ${u.tokens} token, açıldıkları anda performanslarına bakılmadan kaydedildi.`,
    );
  } else {
    w.push(
      'Evren trend listelerinden ve analiz edilen cüzdanların tokenlarından oluşuyor: hayatta kalan tokenlara doğru yanlılık (survivorship bias) var, gerçek sonuçlar daha kötü olabilir.',
    );
    w.push(
      scope === 'backtest'
        ? `Tarafsız evrende bu strateji için ${u.unbiasedAvailable} token var (en az ${MIN_UNBIASED} gerekli). Kayıt biriktikçe otomatik kullanılacak.`
        : `Bazı test pencerelerinde tarafsız evrende yeterli token yok (en az ${u.unbiasedAvailable}, gerekli ${MIN_UNBIASED}). Kayıt biriktikçe otomatik kullanılacak.`,
    );
  }
  const missing = stats.noCandles + stats.noSupply;
  if (stats.attempted > 0 && missing / stats.attempted > 0.2) {
    w.push(
      `${stats.attempted} tokenın ${missing}'inde fiyat/arz verisi bulunamadı (%${Math.round((100 * missing) / stats.attempted)}). Bunlar çoğunlukla ölü tokenlar olduğundan sonuçlar iyimser olabilir.`,
    );
  }
  return w;
}

/**
 * Yerel veritabanındaki token evreni üzerinde backtest. Evren: keşif ve cüzdan analizinde
 * görülen tüm tokenlar (cüzdanların dokunmadıkları dahil). Mumlar GeckoTerminal'den çekilir ve önbelleklenir.
 */
export async function runBacktest(spec: StrategySpec, opts: { maxTokens?: number; feePctPerSide?: number } = {}): Promise<BacktestReport> {
  const fee = opts.feePctPerSide ?? defaultFee(spec);
  const pick = pickUniverse(spec, tokenRepo.all(), universeRepo.all(), undefined, opts.maxTokens ?? 60);
  const universe = pick.tokens;
  const coverage: CoverageStats = { attempted: 0, noCandles: 0, noSupply: 0 };
  const trades = await collectTrades(spec, universe, { feePctPerSide: fee, stats: coverage });
  const portfolio = simulatePortfolio(spec, trades);
  const warnings = [
    ...universeWarnings({ ...pick, tokens: universe.length }, coverage),
    'Likidite ve alım/satım sayısı koşulları mum verisinde olmadığı için backtest\'te uygulanmadı.',
    'Strateji büyük ölçüde aynı dönemin verisinden çıkarıldı: bu sonuç iyimserdir. Görülmemiş veride test için /walkforward kullanın.',
  ];
  if (trades.length < 20) warnings.push(`Sadece ${trades.length} işlem: istatistiksel olarak zayıf. Daha fazla keşif/veri gerekli.`);
  const report: BacktestReport = {
    strategyId: spec.id,
    universe: universe.length,
    universeSource: pick.source,
    unbiasedAvailable: pick.unbiasedAvailable,
    coverage,
    tokensWithSignal: trades.length,
    feePctPerSide: fee,
    warnings,
    sampleTrades: trades.slice(0, 10),
    ...portfolio,
  };
  getDb()
    .prepare('INSERT INTO backtests(strategy_id, created_at, json) VALUES (?, ?, ?)')
    .run(spec.id, Date.now(), JSON.stringify({ ...report, equityCurve: report.equityCurve.slice(-200) }));
  return report;
}
