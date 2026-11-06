# Maintenance & Configuration Knobs

This document covers troubleshooting common issues and adjusting CI configuration knobs.

## Maintenance & troubleshooting

### Android APK issues
- **Build failed at the patch step** → Upstream moved an anchor; update `scripts/apply-statusbar-patch.mjs` (the error output names the missing anchor).
- **Build failed at prebuild/gradle** → Upstream modified the build configuration; compare against upstream `.github/workflows/android-apk-release.yml` and `eas.json`.
- **Schedule went quiet for ~60 days** → GitHub auto-disables idle scheduled workflows. The `Keepalive` step in `statusbar-build.yml` pushes an empty commit when the repo nears 50 days idle. If disabled, re-enable from the Actions tab.

### Desktop build issues
- **App dies at launch with `different Team IDs`** → Check `codesign -d --entitlements - /Applications/Paseo.app`. If `disable-library-validation` is missing, reinstall. If present, delete the existing `/Applications/Paseo.app` before installing to avoid lingering frameworks signed by another identity.
- **Patch does not apply** → Upstream moved targeted code. Rebuild the series (`git diff > patches/paseo-kimi-native-<ver>.patch`), update `PATCHES` in `apply-desktop-patch.mjs`, and refresh markers.
- **`ERR_UPDATER_CHANNEL_FILE_NOT_FOUND`** → The channel manifest is missing from the latest Release. Re-running the workflow republishes both `latest[-mac].yml` and `beta[-mac].yml`.
- **`ERR_UPDATER_INVALID_VERSION`** → The manifest `version` is not valid semver (check custom version overrides).
- **Updater finds nothing after a tag bump** → Confirm the Release is neither a draft nor a prerelease (`GET /releases/latest` ignores both).

---

## Configuration knobs

### Android knobs
- **Schedule cadence**: Edit the `cron` in `upstream-release-watch.yml` (currently `7,37 * * * *`, every 30 minutes).
- **Safety net cadence**: The schedule in `statusbar-build.yml` (`17 */6 * * *`) acts as a fallback.
- **Prereleases filter**: To build prereleases only, add a `.prerelease == true` filter in the resolve step.
- **Rebuild an existing tag**: Run workflow manually with `force: true`.
- **Architecture**: Universal 4-ABI (`armeabi-v7a`, `arm64-v8a`, `x86`, `x86_64`).

### Desktop knobs
- **Cadence**: `cron` in each desktop workflow (daily safety nets).
- **Windows on ARM**: Drop `-c.win.target=nsis` in `desktop-windows-build.yml`, add `--arm64`, and widen resolve patterns.
- **Disable update feeds**: Remove `.zip` / manifest resolve patterns and updater manifest staging steps.
- **Re-check a published release**: Run macOS workflow with `verify_only: true` (downloads and verifies DMG/ZIP signatures and sha512 without rebuilding).
- **Entitlements**: Modify `entitlements/entitlements.mac.plist` and `entitlements.mac.inherit.plist`.
- **Timeouts**: Configured for 150 minutes per desktop job (typical run takes 30–60 minutes).

---

[← Back to README](../README.md)
