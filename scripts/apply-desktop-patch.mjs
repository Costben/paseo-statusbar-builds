#!/usr/bin/env node
// Applies the Kimi Goal Bridge daemon patches to a freshly checked-out
// upstream tag (getpaseo/paseo).
//
// These patches are what the plugin cannot reach on its own: they live inside
// the daemon, so they have to be compiled into the app.
//
//   acp-usage-update        maps ACP's usage_update notification into a
//                           usage_updated agent event, which is what fills the
//                           native context table (upstream getpaseo/paseo#1390).
//   windows-hidden-console  routes the daemon's four fork() call sites through
//                           forkProcess() and sets windowsHide, so a forked
//                           worker cannot allocate a visible console window that
//                           takes the whole daemon down when closed.
//
// - Idempotent: re-running on an already-patched tree is a no-op.
// - Fails loudly: if upstream moved the code these patches touch, exits non-zero
//   and names the patch that no longer applies. A red CI run is the signal to
//   refresh that patch file (or confirm it landed upstream).
//
// Usage: node apply-desktop-patch.mjs <sourceDir> <mac|win>

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const patchDir = resolve(here, "..", "patches");

const sourceDir = resolve(process.argv[2] ?? ".");
const platform = (process.argv[3] ?? "").toLowerCase();

if (platform !== "mac" && platform !== "win") {
  console.error("[desktop-patch] ERROR: platform must be 'mac' or 'win'");
  process.exit(1);
}

// The Windows patch only matters on Windows; applying it on macOS would add
// churn for zero behavioural difference (windowsHide is a no-op on POSIX).
const PATCHES = [
  {
    name: "acp-usage-update",
    file: "paseo-acp-usage-update.patch",
    platforms: ["mac", "win"],
  },
  {
    name: "windows-hidden-console",
    file: "paseo-windows-hidden-console.patch",
    platforms: ["win"],
  },
];

// Post-checks. `git apply` succeeding only proves the text landed; these prove
// the code that is supposed to be there is actually there.
const MARKERS = [
  {
    label: "ACP usage_update mapping",
    path: "packages/server/src/server/agent/providers/acp-agent.ts",
    needle: "handleUsageUpdate(update: UsageUpdate): AgentStreamEvent[]",
  },
  {
    label: "ACP usage_update event emission",
    path: "packages/server/src/server/agent/providers/acp-agent.ts",
    needle: "return [...pendingUserEvents, ...this.handleUsageUpdate(update)]",
  },
];

if (platform === "win") {
  MARKERS.push(
    {
      label: "forkProcess helper",
      path: "packages/server/src/utils/spawn.ts",
      needle: "export function forkProcess(",
    },
    {
      label: "supervisor worker spawn hides its console",
      path: "packages/server/scripts/supervisor.ts",
      needle: "child = forkProcess(workerEntry, workerArgs, {",
    },
  );
}

function fail(message) {
  console.error(`[desktop-patch] ERROR: ${message}`);
  process.exit(1);
}

function git(args, { allowFailure = false } = {}) {
  try {
    return execFileSync("git", args, {
      cwd: sourceDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (allowFailure) {
      return null;
    }
    const stderr = error.stderr?.toString?.() ?? String(error);
    fail(`git ${args.join(" ")} failed:\n${stderr.trim()}`);
  }
}

function checkApplies(patchPath, { reverse }) {
  const args = ["apply", "--check"];
  if (reverse) {
    args.push("--reverse");
  }
  args.push(patchPath);
  return git(args, { allowFailure: true }) !== null;
}

if (!existsSync(join(sourceDir, ".git"))) {
  fail(`${sourceDir} is not a git checkout`);
}

let applied = 0;
let skipped = 0;

for (const patch of PATCHES) {
  if (!patch.platforms.includes(platform)) {
    console.log(`[desktop-patch] skip ${patch.name} (not used on ${platform})`);
    continue;
  }

  const patchPath = join(patchDir, patch.file);
  if (!existsSync(patchPath)) {
    fail(`patch file is missing: ${patchPath}`);
  }

  // Already applied? Then leave the tree alone. This is what makes a re-run safe.
  if (checkApplies(patchPath, { reverse: true })) {
    console.log(`[desktop-patch] ${patch.name} already applied`);
    skipped += 1;
    continue;
  }

  if (!checkApplies(patchPath, { reverse: false })) {
    fail(
      `${patch.name} does not apply to this upstream tag. ` +
        `Upstream moved the code it targets — refresh patches/${patch.file} ` +
        `against the new tag, or confirm the change landed upstream and drop the patch.`,
    );
  }

  git(["apply", patchPath]);
  console.log(`[desktop-patch] applied ${patch.name}`);
  applied += 1;
}

for (const marker of MARKERS) {
  const target = join(sourceDir, marker.path);
  if (!existsSync(target)) {
    fail(`post-check failed: ${marker.path} is missing`);
  }
  if (!readFileSync(target, "utf8").includes(marker.needle)) {
    fail(`post-check failed: ${marker.label} — ${marker.path} lacks: ${marker.needle}`);
  }
  console.log(`[desktop-patch] verified ${marker.label}`);
}

// A leftover conflict marker means a patch landed half-applied. Never build that.
const dirty = git(["diff", "--check"], { allowFailure: true });
if (dirty && dirty.trim().length > 0) {
  fail(`whitespace/conflict problems in the patched tree:\n${dirty.trim()}`);
}

console.log(`[desktop-patch] done for ${platform}: ${applied} applied, ${skipped} already present`);
