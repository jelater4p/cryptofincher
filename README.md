# CryptoFincher

Solana'da **kazanan cüzdanları analiz edip ne yaptıklarını anlayan**, bu davranışlardan **parametreli stratejiler çıkaran** ve seçtiğin stratejiyle **kendi alım-satım motorunda** işlem yapan modüler bir bot.

Bot cüzdanları **kopyalamaz**. Cüzdanlar sadece öğrenme verisidir. İşlem motoru, çıkarılan stratejinin kurallarına (giriş koşulları, kâr alma merdiveni, zarar kesme vb.) göre kendi kararını verir.

> ⚠️ Memecoin işlemleri çok yüksek risklidir. Bu yazılım finansal tavsiye değildir. Önce **backtest** ve **paper** modda test edin; canlıda sadece kaybetmeyi göze aldığınız tutarla, sadece bu bot için açılmış ayrı bir cüzdanla çalışın.

## Mimari

```
 ┌──────────────┐   ┌──────────────┐   ┌──────────────────┐   ┌──────────────┐
 │ 1. Keşif     │──▶│ 2. Senkron   │──▶│ 3. Davranış      │──▶│ 4. Strateji  │
 │ trend token  │   │ Helius RPC   │   │ analizi          │   │ çıkarımı     │
 │ → erken      │   │ → swap       │   │ tur, metrik,     │   │ k-means      │
 │   alıcılar   │   │   ayrıştırma │   │ bot/sniper eleme │   │ → kurallar   │
 └──────────────┘   └──────────────┘   └──────────────────┘   └──────┬───────┘
                                                                     │ sen seçersin
 ┌──────────────┐   ┌──────────────┐   ┌──────────────────┐   ┌──────▼───────┐
 │ 8. Telegram  │◀──│ 7. Pozisyon  │◀──│ 6. Güvenlik +    │◀──│ 5. Backtest  │
 │ bildirim,    │   │ yöneticisi   │   │ risk + yürütücü  │   │ → paper      │
 │ komut, panik │   │ TP/SL/trail  │   │ (paper | live)   │   │ → live       │
 └──────────────┘   └──────────────┘   └──────────────────┘   └──────────────┘
```

| Klasör | Görev |
|---|---|
| `src/data` | Veri kaynakları: Helius (kredi bütçeli), DexScreener, GeckoTerminal, RugCheck, Jupiter, pump.fun akışı |
| `src/analysis` | Swap ayrıştırıcı, pozisyon turları, cüzdan metrikleri, bot/sniper/wash filtreleri, beceri skoru, k-means, zenginleştirme |
| `src/discovery` | Kazanan token bulma ve erken alıcı cüzdan keşfi |
| `src/strategy` | Strateji şeması, çıkarım, Türkçe açıklama, giriş/çıkış kuralları (backtest ve canlı motor **aynı kuralları** kullanır) |
| `src/backtest` | Mum verisiyle lookahead'siz simülasyon ve portföy simülasyonu |
| `src/engine` | Tarama, zorunlu güvenlik filtresi, pozisyon boyutu, paper/live yürütücü, TP/SL/trailing/DCA, panik satış |
| `src/wallet` | Şifreli keystore (scrypt + AES-256-GCM) |
| `src/telegram` | Yönetim ve bildirimler |

## Analiz: cüzdanlardan ne öğreniliyor?

Her işlem DEX'e özel talimat çözülerek değil, **cüzdanın SOL ve token bakiye farklarından** ayrıştırılır. Böylece pump.fun, PumpSwap, Raydium, Meteora, Orca ve Jupiter aynı mantıkla çalışır. İşlem ücreti ve token hesabı kirası değerden ayıklanır.

Alımlar ve satımlar **pozisyon turlarına** dönüştürülür, her cüzdan için şunlar ölçülür:

- **Performans:** kazanma oranı, gerçekleşen PnL, ROI, kâr faktörü, kârlı hafta oranı, en büyük kazancın payı (şans göstergesi), maksimum düşüş
- **Giriş:** havuz açılışından ne kadar sonra girdiği, giriş market cap'i, kademeli alım (DCA) yapıp yapmadığı, düşüşte mi eklediği
- **Çıkış:** kısmi satış oranı, ilk satışın hangi katta ve pozisyonun ne kadarı olduğu, son satış katı, zarar kesme seviyesi
- **Zamanlama:** tutma süresi (kazançlarda ve kayıplarda ayrı), aktif saatler
- **Bağlam** (`/zenginlestir`): girişten önceki 5/15 dk fiyat hareketi (breakout mu, dip alımı mı), hacim artışı, pozisyon süresince görülen zirve ve hareketin ne kadarını yakaladığı

**Elenen cüzdanlar:** az veri, kârsız, yüksek frekanslı bot, blok-0 sniper (altyapı avantajı taklit edilemez), aynı slotta al-sat (wash/MEV), tokenları transferle gelen (insider/bundle şüphesi).

Uygun cüzdanlar davranış özelliklerine göre **k-means** ile gruplanır (k silüet skoruyla otomatik seçilir). Her gruptan, beceri skoruyla ağırlıklandırılmış istatistiklerle bir **strateji** çıkar (örnek çıktı):

```
Meme · Gün İçi · Momentum · Breakout
4 cüzdanın 112 kapanmış işleminden çıkarıldı (kazanma oranı %58).
Giriş: havuz 12 dk - 3.4 saat yaşındayken, market cap $85K - $1.2M aralığında.
Yükselişe binen bir yapı: girişten önceki 5 dk'da fiyat genelde %14 artmış.
Kâr alma: 2x'te %33, 3x'te %33, 5x'te %34.
Zarar kesme: giriş fiyatının 0.62x seviyesinde (%38 zarar).
İlk kâr almadan sonra zirveden %30 düşüşte kalan satılır.
```

Tüm parametreler Telegram'dan `/ayar` ile değiştirilebilir.

## Piyasa taraması

Bot iki ayrı iş yapar: **öğrenme** (cüzdan keşfi, analiz, strateji çıkarımı; varsayılan 24 saatte bir) ve **işlem** (piyasayı tarayıp strateji kurallarına uyan tokenlara girmek). İşlem tarafı sürekli çalışır:

| | Sıklık |
|---|---|
| Aday tokenları strateji kurallarına göre kontrol | 20 saniyede bir (`SCAN_INTERVAL_SEC`) |
| Açık pozisyonların kâr alma / zarar kesme kontrolü | 5 saniyede bir |
| GeckoTerminal yeni havuzlar listesi | 2 dakikada bir (`UNIVERSE_RECORDER_MINUTES`) |
| pump.fun yeni tokenları (Helius WebSocket) | Saniyeler içinde (`PUMPFUN_STREAM`) |

Aday tokenlar dört kaynaktan gelir: pump.fun canlı akışı, GeckoTerminal yeni havuzlar listesi, DexScreener profil/boost listeleri ve `/izle` ile eklenen tokenlar. Aday listesi en fazla `SCAN_MAX_CANDIDATES` (900) token tutar; en eskiler önce çıkar. Tarama sadece aktif bir strateji varken alım kontrolü yapar.

**pump.fun akışı** önce hafif modda çalışır: sadece pump.fun'ın token basma yetkilisinin geçtiği işlemleri, yani neredeyse yalnızca yeni token oluşturmaları dinler. Bu adres resmi bir kaynaktan doğrulanamadı; hafif mod 10 dakika içinde hiç token göremezse bot otomatik olarak pump.fun programının tüm işlemlerini dinleyen tam moda geçer ve gruba bildirir. Tam mod çok daha yüksek bant genişliği kullanır. Akışın durumu `/durum` ve günlük özette görünür. Helius WebSocket kullanımının kredi tüketip tüketmediğini ilk günlerde Helius panelinden kontrol et.

## Tarafsız token evreni

Normal backtest'te test edilen tokenlar trend listelerinden geliyor; yani çoğu sonradan yükselmiş "kazananlar". Ölen tokenlar evrende olmadığı için sonuçlar olduğundan iyi görünür (survivorship bias).

Bunu önlemek için bot, GeckoTerminal'in yeni havuzlar listesinden tokenları **açıldıkları anda**, gelecekte ne olacakları bilinmeden kaydeder (varsayılan 2 dakikada bir, ücretsiz, Helius kredisi harcamaz; aynı tokenlar işlem taramasına da aday olarak verilir). Ölenler de evrende kalır. Token sonradan başka bir DEX'e taşınsa bile ilk havuzu değişmez.

- Backtest ve walk-forward, uygun **en az 20 tarafsız token** varsa sadece bunları kullanır. Yoksa eski evrenle birleştirir ve raporda "karışık" olarak belirtir.
- Fiyat verisi bulunamayan tokenların oranı raporda gösterilir; bunlar çoğunlukla ölü tokenlar olduğu için yüksek oran sonuçların iyimser olabileceği anlamına gelir.
- İşlem olmayan dakikalarda mum gelmediği için boşluklar bir önceki kapanış fiyatıyla doldurulur.

Evrenin birikmesi zaman alır; ilk günlerde backtest'ler "karışık" evrenle çalışır.

## Günlük özet

Her gün `DAILY_SUMMARY_HOUR` saatinde (varsayılan 09:00, İstanbul saati) gruba tek bir mesaj gelir: son 24 saatin ve toplamın kâr/zararı, açık pozisyonlar, aktif stratejiler ve walk-forward sonuçları, keşif durumu, cüzdan sayıları, tarafsız evrenin büyümesi, Helius durumu ve kredi kullanımı. Bot o saatte kapalıysa aynı gün açılınca gönderir. İstediğin zaman `/ozet` ile de alabilirsin.

## Walk-forward doğrulama

Normal backtest iyimserdir, çünkü strateji büyük ölçüde test edildiği dönemin verisinden çıkarılır. Walk-forward bunu önler: veri zamana göre bölünür, strateji her turda sadece **öğrenme** penceresinden yeniden çıkarılır ve hemen sonraki, hiç görmediği **test** penceresinde denenir.

```
[ Öğren: 1-14. gün ][ Test: 15-21 ]
         [ Öğren: 8-21. gün ][ Test: 22-28 ]
                  [ Öğren: 15-28. gün ][ Test: 29-35 ] ...
```

- **Geleceğe bakma yok:** öğrenme penceresinde sadece o pencere bitmeden kapanmış işlemler kullanılır. Cüzdanlar da o dönemki performanslarına göre yeniden seçilir. O tarihte uygun olmayan bir cüzdan o turda kullanılmaz.
- **Ölçülenler:** öğrenme ve test getirisi (tur başı medyan), kazanma oranı düşüşü, test kâr faktörü, kârlı tur oranı, parametrelerin turdan tura kararlılığı, seçilen cüzdanların test döneminde seçilmeyenlere göre daha kârlı olup olmadığı.
- **Sonuç:** ✅ sağlam / 🟡 zayıf / ⛔ aşırı uyum / ❔ veri yetersiz. Aşırı uyum çıkan bir strateji `/sec` ile ancak açık onayla aktifleştirilir.

```
/walkforward <id>          # bir stratejinin kaynak cüzdanlarıyla
/walkforward hepsi         # tüm çıkarım yöntemi: her turda öğrenmede en iyi görüneni seçip test eder
/walkforward <id> 21 7     # 21 gün öğren, 7 gün test
```

Anlamlı sonuç için en az 3 haftalık işlem geçmişi gerekir. Ne kadar uzunsa o kadar iyi.

## Güvenlik (kapatılamaz)

- **Zorunlu token filtresi:** mint authority veya freeze authority aktifse, RugCheck skoru eşiği aşıyorsa ya da tehlikeli risk varsa işleme girilmez. Veri alınamazsa da girilmez (fail-closed).
- **Telegram acil durdurma:** `/dur` yeni girişleri durdurur (açık pozisyonların SL/TP yönetimi sürer), `/panik` her şeyi durdurup tüm pozisyonları satar.
- **Anahtar:** ayrı bir cüzdan, parola ile şifrelenmiş dosya (0600 izinli), parola başlangıçta sorulur.
- **Helius kredi bütçesi:** analiz işleri aylık kredinin %95'inde durur, kalan %5 canlı işlemlere ayrılır.
- Canlıya geçiş için açık onay gerekir: `/mod live ONAY`.

## Kurulum

```bash
git clone <repo> && cd cryptofincher
cp .env.example .env    # HELIUS_API_KEY, JUPITER_API_KEY, TELEGRAM_* doldurun
npm install
npm test
```

**Anahtarlar:**
- Helius: https://dashboard.helius.dev (Free plan yeterli)
- Jupiter: https://portal.jup.ag (ücretsiz anahtar, dakikada 60 istek)
- Telegram: @BotFather ile bot oluşturun. Chat ID'nizi öğrenmek için botu başlatıp `/start` yazın.

### VPS'te Docker ile

```bash
docker compose up -d --build
docker compose logs -f
```

Canlı mod için önce işlem cüzdanını oluşturun:

```bash
docker compose run --rm bot node dist/cli.js keystore:create
```

Sonra `.env` içinde `TRADING_MODE=live` yapın, `docker compose up -d` çalıştırın, `docker attach cryptofincher` ile bağlanıp parolayı girin ve **Ctrl+P, Ctrl+Q** ile ayrılın.

## Önerilen iş akışı

1. `/kesif`: kazanan tokenlar bulunur, erken alıcıları keşfedilir, analiz edilir, stratejiler çıkarılır. Kendi bildiğin cüzdanlar için `/cuzdanekle` ve `/analiz` kullanılır.
2. `/cuzdanlar` ve `/cuzdan <adres>`: cüzdanların ne yaptığını incele.
3. `/zenginlestir` ve ardından `/cikar`: giriş öncesi momentum bilgisiyle stratejileri güncelle.
4. `/stratejiler`, `/strateji <id>`, `/backtest <id>`
5. `/walkforward <id>`: görülmemiş veride doğrula. Sadece ✅ ya da 🟡 çıkanlarla devam et.
6. `/sec <id>`: önce **paper** modda en az birkaç gün çalıştır, `/pnl` ile izle.
7. Sonuçlar tatmin ediciyse `/mod live ONAY`.

CLI karşılıkları için `npm run cli` çalıştırın.

## Helius Free plan notları

- `getTransactionsForAddress` Free planda yok. Bot, her planda çalışan `getSignaturesForAddress` + `getTransaction` ile çalışır.
- Bot cüzdanlar, işlem çekilmeden önce sadece imza listesine bakılarak elenir. Bu kredinin büyük kısmını korur.
- Tüm veriler yerel SQLite'ta önbelleklenir, aynı işlem iki kez çekilmez.
- Panelde gözlenen maliyet çağrı başına yaklaşık 1 kredi (`HELIUS_CREDIT_*`). Fiyatlandırma değişirse `.env`'den güncelleyin.

## Cüzdan geçmişi ve analiz sırası

- Cüzdan başına en fazla `ANALYSIS_MAX_TX_PER_WALLET` (2000) işleme bakılır. Eski geçmişe inerken `ANALYSIS_TARGET_CLOSED_TRIPS` (60) kapanmış işlem toplanınca durulur: çok işlem yapan cüzdanlar gereksiz derin taranmaz, az işlem yapanlar sınıra kadar taranır.
- Tekrar analizde zaten işlenmiş işlemler atlanır. Son analizden sonraki yeni işlemler her zaman alınır; sınır büyütülürse eksik eski geçmiş tamamlanır.
- Her turda en fazla `ANALYSIS_WALLETS_PER_RUN` (60) cüzdan analiz edilir. Sıra: elle eklenenler, hiç analiz edilmemiş keşif cüzdanları (en eski eklenen önce), 3 günden eski uygun cüzdanların yenilenmesi, son olarak sadece "yeterli veri yok" yüzünden ve daha sığ geçmişle elenmiş cüzdanlar. Yeterli veriyle kârsız çıkan cüzdanlara tekrar bakılmaz.
- Asıl sınır kredi değil hız: Free planda saniyede ~8 istek. 2000 işlemlik bir cüzdan birkaç dakika sürer; plan yükseltilirse `HELIUS_RPS` artırılabilir.

## Bilinen sınırlar

- Tarafsız evren yeterince birikene kadar backtest evreni trend listelerinden ve analiz edilen cüzdanların tokenlarından oluşur; bu dönemde hayatta kalan tokenlara doğru yanlılık var (survivorship bias). Rapor hangi evrenin kullanıldığını her zaman belirtir.
- Cüzdanlar, aldıkları tokenlar sonradan yükseldiği için keşfediliyor; walk-forward bu seçimin etkisini tamamen ortadan kaldıramaz.
- Mum verisinde likidite ve alım/satım sayısı yok, bu iki koşul backtest'te uygulanmaz.
- Paper modda doldurulan fiyat gerçek Jupiter teklifidir, ama zincirdeki gerçek kayma ve işlemin bloğa girememe ihtimali modellenmez.

Daha fazla veri kaynağı ve geliştirme fikirleri için: [docs/KAYNAKLAR.md](docs/KAYNAKLAR.md)
