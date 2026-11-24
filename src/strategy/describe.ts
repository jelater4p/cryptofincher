import type { StrategySpec } from './types.js';

export function fmtDuration(sec: number): string {
  if (!Number.isFinite(sec)) return '?';
  if (sec < 90) return `${Math.round(sec)} sn`;
  if (sec < 5400) return `${Math.round(sec / 60)} dk`;
  if (sec < 2 * 86400) return `${(sec / 3600).toFixed(1)} saat`;
  return `${(sec / 86400).toFixed(1)} gün`;
}

export function fmtUsd(x: number): string {
  if (!Number.isFinite(x)) return '?';
  if (x >= 1e9) return `$${(x / 1e9).toFixed(1)}B`;
  if (x >= 1e6) return `$${(x / 1e6).toFixed(1)}M`;
  if (x >= 1e3) return `$${(x / 1e3).toFixed(0)}K`;
  return `$${x.toFixed(0)}`;
}

export function nameStrategy(s: StrategySpec): string {
  const hold = Number(s.evidence.medianHoldSec ?? s.exit.maxHoldSec);
  const style = hold < 15 * 60 ? 'Scalper' : hold < 6 * 3600 ? 'Momentum' : hold < 3 * 86400 ? 'Swing' : 'Holder';
  const timing =
    s.segment === 'memecoin'
      ? s.entry.maxPoolAgeSec <= 30 * 60
        ? 'Erken Giriş'
        : s.entry.maxPoolAgeSec <= 24 * 3600
          ? 'Gün İçi'
          : 'Olgun Token'
      : 'Yerleşik';
  const flavor =
    s.entry.priceChange5mMin !== null && s.entry.priceChange5mMin > 5
      ? 'Breakout'
      : s.entry.priceChange5mMax !== null && s.entry.priceChange5mMax < 0
        ? 'Dip Alıcı'
        : s.entry.dca
          ? 'DCA'
          : '';
  return [s.segment === 'memecoin' ? 'Meme' : 'Major', timing, style, flavor].filter(Boolean).join(' · ');
}

/** Stratejinin, kaynağı olan cüzdanların ne yaptığını Türkçe anlatan açıklaması */
export function describeStrategy(s: StrategySpec): string {
  const e = s.evidence;
  const lines: string[] = [];
  lines.push(
    `${e.wallets} cüzdanın ${e.trips} kapanmış işleminden çıkarıldı (kazanma oranı %${Math.round(Number(e.winRate) * 100)}).`,
  );
  lines.push(
    `Giriş: havuz ${fmtDuration(s.entry.minPoolAgeSec)} - ${fmtDuration(s.entry.maxPoolAgeSec)} yaşındayken, market cap ${fmtUsd(s.entry.mcapUsdMin)} - ${fmtUsd(s.entry.mcapUsdMax)} aralığında.`,
  );
  if (s.entry.priceChange5mMin !== null && s.entry.priceChange5mMax !== null) {
    const med = Number(e.medianPreChange5m);
    lines.push(
      med > 3
        ? `Yükselişe binen bir yapı: girişten önceki 5 dk'da fiyat genelde %${med} artmış (breakout/momentum alımı).`
        : med < -3
          ? `Düşüşte alım yapıyorlar: girişten önceki 5 dk'da fiyat genelde %${Math.abs(med)} düşmüş.`
          : `Yatay bölgede giriş: girişten önceki 5 dk fiyat değişimi küçük (%${med}).`,
    );
  } else {
    lines.push('Giriş öncesi momentum verisi yok (zenginleştirme çalıştırılınca eklenir).');
  }
  if (s.entry.dca) lines.push(`Kademeli alım: girişi ${s.entry.dca.tranches} parçaya bölüyorlar, ikinci alım ~%${s.entry.dca.dipPct} düşüşte.`);
  const tps = s.exit.takeProfits.map((t) => `${t.multiple}x'te %${t.sellPct}`).join(', ');
  lines.push(`Kâr alma: ${tps}.`);
  lines.push(`Zarar kesme: giriş fiyatının ${s.exit.stopLossMultiple}x seviyesinde (%${Math.round((1 - s.exit.stopLossMultiple) * 100)} zarar).`);
  if (s.exit.trailingStopPct) lines.push(`İlk kâr almadan sonra zirveden %${s.exit.trailingStopPct} düşüşte kalan satılır.`);
  lines.push(`Tipik tutma süresi ${fmtDuration(Number(e.medianHoldSec))}; en fazla ${fmtDuration(s.exit.maxHoldSec)} tutulur.`);
  if (e.medianCaptureRatio !== null && e.medianCaptureRatio !== undefined)
    lines.push(`Kazanan işlemlerde hareketin ~%${Math.round(Number(e.medianCaptureRatio) * 100)}'ini yakalamışlar.`);
  return lines.join('\n');
}
