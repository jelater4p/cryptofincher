import { getDb } from '../storage/db.js';

export interface PositionRow {
  id: number;
  strategy_id: string;
  mode: 'paper' | 'live';
  mint: string;
  symbol: string | null;
  status: 'open' | 'closed';
  opened_at: number;
  closed_at: number | null;
  entry_price_sol: number;
  cost_sol: number;
  token_amount: number;
  remaining_tokens: number;
  proceeds_sol: number;
  peak_price_sol: number;
  tp_hits: number;
  exit_reason: string | null;
}

export const positionsRepo = {
  open(p: { strategyId: string; mode: 'paper' | 'live'; mint: string; symbol?: string; priceSol: number; costSol: number; tokens: number }) {
    const r = getDb()
      .prepare(
        `INSERT INTO positions(strategy_id, mode, mint, symbol, status, opened_at, entry_price_sol, cost_sol, token_amount, remaining_tokens, peak_price_sol)
         VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`,
      )
      .run(p.strategyId, p.mode, p.mint, p.symbol ?? null, Date.now(), p.priceSol, p.costSol, p.tokens, p.tokens, p.priceSol);
    return Number(r.lastInsertRowid);
  },
  get(id: number) {
    return getDb().prepare('SELECT * FROM positions WHERE id = ?').get(id) as PositionRow | undefined;
  },
  listOpen(mode?: 'paper' | 'live') {
    return (
      mode
        ? getDb().prepare("SELECT * FROM positions WHERE status = 'open' AND mode = ? ORDER BY opened_at").all(mode)
        : getDb().prepare("SELECT * FROM positions WHERE status = 'open' ORDER BY opened_at").all()
    ) as PositionRow[];
  },
  listClosed(limit = 50, mode?: 'paper' | 'live') {
    return (
      mode
        ? getDb().prepare("SELECT * FROM positions WHERE status = 'closed' AND mode = ? ORDER BY closed_at DESC LIMIT ?").all(mode, limit)
        : getDb().prepare("SELECT * FROM positions WHERE status = 'closed' ORDER BY closed_at DESC LIMIT ?").all(limit)
    ) as PositionRow[];
  },
  hasOpenForMint(mint: string) {
    return !!getDb().prepare("SELECT 1 FROM positions WHERE status = 'open' AND mint = ?").get(mint);
  },
  countOpen(strategyId?: string) {
    const r = (
      strategyId
        ? getDb().prepare("SELECT COUNT(*) AS n FROM positions WHERE status = 'open' AND strategy_id = ?").get(strategyId)
        : getDb().prepare("SELECT COUNT(*) AS n FROM positions WHERE status = 'open'").get()
    ) as { n: number };
    return r.n;
  },
  /** Bir stratejinin yakın zamanda işlem yaptığı tokenlara tekrar girmemek için */
  recentlyTraded(mint: string, withinMs: number) {
    return !!getDb()
      .prepare('SELECT 1 FROM positions WHERE mint = ? AND opened_at > ?')
      .get(mint, Date.now() - withinMs);
  },
  updatePeak(id: number, peak: number) {
    getDb().prepare('UPDATE positions SET peak_price_sol = MAX(peak_price_sol, ?) WHERE id = ?').run(peak, id);
  },
  recordSell(id: number, f: { tokens: number; sol: number; price: number; signature?: string; reason: string; tpHits: number }) {
    const db = getDb();
    db.transaction(() => {
      db.prepare(
        `UPDATE positions SET remaining_tokens = MAX(0, remaining_tokens - ?), proceeds_sol = proceeds_sol + ?, tp_hits = ? WHERE id = ?`,
      ).run(f.tokens, f.sol, f.tpHits, id);
      db.prepare('INSERT INTO fills(position_id, side, sol_amount, token_amount, price_sol, signature, reason, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
        id,
        'SELL',
        f.sol,
        f.tokens,
        f.price,
        f.signature ?? null,
        f.reason,
        Date.now(),
      );
      const p = db.prepare('SELECT remaining_tokens, token_amount FROM positions WHERE id = ?').get(id) as {
        remaining_tokens: number;
        token_amount: number;
      };
      if (p.remaining_tokens <= p.token_amount * 0.001) {
        db.prepare("UPDATE positions SET status = 'closed', closed_at = ?, exit_reason = ?, remaining_tokens = 0 WHERE id = ?").run(
          Date.now(),
          f.reason,
          id,
        );
      }
    })();
  },
  recordBuyFill(id: number, f: { tokens: number; sol: number; price: number; signature?: string }) {
    getDb()
      .prepare('INSERT INTO fills(position_id, side, sol_amount, token_amount, price_sol, signature, reason, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, 'BUY', f.sol, f.tokens, f.price, f.signature ?? null, 'entry', Date.now());
  },
  buyFillCount(id: number): number {
    return (getDb().prepare("SELECT COUNT(*) AS n FROM fills WHERE position_id = ? AND side = 'BUY'").get(id) as { n: number }).n;
  },
  /** DCA ek alımı: maliyet ve miktar eklenir, giriş fiyatı ortalanır */
  addBuy(id: number, f: { tokens: number; sol: number; price: number; signature?: string }) {
    const db = getDb();
    db.transaction(() => {
      db.prepare(
        `UPDATE positions SET cost_sol = cost_sol + ?, token_amount = token_amount + ?, remaining_tokens = remaining_tokens + ?,
           entry_price_sol = (cost_sol + ?) / (token_amount + ?) WHERE id = ?`,
      ).run(f.sol, f.tokens, f.tokens, f.sol, f.tokens, id);
      positionsRepo.recordBuyFill(id, f);
    })();
  },
  summary(mode?: 'paper' | 'live') {
    const closed = positionsRepo.listClosed(100000, mode);
    const pnl = closed.reduce((s, p) => s + (p.proceeds_sol - p.cost_sol), 0);
    const wins = closed.filter((p) => p.proceeds_sol > p.cost_sol).length;
    return { closed: closed.length, wins, winRate: closed.length ? wins / closed.length : 0, realizedPnlSol: pnl };
  },
};
