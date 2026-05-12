---
date: 2026-05-07T00:00:00Z
author: Taras
topic: "Cloud deployment personalization & onboarding"
tags: [brainstorm, cloud, onboarding, ui, agent-fs]
status: handed-off-to-research
exploration_type: idea
last_updated: 2026-05-07
last_updated_by: Taras
---

# Cloud deployment personalization & onboarding — Brainstorm

## Context

We have a free, hosted (cloud) deployment of the swarm app. Today, when users land there, we ask them to set their credentials in the app. That works, but the experience is generic — it doesn't feel like *their* swarm.

Taras is bringing four parallel ideas to the table:

1. **`/cloud` endpoint** — The API exposes a special, env-driven endpoint that surfaces metadata (icon, name, …) the UI can use to "skin" itself / declare it's running in cloud mode.
2. **Onboarding experience** — If agents are missing things (envs, harness config, etc.), guide the user to set them up. Tracked progress stored in local storage. More of a guided "first run" experience.
3. **agent-fs surfacing** — Make agent-fs more visible / first-class in the app UI.
4. **Link back to cloud** — From self-hosted / local instances, link back to the hosted cloud instance (presumably for upgrade, signup, or cross-promotion).

These are loosely connected by a theme: *making the cloud experience feel like a real product, not a bare deployment.*

## Exploration

### Q: Who is the primary user of the hosted cloud deployment that you're trying to make feel more personalized?

People who do not want to self-host. They just want to use swarm without operating any infrastructure themselves.

**Insights:**
- This narrows the persona: the cloud audience is *not* power users who already know swarm locally — it's people who want a managed product.
- Personalization for this audience leans toward "this is *my* workspace inside a hosted product" rather than "this is *my* self-hosted instance with my logo."
- It also implies the cloud likely needs an account / tenant model so each user has their own personalization surface — a single shared deployment can't really feel personal otherwise.
- Branding/skin-the-app concerns (idea #1) become less about white-labeling and more about distinguishing "this is the cloud product" vs. "this is your local install."

### Q: How does the cloud deployment work for these users today — do they share one deployment or each get their own?

Each org (company / group of users of the same org) gets their own deployment.

**Insights:**
- This is **per-tenant deployment**, not classic SaaS multi-tenancy. Each org has its own isolated swarm instance.
- This makes the `/cloud` endpoint idea natural: env vars baked into the deployment can carry org identity (name, logo, brand color) and the API surfaces them.
- Personalization moves from "per-user account UI" to "per-deployment identity" — closer to white-labeling than tenant-skinning.
- It also means *onboarding* (idea #2) is per-org, run roughly once per deployment, not a per-user repeat experience. That's a much narrower problem.
- agent-fs surfacing (idea #3) and link-back-to-cloud (idea #4) inherit org-level scoping for free.
- Open question: who provisions the deployment? Is it self-service (signup → deploy), or are deployments hand-rolled by the swarm team today? That dictates where the personalization metadata gets *set*.

### Q: When a new org wants the cloud product, how does their deployment come into existence today?

Taras has a separate project that handles provisioning: spins up a VPS, runs `docker compose` with swarm (API + workers) + agent-fs, and wires up a Vercel domain over HTTPS.

**Insights:**
- Provisioning is **automated by an external orchestrator**, not by swarm itself. That orchestrator already knows org identity (name, domain) at deploy time.
- This means swarm's job is just to **read its own env** and surface that identity. The hard "how do we know the org?" problem is solved upstream.
- The `/cloud` endpoint idea becomes very concrete: a small API surface that reads e.g. `SWARM_CLOUD_ORG_NAME`, `SWARM_CLOUD_ORG_LOGO_URL`, `SWARM_CLOUD_BRAND_COLOR`, etc., set by the orchestrator, and exposes them for the UI to consume.
- The orchestrator is the natural place to also set "is this cloud?" (`SWARM_CLOUD=true`) which gates whether the link-back-to-cloud (idea #4) shows on local installs vs. cloud.
- Open question: what does the orchestrator already inject? Is there a stable contract between it and swarm, or is each deployment a snowflake today?
- Open question: do users on the cloud have *individual* identity (login with their email) or is it just "anyone with the org's URL gets in"?

### Q: When you imagine a logged-in user opening their cloud swarm and feeling "this is mine," what do you most want them to see that they don't see today?

A mix of all four — branding throughout the UI, a welcoming home surface, setup-state awareness, and some pre-seeded content. And critically: **the same surfaces would also help anyone setting it up locally for the first time.**

**Insights:**
- The "wants" are broad, but the *insight* is sharper: **the cloud personalization story and the local first-run-onboarding story are the same product surface**, just driven by different inputs.
  - On cloud: identity + branding come from env (set by the orchestrator).
  - On local: identity is unset → graceful fallback to "Local Swarm" or similar; setup state comes from runtime checks.
- This collapses ideas #1 (cloud `/cloud` endpoint) and #2 (onboarding) into one feature: a **status / identity / setup-progress** API + UI that has cloud and local behaviors as variants.
- Strong reframe: instead of "personalize the cloud," it's **"give the app a real home + setup story, and let cloud env personalize it further."** This is more durable and avoids cloud-only dead code.
- Sub-features that would need to feed this surface:
  - **Identity:** org name, logo, brand color (cloud) vs. defaults (local).
  - **Setup state:** what's missing — providers, integrations (Slack/GitHub/Linear/Jira), harness env, credentials, agent-fs.
  - **Activity / "what's set up" snapshot:** agents online, recent tasks, configured workflows.
  - **Pre-seeded content:** template starting workflows / suggested tasks. Could be the same as cloud.
- What's *not* in scope yet: per-user personalization (since cloud is per-org, not per-user). That can wait.
- Idea #3 (agent-fs surfacing) and idea #4 (link-back-to-cloud) are still separate threads — worth pulling apart next.

### Q: What are the most important things a fresh swarm install (cloud or local) doesn't have configured yet that the onboarding/setup surface should help users complete?

All four:
1. Harness provider + creds (HARNESS_PROVIDER, API keys / OAuth, validation)
2. Integrations (Slack / GitHub / Linear / Jira — OAuth or token setup)
3. Workers running (at least one lead and one worker connected)
4. First task / template (sample task or pick-a-template so the user sees something work end-to-end)

**Insights:**
- This is the **canonical setup checklist** — four ordered milestones. They map well to a stepper UI: "1 of 4 — harness", "2 of 4 — integrations", etc. (Skipping is fine; it's a checklist not a wizard.)
- They're all *checkable* server-side:
  - Harness: env presence + a test call (or stored OAuth row).
  - Integrations: presence of OAuth tokens + token health endpoint per integration.
  - Workers: heartbeats — query agents table (server-side) to see how many leads/workers are live.
  - First task: count of tasks executed > 0.
- Implication for the API: the `/cloud` endpoint conceptually generalizes to a `/status` (or `/setup-state` / `/onboarding`) endpoint that returns:
  - `identity` — name, logo, brand color, isCloud (from env)
  - `setup` — checklist of milestones, each with `{ id, label, done, hint?, action_url? }`
  - `activity` — agents online, recent tasks (small summary)
- The naming probably matters: not `/cloud` (which implies "only on cloud"), but something like `/status` or `/instance-info` that also serves the local-onboarding case. The cloud-specific bits (logo, name) just degrade gracefully when env is unset.
- "First task / template" overlaps interestingly with idea #3 (agent-fs surfacing) — sample content could be agent-fs files. That's a hint these aren't fully independent.
- Open question: **local storage progress store** — Taras mentioned this in the original framing. Is the per-user progress (e.g. "user dismissed the intro card", "user has seen template X") a frontend-only concern, or do we want it shared across browsers? That changes the architecture (frontend localStorage vs. server-side per-user state).

### Q: Why do you want agent-fs to surface more cleanly in the app — what's the user pain you're solving?

A mix of #1 (discoverability) and #4 (agent activity transparency). It's fine if it just redirects to agent-fs proper — the goal is at least a *notion* that it's there. The API already knows whether agent-fs is set up.

**Insights:**
- This is a **soft surface**, not a deep integration. Goal is: "this product has a filesystem; here's where you go." Not: "rebuild a file browser inside swarm UI."
- Two natural touch points fall out:
  - **In setup-state / home:** an indicator card "Storage: agent-fs configured ✓ → Open" or "Storage: not configured → Set up". This lives alongside harness, integrations, workers in the checklist.
  - **In task / agent run views:** a panel that says "Files: this task touched X files in agent-fs → Open in agent-fs." Doesn't render the files; just a lightweight link with counts/names.
- The API already knows agent-fs status (env / config check) — so the existing `/status` surface should include `agent_fs: { configured: bool, base_url?: string }`.
- For activity transparency (touch point #2), this is more involved — need to track which agent-fs paths a run wrote to. May or may not be in scope; could be deferred.
- **Strong scope discipline:** "redirects to agent-fs is fine" → don't build a file browser. Build *links* and *counts*.
- This becomes idea #3 → "agent-fs is a first-class card in the home/setup surface, plus a link from runs." Scoped small.

### Q: When you say "link back to cloud," what's the actual link and where does it appear?

Both directions:
- Local → cloud (acquisition): "don't want to self-host? Try hosted."
- Cloud → marketing/docs/support.

**Insights:**
- This is the **same UI affordance with mode-aware copy** — driven by the `isCloud` flag from the `/status` endpoint.
  - `isCloud === false`: subtle banner / footer link → marketing signup page.
  - `isCloud === true`: support / docs / billing menu items in the user account dropdown or nav.
- Concretely, both can live in the same place: the user/help menu in the top-right of the app. Different items appear based on `isCloud`.
- This neatly closes the loop: idea #1 (cloud env detection) → idea #4 (cloud-aware UI affordances). The same env signal drives both.
- One small concern: a hardcoded marketing URL on local installs is a tiny ad — make sure it's tasteful (footer link, not banner) and dismissable. Open-source users can be touchy about this.
- Open question: is the marketing URL fixed in code (`https://swarm.dev` or wherever) or configurable? Probably fine to bake in; can add a `SWARM_HIDE_CLOUD_PROMO` opt-out env if needed.

### Q: Which adjacent ideas feel worth pulling in alongside #1–#4?

Yes to:
- **Health badge in nav** — persistent header indicator (green/yellow/red).
- **Empty-state → sample template** — seed pre-built templates tied to detected integrations.

Skipped:
- "Connect from CLI" deep-link.
- Onboarding telemetry.

**Insights:**
- The **health badge** extends setup-state from "one-time onboarding" to "always-on awareness." Once you've completed setup, it doesn't go away; it just changes meaning to "is everything still healthy?" That keeps the `/status` API valuable forever, not just on first run. Strong reuse case.
- **Empty-state → sample template** is a really tidy way to make "First task / template" (the 4th milestone) feel concrete. Detect what's set up, recommend templates matching. This implicitly *requires* the setup-state surface to know what's configured. So it depends on idea #1+#2 work being done first.
- Skipping CLI deep-link and telemetry suggests Taras wants to **stay on the user-facing UX side**, not infrastructure / data-collection side. Good scoping signal.

### Q: If you could only ship one thing first — the smallest, most valuable slice — what is it?

All of #1+#2 together — the status API and the onboarding/home UI ship as one feature, since they're tightly coupled.

**Insights:**
- This validates the earlier reframe: **the cloud personalization story and the local onboarding story are one product surface.** Shipping them together keeps cloud and local in lockstep and avoids dead UI waiting on backend.
- MVP scope locks in:
  - `/status` API (identity + setup checklist + activity summary).
  - Home page UI consuming it (org branding header, checklist, basic activity).
  - Driven by env on cloud, gracefully degraded on local.
- Health badge, agent-fs card, link-back-to-cloud, and empty-state-templates can all be follow-ups that *consume* the same `/status` API. They're enhancements layered on the same foundation, which is exactly what we want.
- Implementation order falls out cleanly:
  1. **Phase 1 (MVP):** `/status` API + home page UI + identity from env.
  2. **Phase 2:** Health badge in nav + cloud-aware nav items + agent-fs card.
  3. **Phase 3:** Empty-state → sample templates (depends on knowing detected integrations).
  4. **Phase 4 (optional):** Per-user progress (localStorage flags for dismissed cards / tour completion).

## Synthesis

### Reframe (the most important takeaway)

The four ideas Taras started with are not four independent features. They are one feature plus three enhancements, all hanging off a single new product surface:

> **A `/status`-style API + a "home + setup + always-on health" UI surface that uses env-driven identity on cloud and graceful defaults on local.**

The same surface that "personalizes" the cloud is the surface that "onboards" a new install. Cloud and local are just different inputs to the same UI. This is the durable reframe that prevents cloud-only dead code and gives the work a much sharper shape.

### Key Decisions

- **Scope is unified, not split.** Build one product surface (home + setup + health) that has cloud and local variants, not two parallel features.
- **Identity is env-driven.** Org name, logo, brand color, `isCloud`, and link-back URLs come from env vars set by the upstream orchestrator. Swarm just reads + serves them.
- **No new account/auth model required.** Cloud is per-org per-deployment; the org *is* the deployment. Per-user state stays in browser localStorage (e.g. dismissed cards). No server-side per-user storage in MVP.
- **agent-fs surfacing is "links + counts," not a file browser.** Card on home + lightweight per-run "files touched" link. Redirects to agent-fs proper.
- **Link-back-to-cloud is the same UI affordance, mode-aware.** Header/footer menu items differ on `isCloud`; subtle, dismissable on local.
- **MVP is Phase 1 — `/status` API + home UI shipped together.** Health badge, agent-fs card, link-back, templates layer on top.
- **Naming:** call the endpoint `/status` (or `/instance-info`), not `/cloud`. Cloud-only naming would imply dead code on local — and the surface is dual-purpose by design.

### Constraints Identified

- **Per-org per-deployment** — one swarm instance per org, provisioned by Taras's external orchestrator (VPS + docker-compose + Vercel domain). Identity must come from env, set by that orchestrator.
- **No first-class user accounts** in cloud today; persona = "people who don't want to self-host." Don't design for multi-user concurrency in this phase.
- **Local storage progress** is browser-scoped — per-user, not portable. Acceptable for non-critical UX flags ("user dismissed the intro tour"); not for anything that has to survive a browser switch.
- **Existing API server is the sole DB owner** (per CLAUDE.md). The `/status` route lives in `src/http/` via the `route()` factory, not on the worker.
- **Don't build a file browser.** agent-fs has its own UI; swarm UI surfaces *notion of it*, not a duplicate.
- **OSS-friendly tone.** Cloud promo on local must be subtle and dismissable; opt-out env if needed.

### Core Requirements

**Server-side:**
1. `GET /status` (or `/instance-info`) authenticated route returning:
   - `identity`: `{ name, logo_url, brand_color, is_cloud, marketing_url? }` — sourced from env (`SWARM_CLOUD`, `SWARM_ORG_NAME`, `SWARM_ORG_LOGO_URL`, `SWARM_BRAND_COLOR`, `SWARM_MARKETING_URL`, etc.). Defaults when unset.
   - `setup`: array of milestones, each `{ id, label, done, hint?, action_url? }` covering harness, integrations, workers, first-task.
   - `activity`: `{ agents_online, leads_online, recent_tasks_count }` (cheap summary).
   - `agent_fs`: `{ configured, base_url? }`.
2. Setup checks must be **cheap and side-effect-free** (presence of env / DB rows / heartbeats; no live API calls in MVP).
3. Route registered via `route()` factory + reflected in `openapi.json` per project conventions.

**UI:**
4. New home/landing route in `ui/` that consumes `/status`.
5. Org identity in app chrome (header logo + name + color accent).
6. Setup checklist (4 milestones) with deep-links to existing config UI (don't rebuild).
7. Activity summary (agents online + recent tasks).
8. Cloud-mode-aware menu items in header (cloud → docs/support, local → cloud promo footer link).
9. Persistent browser-localStorage flags for dismissed cards / completed tour items.

**Phase 2+ (out of MVP scope, feed off same `/status`):**
- Health badge in nav.
- agent-fs card on home + per-run "files touched" link.
- Empty-state → recommended templates based on detected integrations.

### Open Questions

- **What identity envs does the orchestrator already inject?** Need a stable contract. If nothing today, define one.
- **Does cloud have a single account / login per deployment, or is "anyone with the URL" the model today?** Affects whether localStorage flags are good enough or if we need server-side per-user state for tour progress.
- **What's the marketing URL?** Need a real one for the local→cloud link, plus an opt-out env (`SWARM_HIDE_CLOUD_PROMO`?).
- **Where does the home page live route-wise** (`/` vs `/home` vs `/dashboard`)? Affects `ui/` (Vite + react-router-dom, **not** Next.js per [research § 1](../research/2026-05-07-cloud-personalization-research.md#1-ui-home-routing-ui)) and the now-removed-landing-page logic. Today `/` goes straight to `DashboardPage` via `ui/src/app/router.tsx:45`.
- **Does the existing config UI cover all 4 setup milestones already?** If not, MVP grows to add missing config screens (or deep-link to docs as a stopgap).
- **First-task milestone definition:** "ran a task" or "saved a workflow"? The bar matters for checklist UX.

## Iteration — Honest Critique Round

After draft-1 synthesis, ran a radical-candor pass and identified three real cracks. Two were resolved here; the third is downgraded with honest scoping.

### Crack 1 (resolved) — The setup checklist would lie

**Problem:** Draft-1 said "no live API calls in MVP," which meant env-presence drove green-checks. A user with `HARNESS_PROVIDER=claude` and an *invalid* API key would see "Harness ✓ done" — and a green-checkmark for broken setup is *worse* than no checklist for the audience this surface targets (confused new users).

**Resolution:** Three-state model per milestone — `configured | unverified | verified` — with the source of "verified" depending on the type of milestone:

| Milestone type | What "configured" means | What "verified" means |
|---|---|---|
| OAuth integration (Linear/Jira **only**) | Token row exists in `oauth_tokens` (provider=linear/jira) | Row exists + most-recent `keepalive.ts` refresh cycle did not error. **Caveat:** refresh failures don't delete the row today (no error column), so "row exists" can lie. Plan-phase decides between (a) new migration adding `last_refresh_error_at`, (b) reading keepalive state another way, or (c) accepting the simplification. |
| Env-vars-only integration (Slack, GitHub) | All required envs present (`SLACK_BOT_TOKEN`+`SLACK_APP_TOKEN`+!`SLACK_DISABLE` for Slack; `GITHUB_WEBHOOK_SECRET`+`GITHUB_APP_ID`+`GITHUB_APP_PRIVATE_KEY` for GitHub) | Same as configured. Slack uses Socket Mode (no OAuth user flow); GitHub uses GitHub App with JIT-minted per-installation tokens (no OAuth user flow). Research [2026-05-07-cloud-personalization-research.md § 7](../research/2026-05-07-cloud-personalization-research.md#7-oauth-integration-storage--important-correction-to-brainstorm). |
| API-key env (Anthropic, OpenRouter, etc.) | Env var is set | Explicit "Test connection" button in the row, or a successful first-use. Until then: unverified (yellow). |
| Workers (lead/worker) | Row exists in agents table | Heartbeat fresh within last N minutes. Stale heartbeat → unverified. |
| First task | n/a | At least one task completed. Binary: done or not done. |

**Insights:**
- This is a much sharper requirement than "checklist of bools." The `/status` schema needs `state: "configured" | "unverified" | "verified"` per row, not just `done: bool`.
- OAuth's "token = verified" property is a *gift* — it means we don't need a "test integration" button for those four (Slack/GitHub/Linear/Jira). API-key envs get the button; OAuth doesn't need one.
- "Test connection" is real backend work for each provider type — not free. Worth scoping which providers actually need it for MVP vs. defer.

### Crack 2 (resolved) — The orchestrator → swarm identity contract was undefined

**Problem:** Draft-1 assumed the upstream Taras-orchestrator would inject identity envs (`SWARM_CLOUD`, `SWARM_ORG_NAME`, etc.), but logged the contract itself as a soft "open question." That's actually a **blocker** — without the contract, the cloud half of MVP can't ship.

**Resolution:** **Define the contract in this MVP.** Swarm reads the canonical set of envs and serves them via `/status`. The orchestrator catches up after. Local installs just see defaults.

**Canonical contract (proposed for plan-phase):**

```
SWARM_CLOUD            # "true" | unset (gates is_cloud + cloud-mode UI)
SWARM_ORG_NAME         # display name in header (default: "Swarm")
SWARM_ORG_LOGO_URL     # https URL to org logo (default: bundled swarm logo)
SWARM_BRAND_COLOR      # hex color for accent (default: project default)
SWARM_MARKETING_URL    # marketing/signup link for local→cloud promo (default: bake in real URL)
SWARM_HIDE_CLOUD_PROMO # "true" | unset (opt-out for OSS users)
```

**Insights:**
- Spec on the swarm side first, push to orchestrator after. This means swarm MVP doesn't block on the other repo — it ships with sensible defaults and gets richer when the orchestrator starts injecting.
- These names are namespaced (`SWARM_*`), so they're safe to add to the orchestrator without conflicting with anything else there.
- The contract should be documented in `docs-site/` once the plan lands — orchestrator side will need to read that.

### Crack 3 (downgraded) — "Files-touched-per-run" was scoped dishonestly

**Problem:** Draft-1 said agent-fs surfacing was "links + counts, not a file browser" and listed two touchpoints: a home card *and* a per-run "files touched" panel. The per-run panel was hand-waved as "may be deferred" — but it's not a small deferral. Tracking which agent-fs paths a run wrote to requires task-side instrumentation (hook into agent-fs writes from inside running tasks) that doesn't exist today.

**Resolution (no question needed — just honest scoping):**

- **Phase 2 agent-fs is JUST the home card** (configured/not + link to agent-fs). That alone delivers the discoverability win.
- **The per-run "files touched" panel is its own research project** and is removed from the agent-fs work item entirely. It belongs in a separate brainstorm if/when we decide to do it. Tracking writes from inside tasks touches: provider runners, hooks, possibly DB schema. Not free.
- Updated Phase 2 description: "Health badge + cloud-aware nav items + agent-fs home card." (Per-run panel struck.)

## Synthesis (revised after iteration)

### Additions / changes from iteration

- `/status` setup rows now carry `state: "configured" | "unverified" | "verified"`, not `done: bool`. Type-specific verification rules above.
- OAuth integrations (Slack/GitHub/Linear/Jira) skip "unverified" — token = verified.
- API-key envs need a per-row "Test connection" button. Backend work to implement the test calls per provider type.
- Workers verify via heartbeat freshness.
- The cloud-identity env contract (`SWARM_CLOUD`, `SWARM_ORG_NAME`, …) is **specified by this MVP** — swarm-side first, orchestrator catches up.
- Phase 2 agent-fs scope shrinks to home card only. Per-run files-touched panel is removed and parked.

### Updated Phase ordering

1. **Phase 1 (MVP):** `/status` API (3-state checks + identity from env per the contract above) + home page UI.
2. **Phase 2:** Health badge in nav + cloud-aware nav items + agent-fs home card.
3. **Phase 3:** Empty-state → recommended templates from detected integrations.
4. **Phase 4 (optional):** Per-user localStorage flags (dismissed cards / tour completion).
5. **Parked (future brainstorm):** Per-run "files touched" agent-fs panel.

## Next Steps

- [x] Handoff to `/desplega:research` — audit existing config UI, per-provider test-connection feasibility, current `ui/` home routing, and what envs the orchestrator could reasonably inject today.
- [ ] After research: `/desplega:create-plan` for Phase 1 (status API + home UI).
- [ ] Surface the env-contract spec early in research — that's the swarm/orchestrator interface and needs to be locked before plan-phase.

