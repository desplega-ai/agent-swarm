---
id: step-3
name: "Trust cues: secret preview, telemetry note"
depends_on: []
status: ready
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-3: Trust cues: secret preview, telemetry note

## Overview

After this step, a pasted secret shows its first 4 and last 4 characters plus its length before it saves, so the user sees the paste worked (research J11). The Connect step says the swarm sends anonymous usage stats and how to turn them off (J13).

File ownership (no other PR 1 step touches these): `apps/ui/src/components/onboarding/autosave-secret-field.tsx`, `apps/ui/src/pages/setup/steps/step-connect.tsx`.

## Changes Required:

#### 1. Pre-save secret preview
**File**: `apps/ui/src/components/onboarding/autosave-secret-field.tsx`
**Changes**: While `draft` (`:162-171`) is non-empty and the input is masked, render one muted monospace line under the input: first 4 characters, a mask, last 4 characters, and the length. Example: `sk-a••••wxyz · 108 chars`.
- Show it only for values of 12 or more characters. Shorter values show only the length.
- Hide it when the eye toggle reveals the value, and when the field shows the saved state (`:218-243`).
- Never render anything derived from a saved secret: the API does not return it (dashboard-ui rule).
- The line sits beside the existing `KEY_RULES` hint (`:38-68`) and must not replace it.
- Only /setup uses this component (`setup-field.tsx`, `ai/fields.tsx`), so no other page changes.

#### 2. Telemetry note on Connect
**File**: `apps/ui/src/pages/setup/steps/step-connect.tsx`
**Changes**: Add one muted line under the connect form and under the connected summary: "Sends anonymous usage stats." with an `InfoTip`: "Set ANONYMIZED_TELEMETRY=false on the API server to turn them off." Link "Learn more" to the telemetry docs page (source `docs-site/content/docs/(documentation)/reference/telemetry.mdx`; confirm the public URL on docs.agent-swarm.dev). External link, new tab. Since #1780 the envelope also carries the org name, the admin email domain, and a hashed user ref (`src/telemetry-context.ts`). Match the wording to what `telemetry.mdx` says: if "anonymous" overstates it, use "usage stats with no personal data" or the docs' own phrase.

### Success Criteria:

#### Automated Verification:
- [ ] UI gates pass: `cd apps/ui && bun run lint && bunx tsc -b && bun run check:tokens`
- [ ] Preview reads only the draft: `grep -n "slice(0, 4)\|slice(-4)" apps/ui/src/components/onboarding/autosave-secret-field.tsx` shows code that reads `draft` or `value`, never a saved value
- [ ] Telemetry copy present: `grep -c "anonymous usage stats" apps/ui/src/pages/setup/steps/step-connect.tsx` prints `1` or more
- [ ] No em dashes added: `git diff -U0 -- apps/ui | grep '^+' | grep -c "$(printf '\342\200\224')"` prints `0`

#### Automated QA:
Use the QA environment in `root.md`.
- [ ] On AI Providers, type a fake OpenRouter key into the field without blurring: `agent-browser fill @<ref> "sk-or-v1-$(printf 'a%.0s' {1..64})"`. The preview line shows `sk-o••••aaaa · 73 chars`. Screenshot `/tmp/onb-plan-qa/step3-preview.png`.
- [ ] The eye toggle hides the preview line. Clearing the field removes it.
- [ ] After a successful save, the saved state shows the 12-dot mask and no preview line.
- [ ] Connect step (open `/setup?step=1`) shows the telemetry line, the tooltip opens, and "Learn more" has `target="_blank"`. Screenshot `/tmp/onb-plan-qa/step3-connect.png`.

#### Manual Verification:
- [ ] None beyond the PR 1 gate review.

**Implementation Note**: Commit only the two owned files as `[step-3] secret paste preview and telemetry note`.
