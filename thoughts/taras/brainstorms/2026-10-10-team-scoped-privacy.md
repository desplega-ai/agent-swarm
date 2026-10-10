---
date: 2026-10-10
author: Taras (with Claude)
topic: "Team-scoped privacy: private tasks, memories, and connections per user or team"
tags: [brainstorm, rbac, governance, teams, privacy, sso, enterprise]
status: complete
exploration_type: idea
last_updated: 2026-10-10
last_updated_by: Claude
---

# Team-scoped privacy. Brainstorm

## Context

Taras wants the swarm to be production and enterprise ready for multi-team use.

The reference scenario: an HR team uses the swarm. Some of their work must be visible only to HR users and to the agents working for them. This covers:

1. Private tasks per user or team.
2. User- and team-specific memories.
3. User- and team-specific connections (for example, HR's HRIS OAuth credentials).
4. Other surfaces (KV, pages, files, logs).

This doc records where the code stands today (verified on `main` at `1d5897af9`, 2026-10-10) and the direction we converged on.

### Prior art

- `thoughts/taras/brainstorms/2026-05-15-rbac-for-swarm.md`: the origin RBAC brainstorm.
- `thoughts/taras/research/2026-07-06-rbac-enforcement-surfaces.md`.
- `thoughts/taras/plans/2026-07-07-des-445-rbac-*.md`: DES-445 increments 1, 2, 3 and 5 (shipped 2026-07-07 to 07-09, PRs #921, #935, #951).
- `thoughts/taras/plans/2026-07-30-des-717-rbac-spine-replan.md`: the DES-717 spine re-plan. Draft. No phase has started.
- Issue #1958: centralize request auth to principal resolution. Open.

## Where we stand today

### RBAC

The plumbing is real and CI-enforced. It restricts no human user today.

- **`can()` policy layer** (`src/rbac/can.ts:29`). About 140 verbs (`src/rbac/permissions.ts`) are checked against a hardcoded rule table (`src/rbac/legacy-policy.ts:263`). It always runs, whatever `RBAC_ENABLED` says. It restricts agents and leads.
- **Role engine** (migration `109_rbac_roles.sql`): `roles`, `role_permissions`, `principal_roles(principalType, principalId, roleId)`. It applies only to user tokens (`aswt_`) on REST and `/mcp-user` (`src/http/core.ts:475`). `RBAC_ENABLED` defaults to `true` (`src/rbac/admission.ts:18`).
- **It is a no-op in practice.** A trigger and a boot "pre-GA heal" (`src/be/rbac-roles.ts:344`) attach every user to `rbac-role-admin` (`grantsAll`). `attachRole`/`detachRole` have no production callers. There is no role-assignment API or UI.
- **All grants are global.** `principal_roles` has no scope column.
- **Principals** (`src/http/auth.ts:26-71`): operator (shared API key), user (`aswt_`), agent (`aseph_` session), guest (page session, always denied).
- **Audit.** Decisions go to `permission_audit` (30-day retention, `src/be/rbac-audit.ts:38`). No HTTP route reads it.
- **CI.** `check-rbac-coverage.ts` (about 120 non-GET routes sit in `ROUTE_RBAC_BACKLOG`) and `check-rbac-boundary.sh`.

### Other governance controls

| Area | State |
|---|---|
| HITL approvals | Solid. Quorum, approvers by user or role, expiry, auto-cancel (`src/http/approval-requests.ts`). No generic "this tool requires approval" gate |
| Secrets | Solid. AES-256-GCM, reserved keys, validators (`src/be/swarm-config-guard.ts`), egress scrubbing |
| Budgets | Partial. Daily USD per global, agent, or user, checked at claim (`src/be/budget-admission.ts:72`). No per-task cap |
| Tool surface | `SWARM_ENABLED_TOOLS`, per-task manifests, scripts SDK allowlist, `ext:<name>` identities. Controls which tools exist, not per-user policy |
| Sandbox / SSRF | Scripts run with ulimits and a clean env. No network isolation. SSRF guard fails closed outside dev and test |
| Tenancy | None. No org, workspace, or team model |
| Retention | Opt-in for logs and events (`src/be/db-retention.ts`). None for approvals, tasks, budgets |

### Gaps for the HR scenario, surface by surface

| Surface | Today |
|---|---|
| Tasks | Only `requestedByUserId`. `GET /api/tasks` and `GET /api/tasks/{id}` return everything (`src/http/tasks.ts:799`, `:1411`). Session logs, costs, sessions, and task files check only that the task exists |
| Task routing | Any eligible pool agent can claim. `isAgentEligibleForTask` ignores tags (`src/be/db/agents.ts:621`) |
| Agent reads | `requesterOwnsTask` returns `true` for every caller that is not a user (`src/rbac/legacy-policy.ts:179`). Any agent can read any task |
| Memory | Scopes are only `agent` and `swarm` (`001_initial.sql:274`). Leads skip the agent filter (`src/be/memory/providers/sqlite-store.ts:898`). Dashboard users see all |
| Connections / OAuth | Scopes `global`, `agent`, `repo`. `oauth_authorizations.userId` is recorded but never checked at use (`src/be/oauth-credential-bindings.ts:55`). Broker context is `{agentId, repoId}` only |
| Swarm config | Scopes `global`, `agent`, `repo`. No user scope |
| KV | Any caller can read any namespace by design (`src/tools/kv/kv-read-auth.ts:3`) |
| Pages / assets | Page list, resolve, and launch have no owner check (`src/http/pages.ts:561`). `personal/<userId>/` asset keys limit writes only |
| Workspace / files | One `/workspace/shared` volume for all agents. One agent-fs org and drive per swarm (`src/fs/agent-fs-provider.ts:99-107`) |
| Slack | Output goes to the source thread. Channel members can read it |
| Dashboard | Uses the operator key, so it sees everything |
| SSO | A gate, not identity. oauth2-proxy in front of the dashboard, all users share the operator key. No OIDC, SAML, SCIM, or forwarded-header reading in `src/` |

### The three blockers under everything

1. **No team concept.** No `teams` or membership table. `users.role` is free text, used only for approver matching (`src/http/approval-requests.ts:756`).
2. **Agents are not real identities.** Workers use the shared operator key plus an unverified `X-Agent-ID` header (`src/http/request-principal.ts:27`). Any per-row filter can be bypassed while this holds.
3. **The originator never reaches agent calls.** The requester appears only in the prompt (`src/http/poll.ts:101`). Nothing downstream can ask "is this HR work?"

DES-717 phases 3, 4, and 6 (originator source, signed agent identity, originator-aware `can()`) address blockers 2 and 3. **DES-717 is a prerequisite for team privacy.**

Near term, the only real isolation for an HR-like customer is a **separate swarm deployment**.

## Exploration

### Q: Don't we already have roles? Do we need teams separately?

Roles answer **what you may do** (verbs). Teams answer **which data you may see** (scope). We need both.

Using roles alone as teams causes role explosion: one verb per team (`task.read.team:hr`) and one role per team and level (`hr-admin`, `hr-requester`). Data rows still need a team tag.

**Direction:** keep one role engine and add scope.

```sql
CREATE TABLE teams (id, name, parentId, externalSource, externalId, ...);

-- add to principal_roles:
scopeType TEXT CHECK (scopeType IN ('global','team')) DEFAULT 'global',
scopeId   TEXT  -- teams.id when scopeType='team'
```

- Membership is a role binding ("Alice is `requester` in HR"). No separate members table is needed.
- `principalType` already allows `'agent'`, so team-bound agents use the same table.
- Today's global `admin`/`requester` stay valid as `scopeType='global'`.

This matches GitHub (org and team roles) and GCP IAM (bindings on a resource).

### Q: Team hierarchies and multiple teams owning one resource?

**Multi-owner:** use a join table instead of a single `teamId`.

```sql
CREATE TABLE resource_teams (
  resourceType TEXT,   -- 'task' | 'memory' | 'connection' | ...
  resourceId   TEXT,
  teamId       TEXT REFERENCES teams(id),
  access       TEXT CHECK (access IN ('owner','viewer')),
  PRIMARY KEY (resourceType, resourceId, teamId)
);
CREATE INDEX ON resource_teams(teamId, resourceType);
```

- **Union semantics.** Membership in any listed team grants access. No AND semantics.
- **`owner` vs `viewer`.** Owners edit, delete, and change sharing. Viewers read.

**Hierarchy:** `teams.parentId` plus a `team_closure(ancestorId, descendantId)` table (or `WITH RECURSIVE`). Each request computes the caller's effective team set once.

- Access flows **down**: a role in "People Ops" applies in its child "Recruiting".
- Never up.
- An `isolated` flag on a team stops inheritance ("HR Investigations" under "Operations").
- Suggested v1: store `parentId`, ship without inheritance unless a real customer needs nesting.

**Two problems that matter more than the schema:**

1. **Derived data must inherit teams.** Child tasks, memories, KV, files, and logs created during an HR task must copy its teams. Otherwise the agent's learnings go swarm-wide. This needs originator propagation (DES-717).
2. **Filtered vector search.** Top-K then filter gives HR users worse recall. The filter must run before or inside the KNN step. Needs a spike.

### Q: Should we plug in an existing engine?

Researched 2026-10-10. Only OpenFGA's SQLite status was checked against a primary source (README: "SQLite (beta)"). The rest comes from search snippets.

| Option | Fit | Catch |
|---|---|---|
| OpenFGA | Zanzibar. Hierarchies and multi-owner built in. Apache-2.0, CNCF Incubating, Auth0 FGA in prod since 2021. Node SDK | Separate Go service. SQLite is beta. Dual-write sync. ListObjects default cap 1,000 |
| Cerbos | Stateless PDP, no sync. `PlanResources` emits SQL filters (Drizzle adapter for SQLite) | No relationship model. Hierarchy and multi-owner stay in our tables |
| SpiceDB | Most capable Zanzibar engine | No SQLite datastore. Needs Postgres |
| Skip | Oso (OSS deprecated, cloud proprietary), Ory Keto (no "list what I can see"), Topaz (Aserto shut down), WorkOS FGA and Permit (SaaS) | |

**Taras:** does not want a sidecar. Asked whether in-house is hard.

**Decision direction: build in-house, Zanzibar-shaped.** It is not hard for our scope.

- **Pieces:** `teams` with `parentId`, `team_closure`, `scopeType/scopeId` on `principal_roles`, `resource_teams`, and a `visibility` column on each scoped resource.
- **Helpers:** `teamsOf(principal)` (once per request, cached) and `visibleTo(principal)` (a SQL `EXISTS` clause every list query joins). `can()` checks team-scoped grants against the resource's teams.
- **Why it wins for us:**
  - Filters join in SQL. No ListObjects cap, and memory search can pre-filter.
  - Team rows commit in the same transaction as the resource. No outbox, no sync.
  - No new service for compose, Helm, or single-node installs.
- **Cost:** we own correctness and get no policy language. Mitigate with property tests on hierarchy and sharing. The Zanzibar shape (subject, relation, object) keeps a later move to OpenFGA a data migration, not a redesign.
- **Size:** the model and helpers take days. Wiring every read path takes weeks, and that is the same with an engine.

### Q: Will the relation table grow a ton?

Not if we tag **containers**, not every row.

- **Tag:** root tasks, memories, connections, KV namespaces, pages, workflows.
- **Inherit through a foreign key (no rows):** session logs, costs, task files, child tasks.
- **Swarm-wide resources:** no rows.

1M tasks at about 1.2 teams each is about 1.2M short rows. That is fine for SQLite with an index on `(teamId, resourceType)`. Volume is not the risk. **Wrong data is the risk.**

### Q: How do we make sure it is populated correctly?

Correction to an earlier idea: "no rows = swarm-wide" **fails open**. One missed insert leaks HR data. Instead:

- **Explicit `visibility` column** (`'swarm' | 'teams'`). If `visibility='teams'` and there are no team rows, only admins see it. Bugs hide data instead of leaking it.
- **One write path.** `assignTeams()` / `insertScoped()` runs in the same transaction as the insert.
- **Teams come from the context, not the creator.**

**Taras:** enforce it with a script, like the audit fields. Agreed: `scripts/check-visibility-columns.ts`, with three layers:

1. **Schema.** Every table has `visibility TEXT NOT NULL CHECK (visibility IN ('swarm','teams'))` with **no default**, or is listed in `.non-scoped-tables` with a reason. The opt-out list forces new tables to decide.
2. **Write path.** A grep check (like `check-rbac-boundary`) bans raw `INSERT INTO <scoped_table>` outside the helper.
3. **Runtime invariant.** A periodic sweep reports `visibility='teams'` rows with no team rows.

### Q: If I am in 4 teams and create something, are there 4 rows?

No. Membership is 4 rows in `principal_roles`, stored once. A new resource gets **one** row: the team of the current context. More rows come only from explicit sharing. Tagging all 4 teams would be the leak. Hierarchy adds no rows, because parent access is computed at read time.

### Q: How do we know which team you are working in?

From the entry point, resolved in order. The first match wins.

1. **Parent task.** Children and agent-created data inherit the task's teams.
2. **Channel or source binding.** `#hr-private` maps to HR. Linear team or project, GitHub repo, or email inbox can map the same way.
3. **Workflow or schedule owner.**
4. **Dashboard or API team switcher** (like the GitHub org picker). Sent as `X-Team-ID` or `teamId` on create, checked against membership.
5. **Team-bound agent.** An HR-only agent tags everything as HR.
6. **Fallback.** A single-team user gets that team. Otherwise the user's default team. If nothing resolves, the resource is personal (a team of one), so it fails closed.

Hard case: a Slack DM from a user in 4 teams. Claude leans toward personal plus a one-click "share with team".

### Q: Does agent-fs need this too?

Yes. agent-fs has its own authorization, and the swarm uses one org and one drive today.

- One drive per team.
- Swarm team membership synced into drive members. The swarm stays the source of truth.
- Agents get credentials only for the drives of their current task's teams.

This needs a matching slice of work in the agent-fs repo. Drive-member semantics were not checked in detail.

### Q: How does it fit SSO?

**Taras:** that is the goal. Teams must fit SSO.

Needed:

- **Per-user login.** OIDC in the API, or trusted-header identity that the API consumes.
- **SCIM `/Users` and `/Groups`.** IdP groups map to teams (`teams.externalSource`, `externalId`) with a role per mapping. Memberships managed by the IdP are read-only in the UI.
- **Deprovisioning.** A SCIM user deactivation revokes that user's tokens and team roles.

Enterprise buyers ask whether Okta or Entra groups become swarm teams. This sits next to the authorization work, not after it.

## Synthesis

### Key decisions (direction, not yet planned)

- **The team is the unit of privacy.** User-private means a team of one.
- **One role engine with scope.** No parallel team-permission system.
- **In-house, Zanzibar-shaped.** No sidecar engine. Keep a later move to OpenFGA possible.
- **Join table, union semantics, owner/viewer.**
- **Fail closed everywhere.** An explicit `visibility` column, no default, CI-enforced like audit columns.
- **Tag containers, inherit the rest** through foreign keys.
- **Team context comes from the entry point,** in the resolution order above.
- **Team-bound agents** go with team-scoped data. Filtering rows while agents stay shared is much harder.
- **Teams come from the IdP** through SCIM.

### Suggested order

1. DES-717 phases 3 and 4: signed agent identity and an originator on every call.
2. Teams, team-scoped `principal_roles`, and a role-assignment API and UI. Remove the "pre-GA heal".
3. Per-user login and SCIM group to team mapping.
4. Team-bound agents and a team check in pool eligibility.
5. `visibility` and `resource_teams` with read filters, in this order: tasks with logs and files, memory, connections and OAuth, KV and pages.
6. Physical separation: workspace volume and agent-fs drive per team. Slack routing for private tasks.
7. Team-aware lead. Today `isLead` bypasses memory scoping and manages all connections.

### Open questions

- Inheritance in v1, or `parentId` only?
- Slack DM from a multi-team user: personal, default team, or ask?
- Can a script run by an agent use a user's private connection? The broker has no notion of the human today.
- How does the lead route team-private work without seeing it?
- Should the cloud offering use the same model per tenant, or a separate tenant layer above teams?
- Filtered vector search approach (pre-filter vs over-fetch). Needs a spike.
- Who may mint agent tokens (DES-717 open decision 4)?

### Not verified

- Linear DES-445 and DES-717 status (`linear-mcp` returned 401).
- RBAC posture of `/api/db-query`.
- Linear and GitHub inbound attribution, steering-message routes.
- Engine details other than OpenFGA's SQLite status.
- agent-fs drive-member semantics.

## Next steps

- `/desplega:research` on team-scoped privacy, using DES-717 as the base and this doc as input.
- Refresh DES-717 (migration 123 is taken, it now needs a new ordinal) and fold in the team model.
- Spike: filtered vector search on the memory store.
