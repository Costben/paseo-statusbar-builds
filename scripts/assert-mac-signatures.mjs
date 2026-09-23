#!/usr/bin/env node
//
// Asserts that every Mach-O inside a macOS app bundle carries the same code
// signature as the bundle's main executable.
//
// Why this exists: macOS refuses to load a framework whose Team ID differs from
// the loading process's, and the complaint only ever shows up on a user's Mac:
//
//   Library not loaded: @rpath/Electron Framework.framework/Electron Framework
//   Reason: ... mapping process and mapped file (non-platform) have different Team IDs
//
// That state is easy to produce and impossible to notice here. Electron ships
// pre-signed binaries, so a signing step that covers the app but misses a nested
// framework leaves our certificate on one half of the bundle and Electron's on the
// other half — and electron-builder logs a successful sign either way. The same
// check catches the other half of the problem, a nested binary that carries no
// certificate at all, which is what the ad-hoc fallback leaves behind.
//
// Usage: node assert-mac-signatures.mjs <path/to/App.app>
// Exit 0 — every binary agrees. Exit 1 — mismatch, offending paths are printed.

import fs from "node:fs";
import path from "node:path";

const MAGIC_THIN_32 = 0xfeedface;
const MAGIC_THIN_64 = 0xfeedfacf;
const MAGIC_FAT_32 = 0xcafebabe;
const MAGIC_FAT_64 = 0xcafebabf;

const LC_CODE_SIGNATURE = 0x1d;

const CSMAGIC_EMBEDDED_SIGNATURE = 0xfade0cc0;
const CSMAGIC_CODEDIRECTORY = 0xfade0c02;
const CSSLOT_CODEDIRECTORY = 0x0;
const CSSLOT_SIGNATURESLOT = 0x10000;

// Fatal by design: dyld loads these, so a mismatch here is the crash above.
const LOADED_PREFIXES = ["Contents/MacOS/", "Contents/Frameworks/"];

function readCString(buf, offset) {
  if (offset <= 0 || offset >= buf.length) return null;
  let end = offset;
  while (end < buf.length && buf[end] !== 0) end++;
  const value = buf.subarray(offset, end).toString("utf8");
  return value.length > 0 ? value : null;
}

function looksLikeMachO(head) {
  if (head.length < 4) return false;
  if (head.readUInt32BE(0) === MAGIC_FAT_32 || head.readUInt32BE(0) === MAGIC_FAT_64) return true;
  return head.readUInt32LE(0) === MAGIC_THIN_32 || head.readUInt32LE(0) === MAGIC_THIN_64;
}

function slicesOf(buf) {
  if (buf.length < 8) return null;
  const fat = buf.readUInt32BE(0);
  if (fat === MAGIC_FAT_32 || fat === MAGIC_FAT_64) {
    const wide = fat === MAGIC_FAT_64;
    const count = buf.readUInt32BE(4);
    const stride = wide ? 32 : 20;
    const slices = [];
    for (let i = 0; i < count; i++) {
      const entry = 8 + i * stride;
      if (entry + stride > buf.length) break;
      const offset = wide ? Number(buf.readBigUInt64BE(entry + 8)) : buf.readUInt32BE(entry + 8);
      const size = wide ? Number(buf.readBigUInt64BE(entry + 16)) : buf.readUInt32BE(entry + 12);
      if (offset + size > buf.length) continue;
      slices.push({ offset, size });
    }
    return slices.length > 0 ? slices : null;
  }
  const thin = buf.readUInt32LE(0);
  if (thin === MAGIC_THIN_32 || thin === MAGIC_THIN_64) return [{ offset: 0, size: buf.length }];
  return null;
}

function parseSlice(buf, slice) {
  const magic = buf.readUInt32LE(slice.offset);
  const headerSize = magic === MAGIC_THIN_64 ? 32 : 28;
  const end = slice.offset + slice.size;
  if (slice.offset + headerSize > end) return { error: "truncated header" };

  const ncmds = buf.readUInt32LE(slice.offset + 16);
  let cmd = slice.offset + headerSize;
  let signature = null;
  for (let i = 0; i < ncmds; i++) {
    if (cmd + 8 > end) return { error: "truncated load commands" };
    const type = buf.readUInt32LE(cmd);
    const size = buf.readUInt32LE(cmd + 4);
    if (type === LC_CODE_SIGNATURE) {
      signature = { dataoff: buf.readUInt32LE(cmd + 8), datasize: buf.readUInt32LE(cmd + 12) };
      break;
    }
    if (size < 8) return { error: "bad load command size" };
    cmd += size;
  }
  if (!signature || signature.datasize === 0) return { adhoc: true };

  const base = signature.dataoff;
  if (base + 12 > buf.length) return { error: "code signature out of range" };
  if (buf.readUInt32BE(base) !== CSMAGIC_EMBEDDED_SIGNATURE) {
    return { error: "no embedded signature superblob" };
  }
  const count = buf.readUInt32BE(base + 8);
  const slots = new Map();
  for (let i = 0; i < count; i++) {
    const entry = base + 12 + i * 8;
    if (entry + 8 > buf.length) break;
    slots.set(buf.readUInt32BE(entry), base + buf.readUInt32BE(entry + 4));
  }

  const codeDirectory = slots.get(CSSLOT_CODEDIRECTORY);
  if (codeDirectory === undefined) return { error: "no CodeDirectory" };
  if (buf.readUInt32BE(codeDirectory) !== CSMAGIC_CODEDIRECTORY) {
    return { error: "bad CodeDirectory magic" };
  }
  const version = buf.readUInt32BE(codeDirectory + 8);
  const flags = buf.readUInt32BE(codeDirectory + 12);
  const identifier = readCString(buf, codeDirectory + buf.readUInt32BE(codeDirectory + 20));
  let teamId = null;
  if (version >= 0x20200 && codeDirectory + 52 <= buf.length) {
    const teamOffset = buf.readUInt32BE(codeDirectory + 48);
    if (teamOffset !== 0) teamId = readCString(buf, codeDirectory + teamOffset);
  }

  const cms = slots.get(CSSLOT_SIGNATURESLOT);
  const hasCertificate = cms !== undefined && buf.readUInt32BE(cms + 4) > 8;
  return { identifier, teamId, flags, adhoc: (flags & 0x2) !== 0, hasCertificate };
}

function collectMachOFiles(root) {
  const found = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      let fd = null;
      try {
        fd = fs.openSync(full, "r");
        const head = Buffer.alloc(16);
        const read = fs.readSync(fd, head, 0, 16, 0);
        if (read < 4) continue;
        if (looksLikeMachO(head.subarray(0, read))) found.push(full);
      } catch {
        // unreadable entry: not our business
      } finally {
        if (fd !== null) fs.closeSync(fd);
      }
    }
  }
  return found.sort();
}

function inspect(file) {
  const buf = fs.readFileSync(file);
  const slices = slicesOf(buf);
  if (slices === null) return null;
  return slices.map((slice) => parseSlice(buf, slice));
}

const appPath = process.argv[2];
if (!appPath) {
  console.error("usage: node assert-mac-signatures.mjs <path/to/App.app>");
  process.exit(2);
}
if (!fs.existsSync(appPath)) {
  console.error(`no such bundle: ${appPath}`);
  process.exit(2);
}

const appRoot = appPath.replace(/[\\/]+$/, "");
const macosDir = path.join(appRoot, "Contents", "MacOS");
let mainExecutable = null;
if (fs.existsSync(macosDir)) {
  for (const name of fs.readdirSync(macosDir).sort()) {
    const candidate = path.join(macosDir, name);
    if (!fs.statSync(candidate).isFile()) continue;
    if (inspect(candidate) !== null) {
      mainExecutable = candidate;
      break;
    }
  }
}
if (mainExecutable === null) {
  console.error(`no Mach-O executable under ${path.relative(appRoot, macosDir) || macosDir}`);
  process.exit(1);
}

const mainSlices = inspect(mainExecutable);
const expectedTeamId = mainSlices[0].teamId ?? null;

console.log(`bundle            : ${appRoot}`);
console.log(
  `main executable   : ${path.relative(appRoot, mainExecutable)} ` +
    `identifier=${mainSlices[0].identifier} team=${expectedTeamId ?? "<none>"} ` +
    `certificate=${mainSlices[0].hasCertificate ? "yes" : "no"}`,
);

const files = collectMachOFiles(appRoot);
const report = { total: 0, unsigned: [], mismatched: [], teamIds: new Set(), identifiers: new Set() };

for (const file of files) {
  const relative = path.relative(appRoot, file).split(path.sep).join("/");
  const slices = inspect(file);
  if (slices === null) continue;
  const loaded = LOADED_PREFIXES.some((prefix) => relative.startsWith(prefix));
  for (const slice of slices) {
    report.total += 1;
    if (slice.identifier) report.identifiers.add(slice.identifier);
    report.teamIds.add(slice.teamId ?? "<none>");
    if (!slice.hasCertificate) {
      report.unsigned.push({ relative, reason: slice.error ?? (slice.adhoc ? "ad-hoc" : "no certificate"), loaded });
      continue;
    }
    if ((slice.teamId ?? null) !== expectedTeamId) {
      report.mismatched.push({ relative, teamId: slice.teamId ?? "<none>" });
    }
  }
}

console.log(`mach-o slices     : ${report.total}`);
console.log(`distinct team ids : ${[...report.teamIds].join(", ") || "<none>"}`);
console.log(`distinct idents   : ${report.identifiers.size}`);

const fatal = [
  ...report.unsigned.filter((entry) => entry.loaded).map((entry) => `no certificate: ${entry.relative} (${entry.reason})`),
  ...report.mismatched.map((entry) => `team id ${entry.teamId} != ${expectedTeamId ?? "<none>"}: ${entry.relative}`),
];

for (const entry of report.unsigned.filter((item) => !item.loaded)) {
  console.warn(`warning: nested binary without a certificate: ${entry.relative} (${entry.reason})`);
}

if (fatal.length > 0) {
  console.error(`\n${fatal.length} nested binary/binaries disagree with the main executable:`);
  for (const line of fatal.slice(0, 40)) console.error(`  - ${line}`);
  if (fatal.length > 40) console.error(`  ... and ${fatal.length - 40} more`);
  console.error(
    "\nmacOS refuses to load a framework whose Team ID differs from the process's, so this\n" +
      "bundle would crash on the user's Mac with `different Team IDs`. Every nested binary\n" +
      "has to be signed by the same certificate in the same pass.",
  );
  process.exit(1);
}

console.log("ok: every nested Mach-O is signed by the main executable's certificate");
