# paseo-statusbar-builds

Automated CI that rebuilds [getpaseo/paseo](https://github.com/getpaseo/paseo)
Android `arm64-v8a` APK from the latest non-draft upstream release with the
**edge-to-edge status bar fix** applied, and publishes them to this repo's
Releases.

This is a **standalone build repo**, not a fork. It stores only the workflow and
the patch script. At build time it checks out an upstream tag, injects the patch,
and compiles — it never stores or merges upstream source, so there are no merge
conflicts to maintain.

## How it works

```
schedule (every 6h)  ─┐
workflow_dispatch     ─┴─► resolve latest upstream release tag
                            │
                            ├─ already released here? ─► skip
                            │
                            └─ new tag ─► checkout upstream@tag
                                          apply status bar patch (2 files)
                                          npm ci → build:workspace-deps
                                          expo prebuild → gradle assembleRelease (arm64-v8a)
                                          upload paseo-<tag>-statusbar-fixed.apk
                                          to this repo's Release
```

### Why polling, not "on upstream push"
GitHub only delivers workflow-triggering events for repos you own. An upstream
release in `getpaseo/paseo` cannot trigger Actions here, so the workflow polls
the releases API on a schedule. "Auto" means "checked every 6 hours," not
"instant on upstream merge."

## The patch

`scripts/apply-statusbar-patch.mjs` injects `react-native-edge-to-edge` into two
files (idempotently — re-running is a no-op):

| File | Change |
|------|--------|
| `packages/app/app.config.js` | require the edge-to-edge expo plugin; add `edgeToEdge({ android: { parentTheme: "Default", enforceNavigationBarContrast: true } })` as the first plugin |
| `packages/app/src/app/_layout.tsx` | import `SystemBars`; render `<SystemBars style="auto" />` as the first child of `GestureHandlerRootView` |

If upstream moves one of the injection anchors, the script **exits non-zero and
names the missing anchor**. That red build is the signal to update the anchor in
the script (or to confirm upstream now handles the status bar itself, making the
patch unnecessary).

## First-time setup

1. Create a new GitHub repo (e.g. `paseo-statusbar-builds`) and push these files
   so the layout is:
   ```
   .github/workflows/statusbar-build.yml
   scripts/apply-statusbar-patch.mjs
   README.md
   ```
   (In this monorepo they live under `apps/paseo/ci/` — copy that directory's
   contents to the new repo root.)
2. On the new repo: **Settings → Actions → General → Allow all actions**, and
   ensure workflows have **Read and write permissions** (Settings → Actions →
   General → Workflow permissions). The workflow needs `contents: write` to
   publish releases; it already declares that, but the repo toggle must allow it.
3. **No secrets required.** `GITHUB_TOKEN` is provided automatically. There is no
   Expo account, signing keystore, or npm token to configure. Expo generates a
   debug keystore inside the runner for signing; the workflow never uploads or
   commits it. The resulting APK is installable but not Play-Store grade.

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

Confirm the status/navigation bar renders edge-to-edge and that the APK installs
over a previous build. Once a manual run is green, the 6-hourly schedule will
pick up each new upstream release on its own.

## Maintenance

- **Build failed at the patch step** → upstream moved an anchor; update
  `scripts/apply-statusbar-patch.mjs` (the error names which one).
- **Build failed at prebuild/gradle** → upstream changed the build; compare
  against their `.github/workflows/android-apk-release.yml` and `eas.json`.
- **Schedule went quiet for ~60 days** → GitHub auto-disables idle scheduled
  workflows. The `Keepalive` step pushes an empty commit when the repo nears 50
  days idle to prevent this; if it ever does get disabled, re-enable from the
  Actions tab.

## Knobs

- **Build cadence**: edit the `cron` in `statusbar-build.yml` (currently
  `17 */6 * * *`).
- **Prereleases only**: the resolver currently picks the latest non-draft
  release, including stable releases and prereleases. To build prereleases only,
  add a `.prerelease == true` filter in the `Resolve upstream tag` step.
- **Rebuild an existing tag**: run manually with `force: true`.
- **Android architecture**: builds are intentionally fixed to `arm64-v8a` for
  modern physical Android devices.
