---
id: step-5
name: Files step in /setup
depends_on: []
status: done
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-5: Files step in /setup

## Overview

`/setup` gains a step `files`, placed before `first_task`. It explains agent-fs in three sentences and connects the person to Comb with no click and no key to paste: it runs Comb's existing browser flow (`register`, swarm invite, save the key) with the email the person gave in step 1. The step shows only when the API knows the step and Comb is on. Also fix the seeder so a transient invite failure retries on the next boot.

Facts (accounts spike, `thoughts/taras/plans/2026-10-26-agent-fs-onboarding/spikes/accounts/README.md`):
- agent-fs has no admin create-user route. Only public `POST /auth/register` creates an account, and it returns the key to the caller once. So the browser registers (decision 4).
- `createAndConnect(deps, email)` already does register, `GET /auth/me`, `ls` on the swarm drive, the swarm invite on 403 or 404, and saves the credential (`apps/ui/src/components/comb/connect-flow.ts:44-112`). A 409 returns `{kind: "email-taken"}`. A fresh key that cannot finish comes back as `newKey`.
- agent-fs matches emails exactly. Register and invite must use the same string: the swarm user's stored email.
- Step 1 email is required when the identity form shows, but the form is skipped for token-bound or locked identities (`apps/ui/src/pages/setup/steps/step-connect.tsx:116-215`). The step must handle a missing email.
- Stored onboarding rows back-fill a new step as todo (`parseStoredState`, `src/be/onboarding.ts:332-352`). A finished onboarding does not reopen (`completedAt || autoCompleted`).
- Step ids are free strings in telemetry, so no catalog change.

## Changes Required:

#### 1. Server step
**Files**: `src/be/onboarding.ts`, `src/http/onboarding.ts`
**Changes**:
- Add `"files"` to `OnboardingStepIdSchema` (line 10), the steps object in `OnboardingStateSchema` (105-123), `freshState` (306), the method union `OnboardingStepMethodSchema` (66) with methods `created` and `connected`, and the `complete` and `skip` members of `OnboardingActionSchema` (164-215).
- Add `signals.files = { enabled: boolean }` to `OnboardingSignalsSchema` (127-158), built in `buildSignals` (`src/http/onboarding.ts:29`) from `isCombEnabled()`.
- In `deriveState` (495), report `files` as `skipped` in the response while `signals.files.enabled` is false and the stored step is still todo. Never persist that status and never emit `step_skipped` for it: otherwise every install without Comb sends a funnel event, and the step stays skipped after Comb is turned on.
- `bun run docs:openapi` and commit the regenerated files.

#### 2. UI step list
**Files**: `apps/ui/src/api/types.ts` (`OnboardingStepId` 3946, `OnboardingSignals` 4028, the complete action 4048+), `apps/ui/src/api/hooks/use-onboarding.ts` (`ONBOARDING_STEPS` 18-26, back-fill guard 43-49)
**Changes**:
- Insert `{ id: "files", label: "Files" }` before `first_task`.
- Add `useVisibleOnboardingSteps()`: keep a step when its id is in the raw server `state.steps` (read before the back-fill guard, so an older API hides `files`) and, for `files`, when `signals.files?.enabled` is true.
- Put the filter in a pure function, `visibleOnboardingSteps(rawState, signals)`, that the hook calls. Replace direct `ONBOARDING_STEPS` reads in every consumer: `grep -rn "ONBOARDING_STEPS" apps/ui/src` (stepper, pill, checklist card, page navigation). `stepNumber()` (`apps/ui/src/components/onboarding/step-status.tsx:50`) and `TOTAL` (`apps/ui/src/pages/setup/page.tsx:94-101`) are module-level today: give them the visible list as an argument instead of reading the constant.
- Add the `STEP_ICON` entry (`apps/ui/src/pages/setup/components/setup-stepper.tsx:30`, for example `FolderOpen`), `STEP_COPY` and `STEP_BODIES` (`apps/ui/src/pages/setup/page.tsx:49,85`), and the `stepSubtitle` case (`apps/ui/src/components/onboarding/setup-checklist-card.tsx:152`: "Connected as <email>" or "Not connected").

#### 3. Shared connect deps
**File**: `apps/ui/src/components/comb/connect-card.tsx` (lines 41-62)
**Changes**: Move the deps object into a hook, `useConnectFlowDeps()`, in `apps/ui/src/components/comb/use-connect-flow-deps.ts` (new). `ConnectCard` uses it. `connect-flow.ts` does not change.

#### 4. Step body
**File**: `apps/ui/src/pages/setup/steps/step-files.tsx` (new; follow `apps/ui/src/pages/setup/step-contract.ts` and the other step files)
**Changes**:
- `/setup` is outside `AgentFsProvider` (the provider mounts in `apps/ui/src/components/layout/root-layout.tsx:103`, and `/setup` is routed outside it at `apps/ui/src/app/router.tsx:123`). Wrap the step body in `AgentFsProvider` (`apps/ui/src/contexts/agent-fs-context.tsx`) and check that it gets the status it needs there.
- Copy:
  - title "Files";
  - body "Agents save their work in agent-fs, the shared drive of your swarm. You read it, comment on it and send it back to agents in Comb. We create your files account with <email>.";
  - done "Your files account is ready." with a link to `/file`.
- Email: `useCurrentUser().user?.email`, unchanged. No email: show "Add your email in step 1 to create your files account." with a link to `setupStepHref("connect")`, plus Skip. Never take a typed email in this step.
- Auto-run `createAndConnect(useConnectFlowDeps(), email)` once, when `useAgentFs().state === "needs-connect"`. Guard with a ref keyed by `<endpoint>|<email>`, so React re-renders and strict mode do not register twice.
- Outcomes:
  - connected: `act({ action: "complete", step: "files", method: "created" | "connected" })`;
  - `email-taken`: render the existing paste-key UI from `ConnectCard`;
  - `newKey`: show the key once with a copy button and "Save this key now. It is shown once.";
  - any other failure: the error and a Retry button.
- State `ready` on entry: complete with `connected`. Hold Continue with `setContinueBlocker` while the flow runs.
- Call `act` last and ignore a 403 (a non-admin cannot write onboarding, but the account is still created).

#### 5. Seeder retry
**File**: `src/be/seed/agent-fs-provision.ts`
**Changes**: `git apply thoughts/taras/plans/2026-10-26-agent-fs-onboarding/spikes/accounts/seeder-invite-retry.patch` (applies on main). Then:
- change its code comment: the account is created later by the Files step or Comb's connect card, which invite in the same flow (there is no `/api/fs/me/account` route);
- confirm that the throw comes after the org and drive config rows are written (lines 105-129). Agent keys are minted on demand by `ensureAgentFsCredentialsForAgent` (line 236), not by this loop, so they are not affected;
- make `resolveInviteTargets` (498-508) follow RBAC instead of the free-text profile role: skip users whose status is not `active`; role `editor` when the user's grant is grant-all or holds `task.fs.mutate`, else `viewer` (`getUserGrant`, `src/be/rbac-roles.ts:185`). Today an RBAC Viewer is invited as `editor`, and the rank check would re-promote anyone that step-6 sets to `viewer`. Trim the emails too;
- the hash input changes for installs with non-active users or narrowed roles, so those invites run once more at the next boot. That is expected;
- do not bump `PROVISION_VERSION`.

#### 6. Docs
**Files**: `docs-site` pages that describe `/setup` (find them with `grep -rln "first_task\|Step 7\|seven steps" docs-site/content`), `.claude/internal-skills/onboarding-qa/SKILL.md` and `personas.md` (they mention steps 1-7)
**Changes**: Add the Files step and the new step count.

### Success Criteria:

#### Automated Verification:
- [x] Server: `bun run test:root -- src/tests/onboarding.test.ts` (new cases: fresh state has `files` todo; a stored row without `files` back-fills as todo, copy the case at line 241; Comb off derives `skipped`; complete with `created` and with `connected`; a bad method is rejected, copy line 583)
- [x] Seeder: `bun run test:root -- src/tests/agent-fs-provision-seeder.test.ts` (new: a 503 invite does not store the hash and the next run invites again; a 500 "not found" stores the hash; an unchanged second run is a no-op; the org and drive config rows persist when an invite fails; an RBAC Viewer is invited as `viewer`; an `invited` or `suspended` user is not invited)
- [x] Step render: `bun run test:root -- apps/ui/src/pages/setup/steps/step-files.test.tsx` (new file; happy-dom, copy `apps/ui/src/pages/setup/steps/agents/agent-models.test.tsx`; cases: no email, auto-run once across two renders, `email-taken`, `newKey`, a 403 from `act` still shows done)
- [x] Visibility: `bun run test:root -- apps/ui/src/api/hooks/visible-onboarding-steps.test.ts` (new; put the filter in a pure function `visibleOnboardingSteps(rawState, signals)` that the hook calls; cases: API without `files` hides it, Comb off hides it)
- [x] Comb flow regression: `bun run test:root -- apps/ui/src/components/comb/connect-flow.test.ts apps/ui/src/lib/agent-fs/credential-store.test.ts`
- [x] Telemetry contract: `bun run check:telemetry-contract`
- [x] Gates: `bun run check:local && bun run lint && bun run lint:slop && bun run tsc:check:tsc && bun run docs:openapi`
- [x] UI: `cd apps/ui && bun install --frozen-lockfile && bun run lint && bunx tsc -b`

#### Automated QA:
- [x] Fresh-install walk on a local stack (`AGENT_BROWSER_SESSION=afo-step-5`), recorded per LOCAL_TESTING.md "When you need to verify a UI change":
  - Start agent-fs as root Manual E2E part A does, but with `-e AGENT_FS_PUBLIC_URL=http://localhost:7433`.
  - Boot the API in the background from a fresh worktree (PID in `/tmp/afo-step-5/pid`, killed at the end) with a new `DATABASE_PATH`, `AGENT_FS_API_URL=http://localhost:7433`, `AGENT_FS_PUBLIC_URL=http://localhost:7433` and `COMB_ENABLED=true`, then start `cd apps/ui && bun run dev`.
  - Walk `/setup`. Step 1 takes `qa+files@example.com`. The Files step connects by itself and shows done.
  - `/file` opens Comb with no connect card.
  - Reload `/setup`: the Files step stays done, and agent-fs has exactly one account for that email (check with `GET /orgs/<org>/members` and the bootstrap key, run inside a script that never prints the key).
- [x] Same stack with `COMB_ENABLED` unset: the stepper shows no Files step.
- [x] Old-API check: point the new UI at an API built from `origin/main` before this step. The stepper shows no Files step and no console error.

#### Manual Verification:
- [ ] Taras reads the step copy once.

**Implementation Note**: This step is a vertical slice, QA-able on its own. After completing it, pause for manual confirmation. Commit as `[step-5] Files step in /setup` after verification passes.
