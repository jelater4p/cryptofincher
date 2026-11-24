import { getDb } from './db.js';
import type { SwapEvent, TokenInfo, TransferEvent } from '../core/types.js';

// ---------------- KV ----------------
export const kv = {
  get<T>(key: string, def: T): T {
    const row = getDb().prepare('SELECT value FROM kv WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row ? (JSON.parse(row.value) as T) : def;
  },
  set(key: string, value: unknown) {
    getDb()
      .prepare('INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  },
};

// ---------------- Wallets ----------------
export interface WalletRow {
  address: string;
  source: 'manual' | 'discovered';
  label: string | null;
  added_at: number;
  discovered_from: string | null;
  last_analyzed_at: number | null;
  newest_signature: string | null;
  /** son analizde kullanılan geçmiş derinliği (işlem sayısı sınırı) */
  history_max: number | null;
  status: 'active' | 'excluded';
}

export const wallets = {
  add(address: string, source: WalletRow['source'], opts: { label?: string; from?: string } = {}) {
    getDb()
      .prepare(
        `INSERT INTO wallets(address, source, label, added_at, discovered_from)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(address) DO UPDATE SET
           label = COALESCE(excluded.label, wallets.label),
           source = CASE WHEN excluded.source = 'manual' THEN 'manual' ELSE wallets.source END`,
      )
      .run(address, source, opts.label ?? null, Date.now(), opts.from ?? null);
  },
  get(address: string) {
    return getDb().prepare('SELECT * FROM wallets WHERE address = ?').get(address) as WalletRow | undefined;
  },
  list(status?: WalletRow['status']) {
    return (
      status
        ? getDb().prepare('SELECT * FROM wallets WHERE status = ? ORDER BY added_at DESC').all(status)
        : getDb().prepare('SELECT * FROM wallets ORDER BY added_at DESC').all()
    ) as WalletRow[];
  },
  setStatus(address: string, status: WalletRow['status']) {
    getDb().prepare('UPDATE wallets SET status = ? WHERE address = ?').run(status, address);
  },
  remove(address: string) {
    getDb().prepare('DELETE FROM wallets WHERE address = ?').run(address);
  },
  markAnalyzed(address: string, newestSignature: string | null, historyMax?: number) {
    getDb()
      .prepare(
        'UPDATE wallets SET last_analyzed_at = ?, newest_signature = COALESCE(?, newest_signature), history_max = COALESCE(?, history_max) WHERE address = ?',
      )
      .run(Date.now(), newestSignature, historyMax ?? null, address);
  },
};

// ---------------- Swaps / Transfers ----------------
export const swaps = {
  insertMany(events: SwapEvent[]) {
    const stmt = getDb().prepare(
      `INSERT OR IGNORE INTO swaps(signature, wallet, mint, side, token_amount, quote_mint, quote_amount,
        sol_value, price_sol, block_time, slot, dex)
       VALUES (@signature, @wallet, @mint, @side, @tokenAmount, @quoteMint, @quoteAmount,
        @solValue, @priceSol, @blockTime, @slot, @dex)`,
    );
    const tx = getDb().transaction((rows: SwapEvent[]) => rows.forEach((r) => stmt.run(r)));
    tx(events);
  },
  byWallet(wallet: string): SwapEvent[] {
    return getDb()
      .prepare(
        `SELECT signature, wallet, mint, side, token_amount AS tokenAmount, quote_mint AS quoteMint,
          quote_amount AS quoteAmount, sol_value AS solValue, price_sol AS priceSol,
          block_time AS blockTime, slot, dex
         FROM swaps WHERE wallet = ? ORDER BY block_time, slot`,
      )
      .all(wallet) as SwapEvent[];
  },
  byMint(mint: string): SwapEvent[] {
    return getDb()
      .prepare(
        `SELECT signature, wallet, mint, side, token_amount AS tokenAmount, quote_mint AS quoteMint,
          quote_amount AS quoteAmount, sol_value AS solValue, price_sol AS priceSol,
          block_time AS blockTime, slot, dex
         FROM swaps WHERE mint = ? ORDER BY block_time, slot`,
      )
      .all(mint) as SwapEvent[];
  },
  distinctMints(): string[] {
    return (getDb().prepare('SELECT DISTINCT mint FROM swaps').all() as { mint: string }[]).map((r) => r.mint);
  },
};

export const transfers = {
  insertMany(events: TransferEvent[]) {
    const stmt = getDb().prepare(
      `INSERT OR IGNORE INTO transfers(signature, wallet, mint, direction, amount, block_time)
       VALUES (@signature, @wallet, @mint, @direction, @amount, @blockTime)`,
    );
    const tx = getDb().transaction((rows: TransferEvent[]) => rows.forEach((r) => stmt.run(r)));
    tx(events);
  },
  byWallet(wallet: string): TransferEvent[] {
    return getDb()
      .prepare(
        `SELECT signature, wallet, mint, direction, amount, block_time AS blockTime
         FROM transfers WHERE wallet = ? ORDER BY block_time`,
      )
      .all(wallet) as TransferEvent[];
  },
};

export const seen = {
  has(wallet: string, signature: string) {
    return !!getDb().prepare('SELECT 1 FROM seen_signatures WHERE wallet = ? AND signature = ?').get(wallet, signature);
  },
  addMany(wallet: string, signatures: string[]) {
    const stmt = getDb().prepare('INSERT OR IGNORE INTO seen_signatures(wallet, signature) VALUES (?, ?)');
    const tx = getDb().transaction((sigs: string[]) => sigs.forEach((s) => stmt.run(wallet, s)));
    tx(signatures);
  },
};

// ---------------- Tokens ----------------
export const tokens = {
  upsert(info: TokenInfo) {
    const prev: Partial<TokenInfo> = tokens.get(info.mint) ?? {};
    const merged: TokenInfo = { ...prev, ...stripUndefined(info), mint: info.mint, updatedAt: Date.now() };
    // çıkış zamanı sadece geriye gidebilir: sonraki bir sorguda eski havuz listelenmese bile kaybolmasın
    const launches = [prev.launchedAt, info.launchedAt].filter((x): x is number => typeof x === 'number');
    if (launches.length) merged.launchedAt = Math.min(...launches);
    getDb()
      .prepare(
        'INSERT INTO tokens(mint, json, updated_at) VALUES(?, ?, ?) ON CONFLICT(mint) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at',
      )
      .run(info.mint, JSON.stringify(merged), Date.now());
    return merged;
  },
  get(mint: string): TokenInfo | undefined {
    const row = getDb().prepare('SELECT json FROM tokens WHERE mint = ?').get(mint) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as TokenInfo) : undefined;
  },
  all(): TokenInfo[] {
    return (getDb().prepare('SELECT json FROM tokens').all() as { json: string }[]).map((r) => JSON.parse(r.json));
  },
};

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

// ---------------- Candles / SOL price ----------------
export interface Candle {
  ts: number; // saniye
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export const candles = {
  insertMany(pool: string, tf: string, rows: Candle[]) {
    const stmt = getDb().prepare(
      'INSERT OR REPLACE INTO candles(pool, tf, ts, o, h, l, c, v) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const tx = getDb().transaction((rs: Candle[]) => rs.forEach((r) => stmt.run(pool, tf, r.ts, r.o, r.h, r.l, r.c, r.v)));
    tx(rows);
  },
  range(pool: string, tf: string, fromTs: number, toTs: number): Candle[] {
    return getDb()
      .prepare('SELECT ts, o, h, l, c, v FROM candles WHERE pool = ? AND tf = ? AND ts BETWEEN ? AND ? ORDER BY ts')
      .all(pool, tf, fromTs, toTs) as Candle[];
  },
};

export const solPrice = {
  get(day: number): number | undefined {
    const row = getDb().prepare('SELECT usd FROM sol_price WHERE day = ?').get(day) as { usd: number } | undefined;
    return row?.usd;
  },
  nearest(day: number): number | undefined {
    const row = getDb()
      .prepare('SELECT usd FROM sol_price ORDER BY ABS(day - ?) LIMIT 1')
      .get(day) as { usd: number } | undefined;
    return row?.usd;
  },
  setMany(rows: Array<{ day: number; usd: number }>) {
    const stmt = getDb().prepare('INSERT OR REPLACE INTO sol_price(day, usd) VALUES (?, ?)');
    const tx = getDb().transaction((rs: typeof rows) => rs.forEach((r) => stmt.run(r.day, r.usd)));
    tx(rows);
  },
};

// ---------------- Trip context (zenginleştirme) ----------------
export interface TripContext {
  /** girişten önceki 5/15 dakikadaki fiyat değişimi (%) */
  preChange5m?: number;
  preChange15m?: number;
  /** girişten önceki 15 dk hacmin, önceki 60 dk ortalamasına oranı */
  volumeSurge?: number;
  /** pozisyon süresince görülen en yüksek fiyat / giriş fiyatı */
  peakMultiple?: number;
  /** pozisyon süresince en düşük fiyat / giriş fiyatı */
  troughMultiple?: number;
}

export const tripContext = {
  get(wallet: string, mint: string, openedAt: number): TripContext | undefined {
    const row = getDb()
      .prepare('SELECT json FROM trip_context WHERE wallet = ? AND mint = ? AND opened_at = ?')
      .get(wallet, mint, openedAt) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as TripContext) : undefined;
  },
  set(wallet: string, mint: string, openedAt: number, ctx: TripContext) {
    getDb()
      .prepare('INSERT OR REPLACE INTO trip_context(wallet, mint, opened_at, json) VALUES (?, ?, ?, ?)')
      .run(wallet, mint, openedAt, JSON.stringify(ctx));
  },
};

// ---------------- Cüzdan kaynakları (çoklu kazanan sinyali) ----------------
export const walletSources = {
  /** Cüzdanın bir kazanan tokende bulunduğunu kaydeder; 'early' kaydı 'recent'in üzerine yazılır */
  record(wallet: string, mint: string, kind: 'early' | 'recent', at = Date.now()) {
    getDb()
      .prepare(
        `INSERT INTO wallet_sources(wallet, mint, kind, found_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(wallet, mint) DO UPDATE SET kind = CASE WHEN excluded.kind = 'early' THEN 'early' ELSE wallet_sources.kind END`,
      )
      .run(wallet, mint, kind, at);
  },
  /**
   * Cüzdan → erken alıcı olduğu farklı kazanan token sayısı. Bu tablodan önceki sürümlerde sadece
   * ilk bulunduğu token (wallets.discovered_from) saklanıyordu; o da sayıma dahil edilir.
   */
  winnerCounts(): Map<string, number> {
    const rows = getDb()
      .prepare(
        `SELECT wallet, COUNT(DISTINCT mint) AS n FROM (
           SELECT wallet, mint FROM wallet_sources WHERE kind = 'early'
           UNION SELECT address AS wallet, discovered_from AS mint FROM wallets WHERE discovered_from IS NOT NULL
         ) GROUP BY wallet`,
      )
      .all() as Array<{ wallet: string; n: number }>;
    return new Map(rows.map((r) => [r.wallet, r.n]));
  },
};
