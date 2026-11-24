import { Bot, type Context } from 'grammy';
import { config } from '../config.js';
import { childLogger } from '../core/logger.js';
import { round } from '../core/stats.js';
import { analyzeWallet, storedReports } from '../analysis/walletAnalyzer.js';
import { FLAG_DESCRIPTIONS } from '../analysis/scoring.js';
import { MIN_UNBIASED, runBacktest } from '../backtest/runner.js';
import { heliusCredits } from '../data/helius.js';
import { heliusAlert } from '../data/heliusAlert.js';
import { discoverFromToken } from '../discovery/discovery.js';
import type { TradingEngine } from '../engine/engine.js';
import { positionsRepo } from '../engine/positionsRepo.js';
import { engineState, events } from '../engine/state.js';
import { currentJob, enrichEligible, fullPipeline, analyzePending, runJob, walkForwardJob } from '../jobs.js';
import { VERDICT_LABEL, formatWalkForward, walkforwards } from '../backtest/walkforward.js';
import { getDb } from '../storage/db.js';
import { kv, tokens, wallets } from '../storage/repo.js';
import { fmtDuration, fmtUsd } from '../strategy/describe.js';
import { extractFromWallets, runExtraction } from '../strategy/pipeline.js';
import { strategies } from '../strategy/registry.js';
import { buildDailySummary, collectSummaryData } from '../summary.js';
import { pumpfunStreamStats } from '../data/pumpfunStream.js';
import { solPriceService } from '../data/solPrice.js';

const log = childLogger('telegram');
const SOLANA_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const HELP = `CryptoFincher komutları

📊 Durum
/durum: mod, bakiye, açık pozisyonlar, kredi
/pozisyonlar: açık pozisyonlar
/pnl: gerçekleşen kâr/zarar
/ozet: günlük özet (her sabah otomatik de gelir)

🧠 Analiz
/kesif: kazanan tokenları bul, cüzdan keşfet, analiz et, strateji çıkar (uçtan uca)
/kesiftoken <mint>: bir tokenın erken alıcılarını keşfet
/cuzdanekle <adres> [etiket]: manuel cüzdan ekle
/cuzdanlar: en iyi cüzdanlar
/cuzdan <sıra no | adres>: cüzdan raporu (örn: /cuzdan 1)
/analiz [adres]: cüzdanı (ya da bekleyenleri) analiz et
/zenginlestir: giriş öncesi fiyat hareketlerini ekle
/cikar: stratejileri yeniden çıkar
/cuzdanstrateji <adres1,adres2>: belirli cüzdanlardan strateji

📈 Strateji
/stratejiler: liste
/strateji <id>: detay
/backtest <id>: geçmiş veride test
/walkforward <id|hepsi> [öğrenGün] [testGün]: görülmemiş veride doğrulama
/sec <id>: stratejiyi aktifleştir
/birak <id>: stratejiyi kapat
/ayar <id> <alan> <değer>: parametre değiştir (örn: /ayar ab12cd34 exit.stopLossMultiple 0.7)
/izle <mint>: yerleşik tokenı izleme listesine ekle

⚙️ Motor
/mod paper | /mod live ONAY
/dur: yeni girişleri durdur (açık pozisyonlar yönetilmeye devam eder)
/panik: her şeyi durdur ve tüm pozisyonları sat
/devam: motoru devam ettir`;

export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

type StoredReport = ReturnType<typeof storedReports>[number];

/**
 * /cuzdan argümanını çözer: sıra numarası (/cuzdanlar sırası), tam adres ya da adresin başı (en az 4 harf).
 * Başlangıç birden fazla cüzdana uyuyorsa 'ambiguous'.
 */
export function resolveWalletRef(ref: string, reports: StoredReport[]): StoredReport | 'ambiguous' | undefined {
  if (/^\d{1,4}$/.test(ref)) return reports[Number(ref) - 1];
  const exact = reports.find((r) => r.address === ref);
  if (exact) return exact;
  if (ref.length < 4) return undefined;
  const matches = reports.filter((r) => r.address.startsWith(ref));
  return matches.length > 1 ? 'ambiguous' : matches[0];
}

/** Skora göre sıralı cüzdan listesi; tam adres dokununca kopyalanır (HTML) */
export function formatWalletList(reports: StoredReport[], max = 15): string {
  const lines = reports.slice(0, max).map(
    (r, i) =>
      `${i + 1}. ${r.eligible ? '✅' : '⛔'} skor ${r.score.toFixed(0)} | kazanma %${Math.round(r.metrics.winRate * 100)} | PnL ${r.metrics.realizedPnlSol.toFixed(1)} SOL | ${r.metrics.closedTrips} işlem\n<code>${r.address}</code>`,
  );
  const eligible = reports.filter((r) => r.eligible).length;
  return [
    `Cüzdanlar (skora göre, ${eligible}/${reports.length} uygun). Adrese dokununca kopyalanır.`,
    '',
    lines.join('\n\n'),
    '',
    'Detay: /cuzdan 1 (sıra no) ya da /cuzdan <adresin ilk harfleri>',
  ].join('\n');
}

/** Gruplarda komut menüsünden seçilen komut "/start@BotAdı" biçiminde gelir */
export function isStartCommand(text?: string): boolean {
  return !!text && /^\/start(@\w+)?(\s|$)/.test(text.trim());
}

export function startTelegram(engine: TradingEngine) {
  if (!config.TELEGRAM_BOT_TOKEN) {
    log.warn('TELEGRAM_BOT_TOKEN yok: Telegram kapalı');
    return null;
  }
  const bot = new Bot(config.TELEGRAM_BOT_TOKEN);
  const allowed = new Set(config.TELEGRAM_ALLOWED_CHAT_IDS);

  // yetki: sadece izinli chat id'ler
  bot.use(async (ctx, next) => {
    const id = String(ctx.chat?.id ?? '');
    if (!allowed.has(id)) {
      if (isStartCommand(ctx.message?.text)) await ctx.reply(`Yetkisiz. Chat ID: ${id} (TELEGRAM_ALLOWED_CHAT_IDS'e ekleyin)`);
      return;
    }
    await next();
  });

  const send = (text: string) => {
    for (const id of allowed) bot.api.sendMessage(id, text.slice(0, 4000), { link_preview_options: { is_disabled: true } }).catch(() => {});
  };
  events.on('notify', send);

  const arg = (ctx: Context) => (ctx.message?.text ?? '').split(/\s+/).slice(1);
  const bg = (ctx: Context, name: string, fn: () => Promise<unknown>) => {
    if (currentJob()) return ctx.reply(`⏳ Şu an çalışan iş: ${currentJob()}`);
    void runJob(name, fn);
    return ctx.reply(`🚀 ${name} başladı. Bitince bildirim gelecek.`);
  };

  bot.command(['start', 'yardim', 'help'], (ctx) => ctx.reply(HELP));

  bot.command('durum', async (ctx) => {
    const mode = engineState.mode();
    let bal = '?';
    try {
      bal = (await engine.executor.balanceSol()).toFixed(4);
    } catch (err) {
      bal = `hata: ${String(err).slice(0, 80)}`;
    }
    const active = strategies.active();
    await ctx.reply(
      [
        `Mod: ${mode.toUpperCase()}${engineState.isHalted() ? ` ⛔ DURDURULDU (${engineState.haltReason()})` : ' ✅ çalışıyor'}`,
        `Bakiye: ${bal} SOL`,
        `Açık pozisyon: ${positionsRepo.countOpen()}`,
        `Aktif strateji: ${active.length ? active.map((s) => `${s.id} (${s.name})`).join(', ') : 'yok: /stratejiler'}`,
        `Helius kredi (bu ay, bu anahtar): ${heliusCredits.used().toLocaleString()} / ${heliusCredits.limit().toLocaleString()}`,
        (() => {
          const a = heliusAlert.get();
          return a ? `Helius: ⛔ ${a.kind === 'budget' ? 'bütçe doldu' : a.kind === 'quota' ? 'kredi/limit bitti' : 'anahtar geçersiz'} (${a.detail})` : 'Helius: ✅ normal';
        })(),
        `Otomatik keşif: ${config.DISCOVERY_INTERVAL_HOURS > 0 ? `${config.DISCOVERY_INTERVAL_HOURS} saatte bir` : 'kapalı'}`,
        `Taranan aday token: ${engine.candidateCount()}${strategies.active().length ? ` (${config.SCAN_INTERVAL_SEC} sn'de bir)` : ' (aktif strateji olunca taranır)'}`,
        (() => {
          const p = pumpfunStreamStats();
          if (!p.enabled) return 'pump.fun akışı: kapalı';
          return `pump.fun akışı: ${p.connected ? '✅ bağlı' : '⏳ bağlanıyor'} (${p.mode === 'light' ? 'hafif mod' : 'tam mod'}), son 10 dk'da ${p.createsLast10m} yeni token`;
        })(),
        `Cüzdan: ${wallets.list('active').length} aktif / ${wallets.list().length} toplam`,
        `Arka plan işi: ${currentJob() ?? 'yok'}`,
      ].join('\n'),
    );
  });

  bot.command('ozet', (ctx) => ctx.reply(buildDailySummary(collectSummaryData())));

  bot.command('pozisyonlar', async (ctx) => {
    const open = positionsRepo.listOpen();
    if (!open.length) return ctx.reply('Açık pozisyon yok.');
    const solUsd = await solPriceService.now().catch(() => undefined);
    const lines = open.map((p) => {
      const t = tokens.get(p.mint);
      // SOL dışı çiftlerde priceSol yok: USD fiyatından çevrilir
      const cur = t?.priceSol ?? (t?.priceUsd && solUsd ? t.priceUsd / solUsd : undefined);
      const mult = cur ? cur / p.entry_price_sol : NaN;
      return `${p.mode === 'paper' ? '📝' : '💰'} ${p.symbol ?? p.mint.slice(0, 6)} [${p.strategy_id}] ${p.cost_sol.toFixed(3)} SOL, x${Number.isFinite(mult) ? mult.toFixed(2) : '?'}, TP ${p.tp_hits}, ${fmtDuration((Date.now() - p.opened_at) / 1000)}`;
    });
    return ctx.reply(lines.join('\n'));
  });

  bot.command('pnl', async (ctx) => {
    const lines = (['paper', 'live'] as const).map((m) => {
      const s = positionsRepo.summary(m);
      return `${m.toUpperCase()}: ${s.closed} işlem, kazanma %${Math.round(s.winRate * 100)}, PnL ${s.realizedPnlSol >= 0 ? '+' : ''}${s.realizedPnlSol.toFixed(4)} SOL`;
    });
    const last = positionsRepo.listClosed(8).map(
      (p) => `${p.symbol ?? p.mint.slice(0, 6)}: ${(p.proceeds_sol - p.cost_sol).toFixed(4)} SOL (${p.exit_reason})`,
    );
    return ctx.reply([...lines, '', 'Son işlemler:', ...last].join('\n'));
  });

  // ---------- Analiz ----------
  bot.command('kesif', (ctx) => bg(ctx, 'uçtan uca keşif', () => fullPipeline({ discoverTokens: Number(arg(ctx)[0] ?? 3) })));

  bot.command('kesiftoken', (ctx) => {
    const mint = arg(ctx)[0];
    if (!mint || !SOLANA_ADDR.test(mint)) return ctx.reply('Kullanım: /kesiftoken <mint>');
    return bg(ctx, `token keşfi ${mint.slice(0, 6)}`, async () => {
      const found = await discoverFromToken(mint, { recent: 100 });
      events.emit('notify', `🔎 ${found.length} cüzdan bulundu. Analiz için /analiz`);
    });
  });

  bot.command('cuzdanekle', (ctx) => {
    const [addr, ...label] = arg(ctx);
    if (!addr || !SOLANA_ADDR.test(addr)) return ctx.reply('Kullanım: /cuzdanekle <adres> [etiket]');
    wallets.add(addr, 'manual', { label: label.join(' ') || undefined });
    return ctx.reply(`✅ Eklendi: ${addr}. Analiz için /analiz ${addr}`);
  });

  bot.command('cuzdanlar', (ctx) => {
    const rows = storedReports();
    if (!rows.length) return ctx.reply('Henüz analiz edilmiş cüzdan yok. /kesif ya da /cuzdanekle');
    return ctx.reply(formatWalletList(rows), { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  });

  bot.command('cuzdan', (ctx) => {
    const ref = arg(ctx)[0];
    if (!ref) return ctx.reply('Kullanım: /cuzdan <sıra no | adres | adresin ilk harfleri>\nÖrn: /cuzdan 1');
    const found = resolveWalletRef(ref, storedReports());
    if (found === 'ambiguous') return ctx.reply('Bu başlangıçla birden fazla cüzdan var; birkaç harf daha yaz.');
    if (!found) return ctx.reply('Rapor yok. Sıra numarası için /cuzdanlar, yeni cüzdan için /analiz <adres>');
    const r = found;
    const addr = r.address;
    const m = r.metrics;
    const header = [
      `<code>${addr}</code>`,
      `<a href="https://solscan.io/account/${addr}">Solscan</a> · <a href="https://gmgn.ai/sol/address/${addr}">GMGN</a>`,
    ];
    const body = [
        `Skor: ${r.score} ${r.eligible ? '✅ uygun' : '⛔ uygun değil'}`,
        r.flags.length ? `Bayraklar: ${r.flags.map((f) => FLAG_DESCRIPTIONS[f]).join('; ')}` : 'Bayrak yok',
        '',
        `Performans: ${m.closedTrips} kapanmış işlem, kazanma %${Math.round(m.winRate * 100)}, PnL ${m.realizedPnlSol.toFixed(2)} SOL, ROI %${Math.round(m.roi * 100)}, PF ${m.profitFactor.toFixed(2)}`,
        `Tutarlılık: kârlı hafta %${Math.round(m.weeklyPositiveRate * 100)}, en büyük kazancın payı %${Math.round(m.pnlConcentration * 100)}`,
        '',
        'Davranış:',
        `• Giriş zamanı: havuz açılışından ~${fmtDuration(m.medianEntryDelaySec)} sonra`,
        `• Giriş mcap: ${fmtUsd(m.p25EntryMcapUsd)} - ${fmtUsd(m.p75EntryMcapUsd)} (medyan ${fmtUsd(m.medianEntryMcapUsd)})`,
        `• Tutma: medyan ${fmtDuration(m.medianHoldSec)} (kazançlar ${fmtDuration(m.medianWinHoldSec)}, kayıplar ${fmtDuration(m.medianLossHoldSec)})`,
        `• Pozisyon: medyan ${m.medianSizeSol.toFixed(2)} SOL, kademeli alım %${Math.round(m.dcaRate * 100)}`,
        `• Çıkış: kısmi satış %${Math.round(m.partialExitRate * 100)}, ilk satış ${round(m.firstExitMultipleMedian, 2)}x'te pozisyonun %${Math.round(m.firstExitFractionMedian * 100)}'i, son satış ${round(m.finalExitMultipleMedian, 2)}x`,
        `• Zarar kesme: ~${round(m.lossExitMultipleMedian, 2)}x`,
        `• Memecoin payı %${Math.round(m.memeShare * 100)}, günde ${m.tradesPerDay.toFixed(1)} swap`,
        m.enrichedTrips
          ? `• Giriş öncesi 5dk fiyat: %${round(m.medianPreChange5m, 1)}, hacim artışı x${round(m.medianVolumeSurge, 1)}, hareketin %${Math.round(m.medianCaptureRatio * 100)}'ini yakalıyor`
          : '• Bağlam verisi yok (/zenginlestir)',
    ];
    return ctx.reply([...header, ...body.map(escapeHtml)].join('\n'), {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  });

  bot.command('analiz', (ctx) => {
    const addr = arg(ctx)[0];
    if (addr) {
      if (!SOLANA_ADDR.test(addr)) return ctx.reply('Geçersiz adres');
      return bg(ctx, `cüzdan analizi ${addr.slice(0, 6)}`, async () => {
        const r = await analyzeWallet(addr);
        if ('prescreenFailed' in r) events.emit('notify', `⛔ ${addr.slice(0, 6)}: ${r.prescreenFailed}`);
        else events.emit('notify', `🧪 ${addr.slice(0, 6)}: skor ${r.score}, ${r.eligible ? 'uygun ✅' : 'uygun değil ⛔'}. Detay: /cuzdan ${addr}`);
      });
    }
    return bg(ctx, 'bekleyen cüzdan analizi', async () => {
      const r = await analyzePending();
      events.emit('notify', `🧪 ${r.analyzed} cüzdan analiz edildi, ${r.eligible} uygun.`);
    });
  });

  bot.command('zenginlestir', (ctx) =>
    bg(ctx, 'zenginleştirme', async () => {
      const n = await enrichEligible();
      events.emit('notify', `📈 ${n} işleme bağlam eklendi. Stratejileri güncellemek için /cikar`);
    }),
  );

  bot.command('cikar', (ctx) => {
    const r = runExtraction();
    return ctx.reply(`🧠 ${r.walletCount} uygun cüzdandan ${r.specs.length} strateji çıkarıldı. /stratejiler`);
  });

  bot.command('cuzdanstrateji', (ctx) => {
    const addrs = (arg(ctx)[0] ?? '').split(',').filter((a) => SOLANA_ADDR.test(a));
    if (!addrs.length) return ctx.reply('Kullanım: /cuzdanstrateji <adres1,adres2>');
    const s = extractFromWallets(addrs);
    return ctx.reply(s ? `✅ Strateji ${s.id}: ${s.name}\n\n${s.description}` : 'Yeterli veri yok (en az 5 kapanmış işlem gerekli).');
  });

  // ---------- Strateji ----------
  bot.command('stratejiler', (ctx) => {
    const list = strategies.list();
    if (!list.length) return ctx.reply('Strateji yok. Önce /kesif ya da /cikar');
    return ctx.reply(
      list
        .map(
          ({ spec, active }) =>
            `${active ? '🟢' : '⚪️'} ${spec.id}: ${spec.name}\n   ${spec.evidence.wallets} cüzdan, ${spec.evidence.trips} işlem, kazanma %${Math.round(Number(spec.evidence.winRate) * 100)}\n   Walk-forward: ${(() => {
              const wf = walkforwards.latest(spec.id);
              return wf ? VERDICT_LABEL[wf.verdict] : 'yapılmadı';
            })()}`,
        )
        .join('\n\n') + '\n\nDetay: /strateji <id>',
    );
  });

  bot.command('strateji', (ctx) => {
    const id = arg(ctx)[0];
    const s = id ? strategies.get(id) : undefined;
    if (!s) return ctx.reply('Kullanım: /strateji <id>');
    const bt = getDb().prepare('SELECT json FROM backtests WHERE strategy_id = ? ORDER BY id DESC LIMIT 1').get(id) as { json: string } | undefined;
    const btLine = bt
      ? (() => {
          const b = JSON.parse(bt.json);
          return `Son backtest: ${b.trades} işlem, kazanma %${Math.round(b.winRate * 100)}, getiri %${Math.round(b.totalReturnPct)}, max DD %${Math.round(b.maxDrawdownPct)}`;
        })()
      : 'Backtest yok: /backtest ' + id;
    const p = s.spec;
    return ctx.reply(
      [
        `${s.active ? '🟢 AKTİF' : '⚪️ pasif'} ${p.id}: ${p.name}`,
        '',
        p.description,
        '',
        'Parametreler:',
        JSON.stringify({ entry: p.entry, sizing: p.sizing, exit: p.exit, execution: p.execution }, null, 1),
        '',
        btLine,
        (() => {
          const wf = walkforwards.latest(p.id);
          return wf
            ? `Son walk-forward: ${VERDICT_LABEL[wf.verdict]} (test medyan getiri %${wf.aggregate.oosMedianReturnPct ?? '?'}, ${wf.aggregate.validFolds} tur)`
            : `Walk-forward yok: /walkforward ${p.id}`;
        })(),
      ].join('\n'),
    );
  });

  bot.command('backtest', (ctx) => {
    const id = arg(ctx)[0];
    const s = id ? strategies.get(id) : undefined;
    if (!s) return ctx.reply('Kullanım: /backtest <id>');
    return bg(ctx, `backtest ${id}`, async () => {
      const r = await runBacktest(s.spec);
      events.emit(
        'notify',
        [
          `📊 Backtest ${id} (${s.spec.name})`,
          `Evren: ${r.universe} token (${r.universeSource === 'unbiased' ? 'tarafsız ✅' : `karışık, tarafsız ${r.unbiasedAvailable}/${MIN_UNBIASED}`}), sinyal: ${r.tokensWithSignal}, işlem: ${r.trades} (kapasite nedeniyle atlanan ${r.skippedForCapacity})`,
          `Kazanma %${Math.round(r.winRate * 100)}, ort. işlem %${r.avgPnlPct.toFixed(1)}, PF ${r.profitFactor.toFixed(2)}`,
          `Toplam getiri %${r.totalReturnPct.toFixed(1)}, max düşüş %${r.maxDrawdownPct.toFixed(1)}`,
          `Çıkışlar: ${Object.entries(r.exitReasonCounts).map(([k, v]) => `${k}:${v}`).join(' ')}`,
          `Maliyet varsayımı: taraf başı %${r.feePctPerSide}`,
          '',
          ...r.warnings.map((w) => `⚠️ ${w}`),
        ].join('\n'),
      );
    });
  });

  bot.command('sec', (ctx) => {
    const [id, confirm] = arg(ctx);
    if (!id || !strategies.get(id)) return ctx.reply('Strateji bulunamadı');
    const wf = walkforwards.latest(id);
    if (wf?.verdict === 'overfit' && confirm !== 'ONAY') {
      return ctx.reply(
        `⛔ ${id} walk-forward doğrulamasında AŞIRI UYUM çıktı: görülmemiş veride işe yaramadı.\n` +
          wf.reasons.map((r) => `• ${r}`).join('\n') +
          `\n\nYine de aktifleştirmek için: /sec ${id} ONAY`,
      );
    }
    strategies.setActive(id, true);
    const hint = !wf
      ? `\nℹ️ Bu strateji henüz walk-forward ile doğrulanmadı: /walkforward ${id}`
      : `\nWalk-forward: ${VERDICT_LABEL[wf.verdict]}`;
    return ctx.reply(`🟢 ${id} aktif. Mod: ${engineState.mode().toUpperCase()}${hint}`);
  });

  bot.command('walkforward', (ctx) => {
    const [rawTarget, train, test] = arg(ctx);
    const target = !rawTarget || rawTarget === 'hepsi' ? '*' : rawTarget;
    if (target !== '*' && !strategies.get(target)) return ctx.reply('Kullanım: /walkforward <id|hepsi> [öğrenGün] [testGün]');
    const opts = {
      ...(train ? { trainDays: Number(train) } : {}),
      ...(test ? { testDays: Number(test) } : {}),
    };
    if ((opts.trainDays !== undefined && !(opts.trainDays > 0)) || (opts.testDays !== undefined && !(opts.testDays > 0)))
      return ctx.reply('Gün değerleri pozitif sayı olmalı');
    return bg(ctx, `walk-forward ${target === '*' ? 'hepsi' : target}`, async () => {
      const r = await walkForwardJob(target, opts);
      events.emit('notify', formatWalkForward(r));
    });
  });

  bot.command('birak', (ctx) => {
    const id = arg(ctx)[0];
    if (!id || !strategies.setActive(id, false)) return ctx.reply('Strateji bulunamadı');
    return ctx.reply(`⚪️ ${id} kapatıldı. Açık pozisyonları yönetilmeye devam eder.`);
  });

  bot.command('ayar', (ctx) => {
    const [id, path, ...rest] = arg(ctx);
    const raw = rest.join(' ');
    if (!id || !path || !raw) return ctx.reply('Kullanım: /ayar <id> <alan> <değer>\nÖrn: /ayar ab12cd34 exit.takeProfits [{"multiple":2,"sellPct":50},{"multiple":4,"sellPct":50}]');
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      value = raw;
    }
    try {
      strategies.setParam(id, path, value);
      return ctx.reply(`✅ ${id}.${path} = ${JSON.stringify(value)}`);
    } catch (err) {
      return ctx.reply(`❌ ${String(err).slice(0, 500)}`);
    }
  });

  bot.command('izle', (ctx) => {
    const mint = arg(ctx)[0];
    if (!mint || !SOLANA_ADDR.test(mint)) return ctx.reply('Kullanım: /izle <mint>');
    const list = new Set(kv.get<string[]>('watchlist', []));
    list.add(mint);
    kv.set('watchlist', [...list]);
    return ctx.reply(`👀 İzleme listesinde ${list.size} token`);
  });

  // ---------- Motor ----------
  bot.command('mod', (ctx) => {
    const [m, confirm] = arg(ctx);
    if (m === 'paper') {
      engineState.setMode('paper');
      return ctx.reply('📝 PAPER mod');
    }
    if (m === 'live') {
      if (!engine.canGoLive()) return ctx.reply('❌ Keystore yüklenmedi. Botu keystore parolasıyla başlatın.');
      if (confirm !== 'ONAY') return ctx.reply('⚠️ Gerçek parayla işlem yapılacak. Onaylamak için: /mod live ONAY');
      engineState.setMode('live');
      return ctx.reply('💰 CANLI mod aktif. Acil durumda: /panik');
    }
    return ctx.reply(`Mevcut mod: ${engineState.mode()}. Kullanım: /mod paper | /mod live ONAY`);
  });

  bot.command('dur', (ctx) => {
    engineState.halt(`Telegram /dur (${ctx.from?.username ?? ctx.from?.id})`);
    return ctx.reply('⛔ Yeni girişler durduruldu. Açık pozisyonların SL/TP yönetimi sürüyor. Tümünü satmak için /panik');
  });

  bot.command('panik', async (ctx) => {
    await ctx.reply('🚨 PANİK: tüm pozisyonlar satılıyor…');
    const n = await engine.panicSellAll();
    return ctx.reply(`🚨 ${n} pozisyon için satış denendi. Motor durduruldu. Devam için /devam`);
  });

  bot.command('devam', (ctx) => {
    engineState.resume();
    return ctx.reply('▶️ Devam');
  });

  bot.catch((err) => log.error({ err: String(err.error) }, 'telegram hatası'));
  void bot.api.setMyCommands([
    { command: 'durum', description: 'Durum' },
    { command: 'kesif', description: 'Keşif + analiz + strateji' },
    { command: 'stratejiler', description: 'Strateji listesi' },
    { command: 'walkforward', description: 'Görülmemiş veride doğrulama' },
    { command: 'ozet', description: 'Günlük özet' },
    { command: 'pozisyonlar', description: 'Açık pozisyonlar' },
    { command: 'pnl', description: 'Kâr/zarar' },
    { command: 'cuzdanlar', description: 'En iyi cüzdanlar' },
    { command: 'dur', description: 'Yeni girişleri durdur' },
    { command: 'panik', description: 'Her şeyi sat ve durdur' },
    { command: 'yardim', description: 'Tüm komutlar' },
  ]).catch(() => {});
  void bot.start({ onStart: () => log.info('Telegram botu çalışıyor') });
  return bot;
}
