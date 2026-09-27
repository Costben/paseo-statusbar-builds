#!/usr/bin/env node
// Applies the Kimi-native daemon series to a freshly checked-out upstream tag
// (getpaseo/paseo).
//
// One series, not a list of independent fixes: the pieces depend on each other.
// The daemon hosts and supervises a `kimi web` local server, a per-session
// bridge drives agent goals over it, and the goal is projected into agent state
// so the composer pill can render it. Nothing in that chain is reachable from
// outside the daemon, so it has to be compiled into the app.
//
//   usage / plan card / compaction / goal state
//                           ACP-side wiring: map usage_update into a
//                           usage_updated agent event (upstream
//                           getpaseo/paseo#1390), tag an ExitPlanMode approval
//                           as kind "plan" with the plan text in metadata so it
//                           renders as the full-height card, accept the
//                           "_paseo.dev/session/compaction" extension
//                           notification as a compaction marker, and carry a
//                           provider-reported goal in the agent snapshot.
//   provider hooks          ACPAgentSession gains providerHooks: an
//                           out-of-band hook for notifications ACP does not
//                           model, and a turn gate so a provider can hold a turn
//                           while it works.
//   kimi sidecar            packages/server/src/server/agent/providers/kimi/
//                           web-server-manager.ts — bind, token, ring buffer,
//                           ref-counted lifecycle, managed-process ledger.
//   kimi native bridge      the same directory's native-bridge.ts — create,
//                           poll, resume and cancel goals over the local server.
//   goal pill               packages/app/src/composer/goal-pill.tsx.
//   reliability             Kimi ACP capability descriptors, log instead of
//                           silently dropping session/staged events, and flag
//                           Kimi turns that complete with no assistant output.
//   composer badges         strip redundant "Thinking " prefixes from thinking
//                           option badges and make composer pills shrinkable
//                           so long labels do not evict adjacent controls.
//   windows-hidden-console  routes the daemon's four fork() call sites through
//                           forkProcess() and sets windowsHide, so a forked
//                           worker cannot allocate a visible console window that
//                           takes the whole daemon down when closed. Inert on
//                           macOS, so both platforms apply the same file.
//
// - Idempotent: re-running on an already-patched tree is a no-op.
// - Fails loudly: if upstream moved the code this series touches, exits non-zero
//   and names the file that no longer applies. A red CI run is the signal to
//   refresh the patch (or confirm the change landed upstream).
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

// One combined patch carrying the whole Kimi-native series: ACP usage/plan/
// compaction wiring, the reliability guards, first-class goal state, the
// daemon-hosted Kimi local server sidecar, the per-session native goal bridge,
// the native goal pill, and the Windows hidden-console fix.
//
// Applied on both platforms. The Windows-specific hunks are inert on POSIX
// (windowsHide is a no-op there) and keeping one series means the marker list
// below is the single description of what a build is supposed to contain.
const PATCHES = [
  {
    name: "kimi-native",
    file: "paseo-kimi-native-092.patch",
    platforms: ["mac", "win"],
    marker: {
      path: "packages/server/src/server/agent/providers/acp-agent.ts",
      needle: "handleUsageUpdate(update: UsageUpdate): AgentStreamEvent[]",
    },
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
  {
    label: "ACP ExitPlanMode plan metadata",
    path: "packages/server/src/server/agent/providers/acp-agent.ts",
    needle: "...(planText === undefined ? {} : { planText }),",
  },
  {
    label: "ACP compaction extension method",
    path: "packages/server/src/server/agent/providers/acp-agent.ts",
    needle: 'const COMPACTION_EXTENSION_METHOD = "_paseo.dev/session/compaction";',
  },
  {
    label: "Thinking label prefix stripper",
    path: "packages/app/src/agent-controls/labels.ts",
    needle: "function stripThinkingPrefix(",
  },
  {
    label: "Composer pill shrinkable",
    path: "packages/app/src/composer/pill-styles.ts",
    needle: "minWidth: 0,",
  },
  {
    label: "AgentManager staged events diagnostics",
    path: "packages/server/src/server/agent/agent-manager.ts",
    needle: 'reason: "staged_events_discarded"',
  },
  {
    label: "Kimi timeline missing validation",
    path: "packages/server/src/server/agent/providers/acp-agent.ts",
    needle: 'code: "kimi_timeline_missing"',
  },
  {
    label: "ACP session mismatch recovery",
    path: "packages/server/src/server/agent/providers/acp-agent.ts",
    needle: 'reason: "session_mismatch"',
  },
  {
    label: "Kimi ACP capability descriptor",
    path: "packages/server/src/server/agent/providers/kimi-acp-agent.ts",
    needle: "export const KIMI_ACP_CAPABILITIES",
  },
  {
    label: "ACP goal extension method",
    path: "packages/server/src/server/agent/providers/acp-agent.ts",
    needle: 'const GOAL_EXTENSION_METHOD = "_paseo.dev/session/goal";',
  },
  {
    label: "Agent snapshot carries the goal",
    path: "packages/protocol/src/messages.ts",
    needle: "goal: AgentGoalPayloadSchema.nullable().optional(),",
  },
  {
    label: "Goal status includes paused",
    path: "packages/protocol/src/messages.ts",
    needle: '  "paused",',
  },
  {
    label: "AgentManager goal state event",
    path: "packages/server/src/server/agent/agent-manager.ts",
    needle: 'case "goal_updated":',
  },
  {
    label: "Goal state projected into the snapshot",
    path: "packages/server/src/server/agent/agent-projections.ts",
    needle: "payload.goal = agent.goal;",
  },
  {
    label: "ACP provider hooks",
    path: "packages/server/src/server/agent/providers/acp-agent.ts",
    needle: "export interface ACPProviderHooks",
  },
  {
    label: "Kimi local server sidecar",
    path: "packages/server/src/server/agent/providers/kimi/web-server-manager.ts",
    needle: "export async function acquireKimiServer(",
  },
  {
    label: "Kimi native goal bridge",
    path: "packages/server/src/server/agent/providers/kimi/native-bridge.ts",
    needle: "export class KimiNativeBridge",
  },
  {
    label: "Kimi provider hooks",
    path: "packages/server/src/server/agent/providers/kimi-acp-agent.ts",
    needle: "export function createKimiProviderHooks(",
  },
  {
    label: "Daemon shuts the Kimi sidecar down",
    path: "packages/server/src/server/bootstrap.ts",
    needle: "await shutdownKimiServer();",
  },
  {
    label: "Native goal pill",
    path: "packages/app/src/composer/goal-pill.tsx",
    needle: "export function GoalPill(",
  },
  {
    label: "Goal pill mounted in the composer",
    path: "packages/app/src/composer/index.tsx",
    needle: "<GoalPill goal={agentState.goal} />",
  },
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
];

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
  const hasMarker =
    Boolean(patch.marker) &&
    existsSync(join(sourceDir, patch.marker.path)) &&
    readFileSync(join(sourceDir, patch.marker.path), "utf8").includes(patch.marker.needle);

  if (checkApplies(patchPath, { reverse: true }) || hasMarker) {
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
