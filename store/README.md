# Store preparation — DocsMasked Relay

This directory contains submission materials for the Chrome Web Store and Microsoft Edge
Add-ons. Nothing here is published automatically; uploading to a store and publishing a
public URL are external actions of the project owner.

## Contents

| Path | Purpose |
| --- | --- |
| `privacy-policy.html` | Standalone Russian store-facing privacy policy (`<html lang="ru">`). Inline CSS, no JS, no external resources, no cookies. |
| `chrome-listing.md` | Chrome Web Store listing copy, permission justifications, data-use answers, review instructions. |
| `edge-listing.md` | Edge Add-ons listing copy and Edge-specific privacy/test notes. |
| `review-notes.md` | Step-by-step reviewer instructions (manual mode, formats, PDF, lock/fail-closed, auto path). |
| `SUBMISSION.md` | Submission checklist for both stores, including external blockers. |
| `assets/` | Store icon, four 1280×800 screenshots, and asset checklist. |

The extension source of truth for privacy is `extension/PRIVACY.md` (Russian). This
directory's HTML page is the Russian store-facing version (listing language: Russian);
keep the facts synchronized.

## Options page behavior

The options page opens in a **separate full browser tab** via
`browser.runtime.openOptionsPage()` (manifest `options_ui.open_in_tab: true` in both the
Chrome and Safari builds). This is intentional: at viewport widths **≥1024 px** the
settings use a two-column layout, while narrow windows fall back to one column. An embedded
options dialog was narrower than the breakpoint, which made the page look single-column.

## Hosting the privacy policy

Store dashboards require a public **HTTPS** URL. Any static host works because the page is
a single self-contained file with no external requests.

### Option A — GitHub Pages

1. Make the repository public (or use a public `docs`/`gh-pages` repository).
2. Copy `store/privacy-policy.html` to `docs/privacy/index.html` (or publish the `docs/`
   folder from the `main` branch).
3. In the repository settings, enable Pages for the branch/folder.
4. The URL will look like:
   `https://<owner>.github.io/<repo>/privacy/` (project site) or
   `https://<owner>.github.io/privacy/` (user site).
5. Open the URL in a private window and verify it loads over HTTPS without mixed content.

### Option B — any static host

Upload `privacy-policy.html` to Cloudflare Pages, Netlify, S3+CloudFront, or the project's
own site. Keep the filename or configure a clean `/privacy` route. No build step or
server-side code is needed.

### Option C — repository raw file

A raw GitHub URL can be used as a fallback, but it renders as plain text/HTML download
rather than a styled page and is not recommended for review. Prefer Pages or a static
host.

## Values the owner must fill before submission

These are placeholders in the checklist/listing docs, **not** in the page text:

- `[PUBLIC CONTACT]` — public support email or support URL. Replaces the store-listing
  contact reference in `PRIVACY.md` if the owner wants a direct contact on the policy; the
  HTML page currently points reviewers to the published store listing contact.
- `[HOSTING URL]` — the final HTTPS URL of the hosted privacy policy. Paste it into:
  - Chrome Web Store → Privacy practices → Privacy policy URL;
  - Microsoft Edge Partner Center → extension listing → Privacy policy URL.

Do not invent a URL: a 404/mismatched policy is a common review rejection. Publishing the
URL (making the page reachable) and registering/verifying store accounts are owner actions;
this repository only prepares the artifacts.

## Screenshots

Four 1280×800 screenshots are included in `assets/`:
`screenshot-options-1280x800.png`, `screenshot-options-columns-1280x800.png`,
`screenshot-custom-rules-1280x800.png`, `screenshot-popup-1280x800.png`. They show the real
UI (popup, options, two-column layout, custom rules) with synthetic data only. The full
asset checklist is in `assets/README.md`. Optional promo tiles are still a separate step.

## What is intentionally not here

- No store credentials, API keys, cookies or tokens.
- No remote URLs embedded in the page beyond documentation links in markdown.
- No generated `.output/` build or zip committed; build them with `bun run build` and
  `bun run zip` in `extension/`.
