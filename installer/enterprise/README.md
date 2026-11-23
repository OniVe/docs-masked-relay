# Self-hosted CRX distribution (enterprise)

Force-install **DocsMasked Relay** in Chrome and Edge on managed Windows
machines from your own HTTPS server. No Chrome Web Store listing, no Developer
mode, no "Load unpacked", and no user interaction on the target machine.

This path is for administrators. It writes a machine-wide browser policy
(`ExtensionInstallForcelist`), so Chrome/Edge install the extension silently
and show it as managed. A standard user cannot do this; a local administrator
on a standalone (non-domain) Windows machine can.

Files in this folder:

| File | Purpose |
| --- | --- |
| `build-selfhosted.ps1` | Packs the existing `extension/.output/chrome-mv3` build into a signed CRX, derives the extension ID, writes `update.xml` and `SHA256SUMS`. Never uploads and never touches the registry. |
| `install-policy.ps1` | Writes/removes the Chrome/Edge force-install policy. Supports `-DryRun`. |
| `extension-id.mjs` | Node/Bun helper: RSA key generation, ID derivation, CRX header check. No OpenSSL needed. |

## Prerequisites

- Windows 10/11 with Chrome and/or Edge installed.
- Node.js or Bun (for `extension-id.mjs`).
- An existing production build: `extension/.output/chrome-mv3` (run
  `bun install && bun run build` in `extension/`).
- A public HTTPS location for two files.
- An elevated **64-bit** PowerShell for the install/uninstall step.

Typical browser paths (the build script auto-detects Edge first, then Chrome):

```
C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
C:\Program Files\Google\Chrome\Application\chrome.exe
C:\Program Files (x86)\Google\Chrome\Application\chrome.exe
```

## 1. Build the package

From the repository root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\installer\enterprise\build-selfhosted.ps1 `
  -BaseUrl https://downloads.example.com/docs-masked-relay
```

`-BaseUrl` is required, must be `https://`, and is the directory that will
contain the CRX and `update.xml` (no trailing slash needed). The default
output is `installer/enterprise/dist`. Other options:

```powershell
# Explicit browser, output directory and key
.\installer\enterprise\build-selfhosted.ps1 `
  -BaseUrl https://example.com/ext `
  -OutDir C:\crx\docs-masked-relay `
  -BrowserPath "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  -KeyPath D:\secrets\docs-masked-relay.pem

# Rebuild an existing version in place
.\installer\enterprise\build-selfhosted.ps1 -BaseUrl https://example.com/ext -Force
```

The version comes from `extension/.output/chrome-mv3/manifest.json`. If you
pass `-Version`, it must match the built manifest (otherwise Chrome would see
a different version inside the CRX than in `update.xml`). The script:

1. Creates `key.pem` (RSA-2048, PKCS#8) if it does not exist. **It never
   overwrites an existing key.**
2. Copies the build to a staging directory and runs
   `msedge.exe/chrome.exe --pack-extension=... --pack-extension-key=... --no-message-box`.
3. Verifies the CRX `Cr24` magic, version 3, header size, and that the public
   key inside the CRX produces the same extension ID as `key.pem`.
4. Writes `update.xml`, `SHA256SUMS` (CRX + update.xml only, never the key),
   and copies this README and `install-policy.ps1` into the output directory.

Output looks like:

```
dist/
  DocsMaskedRelay-0.2.0.crx
  key.pem                     <- secret, never upload or commit
  update.xml
  SHA256SUMS
  install-policy.ps1
  README.md
```

The extension ID is printed and is stable for as long as you reuse the same
`key.pem`. It is the first 16 bytes of SHA-256 over the key's DER
SubjectPublicKeyInfo, with each hex nibble mapped `0-f` to `a-p`.

## 2. Host the files over HTTPS

Upload exactly these two files to the directory named by `-BaseUrl`:

- `DocsMaskedRelay-<version>.crx`
- `update.xml`

The `codebase` in `update.xml` points at
`<BaseUrl>/DocsMaskedRelay-<version>.crx`, so the public URL layout must match
the `-BaseUrl` you built with:

```
https://downloads.example.com/docs-masked-relay/DocsMaskedRelay-0.2.0.crx
https://downloads.example.com/docs-masked-relay/update.xml
```

Any static HTTPS host works: GitHub Pages, Cloudflare Pages, S3/CloudFront,
Azure Blob/Static Web Apps, nginx, IIS. Requirements:

- Valid TLS certificate; no client certificate, cookie, or login in front of
  the files (the browser fetches them unattended).
- `update.xml` reachable at the exact URL placed in the policy.
- Keep `update.xml` cache lifetime short (minutes, not days) so new releases
  are seen promptly; the CRX can be cached permanently.
- `application/x-chrome-extension` for `.crx` is conventional but not required.

**Do not upload `key.pem`.** Keep it offline or in a secrets manager. If you
rebuild from a clean checkout, restore the same key; otherwise every client
gets a new extension ID and the policy entry must be changed.

## 3. Install the policy (admin)

Use the ID printed by the build script, from an elevated 64-bit PowerShell:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install-policy.ps1 `
  -ExtensionId abcdefghijklmnopabcdefghijklmnop `
  -UpdateUrl https://downloads.example.com/docs-masked-relay/update.xml
```

Both browsers by default. Restrict to one:

```powershell
.\install-policy.ps1 -ExtensionId <id> -UpdateUrl https://.../update.xml -Browsers Edge
```

Preview without writing (works as a standard user):

```powershell
.\install-policy.ps1 -ExtensionId <id> -UpdateUrl https://example.invalid/ext/update.xml -DryRun
```

The script refuses IDs that are not exactly 32 characters `a-p`, and update
URLs that are not HTTPS or do not end in `update.xml`. It writes a single
named value, so other force-install entries are preserved:

```
HKLM\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist
    DocsMaskedRelay = <id>;https://.../update.xml

HKLM\SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallForcelist
    DocsMaskedRelay = <id>;https://.../update.xml
```

This is a machine-wide policy: it applies to all Windows users and all
Chrome/Edge profiles on that machine. For fleets, set the same policy through
GPO/Intune/ADMX (`ExtensionInstallForcelist`, value name `DocsMaskedRelay`,
data `<id>;<updateUrl>`) instead of running the script per machine.

### Verify

1. Fully quit and restart Chrome/Edge, including background processes.
2. Open `chrome://policy` or `edge://policy`, click **Reload policies**, and
   confirm `ExtensionInstallForcelist` lists the ID with status **OK**.
3. Open `chrome://extensions` or `edge://extensions`. DocsMasked Relay should
   be installed and enabled, with a managed/"Installed by your administrator"
   badge. It appears without Developer mode or Load unpacked.

Policy changes can take a minute to refresh; a full browser restart is the
reliable way to apply them immediately.

### Uninstall

```powershell
.\install-policy.ps1 -ExtensionId <id> -Uninstall
```

Only the `DocsMaskedRelay` value is removed. The policy key is deleted only if
it becomes empty; other values and subkeys stay. The extension is removed at
the next policy refresh or browser restart.

## 4. Updates

1. Bump the version in `extension/package.json` (WXT writes it into the
   manifest), rebuild: `bun run build`.
2. Re-run `build-selfhosted.ps1` with the **same `-KeyPath`** and the new
   version. Use `-Force` if the output files already exist.
3. Upload the new `DocsMaskedRelay-<version>.crx` and the new `update.xml`.
   Keep old CRX files if clients may still request them.
4. Browsers check the update URL periodically (startup and roughly every few
   hours) and install the signed update automatically. Restart or reload
   policies to speed this up.

The extension ID and the policy entry do not change across updates. Never
regenerate the key for a normal release.

## Limitations and scope

- This mechanism is for administrators. Policy force-install requires write
  access to `HKLM`; it is not a consumer "one-click from a website" flow.
  Zero-action install for ordinary consumers without admin rights is only
  available through the Chrome Web Store.
- On standalone Windows, a local administrator can set the policy and Chrome/
  Edge honor it, but it affects every profile and user on that machine.
- Browsers display the policy-managed state (managed badge, "Managed by your
  organization"). This is intentional and visible; it is not a stealth
  install.
- Windows only. Chrome/Edge on macOS/Linux use different policy locations and
  are outside this installer. Domain-joined machines should use GPO/Intune.
- The update host is trusted for availability. A compromised host can serve a
  different signed build or block updates, but cannot install a CRX signed by
  a different key under this extension ID.

## Security notes

- **Protect `key.pem`.** It signs every future update for this ID. Restrict
  access (`icacls key.pem /inheritance:r /grant:r "%USERNAME%:(R,W)"`), keep
  backups offline, and never commit or upload it. The folder `dist/`, `*.pem`
  and `*.crx` are git-ignored here.
- If the key is lost, you must create a new key/ID and update the policy on
  every machine. If it leaks, rotate to a new ID and remove the old policy
  entry.
- The browser verifies the CRX3 signature and binds the CRX public key to the
  extension ID in the policy. A tampered CRX fails to install.
- `update.xml` is not signed. Serve it over HTTPS and restrict write access to
  the host; use short cache lifetimes.
- Verify downloads against `SHA256SUMS`:

  ```powershell
  Get-FileHash .\DocsMaskedRelay-0.2.0.crx -Algorithm SHA256
  Get-FileHash .\update.xml -Algorithm SHA256
  # compare with SHA256SUMS
  ```

- The extension runs only the code packaged in the CRX (MV3 extension CSP
  blocks remote code). Updates arrive only as newly signed CRX versions.
- No secrets other than the key are involved. The build script performs no
  network requests.
