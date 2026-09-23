#!/usr/bin/env node
// Merges the arm64 and x64 macOS updater manifests into the single
// latest-mac.yml electron-updater expects.
//
// Why this exists: electron-updater reads exactly one manifest per platform
// (<channel>-mac.yml), but electron-builder emits one manifest per build, and
// the two macOS architectures must be built on separate runners (the runner's
// own architecture decides which sherpa-onnx / sharp prebuilds `npm ci`
// installs). One runner per arch therefore means two partial manifests that
// have to be combined here.
//
// Usage: node merge-mac-manifest.mjs <arm64.yml> <x64.yml> <out.yml>
// Needs `js-yaml` resolvable from this file (the workflow installs it).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dump, load } from "js-yaml";

// electron-updater compares this against os.release(), which reports the Darwin
// kernel version. Darwin 22 is macOS 13 Ventura, the app's minimum.
export const MACOS_MINIMUM_DARWIN_VERSION = "22.0.0";

function fail(message) {
  console.error(`[merge-mac-manifest] ERROR: ${message}`);
  process.exit(1);
}

function readManifest(label, filePath) {
  if (!fs.existsSync(filePath)) {
    fail(`${label} manifest is missing: ${filePath}`);
  }

  const parsed = load(fs.readFileSync(filePath, "utf8"));
  if (parsed == null || !Array.isArray(parsed.files) || parsed.files.length === 0) {
    fail(`${label} manifest has no files list: ${filePath}`);
  }

  return parsed;
}

const [, , arm64Path, x64Path, outputPath] = process.argv;
if (!arm64Path || !x64Path || !outputPath) {
  fail("usage: node merge-mac-manifest.mjs <arm64.yml> <x64.yml> <out.yml>");
}

const arm64 = readManifest("arm64", arm64Path);
const x64 = readManifest("x64", x64Path);

if (arm64.version !== x64.version) {
  fail(`arch manifests disagree on version: ${arm64.version} vs ${x64.version}`);
}

const files = [...arm64.files, ...x64.files].filter(
  (file, index, all) => all.findIndex((entry) => entry.url === file.url) === index,
);

const arm64Files = files.filter((file) => String(file.url).includes("arm64")).length;
const x64Files = files.filter((file) => String(file.url).includes("x64")).length;
if (arm64Files === 0 || x64Files === 0) {
  fail(
    `merged manifest is missing an architecture (arm64=${arm64Files}, x64=${x64Files}): ` +
      files.map((file) => file.url).join(", "),
  );
}

const merged = dump(
  { ...arm64, files, minimumSystemVersion: MACOS_MINIMUM_DARWIN_VERSION },
  { lineWidth: -1, noRefs: true },
);

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, merged);
console.log(
  `[merge-mac-manifest] wrote ${outputPath} (version ${arm64.version}, ${files.length} files: ` +
    `${files.map((file) => file.url).join(", ")})`,
);
