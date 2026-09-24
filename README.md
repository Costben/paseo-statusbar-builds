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

| Workflow | Runner | Output |
|---|---|---|
| `statusbar-build.yml` | `ubuntu-latest` | `paseo-<tag>-statusbar-fixed.apk` |
| `desktop-macos-build.yml` | `macos-14` (arm64) | `Paseo-<ver>-arm64.dmg`, `Paseo-<ver>-arm64.zip`, `latest-mac.yml`, `beta-mac.yml` |
| `desktop-windows-build.yml` | `windows-latest` (x64) | `Paseo-Setup-<ver>-x64.exe` |

Both desktop platforms install their own updates. macOS downloads the `.zip`
(`MacUpdater`) and Windows runs the NSIS `.exe` (`NsisUpdater`); `latest-mac.yml`
and `latest.yml` are what point them there, and each has a byte-identical `beta`
twin. The `.dmg` and a manual run of the `.exe` are for a first install, and for
anyone who would rather replace the app by hand.

`.blockmap` files for differential downloads are built on the runner but never
uploaded — `scripts/upload-release-assets.mjs` decides what reaches the Release.
electron-updater treats them as optional: without one it logs "fallback to full
download" and the update still installs, just without the smaller transfer.

The Release is tagged with the version it contains. Normally that version comes
from the upstream tag; the `version` input overrides it, which is how this repo
publishes a build of its own — see "Publishing a version of our own".

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
| `acp-plan-card` | yes | yes | tag an ACP `ExitPlanMode` approval request as kind `plan` and carry the plan text in metadata, so the approval renders as the full-height plan card instead of a 200px scroll box |
| `acp-compaction-timeline` | yes | yes | accept the `_paseo.dev/session/compaction` extension notification and turn it into a compaction timeline marker; ACP 0.17 has no compaction update, so the Kimi Goal Bridge proxy reads the agent's own session log and reports it |
| `app-composer-badges` | yes | yes | strip redundant "Thinking " prefix from option badges, and make composer pills shrinkable so long labels do not evict adjacent buttons |
| `acp-kimi-reliability` | yes | yes | add Kimi ACP capability descriptors, log instead of silently dropping session/staged events, and flag Kimi turns that complete with no assistant output |

It is idempotent (re-runs are a no-op) and fails loudly on a missing anchor,
naming the patch file to refresh. `windows-hidden-console` is skipped on macOS
because `windowsHide` is a no-op there and applying it would add rebase surface
for no behaviour change.

## Update hijack

> **Live on both platforms.** `latest-mac.yml` / `beta-mac.yml` and `latest.yml` /
> `beta.yml` are published alongside the archives they name, so the app offers and
> installs its own updates. Everything below describes what the feed needs in
> order to work.

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
- **Both channels need publishing.** `auto-updater.ts` sets
  `autoUpdater.channel` from the app's release-channel setting (`beta` by
  default in a fresh install) and fetches `<channel>-<plat>.yml`. `latest.yml`
  and `beta.yml` are byte-identical copies, so either setting resolves.
- **macOS needs the `.zip`, not just the `.dmg`.** `MacUpdater.doDownloadUpdate`
  calls `findFile(files, "zip", ["pkg", "dmg"])` and throws
  `ERR_UPDATER_ZIP_FILE_NOT_FOUND` if the manifest has no zip. Both need building
  and uploading.
- **A second macOS architecture would need the manifests merged again.** Only
  arm64 is built, so one manifest would cover the platform. Two architectures need
  one runner each (npm installs `sherpa-onnx` / `sharp` prebuilds for the
  *runner's* arch, so a cross-arch build silently ships without them) plus a
  `finalize` job merging the partial manifests with
  `scripts/merge-mac-manifest.mjs`, which is kept for exactly that.
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

A second assertion walks every Mach-O in the bundle
(`scripts/assert-mac-signatures.mjs`) and requires the signing **certificate** to
be the same everywhere. The root signature can be perfect while a nested
framework still carries Electron's own certificate, and macOS refuses to load
code signed by a different party — the app then dies before it can draw a window.

### A self-signed certificate has no Team ID, and hardened runtime cares

Measured on the macOS 14 runner and locally, and the reason a *perfectly signed*
build can still refuse to start.

codesign writes a `TeamIdentifier` only for a certificate issued by Apple. Every
certificate this repo can produce is self-signed, so `codesign -dvvv` reports
`TeamIdentifier=not set` on **every** binary it signs — with an OU in the subject
and without one, trusted and untrusted, and for the ad-hoc fallback too. Keeping
`OU = paseo-builds` in the subject is still right (it is what a Developer ID
designated requirement matches on, and what the certificate carries if this ever
moves to a real Apple certificate), but it does not create a Team ID. Nothing
that can be generated here does.

Hardened runtime is on, and with it library validation: a process may only load
code signed by *its own* Team ID. With no Team ID on either side there is nothing
to match, so the load fails and the app dies at launch:

```
Library not loaded: @rpath/Electron Framework.framework/Electron Framework
Reason: ... mapping process and mapped file (non-platform) have different Team IDs
```

Two things keep that from shipping again, and neither is a signature check — the
broken build was signed by one certificate, top to bottom, which is exactly why
every signature check passed:

1. `entitlements/` adds `com.apple.security.cs.disable-library-validation` to the
   app and to every nested helper, wired in with `-c.mac.entitlements` and
   `-c.mac.entitlementsInherit`. This is what actually makes the bundle launch.
2. The workflow launches the packaged app
   (`ELECTRON_RUN_AS_NODE=1 … -e 'console.log(1)'`) and fails if dyld refuses to
   load its own frameworks. It is the only check that can catch the failure
   above, because it is the only one that runs the app.

Two things this does not fix:

- **The first install is still manual.** The requirement comes from the app being
  replaced, and the official `Paseo.app` is signed by Team `99ZMJMKU9Y`, which no
  certificate you can obtain satisfies.
- **Notarization is off** (`-c.mac.notarize=false`), so first launch still needs
  a right-click → Open, or `xattr -dr com.apple.quarantine /Applications/Paseo.app`.
  Updates installed by the app itself are exempt — Squirrel clears the quarantine
  flag as part of installing. Notarizing needs a real Developer ID certificate,
  not a self-signed one.

## Publishing a version of our own

The Release is tagged with the version it contains, so publishing `0.9.2` puts it
in a Release tagged `v0.9.2`. Normally both come from the upstream tag; the
`version` input decouples them:

```bash
gh workflow run desktop-macos-build.yml --repo Costben/paseo-statusbar-builds \
  -f tag=v0.9.1 -f version=0.9.2-beta.1
```

That builds upstream `v0.9.1` and publishes it as `0.9.2-beta.1`. It exists for two
reasons: shipping a fix before upstream has a tag for it, and producing a version
newer than the one installed so the update path can be exercised end to end.

The version must be valid semver, and a prerelease component decides how the
Release is treated:

- **`0.9.2-beta.1` style.** Published as a prerelease Release under a tag of the
  same shape (`v0.9.2-beta.1`), exactly how an upstream beta is treated — this
  repo keeps mirroring upstream rather than inventing a version space of its own.
  Only an app on a non-default channel sees it: the default channel reads
  `GET /releases/latest`, which ignores prereleases, while a `beta` channel walks
  the release feed and finds them.
- **A plain `0.9.2`.** Published as a normal Release, visible to every channel —
  and it takes the tag a real upstream `v0.9.2` will later need, so that build
  finds the Release already populated and needs `force: true` once.
- **The prerelease identifier has to be `beta`, not `beta1`.** electron-updater
  treats every other identifier as a *custom* channel: it skips that tag and then
  looks for `<identifier>-mac.yml`. `0.9.2-beta.1` resolves; `0.9.2-beta1` is a
  release nobody is ever offered.
- **Never a fourth component.** `0.9.1.1` is not semver — electron-updater parses
  the manifest version and throws `ERR_UPDATER_INVALID_VERSION` on every check, so
  no update is ever offered and nothing says why.

## Desktop maintenance

- **App dies at launch with `different Team IDs`** → on any build from before
  `entitlements/` was wired in, this was the self-signed-certificate trap above,
  not a partial install: the bundle was signed consistently, by one certificate,
  and still could not load its own frameworks. Check which one it is before
  reinstalling anything —
  `codesign -d --entitlements - /Applications/Paseo.app` reporting no
  `disable-library-validation` means the copy predates the fix, and reinstalling
  is the answer. A bundle that *does* carry it and still fails is something else:
  a nested framework left with another signer's certificate, which is what
  replacing a build by dragging it over an existing `/Applications/Paseo.app`
  leaves behind. Delete the app and install it again rather than dragging it
  over the existing copy; `codesign --verify --deep --strict` and
  `node scripts/assert-mac-signatures.mjs /Applications/Paseo.app` name the files
  that disagree.
- **Patch does not apply** → upstream moved the code it targets. Rebuild the
  patch against the new tag (`git diff > patches/<name>.patch`) and refresh the
  markers in `apply-desktop-patch.mjs`.
- **`ERR_UPDATER_CHANNEL_FILE_NOT_FOUND`** → the manifest for the app's channel
  is missing from the latest Release, so the update check resolves nothing. Both
  `latest[-mac].yml` and `beta[-mac].yml` should be there; if one is gone, the
  installers still work and re-running the workflow republishes it.
- **`ERR_UPDATER_INVALID_VERSION`** → the manifest's `version` is not valid
  semver, which is what a `version` override that is not semver produces (see
  "Publishing a version of our own"). No update is offered while it stands.
- **Updater finds nothing after a tag bump** → confirm the Release is neither a
  draft nor a prerelease. `GET /releases/latest` ignores both.

## Desktop knobs

- **Cadence**: `cron` in each desktop workflow (daily safety nets).
- **Windows on ARM**: drop the `-c.win.target=nsis` pin in
  `desktop-windows-build.yml` and add `--arm64`, then widen the patterns in
  `resolve` and the arm64 guard in `Verify build artifacts`. The pin is what
  makes `--x64` stick — upstream's per-target arch lists override the command
  line, so without it an arm64 installer is packed from x64 native modules.
- **Turn the update feeds off again**: drop the `resolve` patterns for the `.zip`
  and the manifests, the `Stage updater manifests` step in each desktop workflow,
  and the `zip` / `yml` entries in `scripts/upload-release-assets.mjs`. Nothing
  else consumes them. On Windows that leaves the `.exe` alone, which is all
  `NsisUpdater` installs from.
- **Rebuild an existing tag**: run the workflow manually with `force: true`.
- **Change what a Release holds**: the filter is `scripts/upload-release-assets.mjs`.
  Anything it drops is still built, just never uploaded.
- **Re-check a published release**: run the macOS workflow with
  `verify_only: true`. It downloads the released `.dmg`s, the `.zip`s and the
  manifests, mounts each disk image read-only, expands each archive with `ditto`,
  re-runs the same signature assertions on the `.app` inside, launches it, and
  checks each manifest's `sha512` against the archives it names — without building
  or publishing anything.
- **Entitlements**: `entitlements/` is this repo's own pair of plists, pointed at
  with `-c.mac.entitlements` and `-c.mac.entitlementsInherit`, chosen over
  upstream's because they add `disable-library-validation` (see "A self-signed
  certificate has no Team ID"). Add a key to both files — `entitlementsInherit`
  covers every nested helper, and library validation is enforced per process.
- **Timeouts**: 150 minutes per desktop job. Both platforms build the full web
  bundle with Metro and pack ~2 GB of `node_modules`, so expect 30–60 minutes.
