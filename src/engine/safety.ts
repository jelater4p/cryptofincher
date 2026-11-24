import { config } from '../config.js';
import { childLogger } from '../core/logger.js';
import { helius } from '../data/helius.js';
import { rugcheck, type RugSummary } from '../data/rugcheck.js';

const log = childLogger('safety');

export interface SafetyResult {
  ok: boolean;
  reasons: string[];
  rugScore?: number;
}

export interface MintAuthorities {
  mintAuthority: string | null;
  freezeAuthority: string | null;
}

const DANGER_RISK_PATTERNS = [/freeze/i, /mint/i, /honeypot/i, /transfer fee/i, /permanent delegate/i, /copycat/i];

/** Saf kontrol: test edilebilir */
export function assessSafety(auth: MintAuthorities | null, rug: RugSummary | null, maxScore: number): SafetyResult {
  const reasons: string[] = [];
  if (!auth) reasons.push('mint hesabı okunamadı');
  else {
    if (auth.mintAuthority) reasons.push('mint authority aktif (yeni token basılabilir)');
    if (auth.freezeAuthority) reasons.push('freeze authority aktif (hesabınız dondurulabilir)');
  }
  if (!rug) reasons.push('RugCheck raporu alınamadı');
  else {
    const score = rug.score_normalised;
    if (score === undefined) reasons.push('RugCheck skoru yok');
    else if (score > maxScore) reasons.push(`RugCheck skoru yüksek (${score} > ${maxScore})`);
    for (const r of rug.risks ?? []) {
      if (r.level === 'danger' && DANGER_RISK_PATTERNS.some((p) => p.test(r.name))) reasons.push(`RugCheck: ${r.name}`);
    }
  }
  return { ok: reasons.length === 0, reasons, rugScore: rug?.score_normalised };
}

/**
 * ZORUNLU güvenlik filtresi. Kapatılamaz; herhangi bir veri alınamazsa işleme girilmez (fail-closed).
 */
export async function checkTokenSafety(mint: string): Promise<SafetyResult> {
  const [auth, rug] = await Promise.all([
    helius.getMintInfo(mint).catch((err) => {
      log.warn({ mint, err: String(err) }, 'mint bilgisi alınamadı');
      return null;
    }),
    rugcheck.summary(mint).catch((err) => {
      log.warn({ mint, err: String(err) }, 'rugcheck alınamadı');
      return null;
    }),
  ]);
  return assessSafety(auth, rug, config.SAFETY_MAX_RUGCHECK_SCORE);
}
