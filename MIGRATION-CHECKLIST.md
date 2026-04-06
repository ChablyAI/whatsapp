# Baileys → whatsapp-web.js Geçiş Planı ve Checklist

> **Tarih:** 2026-04-06  
> **Mevcut:** Baileys (`BaileysStartupService`)  
> **Hedef:** whatsapp-web.js v1.34.6+ (`WWebJSStartupService`)  
> **Dosya:** `src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts` → yeni servis

---

## Geçiş Stratejisi

### Aşamalar
1. **Aşama 1 - Temel Altyapı**: Bağlantı, QR, oturum yönetimi
2. **Aşama 2 - Mesaj Gönderme**: Metin, medya, sticker, konum, kişi
3. **Aşama 3 - Mesaj Alma**: Gelen mesaj işleme, webhook, chatbot entegrasyonu
4. **Aşama 4 - Grup Yönetimi**: Tüm grup işlemleri
5. **Aşama 5 - Profil & Kişi**: Profil, presence, gizlilik
6. **Aşama 6 - Gelişmiş Özellikler**: Etiketler, katalog, arama, durum/hikaye
7. **Aşama 7 - Entegrasyon**: Chatwoot, OpenAI, chatbot, S3 entegrasyonları
8. **Aşama 8 - Test & Stabilizasyon**: Kapsamlı test ve hata düzeltme

---

## Aşama 1 - Temel Altyapı (Bağlantı & Oturum)

### Bağlantı Yönetimi
- [x] `connectToWhatsapp()` — Client oluşturma ve başlatma
  - Baileys: `makeWASocket()` + Signal protocol
  - wwebjs: `new Client()` + `client.initialize()` (Puppeteer tabanlı)
- [x] QR kod üretimi ve gösterimi
  - Baileys: `connection.update` eventi ile QR
  - wwebjs: `client.on('qr', qr => ...)` eventi
- [ ] Pairing code desteği (telefon numarası ile bağlanma)
  - Baileys: `requestPairingCode()`
  - wwebjs: `client.requestPairingCode(phoneNumber)`
- [x] Oturum kalıcılığı (session persistence)
  - Baileys: Custom auth state (Prisma/Redis/file)
  - wwebjs: `RemoteAuth` + `PrismaRemoteStore` (veritabanı tabanlı, Baileys ile aynı yaklaşım)
- [x] Otomatik yeniden bağlanma (reconnection)
  - Baileys: `connection.update` → `lastDisconnect` + retry
  - wwebjs: `client.on('disconnected')` + otomatik reconnect (NAVIGATION/CONFLICT)
- [x] `reloadConnection()` — Bağlantıyı yeniden kurma
  - wwebjs: `client.destroy()` + `createClient()`
- [x] `logoutInstance()` — Oturumu kapatma ve temizleme
  - wwebjs: `client.logout()` + `client.destroy()` + session silme
- [x] `connectionStatus` / `stateConnection` — Bağlantı durumu
  - wwebjs: `ready`, `disconnected`, `change_state` event handler'ları
- [x] `qrCode` getter — QR bilgisini döndürme
- [x] Multi-device desteği
  - wwebjs: Varsayılan olarak multi-device destekli

### Yapılandırma
- [x] Proxy desteği (`proxyAuthentication` option)
- [x] Puppeteer ayarları (headless, args, executablePath)
- [ ] ffmpeg path ayarı (sticker dönüşümü için)
- [ ] `deviceName` / `browserName` ayarları

---

## Aşama 2 - Mesaj Gönderme

### Temel Mesajlar
- [ ] `textMessage()` — Metin mesajı gönderme
  - Baileys: `client.sendMessage(jid, { text })`
  - wwebjs: `client.sendMessage(chatId, content, options)`
  - [ ] Link preview desteği
  - [ ] Mention (bahsetme) desteği
  - [ ] Quoted (alıntılı) mesaj desteği
  - [ ] Delay (gecikme) ile gönderim

### Medya Mesajları
- [ ] `mediaMessage()` — Genel medya gönderme (image/video/document)
  - Baileys: `client.sendMessage(jid, { image/video/document, caption })`
  - wwebjs: `client.sendMessage(chatId, new MessageMedia(...), { caption })`
  - [ ] URL'den medya gönderme
  - [ ] Base64'ten medya gönderme
  - [ ] Buffer'dan medya gönderme
  - [ ] Dosya adı (fileName) desteği
  - [ ] Caption desteği

### Ses Mesajları
- [ ] `audioWhatsapp()` — Ses mesajı (PTT/voice note)
  - Baileys: `client.sendMessage(jid, { audio, ptt: true })`
  - wwebjs: `client.sendMessage(chatId, media, { sendAudioAsVoice: true })`
- [ ] `processAudio()` — Ses format dönüşümü (MP4/OGG)
- [ ] `processAudioMp4()` — MP4 ses işleme

### Sticker
- [ ] `mediaSticker()` — Sticker gönderme
  - Baileys: WebP dönüşümü + `client.sendMessage(jid, { sticker })`
  - wwebjs: `client.sendMessage(chatId, media, { sendMediaAsSticker: true })`
  - [ ] Sticker metadata (pack name, author)
  - [ ] Sticker pack desteği (`sendMediaAsStickerPack`)

### Konum
- [ ] `locationMessage()` — Konum mesajı
  - Baileys: `client.sendMessage(jid, { location: { degreesLatitude, degreesLongitude } })`
  - wwebjs: `client.sendMessage(chatId, new Location(lat, lng, description))`

### Kişi Kartı
- [ ] `contactMessage()` — vCard mesajı
  - Baileys: `client.sendMessage(jid, { contacts: { contacts: [vcard] } })`
  - wwebjs: `client.sendMessage(chatId, new Contact(...))` veya vCard string

### Etkileşimli Mesajlar
- [ ] `buttonMessage()` — Butonlu mesaj
  - Baileys: Interactive message format
  - wwebjs: ⚠️ **Buttons/Lists deprecated** — alternatif gerekli
- [ ] `listMessage()` — Liste mesajı
  - wwebjs: ⚠️ **Deprecated** — alternatif gerekli
- [ ] `reactionMessage()` — Emoji tepkisi
  - Baileys: `client.sendMessage(jid, { react: { text: emoji, key } })`
  - wwebjs: `message.react(emoji)`

### Anket
- [ ] `pollMessage()` — Anket oluşturma ve gönderme
  - Baileys: `client.sendMessage(jid, { poll: { name, values, selectableCount } })`
  - wwebjs: `client.sendMessage(chatId, new Poll(name, options))`
  - [ ] Anket oyu alma (vote_update eventi)

### PTV (Video Note)
- [ ] `ptvMessage()` — Kısa video mesajı (PTV)
  - Baileys: `client.sendMessage(jid, { video, ptv: true })`
  - wwebjs: ⚠️ **Araştırılmalı** — doğrudan PTV desteği belirsiz

### Durum/Hikâye
- [ ] `statusMessage()` — WhatsApp Status gönderme
  - Baileys: `client.sendMessage('status@broadcast', ...)`
  - wwebjs: `client.sendStatus(content)` (metin) — medya desteği kısıtlı
  - [ ] Metin status
  - [ ] Medya status (görsel/video)
  - [ ] Status silme (`revokeStatusMessage`)

### Mesaj Düzenleme
- [ ] `updateMessage()` — Gönderilmiş mesajı düzenleme
  - Baileys: `client.sendMessage(jid, { text, edit: key })`
  - wwebjs: `message.edit(newContent)` + `message_edit` eventi

### Yazıyor Durumu ile Gönderim
- [ ] `sendMessageWithTyping()` — Gönderim öncesi "yazıyor" gösterme
  - Baileys: `sendPresenceUpdate('composing')` + delay + send
  - wwebjs: `chat.sendStateTyping()` + delay + `client.sendMessage()`

---

## Aşama 3 - Mesaj Alma ve İşleme

### Gelen Mesaj İşleme
- [x] `messages.upsert` handler → `message` / `message_create` eventi
  - wwebjs: `client.on('message', msg => ...)` ile gelen mesaj handler'ı
- [x] Mesaj normalize etme (`prepareMessage`)
  - `prepareMessage(msg)`: wwebjs Message → Baileys uyumlu `messageRaw` dönüşümü
  - `mapWWebJSTypeToMessageType()`: chat→conversation, image→imageMessage, vb.
  - `buildMessageContent()`: Mesaj içeriğini Baileys formatına dönüştürme
- [x] Gelen medya indirme
  - wwebjs: `message.downloadMedia()` → `MessageMedia` objesi (base64)
- [x] Medya S3/MinIO yükleme entegrasyonu
  - S3 aktifse medya otomatik yükleniyor ve `mediaUrl` oluşturuluyor
- [ ] OpenAI speech-to-text (ses mesajları) — Aşama 7'de entegrasyon ile birlikte
- [x] Chatbot emit (chatbotController.emit)
  - Tüm chatbot entegrasyonları (EvolutionBot, Typebot, OpenAI, Dify, N8N, EvoAI, Flowise) tetikleniyor
- [x] Chatwoot entegrasyonu
  - Chatwoot aktifse mesaj senkronizasyonu yapılıyor
- [x] Webhook gönderimi (`sendDataWebhook`)
  - `Events.MESSAGES_UPSERT` webhook'u gönderiliyor
- [x] Telemetri gönderimi
  - `sendTelemetry()` ile mesaj tipi loglanıyor
- [x] Kişi kaydetme (Contact upsert)
- [x] Sohbet kaydetme (Chat upsert)

### Mesaj Güncellemeleri
- [x] `messages.update` handler → `message_ack` eventi
  - wwebjs: `client.on('message_ack', (msg, ack) => ...)`
  - ACK seviyeleri: ERROR(-1), PENDING(0), SERVER_ACK(1), DELIVERY_ACK(2), READ(3), PLAYED(4)
  - DB'de `MessageUpdate` kaydı oluşturuluyor
- [x] Mesaj silme olayları
  - wwebjs: `client.on('message_revoke_everyone', (revokedMsg, oldMsg) => ...)`
  - DB'de logical delete (status: 'DELETED')
  - `Events.MESSAGES_DELETE` webhook'u
- [x] Mesaj düzenleme olayları
  - wwebjs: `client.on('message_edit', (msg, newBody, prevBody) => ...)`
  - DB'de mesaj güncelleme + `MessageUpdate` kaydı (status: 'EDITED')
  - `Events.MESSAGES_EDITED` webhook'u
- [x] Mesaj tepki (reaction) olayları
  - wwebjs: `client.on('message_reaction', reaction => ...)`
  - `Events.MESSAGES_UPDATE` webhook'u

### Okunma Bildirimleri
- [x] `message-receipt.update` → `message_ack` eventi (yukarıdaki message_ack ile birleşik)

### Anket İşleme
- [ ] Anket oyu çözme (decrypt)
  - Baileys: `decryptPollVote` + aggregate
  - wwebjs: `client.on('vote_update')` + `client.getPollVotes(messageId)`

### Mesaj Geçmişi
- [ ] `messaging-history.set` handler — Geçmiş senkronu
  - Baileys: Büyük geçmiş senkronizasyonu
  - wwebjs: `client.syncHistory(chatId)` — kısmi geçmiş

### LID/PN Eşlemesi
- [ ] `enrichMessageKeyWithLid` / `normalizeKeyPnAltFields`
  - Baileys: LID ↔ PN mapping
  - wwebjs: `client.getContactLidAndPhone(userIds)`

---

## Aşama 4 - Grup Yönetimi

- [ ] `createGroup()` — Grup oluşturma
  - Baileys: `client.groupCreate(subject, participants)`
  - wwebjs: `client.createGroup(title, participants, options)`
- [ ] `updateGroupPicture()` — Grup fotoğrafı güncelleme
  - Baileys: `client.updateProfilePicture(jid, image)`
  - wwebjs: `group.setPicture(media)`
- [ ] `updateGroupSubject()` — Grup konusu değiştirme
  - Baileys: `client.groupUpdateSubject(jid, subject)`
  - wwebjs: `group.setSubject(subject)`
- [ ] `updateGroupDescription()` — Grup açıklaması
  - Baileys: `client.groupUpdateDescription(jid, description)`
  - wwebjs: `group.setDescription(description)`
- [ ] `findGroup()` — Grup bilgisi sorgulama
  - wwebjs: `client.getChatById(groupId)` → `GroupChat`
- [ ] `fetchAllGroups()` — Tüm grupları listeleme
  - wwebjs: `client.getChats()` → `.filter(c => c.isGroup)`
- [ ] `inviteCode()` — Davet kodu alma
  - Baileys: `client.groupInviteCode(jid)`
  - wwebjs: `group.getInviteCode()`
- [ ] `inviteInfo()` — Davet linki bilgisi
  - wwebjs: `client.getInviteInfo(inviteCode)`
- [ ] `sendInvite()` — Davet mesajı gönderme
- [ ] `acceptInviteCode()` — Daveti kabul etme
  - wwebjs: `client.acceptInvite(inviteCode)`
- [ ] `revokeInviteCode()` — Daveti iptal etme
  - wwebjs: `group.revokeInvite()`
- [ ] `findParticipants()` — Üye listesi
  - wwebjs: `group.participants` dizisi
- [ ] `updateGParticipant()` — Üye ekleme/çıkarma/promote/demote
  - wwebjs: `group.addParticipants()` / `group.removeParticipants()` / `group.promoteParticipants()` / `group.demoteParticipants()`
- [ ] `updateGSetting()` — Grup ayarları (announcement vb.)
  - wwebjs: `group.setMessagesAdminsOnly(true/false)` / `group.setInfoAdminsOnly(true/false)`
- [ ] `toggleEphemeral()` — Geçici mesajlar ayarı
  - Baileys: `client.sendMessage(jid, { disappearingMessagesInChat: duration })`
  - wwebjs: Chat ephemeral ayarları — **araştırılmalı**
- [ ] `leaveGroup()` — Gruptan ayrılma
  - wwebjs: `group.leave()`

### Grup Olayları
- [ ] `groups.upsert` / `groups.update` handler
  - wwebjs: `client.on('group_update', notification => ...)`
- [ ] `group-participants.update` handler
  - wwebjs: `client.on('group_join')` / `client.on('group_leave')` / `client.on('group_admin_changed')`
- [ ] Grup üyelik talepleri
  - wwebjs: `client.on('group_membership_request')` + `client.approveGroupMembershipRequests()` / `client.rejectGroupMembershipRequests()`

---

## Aşama 5 - Profil, Kişi & Presence

### Profil Yönetimi
- [x] `getProfileName()` — Profil adı alma
  - wwebjs: `client.info.pushname` ✅ Aşama 1'de implemente edildi
- [x] `getProfileStatus()` — Kendi durum metni
  - wwebjs: `client.getState()` ✅ Aşama 1'de implemente edildi
- [ ] `profilePicture()` — Başka birinin profil fotoğrafı
  - wwebjs: `client.getProfilePicUrl(contactId)`
- [ ] `fetchProfile()` — Birleşik profil bilgisi
  - wwebjs: `client.getContactById()` + `getProfilePicUrl()` kombinasyonu
- [ ] `fetchBusinessProfile()` — İşletme profili
  - wwebjs: Contact nesnesindeki business bilgileri
- [ ] `updateProfileName()` — Profil adı güncelleme
  - wwebjs: `client.setDisplayName(name)`
- [ ] `updateProfileStatus()` — Durum güncelleme
  - wwebjs: `client.setStatus(status)`
- [ ] `updateProfilePicture()` — Profil fotoğrafı güncelleme
  - wwebjs: `client.setProfilePicture(media)`
- [ ] `removeProfilePicture()` — Profil fotoğrafı kaldırma
  - wwebjs: `client.deleteProfilePicture()`

### Kişi Yönetimi
- [ ] `whatsappNumber()` — Numara WhatsApp kontrolü
  - Baileys: `client.onWhatsApp(number)`
  - wwebjs: `client.isRegisteredUser(number)` + `client.getNumberId(number)`
- [ ] `blockUser()` — Kullanıcı engelleme
  - wwebjs: `contact.block()` / `contact.unblock()`
- [ ] Kişi olayları (`contacts.upsert` / `contacts.update`)
  - wwebjs: `client.on('contact_changed', (msg, oldId, newId) => ...)`
- [ ] `getContacts()` — Tüm kişiler
  - wwebjs: `client.getContacts()`

### Presence (Çevrimiçi Durumu)
- [ ] `sendPresence()` — Belirli sohbete yazıyor/kaydediyor
  - wwebjs: `chat.sendStateTyping()` / `chat.sendStateRecording()` / `chat.clearState()`
- [ ] `setPresence()` — Genel çevrimiçi durumu
  - wwebjs: `client.sendPresenceAvailable()` / `client.sendPresenceUnavailable()`
- [ ] Presence olayları alma
  - Baileys: `presence.update` eventi
  - wwebjs: ⚠️ **Diğer kullanıcıların presence'ı desteklenmiyor olabilir**

### Gizlilik
- [ ] `fetchPrivacySettings()` — Gizlilik ayarları
  - wwebjs: ⚠️ **Doğrudan API yok** — araştırılmalı
- [ ] `updatePrivacySettings()` — Gizlilik güncelleme
  - wwebjs: ⚠️ **Doğrudan API yok** — araştırılmalı

---

## Aşama 6 - Gelişmiş Özellikler

### Etiket (Label) Yönetimi
- [ ] `fetchLabels()` — Etiketleri listeleme
  - wwebjs: `client.getLabels()`
- [ ] `handleLabel()` — Sohbete etiket ekleme/çıkarma
  - wwebjs: `client.addOrRemoveLabels(labelIds, chatIds)`
- [ ] Etiket olayları
  - wwebjs: `client.getChatLabels(chatId)` / `client.getChatsByLabelId(labelId)`

### Sohbet Yönetimi
- [ ] `markMessageAsRead()` — Okundu işaretleme
  - wwebjs: `client.sendSeen(chatId)` / `chat.sendSeen()`
- [ ] `archiveChat()` — Sohbet arşivleme
  - wwebjs: `client.archiveChat(chatId)` / `chat.archive()`
- [ ] `markChatUnread()` — Okunmadı işaretleme
  - wwebjs: `client.markChatUnread(chatId)`
- [ ] `deleteMessage()` — Mesaj silme
  - Baileys: `client.sendMessage(jid, { delete: key })`
  - wwebjs: `message.delete(true)` (herkes için)
- [ ] `getLastMessage()` — Son mesaj alma
  - wwebjs: `chat.lastMessage`
- [ ] `fetchMessages()` — Sayfalı mesaj sorgulama
  - wwebjs: `chat.fetchMessages({ limit })` + Prisma sorgusu
- [ ] `getBase64FromMediaMessage()` — Medya base64 çıkarma
  - wwebjs: `message.downloadMedia()` → `media.data` (base64)

### Sohbet Olayları
- [ ] `chats.upsert` / `chats.update` / `chats.delete` handler
  - wwebjs: `client.on('chat_removed')` / `client.on('chat_archived')`

### Arama (Call)
- [ ] Gelen arama olaylarını görme
  - Baileys: `events.call` + WebSocket `CB:call`
  - wwebjs: `client.on('incoming_call', call => ...)`
- [ ] Arama reddetme
  - Baileys: `client.rejectCall(callId, callFrom)`
  - wwebjs: `call.reject()`
- [ ] Arama sonrası otomatik mesaj gönderme
- [ ] VoIP entegrasyonu (WaVoIP)
  - wwebjs: ⚠️ **Doğrudan VoIP desteği yok** — farklı çözüm gerekli
- [ ] `offerCall()` — Arama başlatma
  - wwebjs: `client.createCallLink()` — doğrudan arama başlatma yok ama link oluşturabilir

### Katalog / Koleksiyonlar
- [ ] `fetchCatalog()` — İşletme kataloğu
  - wwebjs: ⚠️ **Doğrudan API yok** — araştırılmalı
- [ ] `getCatalog()` — Katalog sarmalayıcı
- [ ] `fetchCollections()` — Koleksiyonlar
- [ ] `getCollections()` — Koleksiyon sarmalayıcı

### Kanal (Newsletter/Channel)
- [ ] Kanal yönetimi
  - wwebjs: `client.createChannel()`, `client.deleteChannel()`, `client.getChannels()`, `client.searchChannels()`, `client.subscribeToChannel()`, `client.unsubscribeFromChannel()`
  - **Baileys'te olmayan ekstra özellik!**

### Yayın (Broadcast)
- [ ] Yayın mesajı
  - wwebjs: `client.getBroadcasts()`, `client.getBroadcastById()`

---

## Aşama 7 - Entegrasyon Katmanı

### Chatbot Entegrasyonları
- [ ] `chatbotController.emit` — Chatbot tetikleme
- [ ] OpenAI speech-to-text entegrasyonu
- [ ] Chatwoot mesaj senkronizasyonu
- [ ] Typebot entegrasyonu
- [ ] Dify entegrasyonu
- [ ] EvolutionBot entegrasyonu

### Depolama
- [ ] S3/MinIO medya yükleme
- [ ] Medya URL oluşturma

### Olay Sistemi
- [ ] EventEmitter2 olayları uyumluluğu
- [ ] WebSocket (Socket.io) bildirimleri
- [ ] RabbitMQ/SQS kuyruk entegrasyonu
- [ ] Webhook gönderimi

### Veritabanı
- [ ] Prisma message/contact/chat/label CRUD
- [ ] Mesaj güncelleme/silme kayıtları
- [x] Oturum/auth state kalıcılığı (`RemoteAuth` + `PrismaRemoteStore` — veritabanı tabanlı) ✅ Aşama 1'de tamamlandı

---

## Aşama 8 - Test & Stabilizasyon

### Fonksiyonel Testler
- [ ] Metin mesaj gönderme/alma
- [ ] Medya mesaj gönderme/alma (resim, video, ses, doküman)
- [ ] Sticker gönderme/alma
- [ ] Konum mesajı gönderme/alma
- [ ] Kişi kartı gönderme/alma
- [ ] Anket oluşturma ve oy alma
- [ ] Tepki gönderme/alma
- [ ] Mesaj düzenleme
- [ ] Mesaj silme
- [ ] Grup oluşturma ve yönetim
- [ ] Profil güncelleme
- [ ] Etiket yönetimi
- [ ] Arama olayları
- [ ] Status/Hikâye gönderme

### Performans Testleri
- [ ] Çoklu instance yönetimi (Puppeteer bellek kullanımı!)
- [ ] Mesaj işleme hızı
- [ ] Medya indirme/yükleme performansı
- [ ] Yeniden bağlanma süresi

### Uyumluluk
- [ ] Mevcut webhook formatları korunmalı
- [ ] Mevcut API endpoint'leri korunmalı
- [ ] Mevcut DTO yapıları uyumlu olmalı
- [ ] Veritabanı şeması uyumlu olmalı

---

## Kritik Farklar ve Riskler

### ⚠️ Mimari Fark
| Konu | Baileys | whatsapp-web.js |
|------|---------|-----------------|
| **Bağlantı** | WebSocket (Signal protocol) | Puppeteer (Chrome tarayıcı) |
| **Bellek** | Düşük (~50-100MB) | Yüksek (~200-500MB/instance) |
| **Bağımlılık** | Sadece Node.js | Node.js + Chrome/Chromium |
| **Session** | Custom auth state | AuthStrategy pattern |
| **Protokol** | Doğrudan WA protocol | WA Web üzerinden inject |

### ⚠️ Dikkat Edilmesi Gerekenler
1. **Bellek Yönetimi**: Puppeteer her instance için Chrome süreci açar — çok sayıda instance'da bellek sorun olabilir
2. **Buttons/Lists Deprecated**: wwebjs'de buton ve liste mesajları deprecated — alternatif düşünülmeli
3. **VoIP Desteği Yok**: wwebjs'de WaVoIP benzeri VoIP entegrasyonu yok
4. **PTV Desteği Belirsiz**: Video note (PTV) doğrudan desteklenmeyebilir
5. **Gizlilik API'si Sınırlı**: Privacy settings doğrudan API yok
6. **Katalog API'si Yok**: İşletme kataloğu için doğrudan API yok
7. **Presence Takibi Sınırlı**: Diğer kullanıcıların online durumunu takip edemeyebilir

### ✅ wwebjs Avantajları (Baileys'te Olmayan)
1. **Kanal (Channel) Yönetimi**: Tam kanal CRUD ve abone yönetimi
2. **Yayın (Broadcast) API**: Yayın listesi yönetimi
3. **Mesaj Arama**: `client.searchMessages(query)` ile mesaj arama
4. **Zamanlanmış Etkinlikler**: `sendResponseToScheduledEvent()`
5. **Müşteri Notları**: `addOrEditCustomerNote()` / `getCustomerNote()`
6. **Otomatik İndirme Kontrolü**: `setAutoDownloadAudio/Photos/Videos/Documents`
7. **Sohbet Sabitleme**: `client.pinChat()` / `client.unpinChat()`
8. **Sohbet Sessize Alma**: `client.muteChat()` / `client.unmuteChat()`
9. **Adres Defteri**: `saveOrEditAddressbookContact()` / `deleteAddressbookContact()`
10. **Sabitlenmiş Mesajlar**: `client.getPinnedMessages(chatId)`

---

## Dosya Yapısı

```
src/api/integrations/channel/
├── whatsapp/                                # Baileys (mevcut)
│   ├── whatsapp.baileys.service.ts          # Mevcut — Baileys ana servis
│   ├── baileys.router.ts                    # Mevcut
│   ├── baileys.controller.ts                # Mevcut
│   ├── baileysMessage.processor.ts          # Mevcut
│   └── voiceCalls/                          # Mevcut (VoIP)
├── wwebjs/                                  # ✅ YENİ — whatsapp-web.js
│   ├── whatsapp.wwebjs.service.ts           # ✅ Ana servis (Aşama 1 tamamlandı)
│   ├── wwebjs.prisma-store.ts               # ✅ RemoteAuth store (veritabanı oturum depolama)
│   ├── wwebjs.message-processor.ts          # 🔜 Mesaj işleme kuyruğu (Aşama 3)
│   └── wwebjs.helpers.ts                    # 🔜 Yardımcı fonksiyonlar
├── meta/                                    # Meta Business API (mevcut)
├── evolution/                               # Evolution Cloud (mevcut)
├── channel.controller.ts                    # ✅ Güncellendi (wwebjs desteği eklendi)
└── channel.router.ts                        # Mevcut
```

### Değiştirilen Dosyalar (Aşama 1)
- `src/api/types/wa.types.ts` — `WHATSAPP_WWEBJS` Integration tipi eklendi
- `src/api/integrations/channel/channel.controller.ts` — wwebjs init dalı eklendi
- `src/api/controllers/instance.controller.ts` — QR desteği wwebjs için eklendi
- `src/api/services/monitor.service.ts` — wwebjs cleanup/reconnect desteği eklendi
- `package.json` — `whatsapp-web.js` bağımlılığı eklendi

---

## İlerleme Özeti

| Aşama | Durum | İlerleme |
|-------|-------|----------|
| 1 - Temel Altyapı | ✅ Tamamlandı | 100% |
| 2 - Mesaj Gönderme | ⬜ Bekliyor | 0% |
| 3 - Mesaj Alma | 🟡 Devam Ediyor | 85% |
| 4 - Grup Yönetimi | ⬜ Bekliyor | 0% |
| 5 - Profil & Kişi | ⬜ Bekliyor | 0% |
| 6 - Gelişmiş Özellikler | ⬜ Bekliyor | 0% |
| 7 - Entegrasyon | ⬜ Bekliyor | 0% |
| 8 - Test & Stabilizasyon | ⬜ Bekliyor | 0% |
