# desloppify — Code-Health Scan Workflow (Swarm Edition)

`desloppify` is a multi-language codebase health scanner (peteromallet/desloppify). This skill covers the install recipe, the scan → status → next → triage workflow, and the publish-to-agent-fs step.

> **Default mode for swarm workers: surface-only.** Run Phase 1 + early Phase 2, publish a memo to agent-fs, stop. Do **not** run Phase 3 (queue-grinding refactors) unless the task explicitly asks.

## When to Use This Skill

- A task asks you to run desloppify, do a code-health scan, get a health score, or surface debt themes on a repo.
- You need to triage tech debt on a TS / Python / multi-lang repo.

## Step 1 — Detect

```bash
command -v desloppify >/dev/null 2>&1 && desloppify --version || echo "NOT INSTALLED"
# Also verify the tree-sitter pin:
pipx runpip desloppify show tree-sitter-language-pack | grep Version
# Expect: Version < 1.8
```

## Step 2 — Install (First Run Only)

```bash
pipx install 'desloppify[full]==0.9.15'
pipx inject --force desloppify 'tree-sitter-language-pack<1.8'
# Verify:
pipx runpip desloppify show tree-sitter-language-pack | grep Version
# → must show 1.6.2 (or another <1.8)
```

**Why the pin:** `tree-sitter-language-pack` 1.8.0 has an ABI mismatch that crashes desloppify in `cohesion.py:52`. Upstream fix is open but unmerged. Cap at `<1.8`.

## Step 3 — Re-pin (Installed but Broken)

```bash
pipx inject --force desloppify 'tree-sitter-language-pack<1.8'
# The --force is required — without it pipx refuses to downgrade.
```

## Step 4 — Scan

```bash
# Single-program repo:
desloppify scan --path .

# Monorepo (scan each program separately):
desloppify --lang typescript scan --path ./frontend
desloppify --lang python      scan --path ./backend
```

## Step 5 — Status + Next + Triage

```bash
desloppify status                          # overall / strict / objective / verified scores
desloppify next --count 15                 # top-priority execution items
desloppify show --status open --count 50   # broader open backlog
```

What to capture for the memo:
- **Status snapshot** — overall, strict, objective, verified scores
- **Item counts by detector** — test_coverage, smells, duplication, security, orphaned
- **Top 10–15 findings** from `next` — identifier · kind · severity · the one-line "why"
- **Themes** (2–4 bullets) — what jumps out across findings
- **Phase 3 candidates** (2–3) — what you'd nominate to actually grind, if asked
- **False positives** — anything desloppify flagged that's intentional in the swarm context

## Step 6 — Publish Findings to agent-fs

```bash
DATE=$(date +%Y-%m-%d)
agent-fs --org 648a5f3c-35c8-4f11-8673-b89de52cd6bd write \
  thoughts/$AGENT_ID/research/$DATE-desloppify-<repo>-scan.md \
  --content "..." -m "desloppify scan memo for <repo>"
```

## Step 7 — Slack Reply

Single concise reply on the originating thread. Include:
- ✅/❌ + scan exit + duration
- Status snapshot (overall / strict / objective / dimension health)
- Top themes (2–4 bullets)
- Phase 3 candidates (2–3)
- agent-fs path to the full memo
- False positives flagged

Slack block limit is 3000 chars per message — split into Part 1 / Part 2 if needed.

## Sprite Escape Hatch

If local pipx is broken, spin a fresh sprite:

```bash
sprite create desloppify-scan
sprite exec -s desloppify-scan -- bash -c '
  set -e
  sudo apt-get update -qq && sudo apt-get install -y pipx python3-venv git
  pipx ensurepath
  export PATH="$HOME/.local/bin:$PATH"
  pipx install "desloppify[full]==0.9.15"
  pipx inject --force desloppify "tree-sitter-language-pack<1.8"
  git clone --depth=1 https://github.com/desplega-ai/<repo>.git /tmp/repo
  cd /tmp/repo && desloppify scan --path . && desloppify status && desloppify next --count 15
'
sprite destroy desloppify-scan --force
```

## Stop Conditions

- If desloppify crashes despite a verified `<1.8` pin → STOP, escalate.
- If the scan produces 0 findings → suspect a `--path` problem. Re-scan with explicit per-program paths.
- If asked to "fix the findings" → that's Phase 3. Confirm scope before doing it.

## Trade-offs

**Surface-only vs Phase 3:** Surface scans (this skill) identify debt without changing code. Phase 3 (queue-grinding refactors) actually modifies files — it's a separate task that requires explicit scope confirmation. The default is surface-only because Phase 3 is irreversible.

**Speed vs accuracy:** desloppify flags heuristic detectors (smells, orphaned, duplication). Some findings are false positives in the swarm context (CLI entrypoints, deferred-registration MCP tools). Always annotate false positives in the memo.
