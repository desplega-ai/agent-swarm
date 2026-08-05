# script-builder

You are converting session intent into a durable, re-runnable script committed to the target project's `scripts/` directory. Two script classes share one principle — **only the derived answer re-enters context; raw payloads never do**:

- **Validation scripts** (`check-*`, `e2e-*`, `smoke-*`, …): a single PASS/FAIL line + `/tmp` log path on success, full verbose output redirected to a timestamped log file.
- **Gather/bulk scripts** (`gather-*`, `bulk-*`): replace N similar tool/API calls with one script that loops, filters, and aggregates *in code* — stdout is one compact summary block (JSON or table), raw responses go to the `/tmp` log. Rubric (from production code-mode data): past ~10 items or any fan-out over a list, a script beats individual tool calls by ~100x on context and roughly halves end-to-end cost. Offer the script *before* the fan-out happens when you can see it coming, not just retrospectively.

Both classes get an `<important if>` block in `CLAUDE.md`/`AGENTS.md` so future agents discover the script when the intent recurs — durable scripts are reusable agent memory: import, don't re-derive.

**Schema discovery happens in code, too**: when scripting against an unfamiliar API, grep/filter its OpenAPI spec or typed client programmatically to find the few relevant endpoints — never paste the full schema into context.

## Working Agreement

These instructions establish a working agreement between you and the user. The key principles are:

1. **AskUserQuestion is your primary communication tool** - Whenever you need to ask the user anything (clarifications, preferences, decisions, confirmations), use the **AskUserQuestion tool**. Don't output questions as plain text - always use the structured tool so the user can respond efficiently.

2. **Establish preferences upfront** - Ask about user preferences at the start of the workflow, not at the end when they may want to move on.

3. **Autonomy mode guides interaction level** - The user's chosen autonomy level determines how often you check in, but AskUserQuestion remains the mechanism for all questions.

## When to Use

This skill activates when:
- User invokes `/script-builder` command
- Another skill references `**OPTIONAL SUB-SKILL:** desplega:script-builder`
- A `planning`, `qa`, or `verifying` flow needs a re-runnable validation script that doesn't yet exist
- The user expresses intent to "turn X into a script", "wrap this validation into something reusable", or "I want to test X end-to-end" with no existing script

## Autonomy Mode

Adapt your behavior based on the autonomy mode:

| Mode | Behavior |
|------|----------|
| **Autopilot** | Detect mode, draft, syntax-check, document, and (if escalation tier) run + iterate without intermediate confirmations. Pause only at hard blockers or destructive side-effects. |
| **Critical** (Default) | Confirm at each tier boundary (after draft, before doc edit, before run). Use AskUserQuestion for fix application during iterate loop. |
| **Verbose** | Confirm before each step. Show every diff. Walk through detection reasoning out loud. |

The autonomy mode is passed by the invoking command. If not specified, default to **Critical**.

## Process Steps

### Step 1: Detect Mode (Retrospective vs Forward-Declared)

Decide silently — **do not** ask the user "which mode?". Use the following heuristics:

1. **Scan recent session tool-use history** (the last ~20 tool calls in the current conversation) for test/validation-shaped activity: `curl`/`fetch` calls, `bun run`/`python`/`pytest`, database queries, `qa-use` browser actions, repeated `grep`/log inspection of a single endpoint or table. If ≥2 such actions targeting the same area exist → **retrospective mode**. Separately, if the history (or the task ahead) shows the *same call shape repeated ~10+ times or a fan-out over a list* → **gather-script mode**: propose replacing the repetition with one `gather-*` script before continuing.
2. **Parse the user's invocation message** for cues:
   - Narrative cues → retrospective: *"we just figured out"*, *"turn this into a script"*, *"wrap that in"*, *"that thing we just did"*.
   - Intent cues → forward-declared: *"I want to test"*, *"validate that"*, *"smoke check"*, *"check before deploy"*.
3. **Fallback**: when ambiguous, default to **forward-declared**.

**Retrospective first action**: summarize the observed activity back to the user as plain text (≤6 lines: what was probed, against what, with what success signal), then go to Step 3 with a confirmation prompt instead of Q&A.

**Forward first action**: skip directly to Step 3's Q&A.

### Step 2: Scan Existing Scripts for Overlap

**Resolve the scripts directory** in this order:
1. Check `CLAUDE.md` for a `<!-- script-builder:dir=<path> -->` marker. If present, use that path.
2. If `scripts/` exists at the repo root, use it.
3. Use **AskUserQuestion** with options: `scripts/ (Recommended) | custom path | skip dir persistence for this run`.

**Edge case — directory absent**: if the resolved path doesn't exist, skip the dedup scan, print a one-line note (`No existing scripts directory at <path> — proceeding to intent gathering`), and remember to optionally offer to create the directory before Step 5.

**When the directory exists**:
1. List files in the scripts directory (top-level only for v1).
2. For each file, read the top of the file (header comment) and capture the file-name tokens.
3. Read `CLAUDE.md`/`AGENTS.md` for `<important if="...">` blocks that point at scripts in this directory and capture the trigger phrases.
4. Fuzzy-match the current intent string against (file-name tokens ∪ header keywords ∪ trigger phrases). A "plausible match" is shared keyword + same area noun (e.g., `auth`, `health`, `webhook`).
5. If ≥1 plausible match → use **AskUserQuestion** with options: `Reuse <name> as-is | Extend <name> | Generate new anyway`.

Never silently skip dedup on borderline matches — surface and let the user decide. The **Extend** branch appends a sub-command/flag to the existing script (do not create a new file); document the new flag in the script's header comment and the existing `<important if>` block.

### Step 3: Gather Intent

Both modes converge on the same internal intent structure: `{ what, success_signal, failure_signal, inputs, env, side_effects }`.

**Forward mode** — use **AskUserQuestion** (one or two questions, not five):

| Question | Options |
|----------|---------|
| "What are we validating, and what's the success signal?" | [Free text — collect what + success signal in one answer] |
| "Any required env vars, inputs, or side-effects to flag (e.g., writes to prod, costs money)?" | [Free text — optional; skip if forward intent already specified them] |

**Retrospective mode** — present the summary from Step 1 and use **AskUserQuestion** with: `That's the flow | Close but fix X | Start over`. On *Close but fix X*, ask for the correction inline; on *Start over*, fall through to forward-mode Q&A.

Persist the resolved intent in working memory (do not write to disk yet).

### Step 4: Detect Language

Priority order — first match wins, with override paths:

1. **TypeScript** — `package.json` + `tsconfig.json` exist.
   - **Bun** if `bun.lock` or `bunfig.toml` is present.
   - else **tsx** if `tsx` appears in `package.json` devDependencies.
   - else **compiled Node** (note in script header: requires `tsc` build).
2. **Python** — `pyproject.toml` or `uv.lock` or `requirements.txt` exists.
   - **uv** if `uv.lock` exists or `pyproject.toml` has `[tool.uv]` configured (sets `{{UV_METADATA}}`).
   - else **vanilla python3** (`{{UV_METADATA}}` substituted with empty string).
3. **Both TS and Python detected** — count source files in `src/`/top-level and ask **AskUserQuestion** tiebreaker with the dominant one Recommended.
4. `Cargo.toml` / `go.mod` only → fall back to **bash** (note: TS/Python/Bash only in v1).
5. Nothing matched → **bash**.

**Task-driven override**: if the gathered intent is clearly shell-y ("verify three docker containers respond", "tail this log file for an error"), propose **bash** even in a TS/Python project.

Confirm via **AskUserQuestion** with the detected language as the first option (Recommended). Skip in Autopilot.

### Step 5: Draft the Script

1. **Pick the template**: `templates/{typescript.ts.tmpl|python.py.tmpl|bash.sh.tmpl}`.
2. **Resolve substitution markers** from gathered intent:
   - `{{SCRIPT_NAME}}` ← proposed file-name stem (see naming table).
   - `{{WHAT}}` / `{{WHEN}}` / `{{ENV}}` / `{{EXAMPLE}}` ← intent fields.
   - `{{UV_METADATA}}` ← per Step 4.
3. **Generate `{{TEST_BODY}}`** from the intent. Keep it minimal: a single concrete probe + assertion, not a battery. Re-read the templates' README (`templates/README.md`) for the contract — the body must respect the PASS/FAIL surface. Throw/raise/`exit 1` on failure; let the template's outer try/trap convert it into the FAIL line.
   **Gather-class bodies** adapt the same template: the loop/aggregation replaces the probe, raw per-item responses go to the log only, and the final `console.log`/`print` emits one compact summary (JSON or aligned table) instead of the PASS line — exit non-zero only on operational failure (auth, network), not on "found problems" (problems ARE the output).
4. **Propose a file name** matching the intent shape — see the prefix table below. Use **AskUserQuestion** with the proposed name first (Recommended) and `custom name` as the alternative.

**Naming conventions** (advisory — skill proposes, user overrides):

| Prefix | When | Example |
|--------|------|---------|
| `e2e-*` | End-to-end flows across multiple components | `e2e-auth-flow.ts` |
| `check-*` | Idempotent single-probe verifications | `check-db-boundary.sh` |
| `smoke-*` | Minimal-viability post-deploy checks | `smoke-prod-api.ts` |
| `measure-*` | Performance / size / token measurements | `measure-tool-tokens.ts` |
| `seed-*` / `generate-*` | Data seeding or artifact generation (rare for validation) | `seed-api-keys.sh` |
| `gather-*` / `bulk-*` | Bulk data-gathering or bulk mutation replacing N tool calls; stdout = one summary block, not PASS/FAIL | `gather-workflow-health.ts` |

If the intent doesn't match any prefix cleanly, propose a free-form name like `validate-<area>.<ext>`.

5. **Write the file** to the resolved scripts directory. Make it executable (`chmod +x`).

### Step 6: Syntax/Type-Check

Run the appropriate checker:

| Language | Checker (in priority order) |
|----------|-----------------------------|
| TypeScript | `bunx tsc --noEmit <file>` if Bun present, else `npx tsc --noEmit <file>` |
| Python | `python3 -m py_compile <file>` (always) + `ruff check <file>` if `ruff` is on PATH |
| Bash | `shellcheck <file>` if available, else `bash -n <file>` |

**On success**: log a single line (`syntax check OK`) and proceed to Step 7.

**On failure**:
1. Print the error (≤10 lines, not the full output).
2. Propose a concrete one-edit fix (the exact `Edit` you'd apply).
3. Use **AskUserQuestion** with `Apply fix | Investigate | Stop`.
   - **Apply fix** → edit the script and re-run the checker (loop, no hardcoded cap).
   - **Investigate** → drop into discussion with the user; do not auto-apply anything.
   - **Stop** → leave script in place at its path; print the path; do not delete.

### Step 7: Document the Script

Auto-edit the target project's `CLAUDE.md` and/or `AGENTS.md` so future agents discover this script when the matching intent recurs.

**Block template** (the literal markdown the skill emits):

```markdown
<important if="[TRIGGER: e.g., you are testing the auth flow]">

## [Area] validation

Run `scripts/<name>` to [one-liner]. Requires [env/deps]. Example: `<cmd>`. Full log at `/tmp/<name>-*.log`.

Generated/maintained via `/script-builder`.

</important>
```

**Behavior**:

1. **Target file selection**: edit `CLAUDE.md` and `AGENTS.md` if both exist; edit only what exists. **Never** create either file from scratch — if neither exists, print a one-line note (`No CLAUDE.md or AGENTS.md found — script generated but not documented`) and skip this step.
2. **Placement heuristic**: search the file for the first heading matching `Test|Testing|Validation|Scripts` (case-insensitive). If found, append the new block within/after that section. Otherwise, append a new `## Scripts for testing & validation` section near the end of the file but **before** any heading matching `License|Acknowledg|Maintain|Contributors`.
3. **Idempotency**: if a block referencing `scripts/<name>` already exists (i.e., a prior `/script-builder` run for the same script name), update it in place — replace the entire `<important if=...>...</important>` block, do not append a duplicate.
4. **Scripts-dir marker**: if Step 2 resolved the scripts directory by user choice (not from an existing marker), insert `<!-- script-builder:dir=<path> -->` near the top of `CLAUDE.md` (after the title) so subsequent runs are silent. Skip if the marker already exists.
5. **Scale gate — `scripts/index.md`**: if the scripts directory holds **>10 documented scripts**, per-script `<important if>` blocks become their own context bloat. Generate/maintain a `scripts/index.md` hub instead (one line + link per script, mirroring the `runbooks/` convention from `desplega:engineering-standards`), collapse the CLAUDE.md/AGENTS.md blocks into ONE pointer block referencing the hub, and add new scripts to the hub only.
6. **Show the diff**: run the equivalent of `git diff CLAUDE.md AGENTS.md` and print a 5-line summary of what changed. **Never auto-stage** — the user commits.

### Step 8: Offer Escalation

After the doc edit, decide whether to proceed to the run-and-iterate tier.

| Autonomy | Behavior |
|----------|----------|
| **Autopilot** | Auto-escalate to Step 9 unless the intent flagged side-effects (writes to prod, sends real money, mutates a shared resource). On flagged side-effects, fall through to Critical behavior. |
| **Critical** (Default) | Use **AskUserQuestion**: `Run it now to confirm it works | I'll run it myself later | Just generate, don't run`. |
| **Verbose** | Same as Critical, plus offer the proposed run command for review before executing. |

If the user picks "I'll run it myself later" or "Just generate, don't run" → skip directly to Step 10.

### Step 9: Iterate on Failures (Escalated Tier Only)

A bounded-by-the-human loop. **Never auto-apply a fix** outside Autopilot.

1. **Run the script** with the proposed example invocation (no `--verbose`, no `--json`). Capture exit code and `tail -n 40` of the `/tmp` log.
2. **If exit code 0** → report PASS (echo the script's PASS line) and proceed to Step 10.
3. **If exit code non-zero**:
   - Summarize the failure in **1–3 lines**: error class (timeout / 4xx / 5xx / assertion / dependency-missing / etc.) + likely cause (grep the log for known signatures: `ECONNREFUSED`, `Traceback`, `non-zero exit`, `command not found`, etc.).
   - **Propose a concrete diff** — the exact `Edit` you would apply to the script. Show old → new.
   - Use **AskUserQuestion**: `Apply fix | Investigate differently | Stop`.
     - **Apply fix** → edit the script, log the change, loop back to (1).
     - **Investigate differently** → drop into discussion; do not auto-apply.
     - **Stop** → leave the script in place, print its path; do not revert.

**No hardcoded retry cap** — the human is the implicit bound.

**Side-effect flag**: if the intent declared side-effects (Step 3) and Autopilot is active, surface a one-line `WARNING: this script <does X> against <target>` before the first run and require explicit confirmation via **AskUserQuestion** even in Autopilot mode.

### Step 10: Handoff

How the skill exits depends on how it was invoked:

**Invoked as a sub-skill** (from `planning`, `qa`, `verifying`):
Return control to the parent skill with a structured summary: `{ script_path, status: "pass"|"fail"|"unrun", log_path?, doc_files_edited: [...] }`.

**Invoked directly** (`/script-builder`):
Use **AskUserQuestion**: `Run it with /qa | Run /verify-plan | Commit the script and doc changes | Done`.
- **Run with /qa** → invoke `desplega:qa` with the script path as the source.
- **Run /verify-plan** → invoke `desplega:verifying` if a plan path is in current context.
- **Commit** → propose a commit message (`feat(scripts): add scripts/<name> for <area> validation`) and stage only the generated script + the CLAUDE.md/AGENTS.md edits. Do not auto-commit; show the proposed `git add` and `git commit` commands and require user confirmation.
- **Done** → print the script path + log path (if escalation ran) and exit.

**Abort path** (Stop selected at any earlier gate): leave the generated script in place, leave any CLAUDE.md/AGENTS.md edit in place if Step 7 ran, and print a one-liner: `Aborted. Script: <path>. Doc edits: <files or "none">. Re-run /script-builder or git checkout to discard.` Do not `git restore` on the user's behalf.

## Learning Capture

**OPTIONAL SUB-SKILL:** If significant insights, patterns, gotchas, or decisions emerged during this workflow, consider using `desplega:learning` to capture them via `/learning capture`. Focus on learnings that would help someone else in a future session.
