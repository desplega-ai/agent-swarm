---
id: step-10
name: Waitlist email for Teams and other channels
depends_on: [step-5]
status: ready
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-10: Waitlist email for Teams and other channels

## Overview

After this step, the Microsoft Teams and "Something else" rows in Team chat have a small waitlist form (research J15, decision: email capture). The design follows the proxy contract that landed with #1780 (see `root.md`, "Telemetry (after #1780)"):

1. The browser sends the email to the proxy `/v1/feedback` endpoint through the existing `api.submitFeedback`, the same path as the Feedback dialog. The proxy stores it in `feedback_submissions`.
2. The UI then calls a new API route. The API emits the catalogued, PII-free `lead.captured` event (`channel`, `submission_id`, `consent`). It obeys `ANONYMIZED_TELEMETRY` like every event.

The form says the email goes to Desplega. No new telemetry event and no proxy PR are needed: `lead.captured` is already in the vendored catalog (`src/telemetry-contract/catalog.json:1203-1223`).

## Changes Required:

#### 1. UI: waitlist form
**Files**: `apps/ui/src/pages/setup/steps/chat/waitlist-form.tsx` (new), `apps/ui/src/pages/setup/steps/step-chat.tsx` (replace the step-5 `WaitlistSlot` placeholder only)
**Changes**:
- Teams row: email field + "Notify me" button. "Something else" row: channel name field (1-40 chars) + email field + "Notify me".
- Disclosure line under the button: "We send this email to Desplega to tell you when it ships."
- Optional unchecked checkbox: "Also send me product updates" → `newsletter_consent`.
- Reuse the Feedback dialog wiring (`apps/ui/src/components/feedback/feedback-dialog.tsx:32-48`, around `:130` for the payload): endpoint from the `feedback_endpoint` global config or the default `https://proxy.desplega.sh/v1/feedback`, `install_id` from the `telemetry_installation_id` config, `user_id` from the current user, `swarm_version` and `org_name` from status. Extract a shared helper if the dialog and the form would otherwise duplicate the payload builder.
- Payload: a fresh `submission_id` (UUID), `email`, `newsletter_consent`, `message` = `"waitlist:teams"` or `"waitlist:other:<channel name>"`, `submitted_at`.
- After `api.submitFeedback` returns, call the new API route (part 2) with `{ channel, submissionId, consent: true }`.
- States: "Sending…", then "Sent. We'll email you when it ships." `submitFeedback` can't confirm delivery on self-hosted origins (opaque `no-cors` fallback, `apps/ui/src/api/client.ts:815-824`), so never say "Saved" or "Confirmed". Show the error with a retry if `submitFeedback` throws.
- This is an explicit submit, not autosave: a button is correct here (the dashboard-ui autosave rule covers config fields).
- Invalid email or missing current user: `aria-disabled` button + tooltip, never `disabled`.

#### 2. API: lead route
**Files**: `src/http/onboarding-lead.ts` (new), `src/http/all-routes.ts`
**Changes**: `POST /api/onboarding/lead` with the `route()` factory.
- Body: `{ channel: "teams" | "other", submissionId: string (1-100 chars), consent: boolean }`. No email field: the API never sees the email.
- `rbac: { permission: "config.write.any" }` (same as `PUT /api/onboarding`), gated with `ensureConfigAdmin()` like `src/http/onboarding.ts:310-316`.
- Emit `lead.captured` with `{ channel, submission_id, consent }` through the typed telemetry API in `src/telemetry.ts` (find the generic catalog-typed emitter or the family wrapper pattern, as `telemetry.onboarding()` does at `:760-780`). Telemetry stays fire-and-forget.
- 200 `{ ok: true }` via `.respond()` with a zod schema.
- A new file keeps this step clear of `src/http/onboarding.ts`, which step 6 edits.

#### 3. Tests
**File**: `src/tests/onboarding-lead.test.ts` (new)
**Changes**: Valid body → 200 and one `lead.captured` emit with the three properties (stub the emitter or `fetch`). Unknown `channel` → 400. A body with an `email` key is rejected or stripped, and no emit carries it. `ANONYMIZED_TELEMETRY=false` → 200 and no emit. Use `port: 0` or the existing HTTP test harness, never a fixed port.

Do not regenerate `openapi.json` here. Step 11 does it once.

### Success Criteria:

#### Automated Verification:
- [ ] Lead route tests: `bun run test:root -- src/tests/onboarding-lead.test.ts`
- [ ] Root typecheck (proves `lead.captured` props match the catalog): `bun run tsc:check`
- [ ] UI gates: `cd apps/ui && bun run lint && bunx tsc -b && bun run check:tokens`
- [ ] API gates: `bash scripts/check-db-boundary.sh && bun run check:rbac-coverage && bun run check:openapi-response-coverage && bun scripts/check-floating-promises.ts && bun scripts/check-promise-sinks.ts`
- [ ] The API never handles the email: `grep -n "email" src/http/onboarding-lead.ts` prints nothing

#### Automated QA:
Use the QA environment in `root.md`. Point the form at a local catcher so QA never writes to the real proxy: set the `feedback_endpoint` global config to `http://localhost:<free port>/v1/feedback` (loopback `http` is allowed by `submitFeedback`) and run a tiny `Bun.serve` catcher that logs request bodies to `/tmp/onb-plan-qa/feedback.log`.
- [ ] Team chat → Teams → type `qa+teams@desplega.sh` → "Notify me": the row shows "Sent…". Screenshot `/tmp/onb-plan-qa/step10-teams.png`.
- [ ] The catcher log has one body with `"message":"waitlist:teams"` and the email.
- [ ] The API log has no email: `grep -c "qa+teams@desplega.sh" /tmp/onb-plan-qa/api.log` prints `0`.
- [ ] A bad email keeps the button blocked with a tooltip.
- [ ] Phone width (390 px): the form fits. Screenshot `/tmp/onb-plan-qa/step10-phone.png`.
- [ ] Remove the `feedback_endpoint` override after QA.

#### Manual Verification:
- [ ] Taras submits one real waitlist entry from a hosted origin and confirms the proxy stored it and recorded `lead.captured`.

**Implementation Note**: Commit as `[step-10] Teams and other-channel waitlist via feedback endpoint`. `apps/ui/src/api/types.ts`, `client.ts`, and `step-chat.tsx` are shared with sibling steps: re-read before each edit.
