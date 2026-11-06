# Getting Started

This guide covers initial repository setup, permission configuration, and running the first build.

## First-time setup

1. Create a new GitHub repo (e.g. `paseo-statusbar-builds`) and push these files so the layout is:
   ```
   .github/workflows/statusbar-build.yml
   scripts/apply-statusbar-patch.mjs
   README.md
   ```
   (In this monorepo they live under `apps/paseo/ci/` — copy that directory's contents to the new repo root.)
2. On the new repo: **Settings → Actions → General → Allow all actions**, and ensure workflows have **Read and write permissions** (Settings → Actions → General → Workflow permissions). The workflow needs `contents: write` to publish releases; it already declares that, but the repo toggle must allow it.
3. **No secrets required.** `GITHUB_TOKEN` is provided automatically. There is no Expo account, signing keystore, or npm token to configure. Expo generates a debug keystore inside the runner for signing; the workflow never uploads or commits it. The resulting APK is installable but not Play-Store grade.

## First build (validate before trusting the schedule)

Run it manually against a known-good tag first:

- Actions tab → **Build status-bar-fixed Paseo APK** → **Run workflow**
- Set `tag` to a recent release (e.g. `v0.1.93`), leave `force` off
- Watch the `build` job get through `expo prebuild` and `assembleRelease`

Then verify the artifact:

```bash
# download paseo-<tag>-statusbar-fixed.apk from the Release, then:
adb install -r paseo-<tag>-statusbar-fixed.apk
```

Confirm the status/navigation bar renders edge-to-edge and that the APK installs over a previous build. Once a manual run is green, the release watcher picks up each new upstream release on its own and starts all three stages.

---

[← Back to README](../README.md) | [Patches & Specifications →](patches.md)
