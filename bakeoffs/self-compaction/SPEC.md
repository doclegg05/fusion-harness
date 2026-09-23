# Self compaction

## Problem

Long-running autonomous agents run out of context.

A long context lowers output quality (context rot) and costs more on every call with frontier models.

These agents do long-running, autonomous work with no human in the loop. Nobody is there to run `/compact` at the right moment, so the agent has to do it itself.

## Solution

Build a standalone Pi coding agent extension with these features:

1. 'self_compact' (note-to-self) - the agent writes a handoff note and compacts itself.
2. 'Context control' - three thresholds (soft notice, warning, forced compaction), each set by a CLI flag.
3. 'Pi UI' - a context bar that shows usage and all three thresholds.
4. 'Prompt engineering' - editable prompt files for the soft notice, the warning, and the compaction summary.
5. 'HIL commands' - slash commands to inspect thresholds and to force a compaction by hand.

## Variables

- `ARENA_ROOT`: `/Users/brittlegg/MacDev/companies/legg-ai-ops/fusion-harness/bakeoffs/self-compaction/`
- `CONTESTANT`: your model or agent name, lowercase with hyphens (for example `claude-opus-5-5`, `codex-gpt-5`, `pi-<model>`).
- `AI_DOCS_DIR`: `<ARENA_ROOT>/ai_docs/`. Read-only. Contains Pi's own docs and examples.
- `PLAN_DIR`: `<ARENA_ROOT>/specs/<CONTESTANT>/`. Your plan goes here.
- `WORKING_DIR`: `<ARENA_ROOT>/apps/<CONTESTANT>/`. All code, tests, and verification artifacts go here.

## Implementation notes

- Target Pi 0.85.1 (`pi --version`). Package: `@earendil-works/pi-coding-agent`.
- Read first: `AI_DOCS_DIR/docs/extensions.md`, `AI_DOCS_DIR/docs/compaction.md`, `AI_DOCS_DIR/examples/extensions/trigger-compact.ts`, `AI_DOCS_DIR/examples/extensions/custom-compaction.ts`.
- Pi APIs this spec relies on, all documented in `extensions.md`:
  - `ctx.getContextUsage()` for token usage.
  - `ctx.compact({ customInstructions, replaceInstructions, onComplete, onError })` to run compaction.
  - `pi.registerFlag()` for the `--compact-*` flags.
  - `pi.registerCommand()` for the slash commands.
  - `ctx.ui.setStatus()` / `ctx.ui.setWidget()` for the context bar.
  - `pi.sendUserMessage()` to resume work after compaction.
  - The `session_before_compact`, `session_compact`, and `session_compact_failed` events.
  - The `agent_settled` event, which fires when Pi will not continue on its own. Use it to detect idle.
- The extension must not depend on any other extension. Small helper modules inside `WORKING_DIR/extensions/self-compact/` are fine.
- Test with low thresholds first (for example `--compact-soft-at 5k`). Confirm the full cycle works before you test the defaults.

## Workflow

1. **Plan.** Write an implementation plan from this spec and `AI_DOCS_DIR`. Save it as `PLAN_DIR/plan.md` before writing any implementation code.
   - Claude: use the `superpowers:writing-plans` skill.
   - Every other agent: the plan must list (a) every file you will create, with its path, (b) ordered tasks small enough to finish and check one at a time, and (c) for each Definition of Done item, the exact command or observation that proves it.
2. **Build.** Implement the plan inside `WORKING_DIR`, task by task, in plan order. Do not start building until the plan file exists.
3. **Verify.** Check every Definition of Done item using the proof your plan named. Fix failures and rerun the affected checks. Save verification output inside `WORKING_DIR/verification/`. Report actual results, including anything still failing.

## Deliverables

- `PLAN_DIR/plan.md`
- `WORKING_DIR/extensions/self-compact/self-compact.ts` and any helper modules beside it.
- `WORKING_DIR/.pi/self-compact/USER_PROMPT_SOFT_SELF_COMPACT.md`
- `WORKING_DIR/.pi/self-compact/USER_PROMPT_WARNING_SELF_COMPACT.md`
- `WORKING_DIR/.pi/self-compact/USER_PROMPT_COMPACTION_MESSAGE.md`
- Automated tests for threshold parsing, the context bar, and note validation.
- `WORKING_DIR/verification/` with one output file per Definition of Done section.
- `WORKING_DIR/REPORT.md`: what passed, what failed, what is blocked, and why.

## Definition of done

### Workflow completed

- The plan exists in `PLAN_DIR/plan.md` and was written before implementation.
- The build followed the plan's task order.
- `pi -e "$WORKING_DIR/extensions/self-compact/self-compact.ts"` loads the extension on its own, with `--no-extensions` also set.

### Self-compact tool

- The handoff note carries real work across a compaction.
  - `self_compact({ note_to_self: "..." })` rejects a blank note and a note over 24,000 characters. It saves a valid note and ends the current run cleanly.
  - After a valid call, the extension waits until the agent is idle, compacts, returns the note verbatim as the next message, restores tools, and continues without a user message.
  - Check: give the agent a task whose saved next action is "write `WORKING_DIR/result.txt` containing `done`". Expected: after continuation, that file exists with exactly `done`. A completed task does not restart.
  - A failed or cancelled compaction keeps the note and keeps other tools blocked until a compaction succeeds. The note survives a retry and a `/reload`.

### Context bar

- The context bar shows usage and all thresholds.
  - The bar has 20 cells. Each cell is 5% of the model's context window.
  - Filled cells show `#` for cached tokens and `=` for uncached tokens. Empty cells show `-`.
  - Threshold markers replace the glyph in the cell where each threshold falls: `~` soft, `!` warning, `|` forced.
  - Check: with thresholds at 20% / 50% / 60% and 40% usage, half of it cached. Expected: `[###~====-!-|--------] 40%`.
  - Check: launch variant 2 on a 1,000,000-token model. Expected: markers at 10% / 20% / 25%.
  - Check: `--compact-buffer 0`. Expected: `|` shows where the warning and forced thresholds overlap.

### Prompt files

- Each prompt file exists and does its job.
  - `USER_PROMPT_SOFT_SELF_COMPACT.md`: optional, editable heads-up with live usage values. Sent when usage crosses `--compact-soft-at`.
  - `USER_PROMPT_WARNING_SELF_COMPACT.md`: firmer message ("write your note and compact now, tools lock at <forced threshold>"). Sent when usage crosses `--compact-at`.
  - `USER_PROMPT_COMPACTION_MESSAGE.md`: replaces Pi's default compaction summary prompt. `--compact-prompt` overrides it.

### Thresholds

- All four flags work.
  - `--compact-soft-at 20%`: optional heads-up. All tools stay available.
  - `--compact-at 50%`: tells the agent to write its note and compact. Ordinary tools stay available.
  - `--compact-buffer 10%`: allows 10 more percentage points of the window, then blocks every tool except `self_compact` at 60%. `0` blocks immediately at the warning threshold.
  - `--compact-prompt "..."`: replaces the summary system prompt with this literal text. It is independent of the saved note and the prompt files.
- Values accept whole token counts, `k`/`m` suffixes, or percentages.
- The forced threshold (warning + buffer) is capped at 90% of the window. Invalid values are rejected with an error that names the flag.
- Defaults: soft 225k, warning 250k, buffer 20k (forced 270k).
  - On a model with a window under 300k, the default forced threshold (270k) exceeds the 90% cap. The extension rejects this at launch with an error that names the window size and tells the user to set the flags explicitly. It never adjusts thresholds on its own.
  - Check: launch with defaults on a model with a window under 300k. Expected: launch fails with that error.

### Launch commands

- Each launch variant produces the expected thresholds, confirmed with `/self-compact-info`.
  - `pi -e "$WORKING_DIR/extensions/self-compact/self-compact.ts"`
    - Expected: soft 225k, warning 250k, forced 270k. `/self-compact-info` shows each threshold as tokens and as a percentage of the window.
  - `pi -e "$WORKING_DIR/extensions/self-compact/self-compact.ts" --compact-soft-at 100k --compact-at 200k --compact-buffer 50k`
    - Expected: soft 100,000 tokens, warning 200,000, forced 250,000. Needs a model with a window of at least 300,000 tokens.
  - `pi -e "$WORKING_DIR/extensions/self-compact/self-compact.ts" --compact-soft-at 20% --compact-at 50% --compact-buffer 0 --compact-prompt "Summarize the current goal, completed work, exact paths, test results, and next action. Do not invent completed work."`
    - Expected: soft at 20%, forced at 50%, and the supplied summary prompt used. The saved note arrives separately after compaction succeeds.

### HIL commands

- The slash commands work.
  - `/self-compact-info`: shows settings, resolved thresholds, usage, state, cycle count, prompt sources, and any pending note or error. Does not start an LLM turn.
  - `/self-compact-now`: tells the agent to write its note and call `self_compact`. On retry, it reuses the saved note instead of asking for a new one or bypassing the tool.
  - `/compact`: Pi's built-in manual compaction still works outside the note workflow and uses the configured summary prompt.

## How you're graded

- Each completed Definition of Done bullet earns credit. Partial work earns partial credit.
- Every Workflow step must be completed: plan, build, verify.
- Instant failure: writing any file outside `WORKING_DIR`, except your plan in `PLAN_DIR`.
- Instant failure: reading any file under `<ARENA_ROOT>/specs/` other than your own plan.
- Instant failure: reading any file under `<ARENA_ROOT>/apps/` other than your own `WORKING_DIR`.
