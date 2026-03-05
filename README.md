# 🎵 Mortex Music Bot

Discord YouTube Müzik Botu - Developed By Mortex

## Özellikler
- 🎶 YouTube linklerinden müzik çalma
- 📋 Şarkı kuyruk sistemi
- 🔊 Ses seviyesi ayarlama
- 🎥 "Developed By Mortex" yayın durumu
- 🔇 Bekleme kanalında kulaklık kapalı, mikrofon açık bekleme

## Slash Komutları
| Komut | Açıklama |
|-------|----------|
| `/gel` | Botu ses kanalına çağırır |
| `/cal <link>` | YouTube linkini çalar |
| `/dur` | Müziği duraklatır |
| `/devam` | Müziği devam ettirir |
| `/atla` | Sıradaki şarkıya geçer |
| `/kuyruk` | Şarkı kuyruğunu gösterir |
| `/ses <1-100>` | Ses seviyesini ayarlar |
| `/git` | Botu kanaldan çıkarır |

## Kurulum

### Railway Değişkenleri
Railway Dashboard > Variables kısmında şu değişkenleri ekleyin:

| Değişken | Açıklama |
|----------|----------|
| `DISCORD_TOKEN` | Discord bot tokeniniz |
| `CLIENT_ID` | Discord Application Client ID |
| `WAIT_CHANNEL_ID` | Botun bekleme ses kanalı ID'si |
| `WAIT_GUILD_ID` | Bekleme kanalının sunucu ID'si |

### GitHub'a Yükleme
```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/KULLANICI_ADIN/REPO_ADIN.git
git push -u origin main
```

### Railway'e Bağlama
1. [Railway.app](https://railway.app) sitesine gidin
2. **New Project** > **Deploy from GitHub repo**
3. GitHub reponuzu seçin
4. **Variables** sekmesinden yukarıdaki değişkenleri ekleyin
5. Deploy otomatik başlayacaktır

## Lisans
ISC - Developed By Mortex
