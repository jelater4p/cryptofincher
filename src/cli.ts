import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { config } from './config.js';
import { analyzeWallet, storedReports } from './analysis/walletAnalyzer.js';
import { runBacktest } from './backtest/runner.js';
import { heliusCredits } from './data/helius.js';
import { solPriceService } from './data/solPrice.js';
import { discoverFromToken, runDiscovery } from './discovery/discovery.js';
import { events } from './engine/state.js';
import { analyzePending, enrichEligible, fullPipeline, reevaluateAndExtract, walkForwardJob } from './jobs.js';
import { formatWalkForward } from './backtest/walkforward.js';
import { getDb } from './storage/db.js';
import { wallets } from './storage/repo.js';
import { extractFromWallets, runExtraction } from './strategy/pipeline.js';
import { strategies } from './strategy/registry.js';
import { keystorePublicKey, promptHidden, saveKeystore } from './wallet/keystore.js';

const [cmd, ...args] = process.argv.slice(2);
events.on('notify', (m: string) => console.log(m));

const commands: Record<string, { help: string; run: () => Promise<unknown> | unknown }> = {
  'wallets:add': {
    help: '<adres> [etiket]  manuel cüzdan ekle',
    run: () => {
      wallets.add(args[0]!, 'manual', { label: args.slice(1).join(' ') || undefined });
      console.log('eklendi');
    },
  },
  'wallets:list': {
    help: 'cüzdanlar ve skorları',
    run: () =>
      console.table(
        storedReports().map((r) => ({
          address: r.address,
          score: r.score,
          eligible: r.eligible,
          winRate: Math.round(r.metrics.winRate * 100),
          pnlSol: Number(r.metrics.realizedPnlSol.toFixed(2)),
          trips: r.metrics.closedTrips,
          flags: r.flags.join(','),
        })),
      ),
  },
  'wallets:remove': { help: '<adres>', run: () => wallets.remove(args[0]!) },
  discover: { help: '[tokenSayısı]  trend tokenlardan cüzdan keşfi', run: async () => console.log(await runDiscovery(args[0] ? Number(args[0]) : undefined)) },
  'discover:token': { help: '<mint>  bir tokenın erken alıcıları', run: async () => console.log(await discoverFromToken(args[0]!, { recent: 100 })) },
  analyze: {
    help: '[adres]  cüzdanı ya da bekleyenleri analiz et',
    run: async () => console.log(args[0] ? JSON.stringify(await analyzeWallet(args[0]), null, 2) : await analyzePending(args[1] ? Number(args[1]) : undefined)),
  },
  enrich: { help: 'uygun cüzdanların işlemlerine giriş bağlamı ekle', run: async () => console.log(await enrichEligible()) },
  extract: {
    help: '[adres1,adres2]  strateji çıkar (adres verilirse sadece onlardan)',
    run: () => {
      if (args[0]) console.log(extractFromWallets(args[0].split(',')));
      else {
        const r = runExtraction();
        for (const s of r.specs) console.log(`\n=== ${s.id}: ${s.name} ===\n${s.description}`);
      }
    },
  },
  reevaluate: { help: 'tüm cüzdanları güncel kurallarla yeniden değerlendir (kredi harcamaz)', run: () => console.log(reevaluateAndExtract('Elle yeniden değerlendirme')) },
  pipeline: { help: 'keşif → analiz → zenginleştirme → strateji', run: () => fullPipeline() },
  'strategies:list': {
    help: 'stratejiler',
    run: () => console.table(strategies.list().map(({ spec, active }) => ({ id: spec.id, name: spec.name, active, ...spec.evidence }))),
  },
  'strategies:show': { help: '<id>', run: () => console.log(JSON.stringify(strategies.get(args[0]!)?.spec, null, 2)) },
  'strategies:activate': { help: '<id>', run: () => console.log(strategies.setActive(args[0]!, true)) },
  'strategies:deactivate': { help: '<id>', run: () => console.log(strategies.setActive(args[0]!, false)) },
  backtest: {
    help: '<id> [maxToken]',
    run: async () => {
      const s = strategies.get(args[0]!);
      if (!s) throw new Error('strateji yok');
      const r = await runBacktest(s.spec, { maxTokens: Number(args[1] ?? 60) });
      console.log(JSON.stringify({ ...r, equityCurve: undefined }, null, 2));
    },
  },
  walkforward: {
    help: '<id|all> [öğrenGün] [testGün] [rolling|expanding]  görülmemiş veride doğrulama',
    run: async () => {
      const target = !args[0] || args[0] === 'all' ? '*' : args[0];
      const r = await walkForwardJob(target, {
        ...(args[1] ? { trainDays: Number(args[1]) } : {}),
        ...(args[2] ? { testDays: Number(args[2]) } : {}),
        ...(args[3] === 'expanding' ? { mode: 'expanding' as const } : {}),
      });
      console.log(formatWalkForward(r));
    },
  },
  'sol:sync': { help: 'SOL/USD geçmişini güncelle', run: () => solPriceService.syncHistory() },
  credits: { help: 'Helius kredi kullanımı', run: () => console.log(`${heliusCredits.used()} / ${heliusCredits.limit()}`) },
  'keystore:create': {
    help: 'yeni işlem cüzdanı oluştur (şifreli)',
    run: async () => {
      const pass = await promptHidden('Yeni parola (en az 10 karakter): ');
      const again = await promptHidden('Tekrar: ');
      if (pass !== again) throw new Error('Parolalar eşleşmiyor');
      const kp = Keypair.generate();
      saveKeystore(config.KEYSTORE_PATH, kp, pass);
      console.log(`Oluşturuldu: ${config.KEYSTORE_PATH}\nAdres: ${kp.publicKey.toBase58()}\nBu adrese sadece kaybetmeyi göze aldığınız kadar SOL gönderin.`);
    },
  },
  'keystore:import': {
    help: 'mevcut gizli anahtarı (base58) şifreleyerek içe aktar',
    run: async () => {
      const secret = await promptHidden('Gizli anahtar (base58): ');
      const kp = Keypair.fromSecretKey(bs58.decode(secret.trim()));
      const pass = await promptHidden('Parola (en az 10 karakter): ');
      saveKeystore(config.KEYSTORE_PATH, kp, pass);
      console.log(`İçe aktarıldı: ${kp.publicKey.toBase58()}`);
    },
  },
  'keystore:address': { help: 'işlem cüzdanı adresi', run: () => console.log(keystorePublicKey(config.KEYSTORE_PATH) ?? 'keystore yok') },
};

async function main() {
  const c = cmd ? commands[cmd] : undefined;
  if (!c) {
    console.log('Kullanım: npm run cli -- <komut> [argümanlar]\n');
    for (const [name, def] of Object.entries(commands)) console.log(`  ${name.padEnd(24)} ${def.help}`);
    return;
  }
  getDb();
  await c.run();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(String(err));
    process.exit(1);
  });
