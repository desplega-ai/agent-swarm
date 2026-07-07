---
date: 2026-07-07T00:00:00Z
author: Claude
planner: Claude
topic: "DES-445 RBAC — user-policy admission model (increments 3–6 revision)"
tags: [design, rbac, auth, security, des-445]
status: draft
last_updated: 2026-07-07
last_updated_by: Claude
related_plan: thoughts/taras/plans/2026-07-07-des-445-rbac-slice1-can-audit.md
related_brainstorm: thoughts/taras/brainstorms/2026-05-15-rbac-for-swarm.md
related_research: thoughts/taras/research/2026-07-06-rbac-enforcement-surfaces.md
---

# DES-445 RBAC — user-policy admission model (increments 3–6 revision)

## 1. Why this note exists

Slice 1 shipped (PRs #921/#922): the central `can()` chokepoint (`src/rbac/can.ts`),
the verb registry (`src/rbac/permissions.ts`, 39 verbs incl. the PR #925 config verbs), the built-in legacy
policy that reproduces today's exact inline rules (`src/rbac/legacy-policy.ts`),
the principal/resource types (`src/rbac/types.ts`), the async audit log, and the
`bun run check:rbac-coverage` CI gate (`scripts/check-rbac-coverage.ts`).

The slice-1 plan closed with **Appendix B — Increments 3–6 outline** (see
`thoughts/taras/plans/2026-07-07-des-445-rbac-slice1-can-audit.md:474`). That
outline predates a design conversation (Taras + Claude, 2026-07-07) that settled
the *shape* of user policy enforcement. Several of its framings are now stale:

- It framed the `permissions:[]` route/tool field (increment 5) as
  **"defense-in-depth over the per-site `can()` calls, which remain the security
  boundary."** That is now inverted: the route-declared verb is the **primary
  admission gate for user tokens**. (The field actually shipped this session as a
  singular `rbac?: { permission } | { ungated }` on `RouteDef`, not an array.)
- It listed the `roles`/`permissions`/`role_permissions`/`principal_roles`
  migration and a `RBAC_ENABLED` flag with a `principal-stack intersection`
  (`agent ∩ originator ∩ trigger-source`), but did not commit to *what a role is*,
  *how grants compose*, or *where policy attaches*. Those are now decided.
- It did not connect the 149-route `ROUTE_RBAC_BACKLOG` to user policy at all —
  it read as parallel hygiene. It is actually a **precondition**.

This note revises Appendix B around the settled decisions. It is a design note,
not an implementation plan; it drives the increment-3 plan that follows. Nothing
here changes code.

The decisions below are settled. They are presented as *the design*, with
rationale — not as open options. Genuinely open items are collected in §7.

## 2. The two-layer authorization model

There are two distinct authorization layers, and user-token policy adds the
first one without removing the second.

**Layer (a) — Admission.** A coarse, DB-free, verb-in-policy gate that runs at
request admission in `handleCore` (`src/http/core.ts`, right after
`resolveHttpRequestAuth` sets the principal, ~`:251`). Implementation nuance
(verified 2026-07-07): the matched `RouteDef` is **not** a local variable at that
point — `handleCore` only auth-resolves and handles inline core routes;
`route()`-factory dispatch happens later. Admission therefore does its own
registry lookup by method+path; a lookup helper already exists in
`src/http/route-def.ts:92+` (currently used for telemetry span naming) and gets
promoted to load-bearing. Inline core routes handled directly in `handleCore`
(`/internal/reload-config`, `/me`, …) have no `RouteDef` at all — non-GET inline
routes default to the same fail-closed posture as `ungated` routes (§4:
operator-only for scoped user principals). The route's declared
`rbac.permission` verb (`src/http/route-def.ts:43`) becomes the enforcement
contract: for a policy-bearing principal, admission checks
`route.verb ∈ principal's effective grant`. This is cheap — the effective grant
is a set of verbs resolved from the principal's roles; no task/resource rows are
loaded. A caller whose grant does not contain the route's verb is rejected before
the handler runs.

**Layer (b) — Handler.** The existing resource-scoped `can()` calls *inside*
handlers stay exactly as they are. Admission cannot answer "does this user own
*this* task?" because it does not know the resource identity until the handler
loads the row (`requestedByUserId`, `creatorAgentId`, the kv namespace string,
etc. — the fields `RbacResource` in `src/rbac/types.ts` carries). The
`requester-owns-task` and `lead-or-resource-owner` style rules in
`src/rbac/legacy-policy.ts` are resource-scoped and remain the ownership boundary.

**We do not get to delete handler `can()` calls.** Admission is additive. The
verb-set gate answers "is this principal *allowed to attempt* this class of
operation at all"; the handler gate answers "is this principal allowed to touch
*this specific resource*." Collapsing them would either re-introduce the
resource-blind bug (admission granting cross-owner access) or push resource I/O
into the admission path (defeating the DB-free property).

### Request flow — scoped user token

1. `aswt_…` bearer arrives. `resolveHttpRequestAuth` (`src/http/auth.ts:13`)
   resolves it to `{ kind: "user", userId, user }` (active users only) and
   `setRequestAuth` stashes it (`src/utils/request-auth-context.ts`).
2. Admission (Layer a) resolves the user's effective grant (union of the roles
   attached to `userId`) and checks the matched route's `rbac.permission`
   against it. Miss → 403, handler never runs. Hit → continue.
3. Handler runs and performs its resource-scoped `can()` (Layer b) exactly as
   today — e.g. `requester-owns-task` denies the task if
   `task.requestedByUserId !== userId`.
4. Both layers' decisions flow through the same audit sink already wired in
   slice 1 (`setAuditSink` in `src/rbac/can.ts`).

## 3. Roles design

### Operator stays god-mode

The shared swarm key is the internal **service credential** — workers
authenticate the entire HTTP surface with it (`X-Agent-ID` self-asserted on top).
`resolveHttpRequestAuth` maps it to `{ kind: "operator" }`. **Policy enforcement
applies only to `aswt_` user tokens.** The operator principal bypasses admission
entirely; the agent path (shared key + self-asserted `X-Agent-ID`) is unchanged
until increment 4 gives agents a signed identity.

This is the load-bearing sequencing decision: **user-RBAC can ship without
waiting on agent identity hardening.** A `user` principal is already
authenticated end-to-end (the `aswt_` token maps to a real `users` row); an
`agent` principal is not (anyone with the shared key asserts any `X-Agent-ID`).
So we constrain the trustworthy principal now and defer the untrustworthy one.

### A role is a named verb-set; grants compose by union

- A **role** = a named set of `PermissionVerb`s (the keys of `PERMISSIONS` in
  `src/rbac/permissions.ts`).
- A **user holds a SET of roles.** Effective grant = **UNION** of the verb-sets
  of all attached roles.
- **Admission = `route.verb ∈ union`.**

Multi-attachable roles *are* the composability. There is no separate "policy"
object, no policy language, no rule ordering. "Give this user read access plus
Slack posting" is "attach the `reader` role and the `slack-poster` role."

**We explicitly defer the policy-engine tax.** No explicit `deny` rules, no
conditions, no resource-pattern matchers, no allow/deny precedence. A pure union
of grant-sets is *monotonic*: adding a role can only widen the grant. This is a
deliberate limitation, flagged honestly:

> Union-only grants cannot express "admin **except** cannot delete configs."
> Subtraction requires a `deny` primitive.

We add `deny` **only if and when a real subtract-requirement appears** — not
speculatively. Deny-precedence is a well-known debugging footgun (every access
decision becomes "which of N rules won and why"); introducing it before there is
a concrete need trades a real cost for a hypothetical benefit. See §7 for the
trigger condition.

### Policy attaches per-user now, per-key later via intersection

Policy attaches at the **user** level, via a new `principal_roles` join table
keyed by user id — **not** the existing single-valued free-form `users.role`
column. That column cannot hold multiple roles and is inert scaffolding (slice-1
derail note, `…slice1-can-audit.md:485`; research §7). It degrades to a display
hint at most; the join table is the source of truth.

We keep the door open for **per-token scopes** later with one documented rule,
decided now so future token work is not an escalation path or a repaint:

> A token's effective grant = **`intersection(user's roles, token's roles)`**.
> A key can only ever **NARROW** its user's grant, never widen it.

This is GitHub fine-grained-PAT semantics: a scoped key is a *subset* of what its
owner can do. Documenting the intersection rule now is what guarantees a
per-token schema, whenever we build it, is monotone-narrowing by construction —
it can never become a privilege-escalation vector.

### Fail-closed + default role

- **Fail-closed.** An empty grant admits only the GET / no-verb fallback (see §6
  on why "read-only" is a verb-set, not literally GET). A user with no roles can
  reach nothing that declares a write verb.
- **Default role.** Turning enforcement on must be a **behavior no-op** for
  existing users. Every existing user is seeded a default role whose verb-set
  matches current user capability — this is the plan's
  `default_unattributed_role = admin` idea (`…slice1-can-audit.md:476`) made
  concrete as a real attached role rather than a fallback constant. Enabling
  enforcement with the default seeded is observably identical to today.

## 4. The route-verb contract and why the backlog is a prerequisite

Admission matches `route.verb` against the user's grant. That only works on
routes that **declare a real verb**. Two failure modes for the others:

- A route that declares `{ ungated: "…" }` has no verb to match.
- A route in `ROUTE_RBAC_BACKLOG` (`scripts/check-rbac-coverage.ts:219`, 149
  non-GET routes pinned ungated at slice 1) likewise has nothing to match.

A scoped user key **cannot be meaningfully constrained** on such a route — the
admission engine has no verb to test set-membership against. The fail-closed
default there is: **`ungated` (or backlogged) + non-GET ⇒ operator-only** — a
scoped user principal cannot reach it at all.

Therefore burning down `ROUTE_RBAC_BACKLOG` — assigning each route a real verb —
is a **precondition** for user policies covering the HTTP write surface, not
parallel cleanup. Until a route has a verb, the only user-token posture available
for it is "closed." The backlog is the work-list that makes the surface
*expressible*.

**Low-hanging fruit.** Several backlogged HTTP routes already have MCP-side verbs
to reuse — the HTTP handlers are a parallel *ungated* path around tool gates that
are already verb-tagged:

- `/api/skills/*` ↔ the `skill.*` verbs (`skill.create.swarm`,
  `skill.install.any`, `skill.update.any`, `skill.delete.any`, …).
- `/api/mcp-servers/*` ↔ the `mcp-server.*` verbs.
- `/api/scripts/*` (global write/delete) ↔ `script.global.write` /
  `script.global.delete`.

These migrate first: the verb already exists, the handler just needs the `can()`
call plus an inline `rbac: { permission }` on the `route()` def, and its backlog
entry deletes (the coverage check enforces that inline-and-backlogged is an
error — `check-rbac-coverage.ts:387`).

The same backlog logic applies to the 76 `UNGATED_TOOL_FILES` in the coverage
check for the MCP surface, though tools are lower priority for user policy since
users reach the HTTP surface first.

## 5. Config verbs (SHIPPED — PR #925)

Built separately, outside the increment sequence, because it closed a
present-tense hole: `delete-config` / `set-config` were ungated for any
agent, and `get-config?includeSecrets=true` was ungated. Three lead-only verbs,
now live in `src/rbac/permissions.ts` (plus `config.credential-bindings.write`):

- `config.write.any` — gate `set-config` (and `PUT /api/config`,
  `DELETE /api/config/{id}`).
- `config.delete.any` — gate config deletion.
- `config.read.secrets` — gate `get-config` with `includeSecrets=true`.

They follow the existing `leadOnly` legacy rule and are registered in
`src/rbac/permissions.ts` + `src/rbac/legacy-policy.ts` like any other verb.

**`db-query` needs separate treatment — do not fold it into the config verbs.**
`POST /api/db-query` / the `db-query` tool run arbitrary **read-only SQL** that
*may* touch secret tables (`oauth_tokens`, credential rows) but usually does not.
A simple principal gate (lead-only) would break every legitimate non-secret read.
Correctly gating it needs either query/table analysis (parse the SQL, gate only
reads that hit sensitive tables) or a blunt blanket lead-only decision accepted
as a usability cost. This is an **open question** (§7), deliberately not bundled
into the config-verb work.

## 6. Method is a proxy; the verb is the truth

"Read-only" must be defined as a **verb-set** (`*.read.*` verbs + GET routes),
**not** literally "GET method only." Two POST endpoints are semantically reads:

- `POST /api/memory/search`
- `POST /api/scripts/search`

A pure HTTP-method rule would wrongly block them for a read-only user. The HTTP
method is only the **fallback** for routes that do not yet declare a verb (the
GET/no-verb admission fallback in §3). Once a route declares its verb, the verb
is authoritative and the method is irrelevant. This is another reason the backlog
burn-down (§4) matters: assigning `*.read.*` verbs to the POST-but-read endpoints
is what lets a read-only role include them.

## 7. Revised increment map (replaces Appendix B increments 3–6)

### Increment 3 — Role engine (per-user, union, deny-deferred)

Migrations: `roles`, `role_permissions`, and a **`principal_roles`** join table
keyed by **user id** (not the free-form `users.role` column). Seed data:

- Legacy-equivalent roles reproducing current capability, and a **default role**
  seeded onto every existing user so enabling enforcement is a no-op (§3).

Engine: resolve a user principal's **effective grant = union** of attached roles'
verb-sets. `RBAC_ENABLED` flag at the top of the admission path: OFF → today's
behavior (operator/agent unaffected, users unconstrained); ON → user tokens gated
at admission against the union.

Explicitly **in scope**: per-user attachment, union semantics, fail-closed empty
grant, default-role seeding, `bun run src/cli.tsx rbac:bootstrap` idempotent
backfill. Explicitly **deferred**: `deny` primitive, conditions, resource-pattern
matchers (§3). Acceptance: enabling with seeded defaults is a behavioral no-op
(the slice-1 characterization suite stays green with the flag ON).

> Change from Appendix B: the outline described a `principal-stack intersection`
> (`agent ∩ originator ∩ trigger-source`) as the enable-time model. That
> conflated two different things. **Per-user role composition is UNION.** The
> only **intersection** in the design is the *future per-token* narrowing rule
> (user-roles ∩ token-roles), which is increment-4 framing, not increment-3
> mechanics.

### Increment 4 — Identity, with policy-attachment framing

`user_api_keys` table (hashed, prefix, revoke/expire) + bearer introspection in
`resolveHttpRequestAuth`. Note (verified 2026-07-07): `aswt_` bearers are already
backed by an existing `user_tokens` table (sha256 `tokenHash`, `revokedAt` —
`src/be/users.ts:490`); increment 4 must reconcile with or extend that table
rather than assume greenfield. Framed explicitly as a **policy-attachment point**: a
key may carry its own role set, and its effective grant is
**`intersection(owner's roles, key's roles)`** — the documented monotone-narrow
rule from §3. Building the key schema with the intersection rule baked in is what
keeps per-token scoping from ever becoming an escalation path.

Also increment 4 (unchanged from Appendix B): the **signed agent-context token**
(carries `agent_id` + per-task `originator_user_id`, minted on lead→worker
handoff) replacing self-asserted `X-Agent-ID`. Hard prerequisite for trusting any
role-based **agent** scoping; user-RBAC (increments 3 + this note's admission
layer) does not wait on it (§3).

### Increment 5 — The `rbac` route/tool field IS the admission contract

**Elevated from Appendix B's "defense-in-depth" to "primary admission gate for
user tokens."** The field already shipped this session:
`rbac?: { permission: PermissionVerb } | { ungated: string }` on `RouteDef`
(`src/http/route-def.ts:43`), enforced for coverage by
`check-rbac-coverage.ts`. Increment 5 makes `handleCore` *enforce* the declared
verb at admission for user principals (§2 Layer a), and burns down
`ROUTE_RBAC_BACKLOG` so the surface is expressible (§4) — starting with the
routes whose MCP-side verbs already exist (skills, mcp-servers, scripts). A
matching `rbac` field on `ToolConfig` / `createToolRegistrar` extends admission to
the MCP surface; prompt-time tool filtering (`buildBasePrompt`) can hide forbidden
tools as a UX layer on top.

> The per-site handler `can()` calls remain (Layer b, §2). What changes vs
> Appendix B is which layer is "primary": for user tokens, the admission verb-gate
> is the first-class control, and the handler `can()` is the resource-scoped
> refinement — not the other way around.

### Increment 6 — Resource ACLs (unchanged)

`channel_members` / `repo_access` / `agent_access` with resource-local roles;
`can()` consults the ACL first, falls back to global roles; creator-becomes-owner
defaults + audit-logged backfill on enable. Still depends on increment 4 for
trusted agent scoping.

### Outside the increment sequence — Config verbs (SHIPPED — PR #925)

`config.write.any` / `config.delete.any` / `config.read.secrets` are live (§5).
`db-query` treatment remains an open question, not part of this.

### Parallel track (unchanged) — Memory RBAC

Separate plan; the SOFT-classified `isLead` sites from slice 1 are its work-list
(`…slice1-can-audit.md:450`).

## 8. Open questions

1. **Deny primitive timing.** Union-only grants cannot express "everything except
   X" (§3). Trigger to add `deny`: the first concrete role definition that is
   genuinely a subtraction of a broader role (not expressible as a smaller
   positive verb-set). Until then, don't build it — deny-precedence is a
   debugging footgun.
2. **`db-query` treatment.** Blanket lead-only (breaks legitimate non-secret
   reads) vs query/table analysis (gate only reads touching `oauth_tokens` /
   credential tables) vs leave ungated behind operator-only admission (§5).
3. **Do sensitive GET reads eventually need verbs?** Admission's GET/no-verb
   fallback (§2, §6) means read routes are currently unconstrained for users.
   Some GET reads are sensitive (secret-adjacent config reads, other agents'
   context). At what point does a read-only user need to be *further* restricted,
   i.e. do sensitive GETs need explicit `*.read.secrets`-style verbs so the
   fallback stops being "all reads allowed"?
4. **Per-token schema when we build it.** The intersection rule is decided (§3,
   increment 4); the concrete `user_api_keys`↔roles schema, the CLI surface
   (`rbac:issue-key`), and how a key's role set is authored are not yet designed.

## 9. References

- Slice-1 plan (Appendix B this note revises):
  `thoughts/taras/plans/2026-07-07-des-445-rbac-slice1-can-audit.md`
- Shipped slice-1 artifacts: `src/rbac/can.ts`, `src/rbac/permissions.ts`,
  `src/rbac/legacy-policy.ts`, `src/rbac/types.ts`
- Route contract: `src/http/route-def.ts` (`RouteDef.rbac`), admission point
  `src/http/core.ts` (~`:251`), coverage gate `scripts/check-rbac-coverage.ts`
- Auth resolution: `src/http/auth.ts`, `src/utils/request-auth-context.ts`
- Brainstorm: `thoughts/taras/brainstorms/2026-05-15-rbac-for-swarm.md`
- Research: `thoughts/taras/research/2026-07-06-rbac-enforcement-surfaces.md`
- Linear: DES-445
</content>
</invoke>
