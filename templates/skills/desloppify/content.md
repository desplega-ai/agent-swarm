# desloppify — Code-health scan workflow (swarm edition)

`desloppify` is a multi-language codebase health scanner (peteromallet/desloppify). This skill is the swarm-adapted SKILL.md: it codifies the **install recipe with the tree-sitter pin**, the surface-only **scan → status → next → triage** workflow for code-health scans, and the **publish-to-agent-fs** step so humans can see the findings.

> **Default mode for swarm workers: surface-only.** Run Phase 1 + early Phase 2, publish a memo to agent-fs, stop. Do **not** run Phase 3 (queue-grinding refactors) unless the task explicitly asks.

## When to use this skill

- A task asks you to run desloppify, do a code-health scan, get a health score, or surface debt themes on a repo.
- A task references `peteromallet/desloppify` or the upstream `docs/SKILL.md`.
- You need to triage tech debt on a TS / Python / multi-lang repo.

If the task is "fix this one bug" or "rename X" → not this skill. Desloppify is for batch debt-surfacing, not point fixes.

## Step 1 — Detect

```bash
command -v desloppify >/dev/null 2>&1 && desloppify --version || echo "NOT INSTALLED"
```

If `--version` prints cleanly, **also verify the tree-sitter pin** (a busted pin is worse than no install — the scan crashes mid-run):

```bash
pipx runpip desloppify show tree-sitter-language-pack | grep Version
# Expect: Version: 1.6.2 (or anything < 1.8)
# If 1.8.x → see Step 3 (re-pin).
```

## Step 2 — Install (first run only)

Use `pipx`. This keeps the scanner isolated from the project environment:

```bash
pipx install 'desloppify[full]==0.9.15'
pipx inject --force desloppify 'tree-sitter-language-pack<1.8'

# Verify the pin landed:
pipx runpip desloppify show tree-sitter-language-pack | grep Version
# → must show 1.6.2 (or another <1.8)
```

**Why the pin:** some `tree-sitter-language-pack` 1.8.x builds have ABI mismatches with `tree-sitter` that crash scans during language extraction. Until the installed scanner version is known to work with newer language-pack releases, cap it below 1.8.

If `pipx` isn't installed: `python3 -m pip install --user pipx && python3 -m pipx ensurepath` and start a new shell. If `pipx install` fails with build errors, jump to **Sprite escape hatch** below.

## Step 3 — Re-pin (installed but broken)

If desloppify is on PATH but `tree-sitter-language-pack` is ≥ 1.8, you do **not** need a full reinstall:

```bash
pipx inject --force desloppify 'tree-sitter-language-pack<1.8'
pipx runpip desloppify show tree-sitter-language-pack | grep Version
```

The `--force` is required — without it pipx refuses to downgrade. Confirm the version drops, then scan.

## Step 4 — Scan

Clone or `cd` into the target repo. For TS repos you usually don't need `node_modules` for the scan, but if a finding requires resolving imports, run `bun install` (or `npm install`) first.

**Monorepo note:** if the repo has multiple programs in sibling folders (e.g. `frontend/`, `backend/`), scan each separately — never scan the parent:

```bash
desloppify --lang typescript scan --path ./frontend
desloppify --lang python      scan --path ./backend
```

Single-program repo:

```bash
desloppify scan --path .
```

Capture **exit code**, **duration**, and any warnings. A clean run is exit 0 with no traceback. Typical scan time: 30–90s for ~200K LOC.

## Step 5 — Status + next + triage

```bash
desloppify status                          # overall / strict / objective / verified scores + dimension health
desloppify next --count 15                 # top-priority execution items (cluster-aware)
desloppify show --status open --count 50   # broader open backlog if you want to slice manually
```

What to capture for the memo:

- **Status snapshot** — overall, strict, objective, verified scores. Note if subjective is at 0% (unassessed) — that means the strict number is a measurement artifact, not a reflection of reality.
- **Item counts by detector** — `desloppify status` shows this. Look for which detectors dominate (test_coverage, smells, duplication, security, orphaned, …).
- **Top 10–15 findings** from `next` — identifier · kind · severity · the one-line "why".
- **Your themes** (2–4 bullets) — what jumps out across the findings. E.g. "godfile in src/be/db.ts", "MCP-tool boilerplate dup cluster", "UI mega-pages with 20+ hooks". Use your own read, not `desloppify plan triage --complete`.
- **Phase 3 candidates** (2–3) — what you'd nominate to actually grind, if asked.
- **False positives** — anything desloppify flagged that's actually intentional in the swarm context (CLI entrypoints, deferred-registration MCP tools, dynamically loaded plugins, sanity fixtures, etc.).

**Do not** run `desloppify plan triage --complete`, `desloppify plan commit-log record`, or any Phase 3 commands in surface-only mode. Those mutate desloppify's local state and create commitments we don't intend to follow through on.

## Step 6 — Publish findings to agent-fs

Save the scan memo somewhere durable so operators can review it. If your deployment uses agent-fs, write it under your own agent namespace:

```bash
DATE=$(date +%Y-%m-%d)
agent-fs --org <org-id> write \
  thoughts/$AGENT_ID/research/$DATE-desloppify-<repo>-scan.md \
  --content "$(cat <<'EOF'
# desloppify scan — <repo> @ <SHA>

## Install + scan
- recipe: pipx install desloppify[full]==0.9.15 + tree-sitter pin
- exit: 0 / duration: 47s / 919 files / 210K LOC

## Status
overall <N>/100 · strict <N>/100 · objective <N>/100 · verified <N>/100
dimension health: File X% · Code Y% · Dup Z% · Security S% · Test T%

## Top 10–15 findings
- src/be/db.ts · godfile · T1 · 9441 LOC / complexity 457 / 48 issues
- ...

## Themes
1. ...
2. ...

## Phase 3 candidates
1. Split src/be/db.ts by domain
2. ...

## False positives (don't act on)
- src/cli.tsx (CLI entrypoint)
- ...
EOF
)" -m "desloppify scan memo for <repo>"
```

Also drop a private copy at `/workspace/personal/memory/desloppify-<repo>-scan-$DATE.md` so it's indexed for future memory-search.

## Step 7 — Slack reply (if the task came from Slack)

Single concise reply on the originating thread (use `slack-reply` with your taskId). Include:

- ✅/❌ + scan exit + duration
- Status snapshot (overall / strict / objective / dimension health)
- Top themes (2–4 bullets)
- Phase 3 candidates (2–3)
- agent-fs path to the full memo
- False positives flagged

**Slack block limit is 3000 chars per message.** If your reply trips `invalid_blocks`, split into Part 1 / Part 2. Don't try to cram everything into one message — readability > brevity.

## Sprite escape hatch — when local pipx is broken

If `pipx install` fails (system-package conflicts, missing build deps, weird Python ABI), or your worker container's desloppify install is corrupt and re-pinning doesn't help, **spin a fresh sprite** instead of fighting the local env. See the `sprite-cli` skill for full details.

```bash
sprite create desloppify-scan
sprite exec -s desloppify-scan -- bash -c '
  set -e
  sudo apt-get update -qq
  sudo apt-get install -y pipx python3-venv git
  pipx ensurepath
  export PATH="$HOME/.local/bin:$PATH"
  pipx install "desloppify[full]==0.9.15"
  pipx inject --force desloppify "tree-sitter-language-pack<1.8"
  pipx runpip desloppify show tree-sitter-language-pack | grep Version
  git clone --depth=1 https://github.com/<owner>/<repo>.git /tmp/repo
  cd /tmp/repo
  desloppify scan --path .
  desloppify status
  desloppify next --count 15
'
# … capture output, then:
sprite destroy desloppify-scan --force
```

**Always destroy the sprite when done.** Sprites are paid resources.

## Stop conditions

- If desloppify crashes despite a verified `<1.8` pin → STOP, paste the traceback, escalate. Don't bisect tree-sitter versions further.
- If the scan produces 0 findings → suspect a `--path` problem (you may be scanning a parent dir of a monorepo). Re-scan with explicit per-program paths.
- If the worker is asked to "fix the findings" → that's Phase 3. Confirm scope with the requester before doing it — Phase 3 is queue-grinding refactors and we historically do *not* default to it.

## Quick reference (cheat sheet)

```bash
# Detect + install (idempotent)
command -v desloppify || { pipx install 'desloppify[full]==0.9.15' && pipx inject --force desloppify 'tree-sitter-language-pack<1.8'; }
pipx runpip desloppify show tree-sitter-language-pack | grep Version  # must be <1.8

# Surface workflow
desloppify scan --path .
desloppify status
desloppify next --count 15

# Publish + report
agent-fs --org <org-id> write thoughts/$AGENT_ID/research/$(date +%F)-desloppify-<repo>-scan.md --content "..." -m "scan memo"
# slack-reply on the originating thread
```

## Upstream reference

Full Phase 3 / review workflow / plan commands are in the upstream SKILL.md: <https://github.com/peteromallet/desloppify/blob/main/docs/SKILL.md>. Reach for it when you're explicitly asked to grind the queue (rare). Default swarm mode stops after the memo + Slack reply.
