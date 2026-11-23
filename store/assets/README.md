# Store assets

## Present

| File | Size | Status |
| --- | --- | --- |
| `icon-128.png` | 128×128 PNG | Ready. Copied from `extension/public/icon/128.png`; this is the store icon. |
| `screenshot-options-1280x800.png` | 1280×800 PNG | Ready. Options page in a full tab. |
| `screenshot-options-columns-1280x800.png` | 1280×800 PNG | Ready. Two-column options layout at ≥1024 px. |
| `screenshot-custom-rules-1280x800.png` | 1280×800 PNG | Ready. Свои правила (replacement label and per-line labels). |
| `screenshot-popup-1280x800.png` | 1280×800 PNG | Ready. Popup with protection, storage (`Хранилище`) and manual mode. |

All screenshots are 1280×800 and use **synthetic** data only (no real ChatGPT chats or
personal data). The extension also ships 16/32/48 px icons inside the package; only the
128×128 icon is uploaded separately to the store listing.

Evidence for the clean-profile smoke run is in `store/evidence/`:
`clean-profile-final.json`, `masked-custom-final.txt`, `restored-custom-final.txt`.
The masked file has no patronymic left in plain text; restore is byte-exact against
`store/fixtures/smoke.txt` (synthetic data).

## Optional (not required)

- [ ] Optional Chrome small promo tile 440×280 and marquee 1400×560, only if the owner
      wants them. They are not required.
- [ ] Optional Edge promotional images; follow the Partner Center size hints at upload time.

## Rules

- No misleading before/after images: masked files still go to ChatGPT; only original personal
  data and the storage stay local.
- Do not show real ChatGPT chats, real personal data, or claims like "100%", "fully
  anonymous", "data never leaves the device", "GDPR/152-FZ compliant".
- No store credentials, account screenshots, tokens or personal data in this folder.
- Keep the source icon in `extension/public/icon/`; do not edit the store copy ad hoc.
