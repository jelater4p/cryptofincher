# Veri kaynakları ve geliştirme yol haritası

Fiyatlar ve limitler sık değişir. Kullanmadan önce her sağlayıcının güncel sayfasını kontrol edin.

## Şu an kullanılanlar (ücretsiz)

| Kaynak | Ne için | Not |
|---|---|---|
| **Helius** RPC + WebSocket | İşlem geçmişi, mint bilgisi, bakiye, pump.fun akışı | Free: 1M kredi/ay. `getTransactionsForAddress` Developer planı gerektirir |
| **Jupiter** Swap V2 + Price V3 | Swap teklifi ve yürütme, fiyat | `api.jup.ag`, ücretsiz anahtar ile dakikada 60 istek. `lite-api` kaldırılıyor |
| **DexScreener** | Token, havuz, likidite, mcap, trend/boost listeleri | Anahtarsız, dakikada 60-300 istek |
| **GeckoTerminal** | OHLCV mumları (backtest, zenginleştirme, SOL/USD geçmişi) | Anahtarsız, dakikada ~30 istek |
| **RugCheck** | Token risk skoru | Tekli rapor uç noktaları anahtarsız |

## Sistemi en çok iyileştirecek yükseltmeler (öncelik sırasıyla)

1. **Helius Developer planı** (~$49/ay)
   - `getTransactionsForAddress`: tek çağrıda 100'e kadar tam işlem. Cüzdan senkronu ~10 kat hızlanır ve ucuzlar.
   - 10M kredi: ayda binlerce cüzdan analizi.
   - Entegrasyon: `src/data/helius.ts` içine `getTransactionsForAddress` ekleyip `syncWallet`'ta kullanmak yeterli; ayrıştırıcı aynı kalır.

2. **Birdeye API** (ücretli katmanlar)
   - Token başına "top traders" ve cüzdan PnL: kazanan cüzdan keşfi için en doğrudan kaynak. Erken alıcı taramasından çok daha az kredi harcar.
   - Geçmiş OHLCV ve token güvenlik verisi.
   - Entegrasyon: `src/discovery` içine yeni bir keşif kaynağı.

3. **Dune Analytics** (`dex_solana.trades`)
   - SQL ile milyonlarca işlem üzerinde toplu analiz. Örneğin "son 30 günde en az 50 işlem yapmış, PnL'i en yüksek 500 cüzdan".
   - Backtest için tarafsız bir token evreni (survivorship bias'ı azaltır).
   - Entegrasyon: Dune API ile sorgu sonuçlarını `wallets` tablosuna aday olarak yazmak.

4. **SolanaTracker Data API**
   - Cüzdan PnL, tokenın ilk alıcıları, trending listeleri. Erken alıcıları tek çağrıda verir.

5. **Bitquery** (GraphQL)
   - Gerçek zamanlı ve geçmiş DEX işlemleri. pump.fun ve PumpSwap için zengin şema.

6. **Gerçek zamanlı akış: Helius LaserStream / Yellowstone gRPC** (Business planı ve üstü, ya da Triton/Shyft)
   - Milisaniye gecikmeyle yeni havuzlar ve işlemler. Erken giriş stratejileri için önemli.

7. **İşlemin zincire girmesi: Jito bundle'ları / Helius Sender**
   - Şu an Jupiter'in yönetilen gönderimi (`/execute`) kullanılıyor. Daha fazla kontrol için Jito tip'li bundle ya da Helius Sender ile kendi gönderim yolunuzu kurabilirsiniz (MEV koruması ve hız).

## Tamamlayıcı ve ücretsiz kaynaklar

- **Shyft**: ayrıştırılmış işlemler, ücretsiz katman, gRPC
- **Vybe Network**: Solana cüzdan ve token analitiği API'si
- **Solscan Pro API**: hesap ve işlem geçmişi (ücretli)
- **pump.fun frontend API / PumpPortal**: pump.fun'a özel token metadata ve işlemler (resmi olmayan, değişebilir)

## Algoritmik geliştirme fikirleri

- **Davranış sınıflandırıcısı**: zenginleştirilmiş turlardan "giriş anındaki token özellikleri → kazanma olasılığı" modeli (gradient boosting). Kural tabanlı stratejiye ek filtre olarak kullanılır.
- **Rejim tespiti**: memecoin piyasasının genel ısısı (pump.fun günlük mezun sayısı, SOL trendi). Stratejiler soğuk piyasada otomatik kısılır.
- **Cüzdan ağı analizi**: aynı kaynaktan fonlanan cüzdanları birleştirme (sybil/bundle tespiti), insider kümelerini eleme.
- **Walk-forward doğrulama**: stratejiyi eski veriden çıkarıp yeni veride test etmek (aşırı uyumu önler).
