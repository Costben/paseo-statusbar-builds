#!/usr/bin/env node
// Uploads built release artifacts one file at a time, with retries.
//
// Why not a single `gh release upload release/*`: uploads.github.com returns
// HTTP 500 on large desktop binaries often enough that one failure would
// discard a ~50 minute build. Uploading per file means a bad asset only costs
// that asset, and the retry usually recovers it.
//
// Only installers are uploaded. A Release is meant to hold one file per platform
// — the macOS .dmg, the Windows NSIS .exe and the Android .apk — so the archives
// (.zip), the differential-update blockmaps and the updater manifests (*.yml)
// that electron-builder also produces never reach it. Everything this leaves out
// is what a manual download would not use.
//
// Usage: node upload-release-assets.mjs <release> <dir> <repo>

import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

const DEFAULT_ATTEMPTS = 5;
const DEFAULT_BACKOFF_MS = 15_000;

const [, , release, releaseDir, repo] = process.argv;
if (!release || !releaseDir || !repo) {
  console.error("usage: node upload-release-assets.mjs <release> <dir> <repo>");
  process.exit(2);
}

// Paseo-<ver>-arm64.dmg, Paseo-Setup-<ver>-x64.exe, paseo-<tag>-statusbar-fixed.apk.
const INSTALLER = /(\.dmg|\.apk|-setup-.*\.exe)$/i;

const files = readdirSync(releaseDir)
  .map((name) => path.join(releaseDir, name))
  .filter((file) => statSync(file).isFile() && INSTALLER.test(path.basename(file)))
  .sort();

if (files.length === 0) {
  console.error(`[upload-release-assets] ERROR: no release artifacts found in ${releaseDir}`);
  process.exit(1);
}

const gh = process.platform === "win32" ? "gh.exe" : "gh";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failed = false;

for (const file of files) {
  let exitCode = 1;

  for (let attempt = 1; attempt <= DEFAULT_ATTEMPTS; attempt += 1) {
    const result = spawnSync(
      gh,
      ["release", "upload", release, file, "--clobber", "--repo", repo],
      { shell: process.platform === "win32", stdio: "inherit" },
    );

    if (result.error) {
      console.error(`[upload-release-assets] failed to start gh: ${result.error.message}`);
      exitCode = 1;
    } else {
      exitCode = result.status ?? 1;
    }

    if (exitCode === 0) break;

    if (attempt < DEFAULT_ATTEMPTS) {
      const delayMs = attempt * DEFAULT_BACKOFF_MS;
      console.warn(
        `[upload-release-assets] upload of ${path.basename(file)} exited ${exitCode}; ` +
          `retrying in ${delayMs / 1000}s (${attempt + 1}/${DEFAULT_ATTEMPTS})`,
      );
      await sleep(delayMs);
    }
  }

  if (exitCode !== 0) {
    console.error(
      `::error::Giving up on ${path.basename(file)} after ${DEFAULT_ATTEMPTS} attempts`,
    );
    failed = true;
  }
}

process.exit(failed ? 1 : 0);
