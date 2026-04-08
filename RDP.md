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

## Konu (WebJS): Oturum stratejisi — LocalAuth varsayilan

## Karar
- `whatsapp.wwebjs.service.ts` icinde `useRemoteAuth = false` tutulur: whatsapp-web.js `LocalAuth` ile oturum dosyalari yalnizca yerel `.wwebjs_auth/` altinda saklanir (`RemoteAuth` + veritabani store kullanilmaz).
- Yerel klasor yokken, daha once yedeklenmis zip varsa `restoreSessionFromDB` ile DB’den geri yukleme ve baglanti sonrasi periyodik `backupSessionToDB` (LocalAuth modunda) davranislari korunur; bu, tasinabilirlik icin istege bagli tamamlayicidir.

## Beklenen Etki
- Gelistirme ve tek makine senaryolarinda baglanti dogrudan yerel Chrome profili uzerinden calisir; RemoteAuth kaynakli ek senkronizasyon katmani devre disidir.
