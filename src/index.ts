import fs from 'node:fs';
import { config } from './config.js';
import { logger } from './core/logger.js';
import { solPriceService } from './data/solPrice.js';
import { TradingEngine } from './engine/engine.js';
import { LiveExecutor, PaperExecutor, type Executor } from './engine/executor.js';
import { engineState } from './engine/state.js';
import { startMonitor } from './monitor.js';
import { startUniverseRecorder } from './discovery/universe.js';
import { getDb } from './storage/db.js';
import { startTelegram } from './telegram/bot.js';
import { loadKeystore, readPassphrase } from './wallet/keystore.js';

async function main() {
  getDb();
  logger.info({ mode: config.TRADING_MODE }, 'CryptoFincher başlıyor');

  let live: Executor | undefined;
  const wantsKey = config.TRADING_MODE === 'live' || !!config.KEYSTORE_PASSPHRASE_FILE;
  if (fs.existsSync(config.KEYSTORE_PATH) && wantsKey) {
    const pass = await readPassphrase(config.KEYSTORE_PASSPHRASE_FILE);
    const kp = loadKeystore(config.KEYSTORE_PATH, pass);
    live = new LiveExecutor(kp);
    logger.info({ address: kp.publicKey.toBase58() }, 'işlem cüzdanı yüklendi');
  } else if (config.TRADING_MODE === 'live') {
    throw new Error(`Canlı mod için keystore yok: ${config.KEYSTORE_PATH}. Önce: npm run cli -- keystore:create`);
  }

  // env'deki mod sadece ilk açılışta uygulanır; sonrasında Telegram'dan değiştirilen mod korunur
  if (config.TRADING_MODE === 'paper') engineState.setMode('paper');
  else if (live && engineState.mode() !== 'live') engineState.setMode('live');

  // arka planda: GeckoTerminal yavaşsa ya da erişilemezse Telegram ve motorun açılışını geciktirmesin
  void solPriceService.syncHistory();
  setInterval(() => void solPriceService.syncHistory(), 24 * 3600_000);

  const engine = new TradingEngine({ paper: new PaperExecutor(), live });
  engine.start();
  startTelegram(engine);

  // Helius limit uyarıları + hatırlatmalar ve zamanlanmış keşif
  startMonitor();
  // tarafsız token evreni: yeni açılan havuzları performanslarına bakmadan kaydeder
  startUniverseRecorder();
  if (config.DISCOVERY_INTERVAL_HOURS > 0) logger.info({ hours: config.DISCOVERY_INTERVAL_HOURS }, 'zamanlanmış keşif açık');

  const shutdown = () => {
    logger.info('kapanıyor');
    engine.stop();
    getDb().close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.fatal({ err: String(err) }, 'başlatılamadı');
  process.exit(1);
});
