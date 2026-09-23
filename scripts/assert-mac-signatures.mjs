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
// The comparison cannot be by Team ID. codesign writes a Team ID only for a
// certificate issued by Apple, and every certificate this repo can use is
// self-signed — so `TeamIdentifier` reads `not set` on *every* binary: measured
// on the macOS 14 runner, with and without an OU in the subject, and for the
// ad-hoc fallback too. Comparing Team IDs therefore compared nothing with
// nothing and called a bundle that dies at launch healthy. The signing
// certificate is the part that is actually present, so that is what this script
// fingerprints and compares. A Team ID, where one exists at all, must still
// agree across the bundle.
//
// Usage: node assert-mac-signatures.mjs <path/to/App.app>
// Exit 0 — every binary agrees. Exit 1 — mismatch, offending paths are printed.
// Env: ALLOW_UNSIGNED_APP=1 permits a bundle with no certificate at all; the
//      workflow sets it only when no signing secret is configured.
//
// No static check can catch the crash this script was written for. The broken
// build was signed consistently, by one certificate, top to bottom — which is
// exactly why every check passed. Launching the app is the only thing that
// detects it, so the workflow does that too; this script's job is the other
// failure, a bundle whose parts were signed by *different* certificates.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MAGIC_THIN_32 = 0xfeedface;
const MAGIC_THIN_64 = 0xfeedfacf;
const MAGIC_FAT_32 = 0xcafebabe;
const MAGIC_FAT_64 = 0xcafebabf;

const LC_CODE_SIGNATURE = 0x1d;

const CSMAGIC_EMBEDDED_SIGNATURE = 0xfade0cc0;
const CSMAGIC_CODEDIRECTORY = 0xfade0c02;
const CSMAGIC_BLOBWRAPPER = 0xfade0b01;
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

  // dataoff is relative to the start of the Mach-O image, which for a slice of a
  // universal binary is not the start of the file. Thin binaries are unaffected
  // (slice.offset is 0), but a fat one reads zeroes without this and every slice
  // comes back as "not signed".
  const base = slice.offset + signature.dataoff;
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
  let signer = null;
  if (hasCertificate && buf.readUInt32BE(cms) === CSMAGIC_BLOBWRAPPER) {
    const wrapped = buf.readUInt32BE(cms + 4);
    signer = signerFingerprint(buf, cms + 8, Math.min(cms + wrapped, buf.length));
  }
  return { identifier, teamId, flags, adhoc: (flags & 0x2) !== 0, hasCertificate, signer };
}

// --- the signing certificate -------------------------------------------------
//
// The CMS/PKCS#7 blob in the signature slot carries the signer's certificate
// chain. This is the one part of a signature that says *who* signed, and it is
// stable across the files that signer signed — unlike the signature bytes, which
// cover each file's own contents.

// Minimal BER/DER TLV reader. The CMS blob a signature carries is BER, so
// indefinite-length containers (an 0x80 length byte) have to be supported: their
// content runs until the end-of-contents marker (00 00) at the same nesting
// level, which means the extent can only be found by walking the children.
// `end` is where the content stops, `next` where the next sibling begins.
function readTLV(buf, offset, limit) {
  if (offset + 2 > limit) return null;
  const tag = buf[offset];
  let length = buf[offset + 1];
  let start = offset + 2;

  if (length === 0x80) {
    let cursor = start;
    for (;;) {
      if (cursor + 2 > limit) return null;
      if (buf[cursor] === 0x00 && buf[cursor + 1] === 0x00) {
        return { tag, start, end: cursor, next: cursor + 2 };
      }
      const child = readTLV(buf, cursor, limit);
      if (child === null) return null;
      cursor = child.next;
    }
  }

  if (length & 0x80) {
    const lengthBytes = length & 0x7f;
    if (lengthBytes === 0 || lengthBytes > 4 || start + lengthBytes > limit) return null;
    length = 0;
    for (let i = 0; i < lengthBytes; i++) length = length * 256 + buf[start + i];
    start += lengthBytes;
  }

  const end = start + length;
  if (end > limit) return null;
  return { tag, start, end, next: end };
}

// ContentInfo ::= SEQUENCE { contentType OID, content [0] EXPLICIT SignedData }
// SignedData  ::= SEQUENCE { version, digestAlgorithms, encapContentInfo,
//                            certificates [0] IMPLICIT SET OF Certificate, ... }
function certificatesIn(buf, start, limit) {
  const contentInfo = readTLV(buf, start, limit);
  if (!contentInfo || contentInfo.tag !== 0x30) return null;

  const oid = readTLV(buf, contentInfo.start, contentInfo.end);
  if (!oid || oid.tag !== 0x06) return null;

  const content = readTLV(buf, oid.next, contentInfo.end);
  if (!content || content.tag !== 0xa0) return null;

  const signedData = readTLV(buf, content.start, content.end);
  if (!signedData || signedData.tag !== 0x30) return null;

  // Walk SignedData's own fields. encapContentInfo may hold a [0] of its own, so
  // only a [0] seen at this level is the certificate set — and it is the first
  // one, since certificates precede crls.
  let field = readTLV(buf, signedData.start, signedData.end);
  while (field !== null && field.next <= signedData.end) {
    if (field.tag === 0xa0) {
      const certificates = [];
      let cursor = field.start;
      while (cursor < field.end) {
        const certificate = readTLV(buf, cursor, field.end);
        if (certificate === null || certificate.tag !== 0x30) break;
        certificates.push(buf.subarray(cursor, certificate.next));
        cursor = certificate.next;
      }
      return certificates.length > 0 ? certificates : null;
    }
    field = readTLV(buf, field.next, signedData.end);
  }
  return null;
}

// Names the signer: SHA-256 over the certificate set in DER, each certificate
// hashed first so the order they happen to be embedded in does not matter.
function signerFingerprint(buf, start, limit) {
  const certificates = certificatesIn(buf, start, limit);
  if (certificates === null) return null;
  const digest = createHash("sha256");
  const hashes = certificates.map((cert) => createHash("sha256").update(cert).digest("hex")).sort();
  for (const hash of hashes) digest.update(hash);
  return { hash: digest.digest("hex"), certificates: certificates.length };
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
const expectedSigner = mainSlices[0].signer?.hash ?? null;

console.log(`bundle            : ${appRoot}`);
console.log(
  `main executable   : ${path.relative(appRoot, mainExecutable)} ` +
    `identifier=${mainSlices[0].identifier} team=${expectedTeamId ?? "<none>"} ` +
    `certificate=${mainSlices[0].hasCertificate ? "yes" : "no"}`,
);
if (expectedSigner !== null) {
  console.log(
    `signing cert      : ${expectedSigner.slice(0, 16)}… ` +
      `(${mainSlices[0].signer.certificates} certificate(s) in the chain)`,
  );
}

// An empty Team ID cannot be the failure signal. codesign writes one only for a
// certificate issued by Apple, and every certificate this repo can use is
// self-signed, so `not set` is what a *correctly* signed binary carries —
// measured on the macOS 14 runner, with an OU in the subject and without one.
// Failing on it would fail every build; ignoring it is what let the crash ship.
// So the required properties are the ones that are actually observable: the main
// executable must carry a certificate, and every other binary must carry the
// same one. A Team ID is compared wherever one exists, so switching to a
// Developer ID certificate tightens this instead of weakening it.
//
// ALLOW_UNSIGNED_APP=1 is the single escape hatch, for a workflow that genuinely
// has no certificate to sign with: an ad-hoc bundle is then expected, not
// broken, and the workflow says so out loud.
const allowUnsigned = process.env.ALLOW_UNSIGNED_APP === "1";
const main = mainSlices[0];
if (!main.hasCertificate) {
  const reason = main.error ?? (main.adhoc ? "ad-hoc signature" : "no signature");
  if (!allowUnsigned) {
    console.error(
      `\nmain executable is not signed with a certificate: ` +
        `${path.relative(appRoot, mainExecutable)} (${reason})\n\n` +
        "electron-builder falls back to an ad-hoc signature — silently — when it cannot\n" +
        "find the signing identity, and an ad-hoc bundle can never install its own\n" +
        "updates. Check that MAC_CSC_LINK is set and that the workflow's trust step ran.\n",
    );
    process.exit(1);
  }
  console.warn(`warning: main executable is ${reason}; ALLOW_UNSIGNED_APP=1 is set.`);
} else if (expectedSigner === null && !allowUnsigned) {
  console.error(
    `\nno signing certificate could be read out of ${path.relative(appRoot, mainExecutable)}\n\n` +
      "The bundle claims a certificate but its CMS blob did not parse, so there is\n" +
      "nothing to compare the nested binaries against — which is how a mixed-signer\n" +
      "bundle would get through.\n",
  );
  process.exit(1);
}

const files = collectMachOFiles(appRoot);
const report = {
  total: 0,
  unsigned: [],
  mismatched: [],
  signers: new Set(),
  teamIds: new Set(),
  identifiers: new Set(),
};
// A universal binary has one entry per slice, and reporting the same file three
// times buries the ones that actually differ.
const seenUnsigned = new Set();
const seenMismatched = new Set();

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
      const reason = slice.error ?? (slice.adhoc ? "ad-hoc" : "no certificate");
      if (!seenUnsigned.has(relative)) {
        seenUnsigned.add(relative);
        report.unsigned.push({ relative, reason, loaded });
      }
      continue;
    }
    if (slice.signer !== null) report.signers.add(slice.signer.hash);

    const signer = slice.signer?.hash ?? null;
    let detail = null;
    if (signer !== expectedSigner) {
      detail =
        signer === null
          ? "signing certificate could not be read"
          : `signed by ${signer.slice(0, 16)}…`;
    } else if (expectedTeamId !== null && (slice.teamId ?? null) !== expectedTeamId) {
      detail = `team id ${slice.teamId ?? "<none>"} != ${expectedTeamId}`;
    } else if (expectedTeamId === null && (slice.teamId ?? null) !== null) {
      // A component carrying a Team ID inside a bundle whose main executable has
      // none did not come out of this signing pass.
      detail = `team id ${slice.teamId} on a bundle whose main executable has none`;
    }

    if (detail !== null && !seenMismatched.has(relative)) {
      seenMismatched.add(relative);
      report.mismatched.push({ relative, detail });
    }
  }
}

const signers = [...report.signers].map((hash) => `${hash.slice(0, 16)}…`);
console.log(`mach-o slices     : ${report.total}`);
console.log(`distinct signers  : ${signers.length}${signers.length > 0 ? ` (${signers.join(", ")})` : ""}`);
console.log(`distinct team ids : ${[...report.teamIds].join(", ") || "<none>"}`);
console.log(`distinct idents   : ${report.identifiers.size}`);

const fatal = [
  ...report.unsigned
    .filter((entry) => entry.loaded && !allowUnsigned)
    .map((entry) => `no certificate: ${entry.relative} (${entry.reason})`),
  ...report.mismatched.map((entry) => `${entry.detail}: ${entry.relative}`),
];

for (const entry of report.unsigned) {
  if (entry.loaded && !allowUnsigned) continue; // already listed as fatal above
  console.warn(`warning: nested binary without a certificate: ${entry.relative} (${entry.reason})`);
}

if (fatal.length > 0) {
  console.error(`\n${fatal.length} nested binary/binaries disagree with the main executable:`);
  for (const line of fatal.slice(0, 40)) console.error(`  - ${line}`);
  if (fatal.length > 40) console.error(`  ... and ${fatal.length - 40} more`);
  console.error(
    "\nmacOS refuses to load code signed by a different party than the process, so this\n" +
      "bundle would crash on the user's Mac before it can draw a window. Every nested\n" +
      "binary has to be signed by the same certificate in the same signing pass.",
  );
  process.exit(1);
}

console.log("ok: every nested Mach-O is signed by the main executable's certificate");
