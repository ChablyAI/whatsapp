# RFC - Husky Uyumlu Kod Uretimi

## Problem
AI tarafindan yazilan degisiklikler bazen commit asamasinda `lint-staged` ve `commitlint` tarafindan reddediliyor.

## Oneri
- Cursor tarafinda kalici bir kural dosyasi ile Husky pipeline beklentilerini acikca tanimla.
- Kod yazimi sirasinda su kontrolleri proaktif uygula:
  - `require()` yerine import kullanimi
  - Import siralama
  - Prettier uyumu
  - TypeScript derleme uyumu
  - Conventional Commit mesaj bicimi

## Kapsam
- Tum repository (always apply).
- Kanal entegrasyonlarinda (or. WebJS `key.id`/medya, WebJS oturum stratejisi) RabbitMQ/webhook yuklerinin veya baglanti davranisinin Baileys/operasyon beklentileriyle hizalanmasi gerektiginde kararlar `RDP.md` altinda kayit altina alinir.
- Yerel altyapi (`docker-compose.services.yaml`: Postgres, Redis, RabbitMQ, MinIO, Soketi) ve Pusher-protokol alternatifleri icin operasyonel notlar `RDP.md` ile eslenir.

## Kabul Kriterleri
- Yeni yazilan kodlar `eslint --fix` ve `tsc --noEmit` adimlarini gecmeli.
- Commit mesaji `type(scope): subject` formatina uygun olmali.
