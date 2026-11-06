# Desktop Auto-Updates & Code Signing

This document details the update feed mechanism, signature verification, and self-signing architecture on desktop.

## Update hijack

> **Live on both platforms.** `latest-mac.yml` / `beta-mac.yml` and `latest.yml` / `beta.yml` are published alongside the archives they name, so the app offers and installs its own updates.

The built app checks **this repo's** Releases for its own updates instead of `getpaseo/paseo`. Nothing is patched to achieve this — it is three build-config values:

```bash
-c.publish.owner=Costben -c.publish.repo=paseo-statusbar-builds
```

electron-builder serialises that `publish` block into `Contents/Resources/app-update.yml` (macOS) / `resources/app-update.yml` (Windows) at pack time, and `electron-updater` reads it at runtime. `-c.` dotted overrides deep-merge onto `packages/desktop/electron-builder.yml`, retaining `provider: github` from upstream.

### Constraints that follow from electron-updater's GitHub provider

- **One Release per tag, shared with the APK.** `GitHubProvider.getLatestVersion` resolves `GET /repos/{owner}/{repo}/releases/latest`, then downloads `<channel>-mac.yml` / `<channel>.yml` from that tag. If desktop builds landed in their own Release, the updater would fetch the wrong one. All three workflows therefore write to the same tag.
- **Never rename the artifacts.** The `files[].url` entries in the manifest point at the exact asset names electron-builder produced. A friendlier name means a manifest that 404s.
- **Both channels need publishing.** `auto-updater.ts` sets `autoUpdater.channel` from the app's release-channel setting (`beta` by default in a fresh install) and fetches `<channel>-<plat>.yml`. `latest.yml` and `beta.yml` are byte-identical copies, so either setting resolves.
- **macOS needs the `.zip`, not just the `.dmg`.** `MacUpdater.doDownloadUpdate` calls `findFile(files, "zip", ["pkg", "dmg"])` and throws `ERR_UPDATER_ZIP_FILE_NOT_FOUND` if the manifest has no zip. Both need building and uploading.
- **A second macOS architecture would need the manifests merged again.** Only arm64 is built, so one manifest covers the platform. Two architectures would need one runner each plus a `finalize` job merging partial manifests with `scripts/merge-mac-manifest.mjs`.
- **The rollout gate is not a blocker.** `shouldAdmitAppUpdate` returns `true` when the channel is not `stable`, when `rolloutHours` is absent, or when the check throws. Manifests here carry no `rolloutHours`, admitting updates immediately.
- **Signature verification is skipped when there is nothing to verify.** `NsisUpdater.verifySignature` returns `null` (no check) when `publisherName` is absent from `app-update.yml`. Unsigned Windows builds therefore self-update without issues.

---

## macOS: auto-update needs a certificate, but not an Apple one

`electron-updater`'s JS never verifies signatures on macOS — it hands the zip to Electron's built-in `autoUpdater` (Squirrel.Mac). Squirrel validates the *new* bundle against the **designated requirement of the app being replaced** (`SQRLInstaller.m`):

```objc
zipWith:[self codeSignatureForBundleAtURL:request.targetBundleURL]
...
SQRLCodeSignature *codeSignature = [SQRLCodeSignature signatureWithBundle:URL error:&error];
if (codeSignature == nil) return [RACSignal error:error];
```

| Signing | Designated requirement | Stable across rebuilds? |
|---|---|---|
| none | — (`signatureWithBundle:` errors) | **no** |
| ad-hoc (`codesign -s -`) | `cdhash H"..."` | **no** — cdhash is the content hash |
| self-signed certificate | `identifier "sh.paseo.desktop" and certificate root = H"<cert hash>"` | **yes** — pinned to the certificate, not the build |
| Developer ID | `identifier "…" and anchor apple generic and … certificate leaf[subject.OU] = "TEAMID"` | **yes** — pinned to the team |

The credential is not the point; **a certificate that never changes** is. A self-signed certificate pinned in a secret works as well as a Developer ID certificate because both produce a requirement that every later build signed the same way satisfies.

Verified directly against the API Squirrel calls (`SecStaticCodeCheckValidityWithErrors` with `kSecCSCheckNestedCode | kSecCSStrictValidate | kSecCSCheckAllArchitectures`):

| Bundle checked against the previous build's requirement | Result |
|---|---|
| rebuilt, same self-signed certificate | **PASS (OSStatus 0)** |
| rebuilt, different self-signed certificate | FAIL (-67050) |
| rebuilt, ad-hoc | FAIL (-67050) |

And a full 480 MB Electron app signed with a self-signed certificate (hardened runtime + entitlements, every nested helper on the same certificate) passes `codesign --verify --deep --strict`. Apple's timestamp server also stamps self-signed code, so signatures stay valid after certificate expiry.

**The one hop that can never be automatic:** The requirement comes from the app being replaced, and the official `Paseo.app` is signed by Team `99ZMJMKU9Y`. No third-party certificate satisfies that, so the first install (official build → this repo's build) is a manual drag to `/Applications`. Every subsequent update is automatic.

**The trap:** electron-builder discovers certificates with `security find-identity -v`, which only lists *trusted* identities. An untrusted self-signed certificate shows up as `CSSMERR_TP_NOT_TRUSTED` and is invisible, so the build silently falls back to ad-hoc. The `Assert code signature` step turns that silence into a red build.

---

## Turning on macOS signing

1. On a Mac, from the repo root:
   ```bash
   scripts/generate-mac-signing-cert.sh
   ```
   It prints two repository secrets plus the certificate's SHA-1. Run it **once** and keep the output directory — re-running produces a *different* certificate, breaking updates for existing users.
2. Add secrets under Settings → Secrets and variables → Actions:
   | Secret | Value |
   |---|---|
   | `MAC_CSC_LINK` | contents of `cert.p12.base64` |
   | `MAC_CSC_KEY_PASSWORD` | the generated password |
3. Re-run the macOS workflow with `force: true`.

The workflow imports the certificate, marks it trusted, and `Assert code signature` fails if the app came out ad-hoc. A second assertion (`scripts/assert-mac-signatures.mjs`) ensures the signing certificate is identical across all Mach-O binaries in the bundle.

---

## Hardened Runtime & Team ID

codesign writes a `TeamIdentifier` only for certificates issued by Apple. Self-signed certificates produce `TeamIdentifier=not set` on every binary.

With Hardened Runtime enabled, library validation restricts loading code signed by different Team IDs. With no Team ID on either side, the load fails and the app crashes at launch:
```
Library not loaded: @rpath/Electron Framework.framework/Electron Framework
Reason: ... mapping process and mapped file (non-platform) have different Team IDs
```

Two guards prevent this:
1. `entitlements/` adds `com.apple.security.cs.disable-library-validation` to the app and nested helpers via `-c.mac.entitlements` and `-c.mac.entitlementsInherit`.
2. The workflow test-launches the packaged app (`ELECTRON_RUN_AS_NODE=1 … -e 'console.log(1)'`) and fails if dyld refuses to load frameworks.

Note:
- **First install is manual:** Quarantine flags must be cleared manually on first run (`xattr -dr com.apple.quarantine /Applications/Paseo.app` or right-click → Open). Updates installed by Squirrel clear quarantine automatically.
- **Notarization is off** (`-c.mac.notarize=false`), as notarization requires an Apple Developer ID.

---

## Publishing a version of our own

The `version` input decouples the release tag from upstream:

```bash
gh workflow run desktop-macos-build.yml --repo Costben/paseo-statusbar-builds \
  -f tag=v0.9.2 -f version=0.10.0-beta.1
```

Requirements:
- **`0.10.0-beta.1` style:** Published as a prerelease Release under `v0.10.0-beta.1`. Default channels ignore prereleases; beta channels discover them.
- **Plain `0.10.0`:** Published as a normal Release, taking the tag a future upstream `v0.10.0` will need.
- **Prerelease identifier must be `beta`, not `beta1`:** electron-updater treats other identifiers as custom channels and looks for `<identifier>-mac.yml`.
- **Never a fourth component:** `0.10.0.1` is not valid semver and causes `ERR_UPDATER_INVALID_VERSION`.

---

[← Back to README](../README.md) | [Maintenance & Knobs →](maintenance.md)
