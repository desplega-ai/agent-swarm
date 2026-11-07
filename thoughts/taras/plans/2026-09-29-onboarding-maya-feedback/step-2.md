---
id: step-2
name: AI billing chips, open-harness rename, dial copy
depends_on: []
status: ready
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-2: AI billing chips, open-harness rename, dial copy

## Overview

After this step, every AI Providers option says how it bills: "Uses your plan" or "Billed per token" (research J4). The open-harness card reads as two things: which harnesses, and which key they use. The Agents dial calls Optimal "our pick" without claiming a benchmark (J7).

File ownership (no other PR 1 step touches these): `apps/ui/src/pages/setup/steps/ai/*` and `apps/ui/src/pages/setup/steps/agents/agent-models.tsx`. Do not edit `page.tsx` (step 1 owns `STEP_COPY`).

## Changes Required:

#### 1. Billing chip per option
**Files**: `apps/ui/src/pages/setup/steps/ai/claude-card.tsx`, `codex-card.tsx`, `open-harness-card.tsx`, `devin-card.tsx` (and `provider-card.tsx` or `fields.tsx` only if a shared chip slot is cleaner)
**Changes**: Add a `SetupChip` (`apps/ui/src/components/onboarding/setup-card.tsx:25-37`) per credential option. Use `neutral` or `info`, never `done` (amber means progress in /setup).
- Claude "Setup token" tab: "Uses your Claude plan". Keep the existing "Recommended" chip.
- Claude "API key" tab: "Billed per token".
- Codex (device login): "Uses your ChatGPT plan".
- Open harnesses, every tab (OpenRouter, gateway, direct keys): "Billed per token".
- Devin: "Uses your Devin plan".

Check each claim against the credential code before you write it: `docs-site/content/docs/(documentation)/guides/harness-providers.mdx` (credential column per harness) and `src/providers/*`. If a claim is not true for a harness, drop the chip there and note it in the commit message.

#### 2. Open-harness card reads as harness + key
**File**: `apps/ui/src/pages/setup/steps/ai/open-harness-card.tsx`
**Changes**: Today: title "Open harnesses: opencode, pi, DeepSeek", subtitle "Model-agnostic harnesses. One OpenRouter key runs all three." (`:71-133`). Change it so harness names and the key are separate facts, for example:
- Title: "opencode, pi, and DeepSeek"
- Subtitle: "Harnesses that run any model. They bill per token through one OpenRouter key or your own gateway."
Keep `DeepSeek` naming consistent with the dsh label fix on main (`e6665039b`). Keep the card id `open` and all env keys unchanged.

#### 3. Dial copy
**File**: `apps/ui/src/pages/setup/steps/agents/agent-models.tsx`
**Changes**: Update `LEVEL_BLURB` (`:57-61` at `d317add09`):
- cheap: "Lowest cost. Fine for routine work." (keep)
- optimal: "Our pick. The best quality for the cost."
- max: "The strongest models. Rarely worth the extra cost."
Add one `InfoTip` next to the level tiles header. Since #1691 the levels are model tiers (cheap → `regular`, optimal → `smart`, max → `ultra`) resolved from the live model catalog (`apps/ui/src/lib/model-dial.ts`, `GET /api/models-catalog/tiers`, `runbooks/model-tiers.md`). The tip must say that, for example: "Each level maps to a model tier. Your swarm's tier settings pick the model. Newer or pricier is not always better." Do not claim benchmarks, and do not name fixed models in the copy: an operator can change the tiers.

### Success Criteria:

#### Automated Verification:
- [ ] UI gates pass: `cd apps/ui && bun run lint && bunx tsc -b && bun run check:tokens`
- [ ] Every card has a billing chip: `grep -l "Billed per token\|Uses your" apps/ui/src/pages/setup/steps/ai/*.tsx | wc -l` prints `4` or more
- [ ] No amber chip for billing: `grep -n 'tone="done"' apps/ui/src/pages/setup/steps/ai/*.tsx` shows no billing chip
- [ ] No benchmark claim: `grep -rn -i "benchmark\|we tested" apps/ui/src/pages/setup/steps/agents/` prints nothing
- [ ] No em dashes added: `git diff -U0 -- apps/ui | grep '^+' | grep -c "$(printf '\342\200\224')"` prints `0`

#### Automated QA:
Use the QA environment in `root.md`.
- [ ] Open AI Providers, expand each card and each tab, and screenshot each: `/tmp/onb-plan-qa/step2-claude.png`, `step2-codex.png`, `step2-open.png`, `step2-devin.png`. Each shows its billing chip.
- [ ] The open-harness card title and subtitle show harness names and the key as separate facts.
- [ ] Agents step (with at least one dial-eligible agent, or the empty state): the Optimal tile shows "Our pick" and the InfoTip opens. Screenshot `/tmp/onb-plan-qa/step2-dial.png`.
- [ ] Phone width (390 px): chips wrap cleanly next to titles. Screenshot `/tmp/onb-plan-qa/step2-phone.png`.

#### Manual Verification:
- [ ] Taras approves the chip wording and the dial copy.

**Implementation Note**: Commit only `apps/ui/src/pages/setup/steps/ai/*` and `apps/ui/src/pages/setup/steps/agents/agent-models.tsx` as `[step-2] AI billing chips, open-harness copy, dial copy`.
