import 'dotenv/config';
import { z } from 'zod';

/** Belirtilmemişse varsayılan değer; belirtilmişse sadece 'true'/'1' açık sayılır */
const boolDefault = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v === 'true' || v === '1'));

const num = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number().finite());

const list = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const schema = z.object({
  // --- Helius ---
  HELIUS_API_KEY: z.string().default(''),
  HELIUS_RPC_URL: z.string().optional(),
  HELIUS_WS_URL: z.string().optional(),
  /** Free plan: düşük tutun. Planınıza göre artırın. */
  HELIUS_RPS: num(8),
  /** Aylık kredi bütçesi (Free = 1.000.000). Bu sınırın %95'inde keşif/analiz durur. */
  HELIUS_MONTHLY_CREDITS: num(1_000_000),

  // --- Jupiter ---
  JUPITER_API_KEY: z.string().default(''),
  JUPITER_BASE_URL: z.string().default('https://api.jup.ag'),
  /** Free key: 60 istek / dakika */
  JUPITER_RPM: num(55),

  // --- Diğer ücretsiz kaynaklar ---
  DEXSCREENER_BASE_URL: z.string().default('https://api.dexscreener.com'),
  GECKOTERMINAL_BASE_URL: z.string().default('https://api.geckoterminal.com/api/v2'),
  GECKOTERMINAL_RPM: num(25),
  RUGCHECK_BASE_URL: z.string().default('https://api.rugcheck.xyz/v1'),
  /** SOL/USD fiyat geçmişi için kullanılacak SOL-USDC havuzu (GeckoTerminal) */
  SOL_USDC_POOL: z.string().default('58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2'),

  // --- Telegram ---
  TELEGRAM_BOT_TOKEN: z.string().default(''),
  /** Botu kullanabilecek chat id'ler (virgülle) */
  TELEGRAM_ALLOWED_CHAT_IDS: list,

  // --- Depolama ---
  DATA_DIR: z.string().default('./data'),

  // --- Cüzdan / Anahtar ---
  KEYSTORE_PATH: z.string().default('./data/keystore.json'),
  /** Docker secret gibi bir dosyadan parola okumak için (opsiyonel) */
  KEYSTORE_PASSPHRASE_FILE: z.string().optional(),

  // --- Motor ---
  /** paper | live */
  TRADING_MODE: z.enum(['paper', 'live']).default('paper'),
  PAPER_STARTING_SOL: num(10),
  /** Agresif varsayılanlar (strateji bazında ezilebilir) */
  RISK_PCT_PER_TRADE: num(10),
  RISK_MAX_OPEN_POSITIONS: num(15),
  RISK_MAX_SLIPPAGE_BPS: num(300),
  /** Her işlemde SOL rezervi (fee/rent için) */
  RISK_SOL_RESERVE: num(0.05),
  /** RugCheck normalize skor üst sınırı (0-100, yüksek = riskli). Zorunlu filtre. */
  SAFETY_MAX_RUGCHECK_SCORE: num(50),
  /** Top 10 holder (LP hariç) toplam yüzde üst sınırı */
  SAFETY_MAX_TOP10_PCT: num(60),
  SCAN_INTERVAL_SEC: num(20),
  POSITION_CHECK_INTERVAL_SEC: num(5),
  /** Yeni pump.fun tokenlarını Helius WebSocket ile saniyeler içinde gör (hafif mod, gerekirse tam mod) */
  PUMPFUN_STREAM: boolDefault(true),
  /** Taramada izlenen en fazla aday token (her biri 20 sn'de bir DexScreener'dan kontrol edilir) */
  SCAN_MAX_CANDIDATES: num(900),

  // --- Analiz ---
  /** 0 = kapalı. Örn 24: günde bir keşif → analiz → strateji çıkarımı (yeniden başlatmada sayaç korunur) */
  DISCOVERY_INTERVAL_HOURS: num(0),
  /** API limiti dolunca Telegram'a kaç saatte bir hatırlatma gönderilsin */
  ALERT_REPEAT_HOURS: num(2),

  /** Tarafsız evren: GeckoTerminal yeni havuzlar listesi kaç dakikada bir kaydedilsin (0 = kapalı) */
  UNIVERSE_RECORDER_MINUTES: num(2),
  /** Tarafsız evrende kayıtlar kaç gün saklansın */
  UNIVERSE_RETENTION_DAYS: num(120),

  /** Günlük özet saati (SUMMARY_TIMEZONE saatiyle, 0-23). -1 = kapalı */
  DAILY_SUMMARY_HOUR: num(9),
  SUMMARY_TIMEZONE: z.string().default('Europe/Istanbul'),

  /** Cüzdan başına en fazla bakılacak işlem (geçmiş derinliği) */
  ANALYSIS_MAX_TX_PER_WALLET: num(2000),
  /** Bu kadar kapanmış işlem toplanınca daha eskiye gidilmez (az işlem yapan cüzdanlar derin taranır) */
  ANALYSIS_TARGET_CLOSED_TRIPS: num(60),
  /** Her analiz turunda (keşif ya da /analiz) en fazla kaç cüzdan analiz edilsin */
  ANALYSIS_WALLETS_PER_RUN: num(60),
  ANALYSIS_MIN_CLOSED_POSITIONS: num(8),
  DISCOVERY_EARLY_BUYERS_PER_TOKEN: num(60),

  LOG_LEVEL: z.string().default('info'),
});

export type Config = z.infer<typeof schema> & {
  heliusRpcUrl: string;
  heliusWsUrl: string;
};

function load(): Config {
  const parsed = schema.parse(process.env);
  const key = parsed.HELIUS_API_KEY;
  return {
    ...parsed,
    heliusRpcUrl: parsed.HELIUS_RPC_URL ?? `https://mainnet.helius-rpc.com/?api-key=${key}`,
    heliusWsUrl: parsed.HELIUS_WS_URL ?? `wss://mainnet.helius-rpc.com/?api-key=${key}`,
  };
}

export const config: Config = load();
