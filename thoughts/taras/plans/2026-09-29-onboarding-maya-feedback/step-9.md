---
id: step-9
name: Welcome pre-step
depends_on: [step-4]
status: ready
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-9: Welcome pre-step

## Overview

After this step, a first-time visitor to /setup sees a welcome screen before Connect: what they get when setup is done (research J6). It is a pre-step outside the numbered stepper. It shows before any API connection exists, so the API cannot track it: a browser-local flag does.

## Changes Required:

#### 1. When the welcome shows
**File**: `apps/ui/src/pages/setup/page.tsx` (the step-routing part near `:245-248`, where unconfigured visits force `connect`)
**Changes**: Show the welcome when localStorage key `agent-swarm-setup-welcome-seen` is unset AND (no connection is configured OR no onboarding step is `done`). `?intro=1` forces it. "Get started" sets the key and goes to Connect. Follow the localStorage pattern in `apps/ui/src/hooks/use-theme.ts:42-58`.
- The stepper and the "Step N of M" label hide on the welcome screen. Numbering starts at Connect.
- Enter triggers "Get started" through the existing setup shortcut rules (`setup-footer.tsx:165-187`).
- Only edit the routing lines in `page.tsx`. Steps 5 and 8 edit `STEP_COPY` and other parts of the same file: re-read before each edit.

#### 2. Welcome screen
**File**: `apps/ui/src/pages/setup/steps/step-welcome.tsx` (new)
**Changes**:
- Headline: "Your AI team, set up in a few minutes"
- Three static panels built from existing components (`AgentAvatar`, `StatusIcon`, cards, no screenshots, no raw palette):
  1. "A lead that plans and delegates": the lead avatar handing tasks to two worker avatars.
  2. "Workers that ship": a task row moving to "PR opened".
  3. "Lives in Slack, remembers past work": a mini Slack line and a memory chip.
- One line under the panels: "Next: connect this dashboard to your swarm."
- Primary action "Get started" with the Enter keycap. No Skip.
- Phone layout: panels stack, no horizontal scroll (#1623 rules).

### Success Criteria:

#### Automated Verification:
- [ ] UI gates: `cd apps/ui && bun run lint && bunx tsc -b && bun run check:tokens`
- [ ] Flag key present once: `grep -rn "agent-swarm-setup-welcome-seen" apps/ui/src | wc -l` prints `1` or `2` (a constant plus its use)
- [ ] No em dashes added: `git diff -U0 -- apps/ui | grep '^+' | grep -c "$(printf '\342\200\224')"` prints `0`

#### Automated QA:
Use the QA environment in `root.md`.
- [ ] Fresh browser (`agent-browser close --all`), open `https://ui.swarm.localhost/setup`: the welcome shows with no stepper. Screenshot `/tmp/onb-plan-qa/step9-welcome.png`.
- [ ] Press Enter: Connect shows as "Step 1". Reload: the welcome does not show again.
- [ ] `?intro=1` shows it again.
- [ ] A browser with the flag unset, connected to an API whose onboarding has a `done` step, skips the welcome.
- [ ] Phone width (390 px): panels stack. Screenshot `/tmp/onb-plan-qa/step9-phone.png`.

#### Manual Verification:
- [ ] Taras approves the headline and the three panels.

**Implementation Note**: Commit as `[step-9] welcome pre-step for /setup`.
