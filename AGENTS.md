# AGENTS.md

Conventions for this repository. Read this before changing anything here.

## This repo is edited on the remote only

`main` on GitHub is the single working copy.

- Do not clone this repo to a local machine, and do not leave a checkout behind.
- Read files with `gh api repos/Costben/paseo-statusbar-builds/contents/<path>`.
- Write with the GitHub API: the git data API (blob → tree → commit → move the
  ref) or the contents API (`PUT .../contents/<path>`, passing the current `sha`).
  Neither needs a worktree.
- Local work is limited to what cannot happen in CI: resolving a patch conflict
  needs an editable working tree, so that goes in a throwaway directory under
  `$TMPDIR` that is deleted afterwards. Never put scratch trees, `node_modules` or
  build output inside a project directory.
- Everything else runs in CI. Never `npm ci`, never a build, a typecheck or a test
  run on a laptop — see "Pre-flight is CI".

The repo stores only workflows, patch scripts and patches. A local checkout adds
nothing but drift, and the drift is invisible until a build fails.

## Pre-flight is CI

`patch-verify.yml` is where a patch refresh is validated. It applies the desktop
patch series to an upstream tag — both the `mac` and the `win` target — then runs
`npm ci`, `npm run build:server`, the server and app typechecks, and every test file
the patch touches. Those are the checks that used to be run by hand. It builds no
bundle and publishes nothing, so it finishes in minutes where a desktop build takes
the better part of an hour.

```bash
gh workflow run patch-verify.yml \
  --repo Costben/paseo-statusbar-builds \
  -f tag=v0.11.1
```

A red run is the answer: fix the patch and dispatch again. Do not reproduce the
failure locally to "confirm" it — not needing that reproduction is the point.

## Verification is CI

There is no local test suite; the workflows are the validator.

- Changed `patches/` or `scripts/` → dispatch the workflow for the tag you target
  and watch the patch step: `Apply desktop patches` for the desktop workflows,
  `Apply statusbar patch` for Android. That step is the gate. Red there means the
  patch no longer applies to that upstream tag and needs refreshing.
- macOS:
  `gh workflow run desktop-macos-build.yml --repo Costben/paseo-statusbar-builds --ref main -f tag=<tag>`
- Windows chains off the macOS workflow via `workflow_run`. Do not dispatch it by
  hand — that races the chain.
- `-f verify_only=true` re-checks assets that are already published (mounts each
  `.dmg`, expands each `.zip`, compares each manifest's `sha512`) without
  rebuilding or publishing.
- `-f force=true` rebuilds even when the Release already holds every artifact.

## Commits

Conventional Commits, subject in Chinese, imperative, no trailing period.

```
<type>(<scope>): <subject>
```

Scopes this repo's history uses:

| scope | 用途 |
| --- | --- |
| `kimi` | Kimi provider / ACP 补丁与行为 |
| `patches` | 补丁文件与 apply 脚本 |
| `composer` | Composer / 输入区 UI 补丁 |
| `acp` | ACP 协议层补丁 |
| `claude` | Claude provider 补丁 |
| `app` | 移动端 App 补丁 |
| `ci` | workflow 与 CI 配置 |
| `build` | 构建与打包 |

Leave the scope empty for repo-wide documentation.

No attribution lines: no `Co-Authored-By`, no `Generated with`, no emoji.
