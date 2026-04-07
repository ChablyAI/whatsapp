# RDP - Rule Development Proposal

## Konu
Cursor tarafinda uretilen kodlarin Husky pre-commit ve commit-msg kontrolleri ile otomatik uyumlu olmasi.

## Karar
- Projeye `.cursor/rules/husky-precommit-compat.mdc` adinda yeni bir always-apply kurali eklendi.
- Kural; `eslint --fix`, `tsc --noEmit`, import sirasi, `require()` yasagi ve Conventional Commit formatini zorunlu rehber olarak tanimlar.

## Beklenen Etki
- Pre-commit hatalari azalir.
- AI tarafindan yazilan kodlar repository standartlarina daha hizli uyum saglar.
