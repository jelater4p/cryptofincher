import { config } from './config.js';
import { childLogger } from './core/logger.js';
import { heliusCredits } from './data/helius.js';
import { heliusAlert, heliusKeyId, type HeliusAlertKind } from './data/heliusAlert.js';
import { isDiscoveryRunning, lastDiscoveryCompleted } from './discovery/scheduleState.js';
import { universe } from './discovery/universe.js';
import { engineState, events } from './engine/state.js';
import { VERDICT_LABEL, walkforwards, type WalkForwardVerdict } from './backtest/walkforward.js';
import { getDb } from './storage/db.js';
import { pumpfunStreamStats } from './data/pumpfunStream.js';
import { kv } from './storage/repo.js';
import { strategies } from './strategy/registry.js';

const log = childLogger('summary');
const DAY = 86400_000;

// ---------------------------------------------------------------- saat dilimi

/** Verilen saat dilimindeki tarih (YYYY-AA-GG) ve saat. Geçersiz dilimde UTC. */
export function localParts(nowMs: number, timeZone: string): { date: string; hour: number; timeZone: string } {
  const fmt = (tz: string) => {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(nowMs));
    const get = (t: string) => parts.find((p) => p.type === t)!.value;
    return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')), timeZone: tz };
  };
  try {
    return fmt(timeZone);
  } catch {
    log.warn({ timeZone }, 'geçersiz saat dilimi, UTC kullanılıyor');
    return fmt('UTC');
  }
}

// ---------------------------------------------------------------- veri

interface ModeStats {
  closed24h: number;
  wins24h: number;
  pnl24h: number;
  closedTotal: number;
  winsTotal: number;
  pnlTotal: number;
}

export interface SummaryData {
  now: number;
  dateLabel: string;
  mode: 'paper' | 'live';
  halted: boolean;
  haltReason: string | null;
  paperBalanceSol: number;
  paper: ModeStats;
  live: ModeStats | null;
  open: { count: number; costSol: number };
  activeStrategies: Array<{ id: string; name: string; verdict: WalkForwardVerdict | null }>;
  newStrategies24h: number;
  wallets: { total: number; eligible: number; analyzed24h: number };
  discovery: { intervalHours: number; lastCompleted: number; running: boolean };
  credits: { used: number; limit: number; sinceLastSummary: number | null };
  heliusAlert: { kind: HeliusAlertKind; detail: string } | null;
  universe: { added24h: number; total: number };
  pumpfun: { enabled: boolean; connected: boolean; mode: 'light' | 'full' | null; createsLast24h: number };
}

function modeStats(mode: 'paper' | 'live', since: number): ModeStats {
  const row = (where: string, ...args: unknown[]) =>
    getDb()
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN proceeds_sol > cost_sol THEN 1 ELSE 0 END), 0) AS w,
                COALESCE(SUM(proceeds_sol - cost_sol), 0) AS pnl
         FROM positions WHERE status = 'closed' AND mode = ? ${where}`,
      )
      .get(mode, ...args) as { n: number; w: number; pnl: number };
  const d = row('AND closed_at >= ?', since);
  const t = row('');
  return { closed24h: d.n, wins24h: d.w, pnl24h: d.pnl, closedTotal: t.n, winsTotal: t.w, pnlTotal: t.pnl };
}

const SNAPSHOT_KEY = 'summary:creditSnapshot';
interface CreditSnapshot {
  used: number;
  month: string;
  keyId: string;
}

export function collectSummaryData(now = Date.now()): SummaryData {
  const since = now - DAY;
  const db = getDb();
  const count = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;
  const open = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(cost_sol), 0) AS c FROM positions WHERE status = 'open'").get() as {
    n: number;
    c: number;
  };
  const hasLive = count("SELECT COUNT(*) AS n FROM positions WHERE mode = 'live'") > 0;
  const snap = kv.get<CreditSnapshot | null>(SNAPSHOT_KEY, null);
  // sayaçla aynı dönem kaynağı: karşılaştırma ancak aynı ay ve aynı anahtar içinde anlamlı
  const month = heliusCredits.period();
  const used = heliusCredits.used();
  const alert = heliusAlert.get();
  return {
    now,
    dateLabel: new Intl.DateTimeFormat('tr-TR', { timeZone: localParts(now, config.SUMMARY_TIMEZONE).timeZone, day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(now)),
    mode: engineState.mode(),
    halted: engineState.isHalted(),
    haltReason: engineState.haltReason(),
    paperBalanceSol: kv.get<number>('paper:sol', config.PAPER_STARTING_SOL),
    paper: modeStats('paper', since),
    live: hasLive ? modeStats('live', since) : null,
    open: { count: open.n, costSol: open.c },
    activeStrategies: strategies.active().map((s) => ({ id: s.id, name: s.name, verdict: walkforwards.latest(s.id)?.verdict ?? null })),
    // created_at sadece ilk kayıtta yazılır: yeniden çıkarılan strateji "yeni" sayılmaz
    newStrategies24h: count('SELECT COUNT(*) AS n FROM strategies WHERE created_at >= ?', since),
    wallets: {
      total: count('SELECT COUNT(*) AS n FROM wallets'),
      eligible: count('SELECT COUNT(*) AS n FROM wallet_metrics WHERE eligible = 1'),
      analyzed24h: count('SELECT COUNT(*) AS n FROM wallets WHERE last_analyzed_at >= ?', since),
    },
    discovery: { intervalHours: config.DISCOVERY_INTERVAL_HOURS, lastCompleted: lastDiscoveryCompleted(), running: isDiscoveryRunning() },
    credits: {
      used,
      limit: heliusCredits.limit(),
      sinceLastSummary: snap && snap.month === month && snap.keyId === heliusKeyId() ? used - snap.used : null,
    },
    heliusAlert: alert ? { kind: alert.kind, detail: alert.detail } : null,
    universe: { added24h: universe.countSince(since), total: universe.total() },
    pumpfun: (() => {
      const p = pumpfunStreamStats(now);
      return { enabled: p.enabled, connected: p.connected, mode: p.mode, createsLast24h: p.createsLast24h };
    })(),
  };
}

// ---------------------------------------------------------------- metin

const sol = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(4)} SOL`;
const pct = (a: number, b: number) => (b > 0 ? `%${Math.round((100 * a) / b)}` : '-');
const ago = (ms: number) => {
  const h = ms / 3600_000;
  return h < 1.5 ? `${Math.max(1, Math.round(ms / 60_000))} dk` : h < 48 ? `${Math.round(h)} saat` : `${Math.round(h / 24)} gün`;
};

function modeLines(label: string, m: ModeStats): string[] {
  return [
    `${label} son 24 saat: ${m.closed24h ? `${m.closed24h} işlem kapandı, ${m.wins24h} kazanç, PnL ${sol(m.pnl24h)}` : 'kapanan işlem yok'}`,
    `${label} toplam: ${m.closedTotal} işlem, kazanma ${pct(m.winsTotal, m.closedTotal)}, PnL ${sol(m.pnlTotal)}`,
  ];
}

export function buildDailySummary(d: SummaryData): string {
  const lines: string[] = [`☀️ Günlük özet · ${d.dateLabel}`, ''];
  lines.push(
    `Mod: ${d.mode.toUpperCase()} ${d.halted ? `⛔ DURDURULDU (${d.haltReason ?? '?'})` : '✅ çalışıyor'} · Paper bakiye: ${d.paperBalanceSol.toFixed(4)} SOL`,
  );
  lines.push(...modeLines('📝 Paper', d.paper));
  if (d.live) lines.push(...modeLines('💰 Canlı', d.live));
  lines.push(`Açık pozisyon: ${d.open.count}${d.open.count ? ` (${d.open.costSol.toFixed(3)} SOL maliyet)` : ''}`);
  lines.push(
    d.activeStrategies.length
      ? `Aktif strateji: ${d.activeStrategies.map((s) => `${s.id} ${s.name} [${s.verdict ? VERDICT_LABEL[s.verdict] : 'walk-forward yok'}]`).join('; ')}`
      : 'Aktif strateji: yok (bot veri topluyor, işlem yapmıyor)',
  );
  lines.push('');

  const disc = d.discovery;
  let discLine: string;
  if (disc.intervalHours <= 0) discLine = 'Otomatik keşif: kapalı';
  else if (disc.running) discLine = 'Keşif: şu an çalışıyor';
  else if (!disc.lastCompleted) discLine = 'Keşif: henüz başarıyla tamamlanmadı';
  else {
    const next = disc.lastCompleted + disc.intervalHours * 3600_000 - d.now;
    discLine = `Keşif: son başarılı ${ago(d.now - disc.lastCompleted)} önce, sonraki ${next > 0 ? `~${ago(next)} sonra` : 'yakında'}`;
  }
  lines.push(discLine);
  lines.push(`Cüzdan: ${d.wallets.total} toplam, ${d.wallets.eligible} uygun, son 24 saatte ${d.wallets.analyzed24h} analiz`);
  lines.push(`Yeni strateji (24 saat): ${d.newStrategies24h}${d.newStrategies24h ? ' · /stratejiler' : ''}`);
  lines.push(
    `Tarafsız evren: son 24 saatte +${d.universe.added24h.toLocaleString()} token (toplam ${d.universe.total.toLocaleString()})` +
      (d.universe.added24h === 0 && config.UNIVERSE_RECORDER_MINUTES > 0 ? ' ⚠️ kayıt çalışmıyor olabilir, logları kontrol et' : ''),
  );
  lines.push(
    d.pumpfun.enabled
      ? `pump.fun akışı: ${d.pumpfun.connected ? '✅ bağlı' : '⚠️ bağlı değil'} (${d.pumpfun.mode === 'light' ? 'hafif mod' : 'tam mod'}), son 24 saatte ${d.pumpfun.createsLast24h.toLocaleString()} yeni token`
      : 'pump.fun akışı: kapalı',
  );
  lines.push('');
  lines.push(
    d.heliusAlert
      ? `Helius: ⛔ ${d.heliusAlert.kind === 'budget' ? 'bütçe doldu' : d.heliusAlert.kind === 'quota' ? 'kredi/limit bitti' : 'anahtar geçersiz'} (${d.heliusAlert.detail})`
      : 'Helius: ✅ normal',
  );
  lines.push(
    `Helius kredi (bu ay): ${d.credits.used.toLocaleString()} / ${d.credits.limit.toLocaleString()} (${pct(d.credits.used, d.credits.limit)})` +
      (d.credits.sinceLastSummary !== null ? ` · son özetten beri +${d.credits.sinceLastSummary.toLocaleString()}` : ''),
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------- zamanlama

const LAST_SENT_KEY = 'summary:lastSentDate';

/**
 * Her gün DAILY_SUMMARY_HOUR'da (SUMMARY_TIMEZONE saatiyle) bir kez gönderir. Bot o saatte kapalıysa
 * aynı gün açıldığında gönderir; aynı gün ikinci kez göndermez. -1 = kapalı.
 */
export function maybeSendDailySummary(now = Date.now()): boolean {
  const hour = config.DAILY_SUMMARY_HOUR;
  if (hour < 0) return false;
  const p = localParts(now, config.SUMMARY_TIMEZONE);
  if (p.hour < hour) return false;
  if (kv.get<string | null>(LAST_SENT_KEY, null) === p.date) return false;
  const data = collectSummaryData(now);
  events.emit('notify', buildDailySummary(data));
  kv.set(LAST_SENT_KEY, p.date);
  kv.set(SNAPSHOT_KEY, { used: data.credits.used, month: heliusCredits.period(), keyId: heliusKeyId() } satisfies CreditSnapshot);
  return true;
}
