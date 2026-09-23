# paseo-statusbar-builds

Automated CI that rebuilds [getpaseo/paseo](https://github.com/getpaseo/paseo)
Android Universal (4-ABI: `armeabi-v7a`, `arm64-v8a`, `x86`, `x86_64`) APK from the
latest non-draft upstream release with the **edge-to-edge status bar fix** applied,
and publishes them to this repo's Releases.

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
                                          expo prebuild → gradle assembleRelease (universal 4-ABI)
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
- **Android architecture**: builds are universal (including `armeabi-v7a`, `arm64-v8a`, `x86`, `x86_64`) matching official releases.

---

# Desktop builds (macOS + Windows)

Two more workflows build the same patched Paseo for desktop and publish to the
**same Release** as the APK:

| Workflow | Runner(s) | Output |
|---|---|---|
| `desktop-macos-build.yml` | `macos-14` (arm64) + `macos-15-intel` (x64) | `Paseo-<ver>-arm64.dmg` / `.zip`, `Paseo-<ver>-x64.dmg` / `.zip` |
| `desktop-windows-build.yml` | `windows-latest` | `Paseo-Setup-<ver>-x64.exe`, `Paseo-Setup-<ver>-x64.zip` |

```
statusbar-build.yml          schedule */6h
   └─ workflow_run: completed ──▶ desktop-macos-build.yml   (+ daily 04:43 safety net)
        └─ workflow_run: completed ──▶ desktop-windows-build.yml  (+ daily 06:23 safety net)
```

## Why three workflows and not one

- **Ordered, not parallel.** Each stage triggers the next on `workflow_run:
  completed`. GitHub cannot deliver upstream `getpaseo/paseo` events here, so the
  chain starts from the existing scheduled Android workflow, which owns the
  polling.
- **`workflow_run` is declared by the *downstream* workflow**, so `statusbar-
  build.yml` needed no changes at all.
- **Same repo, not two more repos.** A Release is a single bucket: splitting
  desktop builds into their own repos would scatter one version's downloads
  across three release pages. The desktop workflows share
  `concurrency: paseo-desktop-builds-v1` so they never write to the same Release
  at once; the Android workflow has its own group and stays independently
  runnable.
- **Every stage self-checks.** `resolve` lists the Release's assets and only
  builds what is actually missing, so the daily schedule is a repair pass, not a
  duplicate build. A failed Android run does not block macOS or Windows — the
  three are independent, and a partial release is better than none.
- `statusbar-build.yml` is the only workflow with a `Keepalive` step. GitHub
  disables idle *scheduled* workflows per repository, so one live commit stream
  keeps all three schedules alive.

## The desktop patch

`scripts/apply-desktop-patch.mjs <sourceDir> <mac|win>` applies the same
"Kimi Goal Bridge" daemon patches that the plugin cannot reach on its own:

| Patch | mac | win | Change |
|---|---|---|---|
| `acp-usage-update` | yes | yes | map ACP's `usage_update` into an `usage_updated` agent event (fills the native context table) |
| `windows-hidden-console` | no | yes | route the daemon's `fork()` call sites through `forkProcess()` with `windowsHide`, so a forked worker cannot allocate a visible console window |

It is idempotent (re-runs are a no-op) and fails loudly on a missing anchor,
naming the patch file to refresh. `windows-hidden-console` is skipped on macOS
because `windowsHide` is a no-op there and applying it would add rebase surface
for no behaviour change.

## Update hijack

The built app checks **this repo's** Releases for its own updates instead of
`getpaseo/paseo`. Nothing is patched to achieve this — it is three build-config
values:

```bash
-c.publish.owner=Costben -c.publish.repo=paseo-statusbar-builds
```

electron-builder serialises that `publish` block into
`Contents/Resources/app-update.yml` (macOS) / `resources/app-update.yml`
(Windows) at pack time, and `electron-updater` reads it at runtime. `-c.` dotted
overrides deep-merge onto `packages/desktop/electron-builder.yml`
(`builder-util/out/deepAssign.js`), so `provider: github` from upstream is kept.

### Constraints that follow from electron-updater's GitHub provider

- **One Release per tag, shared with the APK.** `GitHubProvider.getLatestVersion`
  resolves `GET /repos/{owner}/{repo}/releases/latest`, then downloads
  `<channel>-mac.yml` / `<channel>.yml` from that tag. If desktop builds landed in
  their own Release, the updater would fetch the wrong one. All three workflows
  therefore write to the same tag.
- **Never rename the artifacts.** The `files[].url` entries in the manifest point
  at the exact asset names electron-builder produced. A friendlier name means a
  manifest that 404s.
- **Both channels are published.** `auto-updater.ts` sets
  `autoUpdater.channel` from the app's release-channel setting (`beta` by
  default in a fresh install) and fetches `<channel>-<plat>.yml`. `latest.yml`
  and `beta.yml` are byte-identical copies, so either setting resolves.
- **macOS needs the `.zip`, not just the `.dmg`.** `MacUpdater.doDownloadUpdate`
  calls `findFile(files, "zip", ["pkg", "dmg"])` and throws
  `ERR_UPDATER_ZIP_FILE_NOT_FOUND` if the manifest has no zip. Both are built and
  uploaded.
- **The two macOS architectures need merging.** electron-builder emits one
  manifest per build, and the runners must be split per architecture (npm
  installs `sherpa-onnx` / `sharp` prebuilds for the *runner's* arch, so a
  cross-arch build silently ships without them). The `finalize` job downloads
  both partial manifests and merges them with
  `scripts/merge-mac-manifest.mjs`.
- **The rollout gate is not a blocker.** `shouldAdmitAppUpdate` returns `true`
  when the channel is not `stable`, when `rolloutHours` is absent, or when the
  check throws. The manifests we publish carry no `rolloutHours`, so updates are
  admitted immediately.
- **Signature verification is skipped when there is nothing to verify.**
  `NsisUpdater.verifySignature` returns `null` (no check) when `publisherName` is
  absent from `app-update.yml`, and electron-builder only writes `publisherName`
  when `forceCodeSigning` is set. Unsigned Windows builds therefore self-update
  fine.

### macOS: auto-update needs a certificate, but not an Apple one

This was measured on this machine, not inferred.

`electron-updater`'s JS never verifies signatures on macOS — it hands the zip to
Electron's built-in `autoUpdater` (Squirrel.Mac). Squirrel validates the *new*
bundle against the **designated requirement of the app being replaced**
(`SQRLInstaller.m`), and a missing requirement is a hard failure:

```objc
zipWith:[self codeSignatureForBundleAtURL:request.targetBundleURL]
...
SQRLCodeSignature *codeSignature = [SQRLCodeSignature signatureWithBundle:URL error:&error];
if (codeSignature == nil) return [RACSignal error:error];
```

What that requirement looks like decides everything:

| Signing | Designated requirement | Stable across rebuilds? |
|---|---|---|
| none | — (`signatureWithBundle:` errors) | **no** |
| ad-hoc (`codesign -s -`) | `cdhash H"..."` | **no** — cdhash is the content hash |
| self-signed certificate | `identifier "sh.paseo.desktop" and certificate root = H"<cert hash>"` | **yes** — pinned to the certificate, not the build |
| Developer ID | `identifier "…" and anchor apple generic and … certificate leaf[subject.OU] = "TEAMID"` | **yes** — pinned to the team |

So the credential is not the point; **a certificate that never changes** is. A
self-signed certificate pinned in a secret works exactly as well as a $99/year
Developer ID one, because both produce a requirement that every later build
signed the same way satisfies.

Verified directly against the API Squirrel calls
(`SecStaticCodeCheckValidityWithErrors` with
`kSecCSCheckNestedCode | kSecCSStrictValidate | kSecCSCheckAllArchitectures`):

| Bundle checked against the previous build's requirement | Result |
|---|---|
| rebuilt, same self-signed certificate | **PASS (OSStatus 0)** |
| rebuilt, different self-signed certificate | FAIL (-67050) |
| rebuilt, ad-hoc | FAIL (-67050) |

And a full 480 MB Electron app signed with a self-signed certificate (hardened
runtime + entitlements, every nested helper on the same certificate) passes
`codesign --verify --deep --strict`. Apple's timestamp server also stamps
self-signed code, so those signatures stay valid after the certificate expires.

**The one hop that can never be automatic.** The requirement comes from the app
being replaced, and the official `Paseo.app` is signed by Team `99ZMJMKU9Y`:

```
identifier "sh.paseo.desktop" and anchor apple generic and … certificate leaf[subject.OU] = "99ZMJMKU9Y"
```

No certificate you can obtain satisfies that, so the first install — official
build → this repo's build — is always a manual drag to `/Applications`. Every
update after that is automatic.

**The trap.** electron-builder discovers certificates with
`security find-identity -v`, which only lists *trusted* identities. An untrusted
self-signed certificate shows up as `CSSMERR_TP_NOT_TRUSTED` and is invisible, so
the build silently falls back to an ad-hoc signature — it succeeds, and
auto-update quietly does not work. The `Assert code signature` step exists to
turn that silence into a red build.

Until a certificate is configured, macOS builds are unsigned and **users
download and replace the `.dmg` by hand**. Windows has no such gate; its
auto-update works as built.

### Turning on macOS signing

Until a certificate is configured, macOS builds are unsigned and **users
download and replace the `.dmg` by hand**. To turn signing on:

1. On a Mac, from the repo root:

   ```bash
   scripts/generate-mac-signing-cert.sh
   ```

   It prints two repository secrets plus the certificate's SHA-1. Run it **once**
   and keep the output directory — re-running it produces a *different*
   certificate, which silently breaks updates for everyone who already installed
   a build signed with the old one.

2. Add the secrets under Settings → Secrets and variables → Actions:

   | Secret | Value |
   |---|---|
   | `MAC_CSC_LINK` | contents of `cert.p12.base64` |
   | `MAC_CSC_KEY_PASSWORD` | the generated password |

3. Re-run the macOS workflow with `force: true`. `resolve` sees the existing
   (unsigned) assets and would otherwise skip.

The workflow then imports the certificate, marks it trusted, and the
`Assert code signature` step fails the build if the app came out ad-hoc anyway —
that assertion exists because electron-builder's fallback is *silent*, and an
ad-hoc build looks like a successful one right up until a user cannot update.

Two things this does not fix:

- **The first install is still manual.** The requirement comes from the app being
  replaced, and the official `Paseo.app` is signed by Team `99ZMJMKU9Y`, which no
  certificate you can obtain satisfies.
- **Notarization is off** (`-c.mac.notarize=false`), so first launch still needs
  a right-click → Open, or `xattr -dr com.apple.quarantine /Applications/Paseo.app`.
  Updates installed by the app itself are exempt — Squirrel clears the quarantine
  flag as part of installing. Notarizing needs a real Developer ID certificate,
  not a self-signed one.

## Desktop maintenance

- **Patch does not apply** → upstream moved the code it targets. Rebuild the
  patch against the new tag (`git diff > patches/<name>.patch`) and refresh the
  markers in `apply-desktop-patch.mjs`.
- **`ERR_UPDATER_CHANNEL_FILE_NOT_FOUND`** → the manifest for the app's channel
  is missing from the Release. Check that `EXTRA_CHANNELS` still covers the
  channel the app reports.
- **Updater finds nothing after a tag bump** → confirm the Release is neither a
  draft nor a prerelease. `GET /releases/latest` ignores both.

## Desktop knobs

- **Cadence**: `cron` in each desktop workflow (daily safety nets).
- **Windows on ARM**: add `--arm64` to the `build_args` arch list in
  `desktop-windows-build.yml`. It would roughly double that job's runtime.
- **Add a channel**: append to `EXTRA_CHANNELS` in the workflow `env` block.
- **Rebuild an existing tag**: run the workflow manually with `force: true`.
- **Timeouts**: 150 minutes per desktop job. Both platforms build the full web
  bundle with Metro and pack ~2 GB of `node_modules`, so expect 30–60 minutes.
