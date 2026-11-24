import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

const MIGRATIONS: string[] = [
  `
  CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE IF NOT EXISTS wallets (
    address TEXT PRIMARY KEY,
    source TEXT NOT NULL,            -- manual | discovered
    label TEXT,
    added_at INTEGER NOT NULL,
    discovered_from TEXT,            -- hangi tokendan keşfedildi
    last_analyzed_at INTEGER,
    newest_signature TEXT,           -- artımlı senkron için
    status TEXT NOT NULL DEFAULT 'active'  -- active | excluded
  );

  CREATE TABLE IF NOT EXISTS swaps (
    signature TEXT NOT NULL,
    wallet TEXT NOT NULL,
    mint TEXT NOT NULL,
    side TEXT NOT NULL,
    token_amount REAL NOT NULL,
    quote_mint TEXT NOT NULL,
    quote_amount REAL NOT NULL,
    sol_value REAL NOT NULL,
    price_sol REAL NOT NULL,
    block_time INTEGER NOT NULL,
    slot INTEGER NOT NULL,
    dex TEXT NOT NULL,
    PRIMARY KEY (signature, wallet, mint)
  );
  CREATE INDEX IF NOT EXISTS idx_swaps_wallet ON swaps(wallet, block_time);
  CREATE INDEX IF NOT EXISTS idx_swaps_mint ON swaps(mint, block_time);

  CREATE TABLE IF NOT EXISTS transfers (
    signature TEXT NOT NULL,
    wallet TEXT NOT NULL,
    mint TEXT NOT NULL,
    direction TEXT NOT NULL,
    amount REAL NOT NULL,
    block_time INTEGER NOT NULL,
    PRIMARY KEY (signature, wallet, mint)
  );

  CREATE TABLE IF NOT EXISTS seen_signatures (
    wallet TEXT NOT NULL,
    signature TEXT NOT NULL,
    PRIMARY KEY (wallet, signature)
  );

  CREATE TABLE IF NOT EXISTS tokens (
    mint TEXT PRIMARY KEY,
    json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS wallet_metrics (
    address TEXT PRIMARY KEY,
    computed_at INTEGER NOT NULL,
    skill_score REAL NOT NULL,
    eligible INTEGER NOT NULL,
    flags TEXT NOT NULL,
    json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS strategies (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 0,
    json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS backtests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    strategy_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS candles (
    pool TEXT NOT NULL,
    tf TEXT NOT NULL,
    ts INTEGER NOT NULL,
    o REAL, h REAL, l REAL, c REAL, v REAL,
    PRIMARY KEY (pool, tf, ts)
  );

  CREATE TABLE IF NOT EXISTS trip_context (
    wallet TEXT NOT NULL,
    mint TEXT NOT NULL,
    opened_at INTEGER NOT NULL,
    json TEXT NOT NULL,
    PRIMARY KEY (wallet, mint, opened_at)
  );

  CREATE TABLE IF NOT EXISTS sol_price (day INTEGER PRIMARY KEY, usd REAL NOT NULL);

  CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    strategy_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    mint TEXT NOT NULL,
    symbol TEXT,
    status TEXT NOT NULL,          -- open | closed
    opened_at INTEGER NOT NULL,
    closed_at INTEGER,
    entry_price_sol REAL NOT NULL,
    cost_sol REAL NOT NULL,
    token_amount REAL NOT NULL,
    remaining_tokens REAL NOT NULL,
    proceeds_sol REAL NOT NULL DEFAULT 0,
    peak_price_sol REAL NOT NULL,
    tp_hits INTEGER NOT NULL DEFAULT 0,
    exit_reason TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);

  CREATE TABLE IF NOT EXISTS fills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    position_id INTEGER NOT NULL,
    side TEXT NOT NULL,
    sol_amount REAL NOT NULL,
    token_amount REAL NOT NULL,
    price_sol REAL NOT NULL,
    signature TEXT,
    reason TEXT,
    ts INTEGER NOT NULL
  );
  `,
  // v2: walk-forward doğrulama sonuçları
  `
  CREATE TABLE IF NOT EXISTS walkforwards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target TEXT NOT NULL,          -- strateji id ya da '*' (tüm çıkarım yöntemi)
    created_at INTEGER NOT NULL,
    verdict TEXT NOT NULL,
    json TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_walkforwards_target ON walkforwards(target, id);
  `,
  // v3: tarafsız token evreni (açıldıkları anda, performanslarına bakılmadan kaydedilen havuzlar)
  `
  CREATE TABLE IF NOT EXISTS universe (
    mint TEXT PRIMARY KEY,
    pool TEXT NOT NULL,           -- ilk görülen (açılış) havuzu: sonradan değişmez
    dex TEXT,
    created_at INTEGER NOT NULL,  -- havuz açılışı (ms)
    supply REAL,
    initial_fdv_usd REAL,
    recorded_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_universe_created ON universe(created_at);
  `,
];

export type DB = Database.Database;

let instance: DB | null = null;

export function openDb(file = path.join(config.DATA_DIR, 'cryptofincher.db')): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const current = (db.pragma('user_version', { simple: true }) as number) ?? 0;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec(MIGRATIONS[v]!);
    db.pragma(`user_version = ${v + 1}`);
  }
  return db;
}

export function getDb(): DB {
  if (!instance) instance = openDb();
  return instance;
}

/** Testlerde bellek içi veritabanı kullanmak için */
export function setDb(db: DB) {
  instance = db;
}
