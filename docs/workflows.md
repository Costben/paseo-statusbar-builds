# CI Workflows & Architecture

This document describes the orchestration, scheduling, and build pipeline across platforms.

## How it works

```
schedule (every 30m) ─┐
workflow_dispatch     ─┴─► resolve the highest upstream release tag
                            │
                            ├─ this repo's Release has every asset? ─► skip
                            │
                            └─ missing assets ─► create the Release
                                                 │
                                                 ├─ dispatch statusbar-build.yml        (APK)
                                                 └─ dispatch desktop-macos-build.yml    (.dmg/.zip + manifests)
                                                       └─ workflow_run ──► desktop-windows-build.yml (.exe + manifests)
```

Each dispatched stage runs its own resolve → checkout upstream@tag → apply patch → build → upload to the same Release. Stages that are already complete are skipped, so a late-arriving APK does not force a desktop rebuild.

### Why polling, not "on upstream push"
GitHub only delivers workflow-triggering events for repos you own. An upstream release in `getpaseo/paseo` cannot trigger Actions here, so the workflows poll the releases API on a schedule. "Auto" means "checked periodically", not "instant on upstream merge." The per-stage schedules (6h for the APK, daily for each desktop) remain as the safety net for when the watcher is disabled or a stage fails and needs a repair pass.

---

## Desktop builds (macOS + Windows)

Two more workflows build the patched Paseo for desktop and publish to the **same Release** as the APK:

| Workflow | Runner | Output |
|---|---|---|
| `statusbar-build.yml` | `ubuntu-latest` | `paseo-<tag>-statusbar-fixed.apk` |
| `desktop-macos-build.yml` | `macos-14` (arm64) | `Paseo-<ver>-arm64.dmg`, `Paseo-<ver>-arm64.zip`, `latest-mac.yml`, `beta-mac.yml` |
| `desktop-windows-build.yml` | `windows-latest` (x64) | `Paseo-Setup-<ver>-x64.exe` |

Both desktop platforms install their own updates. macOS downloads the `.zip` (`MacUpdater`) and Windows runs the NSIS `.exe` (`NsisUpdater`); `latest-mac.yml` and `latest.yml` point them there, and each has a byte-identical `beta` twin. The `.dmg` and a manual run of the `.exe` are for a first install or manual replacement.

`.blockmap` files for differential downloads are built on the runner but never uploaded — `scripts/upload-release-assets.mjs` decides what reaches the Release. electron-updater treats them as optional: without one it logs "fallback to full download" and the update still installs, just without the smaller transfer.

```
upstream-release-watch.yml   schedule */30m
   ├─ dispatch ──▶ statusbar-build.yml            (+ 6h safety net)
   └─ dispatch ──▶ desktop-macos-build.yml        (+ daily 04:43 safety net)
                       └─ workflow_run ──▶ desktop-windows-build.yml (+ daily 06:23 safety net)

fallback, still wired: statusbar-build.yml ──workflow_run──▶ desktop-macos-build.yml
                                                          └──workflow_run──▶ desktop-windows-build.yml
```

---

## Why four workflows and not one

- **One entry point, three stages.** `upstream-release-watch.yml` resolves the tag once and dispatches every stage that is missing artifacts, all with the same explicit `tag`. Android has its own group and starts alongside the desktop build.
- **macOS is dispatched alone; Windows follows it.** The desktop pair share `concurrency: paseo-desktop-builds-v1`, and that group holds a single *pending* run: a second dispatch in the same second cancels the first while it is still waiting for a runner. Dispatching both together is how v0.15.2 and v0.15.3 lost their macOS build, so the watcher dispatches macOS and lets its completion trigger Windows through the `workflow_run` chain. Windows is dispatched directly only when macOS already has every asset.
- **The watcher creates the Release.** Three builds dispatched at once would otherwise race on `gh release create`, failing two of the jobs.
- **The `workflow_run` chain stays as the fallback.** If the watcher is disabled or its dispatch fails, the APK's own schedule still triggers macOS, which triggers Windows; each stage self-checks and only fills in what is missing.
- **Same repo, not two more repos.** A Release is a single bucket: splitting desktop builds into separate repos would scatter downloads across three release pages. Rebuilds overwrite by filename, and no two stages publish the same name.
- **Every stage self-checks.** `resolve` lists the Release's assets and only builds what is actually missing, making schedules repair passes rather than duplicate builds. A failed Android run does not block macOS or Windows.
- `statusbar-build.yml` is the only workflow with a `Keepalive` step. GitHub disables idle *scheduled* workflows per repository, so one live commit stream keeps all four schedules alive.

---

## Which stages a change needs

The pipeline exists to propagate a **new upstream tag**, not to rebuild everything for every commit. Each stage applies a different patch set, so a change usually needs only some of the three:

| What changed | APK | macOS | Windows |
|---|---|---|---|
| upstream tag — new client and/or daemon code | rebuild | rebuild | rebuild |
| `paseo-kimi-native-0101.patch`, `paseo-agent-cwd-guard.patch`, `apply-desktop-patch.mjs` — daemon and/or desktop-app code | **—** | rebuild | rebuild |
| the same, but the change also lands in code the APK bundles (e.g. `packages/protocol/`) | rebuild | rebuild | rebuild |
| `paseo-app-composer-badges.patch`, `apply-statusbar-patch.mjs` | rebuild | see below | see below |
| `upload-release-assets.mjs`, the workflow files themselves | rebuild | rebuild | rebuild |

The daemon series never reaches the APK. `apply-desktop-patch.mjs` is the only thing that applies it, and only desktop workflows call that script. `statusbar-build.yml` calls only `apply-statusbar-patch.mjs`, which patches two config files plus `paseo-app-composer-badges.patch`, running only `packages/app` through Expo and Gradle. The APK is a client; rebuilding it for daemon-only changes spends ~25 runner minutes republishing the same file.

"Daemon-only" requires checking boundaries: the APK builds `packages/app`, which imports `@getpaseo/protocol/*` — resolved through that package's `dist`, built from `src` earlier in the same job. A hunk of the desktop patch that lands in `packages/protocol/` **is** part of the client, and skipping the APK ships a phone whose rendering disagrees with the desktop's.

`paseo-app-composer-badges.patch` is applied by the APK workflow, but the same change is carried *inside* `paseo-kimi-native-0101.patch` for desktop builds. Editing one means editing the other and rebuilding all three.

---

## Triggering a patch-only rebuild

A downstream `workflow_run` is dispatched with no inputs, so `force` is empty on the chained run, the guard in its `resolve` job finds the artifacts already present, and the stage skips. The release watcher only fires for a tag whose assets are missing, so it never touches an already-published Release either. Patch-only work therefore triggers each desktop stage directly:

```bash
gh workflow run desktop-macos-build.yml -f tag=v0.10.0-beta.1 -f version=0.10.0-beta.1 -f force=true
gh workflow run desktop-windows-build.yml -f tag=v0.10.0-beta.1 -f version=0.10.0-beta.1 -f force=true
```

`force` bypasses the "do I already have this?" guard. Trigger only the stages needed. Rebuilding never duplicates anything in the Release: assets are keyed by filename, so a rebuild overwrites without collisions.

---

[← Back to README](../README.md) | [Desktop Auto-Updates & Code Signing →](desktop-updates.md)
