#!/usr/bin/env node
// Asserts that a published updater manifest describes the published archives.
//
// Why this exists: electron-updater trusts <channel>-mac.yml and nothing else.
// The manifest and the archives it names come out of one electron-builder run but
// reach the Release as separate uploads, and nothing compares them afterwards —
// a manifest whose `files[].sha512` no longer matches the asset it names makes
// every in-app update fail with a checksum error, long after the build went green.
// This compares them against the bytes a user actually downloads.
//
// Usage: node assert-mac-manifest.mjs <manifest.yml> <assets-dir> <version>
// Needs `js-yaml` resolvable from this file (the workflow installs it).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { load } from "js-yaml";

const [, , manifestPath, assetsDir, expectedVersion] = process.argv;
if (!manifestPath || !assetsDir || !expectedVersion) {
  console.error("usage: node assert-mac-manifest.mjs <manifest.yml> <assets-dir> <version>");
  process.exit(2);
}

const failures = [];
const fail = (message) => {
  failures.push(message);
  console.error(`::error::${message}`);
};

if (!fs.existsSync(manifestPath)) {
  console.error(`::error::${manifestPath} does not exist — the app would have nothing to update from.`);
  process.exit(1);
}

const manifest = load(fs.readFileSync(manifestPath, "utf8"));
console.log(`--- ${manifestPath} ---`);
console.log(fs.readFileSync(manifestPath, "utf8"));

if (manifest == null || typeof manifest !== "object") {
  fail(`${manifestPath} is not a YAML mapping.`);
}

if (manifest?.version !== expectedVersion) {
  fail(
    `manifest version is ${JSON.stringify(manifest?.version)}, expected ${expectedVersion}. ` +
      "The updater compares it against the installed version, so a mismatch means the update is never offered.",
  );
}

const files = Array.isArray(manifest?.files) ? manifest.files : [];
if (files.length === 0) {
  fail("manifest has no files list.");
}

// MacUpdater.doDownloadUpdate calls findFile(files, "zip", ["pkg", "dmg"]) and
// throws ERR_UPDATER_ZIP_FILE_NOT_FOUND when there is no zip. A manifest listing
// only the .dmg is one macOS cannot update from.
if (!files.some((file) => String(file.url).endsWith(".zip"))) {
  fail("manifest lists no .zip — macOS updates install the zip, not the dmg.");
}

const urls = new Set(files.map((file) => String(file.url)));
if (manifest?.path != null && !urls.has(String(manifest.path))) {
  fail(`manifest path ${manifest.path} is not one of its files.`);
}

for (const file of files) {
  const name = String(file.url);
  const local = path.join(assetsDir, name);
  if (!fs.existsSync(local)) {
    fail(`${name} is named by the manifest but was not among the downloaded assets — an updater would 404 on it.`);
    continue;
  }

  const bytes = fs.readFileSync(local);
  let matches = true;
  if (Number(file.size) !== bytes.length) {
    fail(`${name} is ${bytes.length} bytes on the Release but the manifest says ${file.size}.`);
    matches = false;
  }
  const sha512 = crypto.createHash("sha512").update(bytes).digest("base64");
  if (String(file.sha512) !== sha512) {
    fail(`${name} has sha512 ${sha512} but the manifest says ${file.sha512} — every update from it fails its checksum.`);
    matches = false;
  }

  if (matches) console.log(`ok: ${name} (${bytes.length} bytes, sha512 matches the manifest)`);
}

if (failures.length > 0) {
  console.error(`\n${failures.length} problem(s) with ${manifestPath}.`);
  process.exit(1);
}
console.log(`${manifestPath} matches the published archives.`);
