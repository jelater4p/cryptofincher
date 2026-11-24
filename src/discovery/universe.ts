import { config } from '../config.js';
import { PUMPFUN_TOTAL_SUPPLY, QUOTE_MINTS } from '../core/constants.js';
import { childLogger } from '../core/logger.js';
import type { TokenInfo } from '../core/types.js';
import { geckoterminal, type GtPool } from '../data/geckoterminal.js';
import { getDb } from '../storage/db.js';

const log = childLogger('universe');

/**
 * Tarafsız token evreni.
 *
 * Backtest'in en büyük zayıflığı, test edilen tokenların trend listelerinden yani sonradan
 * yükselmiş "kazananlardan" seçilmesi (survivorship bias). Burada tokenlar AÇILDIKLARI ANDA,
 * gelecekteki performansları bilinmeden kaydedilir; ölenler de evrende kalır.
 * İlk görülen havuz sabittir: token sonradan başka bir DEX'e taşınsa bile değişmez.
 */
export interface UniverseRow {
  mint: string;
  pool: string;
  dex: string | null;
  createdAt: number; // ms
  supply: number | null;
  initialFdvUsd: number | null;
  recordedAt: number;
}

const stripPrefix = (id?: string | null) => (id ? id.replace(/^solana_/, '') : undefined);
const num = (x?: string | null) => {
  if (x === null || x === undefined || x === '') return undefined;
  const n = Number(x);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/** GeckoTerminal havuz kaydını evren satırına çevirir; eksik/uygunsuz kayıtta null (saf fonksiyon) */
export function parsePool(p: GtPool, nowMs = Date.now()): UniverseRow | null {
  const pool = p.attributes?.address;
  const mint = stripPrefix(p.relationships?.base_token?.data?.id);
  if (!pool || !mint) return null;
  if (QUOTE_MINTS.has(mint)) return null; // ters çevrilmiş havuz (taban SOL/USDC)
  const created = p.attributes?.pool_created_at ? Date.parse(p.attributes.pool_created_at) : NaN;
  const price = num(p.attributes?.base_token_price_usd);
  const fdv = num(p.attributes?.fdv_usd) ?? num(p.attributes?.market_cap_usd);
  let supply = price && fdv ? fdv / price : undefined;
  if (!supply && mint.endsWith('pump')) supply = PUMPFUN_TOTAL_SUPPLY;
  return {
    mint,
    pool,
    dex: stripPrefix(p.relationships?.dex?.data?.id) ?? null,
    // yeni havuzlar listesinde açılış zamanı yoksa ilk görülme zamanı (dakikalar içinde) yaklaşık doğrudur
    createdAt: Number.isFinite(created) ? created : nowMs,
    supply: supply ?? null,
    initialFdvUsd: fdv ?? null,
    recordedAt: nowMs,
  };
}

export const universe = {
  /** Yeni satırları ekler; zaten kayıtlı tokenın havuzu değişmez. Eklenen sayıyı döner. */
  insertMany(rows: UniverseRow[]): number {
    const stmt = getDb().prepare(
      `INSERT OR IGNORE INTO universe(mint, pool, dex, created_at, supply, initial_fdv_usd, recorded_at)
       VALUES (@mint, @pool, @dex, @createdAt, @supply, @initialFdvUsd, @recordedAt)`,
    );
    let added = 0;
    getDb().transaction((rs: UniverseRow[]) => {
      for (const r of rs) added += stmt.run(r).changes;
    })(rows);
    return added;
  },

  /** Backtest'in kullandığı biçimde (TokenInfo) tüm evren */
  all(): TokenInfo[] {
    const rows = getDb().prepare('SELECT * FROM universe ORDER BY created_at').all() as Array<{
      mint: string;
      pool: string;
      dex: string | null;
      created_at: number;
      supply: number | null;
      initial_fdv_usd: number | null;
    }>;
    return rows.map((r) => ({
      mint: r.mint,
      pairAddress: r.pool,
      pairCreatedAt: r.created_at,
      dexId: r.dex ?? undefined,
      supply: r.supply ?? undefined,
      marketCapUsd: r.initial_fdv_usd ?? undefined,
    }));
  },

  countSince(ms: number): number {
    return (getDb().prepare('SELECT COUNT(*) AS n FROM universe WHERE recorded_at >= ?').get(ms) as { n: number }).n;
  },

  total(): number {
    return (getDb().prepare('SELECT COUNT(*) AS n FROM universe').get() as { n: number }).n;
  },

  prune(olderThanMs: number): number {
    return getDb().prepare('DELETE FROM universe WHERE created_at < ?').run(olderThanMs).changes;
  },
};

/** Bir tur kayıt: yeni havuzlar listesini çekip evrene ekler */
export async function recordNewPools(nowMs = Date.now()): Promise<{ fetched: number; parsed: number; added: number; rows: UniverseRow[] }> {
  const pools = await geckoterminal.newPools(1);
  const rows = pools.map((p) => parsePool(p, nowMs)).filter((r): r is UniverseRow => r !== null);
  if (pools.length > 0 && rows.length === 0) {
    log.warn({ fetched: pools.length }, 'yeni havuzlar ayrıştırılamadı: GeckoTerminal yanıt formatı değişmiş olabilir');
  }
  const added = universe.insertMany(rows);
  return { fetched: pools.length, parsed: rows.length, added, rows };
}

let failures = 0;

/**
 * @param onPools her turda bulunan yeni havuzlar (işlem taramasına aday olarak verilir)
 */
export function startUniverseRecorder(onPools?: (rows: UniverseRow[]) => void): NodeJS.Timeout | null {
  const minutes = config.UNIVERSE_RECORDER_MINUTES;
  if (minutes <= 0) {
    log.info('tarafsız evren kaydı kapalı');
    return null;
  }
  const tick = async () => {
    try {
      const r = await recordNewPools();
      failures = 0;
      log.debug({ fetched: r.fetched, parsed: r.parsed, added: r.added }, 'evren kaydı');
      if (r.rows.length) onPools?.(r.rows);
      // saklama süresini aşan kayıtları temizle (indeksli, ucuz sorgu)
      universe.prune(Date.now() - config.UNIVERSE_RETENTION_DAYS * 86400_000);
    } catch (err) {
      failures++;
      // geçici ağ hatası normal; sürekli hata ise logla (günlük özette sayının düşmesi de görünür)
      if (failures % 12 === 1) log.warn({ err: String(err), failures }, 'evren kaydı başarısız');
    }
  };
  void tick();
  log.info({ minutes }, 'tarafsız evren kaydı açık');
  return setInterval(() => void tick(), minutes * 60_000);
}
