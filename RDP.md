# RDP - Rule Development Proposal

## Konu
Cursor tarafinda uretilen kodlarin Husky pre-commit ve commit-msg kontrolleri ile otomatik uyumlu olmasi.

## Karar
- Projeye `.cursor/rules/husky-precommit-compat.mdc` adinda yeni bir always-apply kurali eklendi.
- Kural; `eslint --fix`, `tsc --noEmit`, import sirasi, `require()` yasagi ve Conventional Commit formatini zorunlu rehber olarak tanimlar.

## Beklenen Etki
- Pre-commit hatalari azalir.
- AI tarafindan yazilan kodlar repository standartlarina daha hizli uyum saglar.

---

## Konu (WebJS): Gelen medya `mediaUrl` ve S3 anahtari ile Baileys uyumu

## Karar
- `whatsapp.wwebjs.service.ts` icinde gelen medya icin MinIO/S3 nesne anahtari, Baileys gelen mesaj akisiyla ayni yapida uretilir: `{instanceId}/{remoteJid}/{messageType}/{timestamp}_{fileName}` (`path.posix.join`).
- `Media.messageId` her zaman Prisma `Message.id` (cuid) olur; WhatsApp `key.id` kullanilmaz.
- Medya yukleme ve `mediaUrl` webhook/RabbitMQ ciktisi, Baileys ile ayni kosulla baglanir: `DATABASE.SAVE_DATA.NEW_MESSAGE` ve mesajin veritabanina yazilmasi basarili oldugunda.

## Beklenen Etki
- RabbitMQ/webhook `messages.upsert` icindeki `mediaUrl` yolu ve semantik olarak Baileys ile uyumludur; tuketici servisler tek format kullanabilir.

---

## Konu (WebJS): `key.id` ile Baileys uyumu (whatsapp-web.js MessageId)

## Karar
- `whatsapp-web.js` mesaj kimligi `MessageId.id` (kisa sunucu id’si) ve `_serialized` (`true|false_<jid>_<id>`) olarak ikiye ayrilir.
- `whatsapp.wwebjs.service.ts` icinde webhook, veritabani ve ilgili olaylar (`message_ack`, revoke, edit, reaction) `key.id` olarak **yalnizca kisa id** kullanir: once `msg.id.id`, yoksa `_serialized` son `_` sonrasi (hex) parca; Baileys `key.id` ile ayni semantik.

## Beklenen Etki
- WebJS ve Baileys tuketicileri mesaj anahtarini ayni formatta karsilar; `true_...@c.us_` oneki webhook yuklerinde yer almaz.

---

## Konu (WebJS): Oturum stratejisi — LocalAuth varsayilan

## Karar
- `whatsapp.wwebjs.service.ts` icinde `useRemoteAuth = false` tutulur: whatsapp-web.js `LocalAuth` ile oturum dosyalari yalnizca yerel `.wwebjs_auth/` altinda saklanir (`RemoteAuth` + veritabani store kullanilmaz).
- Yerel klasor yokken, daha once yedeklenmis zip varsa `restoreSessionFromDB` ile DB’den geri yukleme ve baglanti sonrasi periyodik `backupSessionToDB` (LocalAuth modunda) davranislari korunur; bu, tasinabilirlik icin istege bagli tamamlayicidir.

## Beklenen Etki
- Gelistirme ve tek makine senaryolarinda baglanti dogrudan yerel Chrome profili uzerinden calisir; RemoteAuth kaynakli ek senkronizasyon katmani devre disidir.

---

## Konu: Yerel Soketi (Pusher-protokol alternatifi)

## Karar
- `docker-compose.services.yaml` icine `soketi` servisi eklendi: goruntu `quay.io/soketi/soketi:1.6-16-debian`, host port `127.0.0.1:16001` -> konteyner `6001`.
- Varsayilan uygulama kimlikleri ortam degiskenleriyle (`SOKETI_DEFAULT_APP_*`) veya `.env` uzerinden ozellestirilebilir; varsayilanlar: `evolution` / `evolution-key` / `evolution-secret`.
- Evolution API tarafinda Pusher bulutu yerine Soketi kullanirken Node `pusher` istemcisi genelde `host` (or. `127.0.0.1` veya `soketi`) ve `port` (`16001` hosttan, veya Docker icinden `6001`) ister; mevcut kod yalnizca `cluster` ile Pusher bulutuna giderse, yerel Soketi icin istemci yapilandirmasinin genisletilmesi veya ara katman gerekir.

## Beklenen Etki
- Gelistirmede ucretli Pusher hesabi olmadan Pusher-protokol uyumlu kanal test edilebilir; port ve kimlik bilgileri dokumante edildi.
