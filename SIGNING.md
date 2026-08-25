# Code Signing & Notarization

Prism binaries are signed and notarized to prevent false-positive detections by Windows Defender, Microsoft SmartScreen, and macOS Gatekeeper.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│              GitHub Actions (release.yml)                    │
│                                                             │
│  ┌─────────────────────┐   ┌─────────────────────────────┐ │
│  │  release-windows    │   │     release-macos            │ │
│  │                     │   │                              │ │
│  │  1. Import cert     │   │  1. Import Developer ID      │ │
│  │     (Azure or PFX)  │   │     cert into temp keychain  │ │
│  │  2. Tauri build     │   │  2. Tauri build (universal)  │ │
│  │     → signCommand   │   │     → codesign with entitle-  │ │
│  │     signs .exe+msi  │   │     ments & hardened runtime │ │
│  │  3. Verify signature│   │  3. notarytool submit + wait │ │
│  │                     │   │  4. stapler staple DMG/.app  │ │
│  │                     │   │  5. spctl --assess verify    │ │
│  └─────────────────────┘   └─────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

---

## Prerequisites

### Windows

You need **one** of the following:

| Method | Certificate Type | Cost | Setup Effort |
|--------|-----------------|------|-------------|
| **Azure Trusted Signing** (recommended) | EV-equivalent, cloud-managed | ~$10/month | Medium |
| **PFX Certificate** | EV or Standard Code Signing | $200–$400/year | Low |

#### Option A: Azure Trusted Signing

1. Create an [Azure Trusted Signing](https://learn.microsoft.com/en-us/azure/trusted-signing/) account and Certificate Profile.
2. Register an App Registration with the `Trusted Signing Certificate Profile Signer` role.
3. Create a client secret for the App Registration.
4. Add these GitHub Secrets:

| Secret | Value |
|--------|-------|
| `AZURE_CLIENT_ID` | App Registration client ID |
| `AZURE_CLIENT_SECRET` | App Registration client secret |
| `AZURE_TENANT_ID` | Azure AD tenant ID |
| `AZURE_KEY_VAULT_URI` | `https://<vault>.vault.azure.net` |
| `AZURE_CERT_NAME` | Certificate Profile name |

#### Option B: PFX Certificate (EV / Standard)

1. Purchase a code signing certificate from a CA (DigiCert, Sectigo, SSL.com).
2. Export it as a `.pfx` file with its password.
3. Base64-encode it:

   ```bash
   # PowerShell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("codesign.pfx")) | Set-Clipboard
   ```

4. Add these GitHub Secrets:

| Secret | Value |
|--------|-------|
| `WINDOWS_PFX_BASE64` | Base64-encoded PFX file |
| `WINDOWS_PFX_PASSWORD` | PFX password |

> **EV vs Standard**: Extended Validation (EV) certificates establish SmartScreen reputation instantly. Standard certificates require building reputation over time. If using Standard, plan for the reputation-building steps below.

---

### macOS

You need an **Apple Developer Program** membership ($99/year).

#### 1. Create an App-Specific Password

1. Go to [appleid.apple.com](https://appleid.apple.com) → Sign-In and Security → App-Specific Passwords.
2. Generate one named "Prism Notarization" and save it.

#### 2. Export your Developer ID Application Certificate

1. Open **Keychain Access** on your Mac.
2. Find your `Developer ID Application: <Name> (<Team ID>)` certificate.
3. Select both the certificate **and** its private key (expand the disclosure triangle).
4. Right-click → **Export 2 items…**.
5. Save as `.p12` with a password.

#### 3. Base64-encode it

```bash
base64 -i certificate.p12 -o certificate.p12.b64
```

#### 4. Add these GitHub Secrets

| Secret | Value |
|--------|-------|
| `APPLE_CERTIFICATE` | Base64-encoded .p12 file contents |
| `APPLE_CERTIFICATE_PASSWORD` | Password used when exporting the .p12 |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_TEAM_ID` | Your 10-character Apple Team ID |
| `APPLE_NOTARY_ID` | Your Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | The app-specific password |
| `KEYCHAIN_PASSWORD` | Temporary password for CI keychain (any strong value) |

---

## Entitlements (`src-tauri/entitlements.plist`)

The app uses these Hardened Runtime entitlements:

| Entitlement | Reason |
|-------------|--------|
| `allow-unsigned-executable-memory` | WebKit JIT compilation |
| `allow-jit` | JavaScriptCore JIT in WkWebView |
| `disable-library-validation` | Bundled ONNX Runtime `.dylib` and other native libs |
| `network.client` | API calls, auto-updater, embedding model downloads |
| `files.user-selected.read-write` | Vault import, note attachments |

All of these are standard for Tauri apps and required for notarization.

---

## SmartScreen Reputation (Windows)

Newly signed binaries may still trigger SmartScreen warnings until reputation is established. To accelerate this:

1. **Submit to Microsoft Security Intelligence:**
   - Go to [Microsoft Security Intelligence](https://www.microsoft.com/en-us/wdsi/filesubmission).
   - Upload your signed installer `.exe` and `.msi`.
   - Select "Software developer" as the submission type.
   - State that it's a legitimate application you are the developer of.

2. **Build reputation through volume:**
   - SmartScreen weighs download/install volume heavily.
   - Encourage users to launch the app after installation.
   - EV certificates establish reputation faster than Standard ones.

3. **Sign consistently:**
   - Always sign with the same certificate across releases.
   - Never ship unsigned builds — each unsigned build resets reputation progress.

---

## Testing Locally

### Verify Windows Signature

```powershell
Get-AuthenticodeSignature -FilePath "path\to\Prism_1.0.0_x64_en-US.msi" | Format-List
```

Expected output shows `SignerCertificate` with a `Status: Valid`.

### Verify macOS Signing

```bash
codesign -dvvv "Prism.app"
spctl --assess --verbose=4 --type execute "Prism.app"
```

Expected: `accepted` with `source=Notarized Developer ID`.

### Verify macOS Notarization

```bash
xcrun stapler validate "Prism.dmg"
```

Expected: `The validate action worked!`

---

## Troubleshooting

### Windows: `signCommand` fails

- Ensure the binary exists at the path passed to the signing script (`%1`).
- For Azure: verify the certificate profile is in "Active" state, not "Initializing".
- For PFX: verify the password is correct and the certificate hasn't expired.

### macOS: Notarization fails with "The binary is not signed"

- Check that `signingIdentity` in `tauri.conf.json` matches your Developer ID certificate exactly.
- Verify the entitlements file path is correct.
- Run `codesign --verify --verbose=4 "Prism.app"` to see detailed signing errors.

### macOS: Notarization fails with "Invalid profile"

- Common causes:
  - Hardened Runtime not enabled (`--options runtime` — Tauri enables this when `signingIdentity` is set).
  - Entitlement missing that a bundled library needs.
  - Team ID mismatch between certificate and notarization credentials.
- Check the notarization log: `xcrun notarytool log <submission-id> --apple-id ... --password ...`

### macOS: Gatekeeper still blocks after stapling

- Verify stapling: `xcrun stapler validate "Prism.dmg"`.
- Ensure the user is on macOS 10.15+ (Gatekeeper offline ticket verification requires it).
- First launch may still show a dialog — the user must click "Open" once.