# Patches & Technical Specifications

This document describes all patches maintained and injected by this repository.

## The Android status bar patch

`scripts/apply-statusbar-patch.mjs` injects `react-native-edge-to-edge` into two files (idempotently — re-running is a no-op):

| File | Change |
|------|--------|
| `packages/app/app.config.js` | require the edge-to-edge expo plugin; add `edgeToEdge({ android: { parentTheme: "Default", enforceNavigationBarContrast: true } })` as the first plugin |
| `packages/app/src/app/_layout.tsx` | import `SystemBars`; render `<SystemBars style="auto" />` as the first child of `GestureHandlerRootView` |

If upstream moves one of the injection anchors, the script **exits non-zero and names the missing anchor**. That red build is the signal to update the anchor in the script (or to confirm upstream now handles the status bar itself, making the patch unnecessary).

---

## The desktop patch

`scripts/apply-desktop-patch.mjs <sourceDir> <mac|win>` applies `patches/paseo-kimi-native-0101.patch` — one series carrying everything the daemon needs to talk to Kimi Code directly, with no ACP proxy process in the path:

| Area | Change |
|---|---|
| ACP usage | map ACP's `usage_update` into a `usage_updated` agent event (fills the native context table) |
| ACP plan card | tag an ACP `ExitPlanMode` approval request as kind `plan` and carry the plan text in metadata, so the approval renders as the full-height plan card instead of a 200px scroll box |
| ACP compaction | accept the `_paseo.dev/session/compaction` extension notification and turn it into a compaction timeline marker. Kimi Code never sends it — its compaction is read from the session log and rendered as the same divider, written once when it finishes, and every narration Kimi sends as chat — the `/compact` reply, and the one-liners for a compaction it cancelled or refused because a turn was still running — is dropped so it does not sit next to the divider (see Kimi unstreamed turns) |
| ACP goal state | accept the `_paseo.dev/session/goal`, make a provider-reported goal first-class agent state, and carry it in the agent snapshot so any client sees it |
| ACP provider hooks | `ACPAgentSession` gains `providerHooks` — a prompt rewriter, an out-of-band hook for commands ACP does not model, and a turn gate that holds a turn open while the provider works (released by Stop, not only by its own timeout) |
| Kimi session log | the daemon tails the session's own `~/.kimi-code/sessions/*/<sid>/agents/main/wire.jsonl` for `goal.create` / `goal.update` / `goal.clear` and for the context the turn is using, taken per step from `usage.record` and `context.append_loop_event` `step.end`. The window size is not on the ACP wire at all (Kimi sends no `usage_update`), so it is read from `[models."<alias>"] max_context_size` in `~/.kimi-code/config.toml` and reported alongside the used count — the app draws no meter unless it has both |
| Kimi native bridge | per-session wrapper over that tailer, plus the settle wait the ACP turn hold awaits |
| Kimi subagents | the main log announces every subagent an `Agent` tool call spawns (`subagent.spawned` / `started` / `completed` / `cancelled`), and each one's own `agents/<id>/wire.jsonl` is tailed for its transcript. Both are projected into Paseo's own provider-subagent events, so the composer's subagent pill and its detail panel work for Kimi with no client change. Backed by the same incremental byte-range reads as the goal tailer, capped at the 8 most recent subagents |
| Kimi `/goal` | `/goal <objective>` is rewritten into a prompt that makes the agent create and pursue the goal itself; bare `/goal` and `/goal status` are answered out-of-band from the tailed log |
| Kimi goal pill | a native composer pill showing the live goal, its status and its usage. Tapping it opens a detail panel: the objective, the completion criterion, the turn count, and both token sides. Kimi reports only the output side (`goal.update.tokensUsed`), so the input side is summed by Paseo from each step's `usage.record` while the goal is live — `usageScope: "session"` records are running totals and are skipped, and `step.end` carries a copy of the same `usage`, so counting it too would double every step. The tally is a lifetime re-read count, not a billable one |
| Kimi reliability | Kimi ACP capability descriptors, log instead of silently dropping session/staged events, and flag Kimi turns that complete with no assistant output |
| Harness reminders | a user message that is nothing but a `<system-reminder>` envelope is dropped before it reaches the timeline. Kimi Code and Claude Code inject their own reminders this way (date changes, todo nudges, "the previous turn was interrupted"); Paseo already filtered its own `<paseo-system>` envelope but not this one, so every reminder rendered as a bubble the user appeared to have typed |
| Composer badges | strip the redundant "Thinking " prefix from option badges, and make composer pills shrinkable so long labels do not evict adjacent buttons |
| Windows console | route the daemon's `fork()` call sites through `forkProcess()` with `windowsHide`, so a forked worker cannot allocate a visible console window |
| Terminal output cap | trim an oversized terminal buffer in one byte pass instead of one character at a time. The old shape re-measured the whole string per deleted character, so a command whose output overshot the limit by 1 MB cost tens of seconds on the main thread and the daemon stopped answering |
| Claude context window | a model the manifest does not know — a gateway id behind `ANTHROPIC_BASE_URL`, say — gets no window until its first turn's result reports one, so the composer meter stayed empty for that entire turn. Resolve the window the way Claude Code itself does instead: the manifest first, else a `[1m]` id is 1M, else `CLAUDE_CODE_MAX_CONTEXT_TOKENS` from `settings.json` |
| Claude goal | Claude Code keeps a goal of its own (`/goal <condition>`, re-checked after every turn) and reports it on the same SDK message stream the daemon already reads. Map that frame into the goal state the Kimi side already produces, so the composer pill covers Claude sessions too. The frame's token counter is the ledger reading taken when the goal was set, not what the goal has spent, so the usage is summed from what each API response reports. One response is not one frame — the CLI writes a frame per content block, each carrying the same usage, and a gateway can echo a response — so responses are keyed by `message.id` and a repeat of one already counted is dropped rather than added again |
| Kimi unstreamed turns | Kimi Code streams a turn over ACP only while one of Paseo's `session/prompt` requests awaits its answer. Turns it runs on its own — background-task notifications, goal continuations, cron jobs, and a prompt it queued while busy (answered at once with `end_turn`) — exist only in its session log, so Paseo showed idle while Kimi worked and a queued prompt failed 30 s later with `kimi_timeline_missing`. The bridge now renders those turns from the log (`kimi/main-turn-renderer.ts`): a turn that starts while Paseo is idle opens a turn of its own, and one the ACP stream already delivered is left to the stream. Compaction is rendered the same way, as one settled row written when it finishes. A `/compact` never appears in that log as a prompt, so the compaction it ran is what keeps its turn from being reported as an unrun prompt |
| Kimi queued prompts | a prompt Kimi only queued holds its foreground turn until the prompt has actually run, instead of being judged empty after a fixed grace. It fails as `kimi_prompt_not_accepted` only if the runtime sits idle without ever starting it, and an interrupt during the held turn reports a cancellation rather than an empty turn |
| Kimi log polling | the session-log tailer polls the file once a second when idle, instead of every 10 s, so a turn Kimi starts on its own reaches the timeline within about a second. The old delay could outlast the empty-turn grace and lose the turn entirely. The tailer no longer uses a file watcher |
| Kimi send behavior | steering means injecting a message into the turn that is already running, which the ACP channel Kimi Code speaks cannot do — Kimi queues the prompt and runs it once the turn ends. A message sent during a turn Kimi started itself is therefore steered into that queue instead of interrupting the turn, and the session reports itself steerable. While a prompt of Paseo's own is still in flight the steer is held and sent once that turn ends, rather than replacing the turn: the runtime answers a second concurrent prompt with an error rather than queueing it, and replacing the turn would interrupt the work it is doing. A held message that cannot be sent is reported as an error entry in the timeline. Kimi 2.1.1 ignores `session/cancel` for a turn no ACP request started, so an interrupt could not have stopped it anyway. Stopping such a turn is confirmed at once, and while Kimi runs on the agent is shown running again until Kimi really finishes |
| Background task pill | a minimalist blue pill with terminal icon and count in the bottom-right composer toolbar, surfacing active Kimi background tasks as agent snapshot state without pinning the workspace status, clicking opens detail panel |

One series rather than a list because the pieces depend on each other: the session log tailer is what feeds the goal state, the goal pill is what reads it, and the prompt rewrite is what makes the goal exist in the first place. It is idempotent (re-runs are a no-op) and fails loudly on a missing anchor, naming the file to refresh. The Windows hunks are inert on macOS (`windowsHide` is a no-op there), so both platforms apply the same file and the marker list describes what a build must contain.

### Why the session log and not the daemon-hosted `kimi web` server
That server materializes a *separate, empty runtime* for a session owned by another process's `kimi acp` runtime — `GET /sessions/<id>/runtime` reports `acp:<id>` while `GET /sessions/<id>` returns zeroed usage. It therefore cannot see a goal the agent created, cannot create one the agent will run, and reports zeroed token counts. The append-only log is the only thing the two processes share. This was established by live measurement, not by reading the API surface.

### Shared hunks & `paseo-app-composer-badges.patch`
Superseded patch files live in `patches/archive/`.
`paseo-app-composer-badges.patch` stays in `patches/` because the Android status bar build (`apply-statusbar-patch.mjs`) applies it on its own — the combined desktop series carries the same change for the desktop builds.

---

[← Back to README](../README.md) | [CI Workflows & Architecture →](workflows.md)
