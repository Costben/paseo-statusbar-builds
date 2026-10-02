#!/usr/bin/env node
// Applies the Kimi-native daemon series to a freshly checked-out upstream tag
// (getpaseo/paseo).
//
// One series, not a list of independent fixes: the pieces depend on each other.
// The daemon tails the Kimi session's own log to learn what goal the agent is
// working on, projects it into agent state, and holds the ACP turn open while
// that goal runs; the composer pill renders it. Nothing in that chain is
// reachable from outside the daemon, so it has to be compiled into the app.
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
//   kimi session log        packages/server/src/server/agent/providers/kimi/
//                           session-log.ts — tails the session's own
//                           `agents/main/wire.jsonl` for goal.create /
//                           goal.update / goal.clear and for real token counts.
//   kimi native bridge      the same directory's native-bridge.ts — per-session
//                           wrapper over that tailer, with the settle wait the
//                           turn hold awaits.
//   kimi subagents          the same directory's subagent-log.ts plus the
//                           session log's subagent registry: the main log
//                           announces each subagent an Agent tool call spawned,
//                           and each one's own `agents/<id>/wire.jsonl` is
//                           tailed for its transcript. Both are projected into
//                           Paseo's existing provider-subagent events, so the
//                           composer's subagent pill and detail panel work for
//                           Kimi without a single client change.
//   kimi /goal              `/goal <objective>` is rewritten into a prompt that
//                           makes the agent create and pursue the goal itself,
//                           because Kimi's goal engine is driven by the model's
//                           own goal tools, not by any API a second process can
//                           reach. Bare `/goal` and `/goal status` stay
//                           out-of-band and report from the tailed log.
//   goal pill               packages/app/src/composer/goal-pill.tsx.
//   claude goal             Claude Code reports its own goal on the SDK message
//                           stream. That frame is mapped into the same goal
//                           state, so the pill covers Claude too. The frame only
//                           arrives at the first evaluation, so the command's
//                           own `goal_status` record is read from the session
//                           transcript as well: that is what puts the pill up
//                           the moment `/goal` is set, before the turn ends.
//   kimi cut-in             a message sent while the Kimi runtime is still
//                           working replaces the turn instead of queueing
//                           behind it. Without this the runtime answered the
//                           prompt with an immediate end_turn, the turn looked
//                           finished while the work was not, and the next
//                           message queued instead of interrupting.
//   kimi send behavior      steering means putting a message into the turn that
//                           is already running, which the ACP channel Kimi Code
//                           speaks cannot do. The daemon used to accept the
//                           request and quietly fall through to an interrupt, so
//                           the composer offered a third option that could never
//                           be honoured. The session now reports whether it can
//                           be steered, the daemon dispatches a steer as an
//                           interrupt when it cannot, and the composer shows
//                           queue / interrupt only.
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
//   claude window           a Claude model the manifest does not know gets its
//                           context window resolved the way Claude Code does,
//                           so a fresh session's composer meter is not empty for
//                           its whole first turn.
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
    file: "paseo-kimi-native-0101.patch",
    platforms: ["mac", "win"],
    marker: {
      path: "packages/server/src/server/agent/providers/acp-agent.ts",
      needle: "handleUsageUpdate(update: UsageUpdate): AgentStreamEvent[]",
    },
  },
  {
    name: "agent-cwd-guard",
    file: "paseo-agent-cwd-guard.patch",
    platforms: ["mac", "win"],
    marker: {
      path: "packages/server/src/server/agent/agent-loading.ts",
      needle: 'Agent ${agentId} workspace directory no longer exists: ${record.cwd}',
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
    label: "Generic ACP client takes capability overrides",
    path: "packages/server/src/server/agent/providers/generic-acp-agent.ts",
    needle: "...options.capabilityOverrides,",
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
    needle: 'z.enum(["active", "paused", "complete", "blocked", "cleared"])',
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
    label: "Kimi session log tailer",
    path: "packages/server/src/server/agent/providers/kimi/session-log.ts",
    needle: "export class KimiSessionLog",
  },
  {
    label: "Kimi session log goal parser",
    path: "packages/server/src/server/agent/providers/kimi/session-log.ts",
    needle: "export function parseKimiSessionLogLines(",
  },
  {
    label: "Kimi context window read from the model config",
    path: "packages/server/src/server/agent/providers/kimi/session-log.ts",
    needle: "export async function loadKimiModelContextWindows(",
  },
  {
    label: "Kimi usage reported with used and max together",
    path: "packages/server/src/server/agent/providers/kimi/session-log.ts",
    needle:
      "this.onUsage?.({ contextWindowUsedTokens: used, contextWindowMaxTokens: max });",
  },
  {
    label: "Harness reminder envelopes stay out of the timeline",
    path: "packages/server/src/server/agent/agent-prompt.ts",
    needle: "<system-reminder>[\\s\\S]*<\\/system-reminder>",
  },
  {
    label: "Kimi native goal bridge",
    path: "packages/server/src/server/agent/providers/kimi/native-bridge.ts",
    needle: "export class KimiNativeBridge",
  },
  {
    label: "Kimi subagent registry in the session log",
    path: "packages/server/src/server/agent/providers/kimi/session-log.ts",
    needle: "export interface KimiSubagentRecord",
  },
  {
    label: "Kimi subagent transcript tailer",
    path: "packages/server/src/server/agent/providers/kimi/subagent-log.ts",
    needle: "export class KimiSubagentLogTailer",
  },
  {
    label: "Kimi subagent transcript mapping",
    path: "packages/server/src/server/agent/providers/kimi/subagent-log.ts",
    needle: "export function mapKimiSubagentLogLines(",
  },
  {
    label: "Kimi subagent events reach the client",
    path: "packages/server/src/server/agent/providers/kimi/native-bridge.ts",
    needle: 'type: "provider_subagent"',
  },
  {
    label: "Kimi provider hooks",
    path: "packages/server/src/server/agent/providers/kimi-acp-agent.ts",
    needle: "export function createKimiProviderHooks(",
  },
  {
    label: "Kimi goal command rewritten into a prompt",
    path: "packages/server/src/server/agent/providers/kimi-acp-agent.ts",
    needle: "export function transformKimiGoalPrompt(",
  },
  {
    label: "ACP provider prompt transform hook",
    path: "packages/server/src/server/agent/providers/acp-agent.ts",
    needle: "transformPrompt?(prompt: AgentPromptInput",
  },
  {
    label: "ACP turn hold is interruptible",
    path: "packages/server/src/server/agent/providers/acp-agent.ts",
    needle: "this.turnAbort?.abort();",
  },
  {
    label: "Native goal pill",
    path: "packages/app/src/composer/goal-pill.tsx",
    needle: "export function GoalPill(",
  },
  {
    label: "Goal pill mounted in the composer",
    path: "packages/app/src/composer/index.tsx",
    needle: "<GoalPill goal={agentState.goal} provider={agentState.provider} />",
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
  {
    label: "Agent resume refuses a missing workspace directory",
    path: "packages/server/src/server/agent/agent-loading.ts",
    needle: 'Agent ${agentId} workspace directory no longer exists: ${record.cwd}',
  },
  {
    label: "ACP catch-all tool calls are labelled with the tool name",
    path: "packages/server/src/server/agent/providers/acp-agent.ts",
    needle: 'snapshot.kind !== "other"',
  },
  {
    label: "CamelCase tool names keep the spelling the agent sent",
    path: "packages/protocol/src/tool-call-display.ts",
    needle: "if (/[A-Z]/.test(trimmed.slice(1))) {",
  },
  {
    label: "A turn with no output waits out the late timeline grace",
    path: "packages/server/src/server/agent/providers/acp-agent.ts",
    needle: "lateTimelineGraceMs",
  },
  {
    label: "An expired question is answered as a new prompt",
    path: "packages/server/src/server/agent/providers/acp-agent.ts",
    needle: "function buildLatePermissionAnswer(",
  },
  {
    label: "Goal pill opens a detail panel",
    path: "packages/app/src/composer/goal-pill.tsx",
    needle: "composer-goal-pill-panel",
  },
  {
    label: "A cleared goal is kept with its counters",
    path: "packages/server/src/server/agent/providers/kimi/session-log.ts",
    needle: "function clearGoal(",
  },
  {
    label: "A terminal goal is stamped with when it ended",
    path: "packages/server/src/server/agent/providers/kimi/session-log.ts",
    needle: "next = { ...next, endedAt: time };",
  },
  {
    label: "A session log tick reads at most one budget",
    path: "packages/server/src/server/agent/providers/kimi/session-log.ts",
    needle: "export const MAX_BYTES_PER_TICK = 512 * 1024;",
  },
  {
    label: "A long stretch of lines is parsed in chunks that yield",
    path: "packages/server/src/server/agent/providers/kimi/session-log.ts",
    needle: "yieldToEventLoop",
  },
  {
    label: "A goal carries the input tokens its steps read",
    path: "packages/server/src/server/agent/providers/kimi/session-log.ts",
    needle: "function stepInputUsage(",
  },
  {
    label: "Goal detail shows the input side",
    path: "packages/app/src/composer/goal-pill.tsx",
    needle: "export function formatGoalInputUsage(",
  },
  {
    label: "Terminal output is trimmed in one pass",
    path: "packages/server/src/server/agent/providers/acp-agent.ts",
    needle: "entry.outputBytes += Buffer.byteLength(chunk, \"utf8\");",
  },
  {
    label: "A custom Claude model gets its context window up front",
    path: "packages/server/src/server/agent/providers/claude/models.ts",
    needle: "export function resolveClaudeContextWindowMaxTokens(",
  },
  {
    label: "Claude settings env is read for that window",
    path: "packages/server/src/server/agent/providers/claude/models.ts",
    needle: "export function readClaudeSettingsEnvSync(",
  },
  {
    label: "A Claude session seeds the window it resolved",
    path: "packages/server/src/server/agent/providers/claude/agent.ts",
    needle: "private resolveContextWindowMaxTokens(modelId: string | null | undefined): number | undefined {",
  },
  {
    label: "Claude's own goal drives the composer pill",
    path: "packages/server/src/server/agent/providers/claude/agent.ts",
    needle: 'message.type !== "active_goal"',
  },
  {
    label: "A goal the Claude CLI set is read from the session transcript",
    path: "packages/server/src/server/agent/providers/claude/agent.ts",
    needle: "function readClaudeTranscriptGoalStatus(historyPath: string): ClaudeTranscriptGoalStatus | null {",
  },
  {
    label: "That goal is reported before the first evaluation",
    path: "packages/server/src/server/agent/providers/claude/agent.ts",
    needle: "private appendTranscriptGoalEvents(message: unknown, events: AgentStreamEvent[]): void {",
  },
  {
    label: "A Claude goal set is tested to reach the pill before the turn ends",
    path: "packages/server/src/server/agent/providers/claude/agent.test.ts",
    needle: 'test("a goal the CLI set is reported before the first evaluation", async () => {',
  },
  {
    label: "A Claude goal carries the tokens its responses reported",
    path: "packages/server/src/server/agent/providers/claude/agent.ts",
    needle: "this.accumulateGoalUsage(message.message.id, message.message.usage, events);",
  },
  {
    label: "A finished Claude turn advances its goal's turn count",
    path: "packages/server/src/server/agent/providers/claude/agent.ts",
    needle: "private countGoalTurn(events: AgentStreamEvent[]): void {",
  },
  {
    label: "Every Claude goal report goes through the tally",
    path: "packages/server/src/server/agent/providers/claude/agent.ts",
    needle: "private publishGoal(goal: AgentGoal | null, events: AgentStreamEvent[]): void {",
  },
  {
    label: "A running Claude goal is tested to report what it spent",
    path: "packages/server/src/server/agent/providers/claude/agent.test.ts",
    needle: 'test("a running goal reports the tokens it has spent so far", async () => {',
  },
  {
    label: "The goal panel words its counters per provider",
    path: "packages/app/src/composer/goal-pill.tsx",
    needle:
      "export function resolveGoalUsageHints(provider: AgentProvider | null | undefined): GoalUsageHints {",
  },
  {
    label: "A Claude goal is tested not to read as a Kimi one",
    path: "packages/app/src/composer/goal-pill.browser.test.tsx",
    needle: 'it("describes a Claude goal in Claude\'s terms, not Kimi\'s", () => {',
  },
  {
    label: "A Kimi turn the runtime has not ended counts as running",
    path: "packages/server/src/server/agent/providers/kimi/session-log.ts",
    needle: "isTurnInProgress(): boolean",
  },
  {
    label: "A steer request is dispatched as an interrupt for an agent that cannot steer",
    path: "packages/server/src/server/agent/agent-prompt.ts",
    needle: "capabilities?.supportsSteering === false",
  },
  {
    label: "The agent snapshot reports whether the agent can be steered",
    path: "packages/server/src/server/agent/agent-manager.ts",
    needle: "supportsSteering: session.steerActiveTurn !== undefined,",
  },
  {
    label: "Kimi background task record",
    path: "packages/server/src/server/agent/providers/kimi/session-log.ts",
    needle: "export interface KimiBackgroundTaskRecord {",
  },
  {
    label: "Kimi background tasks settle with the session log",
    path: "packages/server/src/server/agent/providers/kimi/session-log.ts",
    needle: 'updateBackgroundTask(backgroundTasks, entry, "completed");',
  },
  {
    label: "Kimi background tasks are published under their own id",
    path: "packages/server/src/server/agent/providers/kimi/session-log.ts",
    needle: "id: `background:${task.id}`,",
  },
  {
    label: "Kimi background tasks carry the 后台任务 caption",
    path: "packages/server/src/server/agent/providers/kimi/session-log.ts",
    needle: 'subtitle: "后台任务",',
  },
  {
    label: "A Kimi background task is not upserted a second time as a subagent",
    path: "packages/server/src/server/agent/providers/kimi/session-log.ts",
    needle: "if (subagent.runInBackground === true) continue;",
  },
  {
    label: "A Kimi background task's transcript and summary land on its own row",
    path: "packages/server/src/server/agent/providers/kimi/session-log.ts",
    needle: "function subagentRowId(",
  },
  {
    label: "A Claude goal counts each API response once",
    path: "packages/server/src/server/agent/providers/claude/agent.ts",
    needle: "function mergeGoalUsageTotals(",
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
