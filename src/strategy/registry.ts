import { getDb } from '../storage/db.js';
import { StrategySpecSchema, type StrategySpec } from './types.js';

interface Row {
  id: string;
  name: string;
  created_at: number;
  active: number;
  json: string;
}

const parse = (r: Row) => ({ spec: StrategySpecSchema.parse(JSON.parse(r.json)), active: !!r.active });

export const strategies = {
  save(spec: StrategySpec) {
    StrategySpecSchema.parse(spec);
    getDb()
      .prepare(
        `INSERT INTO strategies(id, name, created_at, active, json) VALUES (?, ?, ?, 0, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, json = excluded.json`,
      )
      .run(spec.id, spec.name, spec.createdAt, JSON.stringify(spec));
  },
  get(id: string) {
    const r = getDb().prepare('SELECT * FROM strategies WHERE id = ?').get(id) as Row | undefined;
    return r ? parse(r) : undefined;
  },
  list() {
    return (getDb().prepare('SELECT * FROM strategies ORDER BY created_at DESC').all() as Row[]).map(parse);
  },
  active(): StrategySpec[] {
    return (getDb().prepare('SELECT * FROM strategies WHERE active = 1').all() as Row[]).map((r) => parse(r).spec);
  },
  setActive(id: string, active: boolean) {
    const res = getDb().prepare('UPDATE strategies SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
    return res.changes > 0;
  },
  remove(id: string) {
    getDb().prepare('DELETE FROM strategies WHERE id = ?').run(id);
  },
  /** Tek bir parametreyi nokta yoluyla günceller: "exit.stopLossMultiple" = 0.7 */
  setParam(id: string, path: string, value: unknown): StrategySpec {
    const cur = strategies.get(id);
    if (!cur) throw new Error(`Strateji yok: ${id}`);
    const copy = structuredClone(cur.spec) as Record<string, unknown>;
    const keys = path.split('.');
    let obj: Record<string, unknown> = copy;
    for (const k of keys.slice(0, -1)) {
      if (typeof obj[k] !== 'object' || obj[k] === null) throw new Error(`Geçersiz yol: ${path}`);
      obj = obj[k] as Record<string, unknown>;
    }
    const last = keys[keys.length - 1]!;
    if (!(last in obj)) throw new Error(`Geçersiz alan: ${path}`);
    obj[last] = value;
    const spec = StrategySpecSchema.parse(copy);
    strategies.save(spec);
    return spec;
  },
};
