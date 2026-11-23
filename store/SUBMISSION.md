# Store submission checklist — Chrome Web Store / Microsoft Edge Add-ons

Version 0.2.0. The first Chrome Web Store submission was rejected (Yellow Argon, excessive
keywords); the corrected listing was resubmitted on 2026-11-23 and is pending review.
Microsoft Edge Add-ons was not submitted. See the status section below. The checklist
documents the preparation and remaining external actions of the project owner.

## Submission status (2026-11-23)

- **Chrome Web Store — first submission**: sent on 2026-11-23 via Yandex Browser (Chromium
  MV3) and rejected. Violation: **Yellow Argon**, «Избыточные ключевые слова в описании
  продукта» — the full description contained a long keyword list of file formats
  (`DOCX, XLSX, TXT, MD, JSON, JSONL, XML, PDF, DOC/XLS`).
- **Correction**: the formats sentence in `store/chrome-listing.md` was replaced with prose
  («Расширение работает с документами Word и Excel (включая старые версии)…»); the
  abbreviation list must not be reintroduced.
- **Chrome Web Store — resubmission**: sent on 2026-11-23; current status «Ожидает
  рассмотрения» (pending review). Item ID: `iieopopifchankeeciiekichbcfdbdnl`.
  Auto-publish after approval: enabled. The extension is **not published yet**; the public
  listing URL will be added to this repository only after approval.
- **Privacy policy URL**:
  `https://onive.github.io/docs-masked-relay/store/privacy-policy.html`.
- **Support URL**: `https://github.com/OniVe/docs-masked-relay/issues`.
- **Microsoft Edge Add-ons**: not submitted.

The checklist below is kept as preparation and instruction material. Nothing is marked
done unless it was actually verified.

## 0. Build and verify the package

```bash
cd extension
bun run check
bun run typecheck
bun run test
bun run build
bun run build:safari
bun run zip
```

Expected:

- `.output/chrome-mv3/manifest.json`: `"version": "0.2.0"`, description
  `Local PII anonymization for ChatGPT uploads/downloads. Original PII stays on your device.`
- `.output/chrome-mv3` contains `manifest.json` at its root, background service worker,
  popup/options, content scripts, `offscreen.html`, WASM/worker assets and icons.
- `.output/docs-masked-relay-0.2.0-chrome.zip` exists.
- No `dist/`, `.output/` or secrets are committed.

Quick manifest check:

```bash
bun -e "const m=require('./extension/.output/chrome-mv3/manifest.json'); console.log(m.version, m.description, m.permissions, m.host_permissions)"
```

## 1. External prerequisites (owner)

- [ ] Chrome Web Store developer account, verified contact email, **2FA enabled**.
- [ ] One-time registration fee paid (historically US$5; check the current dashboard).
- [ ] Microsoft Partner Center account for Edge Add-ons (free).
- [ ] Public **HTTPS** privacy-policy URL: host `store/privacy-policy.html` (GitHub Pages
      or any static host; see `store/README.md`). Verify it opens in a private window.
- [ ] Public support contact / support URL (`[PUBLIC CONTACT]`).
- [x] Four screenshots prepared (1280×800), real UI, synthetic data only:
      `screenshot-options-1280x800.png`, `screenshot-options-columns-1280x800.png`,
      `screenshot-custom-rules-1280x800.png`, `screenshot-popup-1280x800.png`.
      See `store/assets/README.md`.
- [ ] Owner decision that Chrome/Edge publication may proceed; Safari remains a separate
      macOS track.

Without these, submission cannot be completed. Do not create fake accounts, URLs or
screenshots.

## 2. Chrome Web Store — step by step

1. Open the Chrome Web Store Developer Dashboard → **New item**.
2. Upload `.output/docs-masked-relay-0.2.0-chrome.zip`. Confirm the dashboard shows
   version 0.2.0 and the expected name/description.
3. **Store listing**:
   - Name, short description, full description, category — from `store/chrome-listing.md`.
   - Language: **Russian (ru)** — listing copy, screenshots and UI are Russian.
     If the Chrome Web Store dashboard requires an English fallback, use English only for
     the fields the dashboard requires; Russian remains the primary listing. Do not create
     a separate English listing.
   - Add the 128×128 icon (`store/assets/icon-128.png`) and the four 1280×800 screenshots
     from `store/assets/` (Russian UI, synthetic data only).
   - Website/support URL: owner-provided.
4. **Privacy practices**:
   - Single purpose: local PII anonymization for ChatGPT uploads/downloads and restoration.
   - Permission justifications: copy from `store/chrome-listing.md` for `storage`,
     `unlimitedStorage`, `offscreen`, each host, and content scripts.
   - Remote code: **No**; explain bundled local WASM.
   - Data use: select PII, website content, user activity; do not claim "no data
     processing". Certify no sale/transfer/unrelated use, no developer collection.
   - Privacy policy URL: the hosted HTML page.
5. **Test instructions**: paste the short steps from `store/chrome-listing.md` or point to
   `store/review-notes.md`.
6. **Distribution / visibility**: owner decision (public/unlisted). For a staged release,
   choose deferred publish if offered.
7. **Submit for review**. Typical review is 1–3 days but can take longer with sensitive
   permissions/PII. Do not publish until the owner explicitly approves.

## 3. Microsoft Edge Add-ons — step by step

1. Open Partner Center → Microsoft Edge → **New extension**.
2. Upload the same `docs-masked-relay-0.2.0-chrome.zip` (Chromium MV3). Confirm manifest,
   version and permissions in the dashboard.
3. **Listing**: language **Russian (ru)**; use `store/edge-listing.md` — same name,
   description, category, icon and Russian-language screenshots. If the dashboard requires
   an English fallback, use English only for the required fields; do not create a separate
   English listing. Add the Edge-specific privacy paragraph.
4. **Privacy**: privacy-policy URL, data-use disclosure (PII, website content, user
   activity; local processing; no developer collection/sale/transfer), permission
   justifications, remote-code = No.
5. **Certification notes/test notes**: manual mode without ChatGPT; optional automatic path
   requires a signed-in ChatGPT session. Full steps: `store/review-notes.md`.
6. Submit for certification. **Up to 7 business days** is normal; longer if changes are
   requested. Do not click Publish until the owner approves.

## 4. Package facts reviewers may check

| Item | Value |
| --- | --- |
| Manifest version | 3 |
| Extension version | 0.2.0 |
| Permissions | `storage`, `unlimitedStorage`, `offscreen` |
| Host permissions | `https://chatgpt.com/*`, `https://chat.openai.com/*`, `https://*.oaiusercontent.com/*` |
| Content scripts | MAIN + ISOLATED, only `chatgpt.com` / `chat.openai.com` |
| CSP | `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; worker-src 'self'` |
| Remote code | None; WASM bundled and built from repository Rust crates |
| Minimum browser | Chromium MV3 (Chrome/Edge stable) |
| Data sold/transferred to developer | No |
| Server/analytics/ads | None |

## 5. What is ready vs. deferred

Ready:

- [x] Manifest description corrected (no "data never leaves the device" claim).
- [x] Version bumped to 0.2.0.
- [x] Privacy policy updated with Limited Use statement, Edge section, transfer/retention/
      deletion details.
- [x] Standalone HTTPS-ready privacy page.
- [x] Chrome/Edge listing drafts, permission justifications, data-use answers, review notes.
- [x] 128×128 store icon.
- [x] Four 1280×800 screenshots (options, two-column options, custom rules, popup).
- [x] Submission checklist and hosting instructions.

Deferred / external:

- [ ] Store accounts, 2FA and fee (owner).
- [ ] Hosting and public privacy-policy URL (owner).
- [ ] Support contact (`[PUBLIC CONTACT]`) and website/support URL (owner).
- [ ] Actual upload, review, and publish (owner; publication is forbidden in this task).
- [ ] Safari/macOS track: Xcode wrapper, signing, notarization, App Store — separate track,
      not part of this package.
- [ ] Re-audit/ship gate before any publication, if the project process requires it.

## 6. Do not

- Do not publish, click Publish, or share store credentials.
- Do not commit `.output/`, zips, secrets, account data or screenshots containing real PII.
- Do not add remote URLs, CDNs, remote config or analytics to make review easier.
- Do not claim "100% detection", "fully anonymous", "data never leaves the device",
  "GDPR/152-FZ compliant", or "ChatGPT cannot see your data".
