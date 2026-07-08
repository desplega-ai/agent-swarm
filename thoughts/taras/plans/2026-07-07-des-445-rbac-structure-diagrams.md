---
date: 2026-07-08T00:00:00Z
author: Claude
topic: "DES-445 RBAC — final structure diagrams (increment 3 + where 4-6 attach)"
tags: [design, rbac, diagram, des-445]
status: draft
last_updated: 2026-07-08
last_updated_by: Claude
related_design: thoughts/taras/plans/2026-07-07-des-445-rbac-user-policy-admission-model.md
related_plan: thoughts/taras/plans/2026-07-07-des-445-rbac-increment3-role-engine.md
---

# DES-445 RBAC — structure diagrams

Two views: (1) the **data/policy model** — what a role is, how grants compose, where every table sits; (2) the **request flow** — how the two authorization layers stack at runtime. Solid = exists after increment 3. Dashed = future increments, shown so you can see what today's schema reserves for them.

## 1. Data / policy model

```mermaid
flowchart LR
    subgraph CREDS["Credentials"]
        SK["shared swarm key<br/>(env, one value)"]
        UT[("user_tokens<br/>aswt_* / sha256 hash / revokedAt<br/><i>exists since migration 067</i>")]
        UAK[("user_api_keys<br/><i>increment 4 — may extend user_tokens</i>")]:::future
    end

    subgraph PRINCIPALS["Principals (src/http/auth.ts)"]
        OP["operator<br/><b>god-mode, bypasses everything</b>"]
        USR["user { userId }<br/><b>the only policy-bearing principal in incr 3</b>"]
        AG["agent { agentId, isLead }<br/>self-asserted X-Agent-ID<br/><i>untrusted until incr-4 signed token</i>"]:::future
    end

    subgraph ROLEENGINE["Role engine — increment 3 (migration 109)"]
        PR[("principal_roles<br/>principalType CHECK ('user','agent')<br/>principalId, roleId")]
        R[("roles<br/>name UNIQUE, isBuiltin, <b>grantsAll</b>")]
        RP[("role_permissions<br/>roleId → verb (no SQL CHECK;<br/>validated vs PermissionVerbSchema)")]
        ADMIN["admin (builtin)<br/><b>grantsAll=1 → wildcard</b><br/>= default role, seeded to EVERY user<br/>(migration backfill + AFTER INSERT trigger)"]
        REQ["requester (builtin)<br/>task.read.own, task.cancel.own,<br/>task.action.own, task.fs.mutate<br/>= what legacy policy grants users today"]
        CUST["custom roles<br/>(operator-authored, never touched by sync)"]:::future
    end

    subgraph VERBS["Verb registry + policy — slice 1 (shipped)"]
        P["PERMISSIONS — 39 verbs<br/>src/rbac/permissions.ts<br/>e.g. kv.write.any, skill.delete.any"]
        LP["LEGACY_POLICY: verb → rule<br/>lead-only / requester-owns-task /<br/>lead-or-resource-owner / ...<br/>src/rbac/legacy-policy.ts"]
    end

    subgraph FUTURE6["Increment 6"]
        ACL[("resource ACLs<br/>channel_members / repo_access / agent_access")]:::future
    end

    SK --> OP
    UT --> USR
    UAK -. "key's grant =<br/><b>user roles ∩ key roles</b><br/>(narrow-only, never widen)" .-> USR
    USR -- "holds a SET of roles" --> PR
    AG -. "reserved 'agent' rows<br/>(incr 4/6, none written today)" .-> PR
    PR --> R
    R --> RP
    RP -- "verb names reference" --> P
    R --- ADMIN
    R --- REQ
    R -.- CUST
    P --> LP
    LP -.-> ACL

    UNION["effective grant =<br/><b>UNION of attached roles' verb-sets</b><br/>any grantsAll role ⇒ unrestricted<br/>zero roles ⇒ empty grant (fail-closed)"]
    PR ==> UNION

    classDef future stroke-dasharray: 5 5,opacity:0.75
```

Key properties of the model:

- **A role is just a named verb-set.** No policy language, no deny, no conditions. Composition is monotonic union — adding a role can only widen. Subtraction ("admin except X") is inexpressible on purpose; the `deny` primitive waits for a real subtract-requirement (design §8.1).
- **`grantsAll` is the one special case** — it exists because "what users can do today" includes 149 backlogged routes that have no verb yet, so no verb-set can express it. `admin` = wildcard = today's behavior. Once increment 5 burns the backlog down, a verb-listing "full" role becomes expressible and `grantsAll` could be retired to operator-only tooling.
- **`users.role` (the freeform TEXT column) plays no part** — display hint only; `principal_roles` is the source of truth.

## 2. Request flow — the two layers at runtime

```mermaid
flowchart TD
    REQ["HTTP request"] --> CORE["handleCore (src/http/core.ts)"]
    CORE --> PUB{"public route<br/>or /mcp-user?"}
    PUB -- "yes" --> NOAUTH["auth = null<br/>(mcp-user does its own aswt_ auth;<br/>MCP <b>tool</b> admission = increment 5)"]
    PUB -- "no" --> AUTH["resolveHttpRequestAuth"]
    AUTH -- "bearer = swarm key" --> OPP["operator → <b>skip admission</b>"]
    AUTH -- "bearer = aswt_*" --> USRP["user principal"]
    AUTH -- "invalid" --> R401["401"]

    USRP --> FLAG{"RBAC_ENABLED<br/>=== 'true'?"}
    FLAG -- "no (default)" --> SKIP["skip admission<br/>= today's behavior, byte-for-byte"]
    FLAG -- "yes" --> GRANT["getUserGrant(userId)<br/>src/be/rbac-roles.ts — 1 indexed query"]

    GRANT --> WILD{"grantsAll?"}
    WILD -- "yes (default admin)" --> SKIP
    WILD -- "no" --> LOOKUP["findRoute(method, path)<br/>src/http/route-def.ts:102"]

    LOOKUP --> KIND{"route's rbac field?"}
    KIND -- "rbac: { permission: verb }" --> INSET{"verb ∈ union?"}
    INSET -- "yes" --> ALLOW["admit  →  audit row"]
    INSET -- "no" --> DENY["403  →  audit row"]
    KIND -- "GET / HEAD<br/>(no verb needed)" --> ALLOW
    KIND -- "non-GET + ungated /<br/>backlogged / no RouteDef<br/>(incl. inline /ping, /close)" --> DENY

    OPP --> HANDLER
    SKIP --> HANDLER
    NOAUTH --> HANDLER
    ALLOW --> HANDLER["route handler"]

    HANDLER --> CAN["<b>Layer b — unchanged</b><br/>resource-scoped can(verb, resource)<br/>LEGACY_POLICY rules:<br/>'does THIS user own THIS task?'"]
    CAN --> SINK["audit sink → permission_audit<br/>(same table for both layers)"]

    style DENY fill:#7a2020,color:#fff
    style ALLOW fill:#1e5c2f,color:#fff
    style SKIP fill:#444,color:#eee
```

Key properties of the flow:

- **Layer a (admission) answers "may this principal *attempt* this class of operation"** — coarse, verb-in-set, one DB read, no resource rows. **Layer b (`can()`) answers "may it touch *this* resource"** — unchanged from slice 1. Neither replaces the other (design §2).
- **Method is a proxy; the verb is the truth.** GET fallback exists only for verb-less routes; a declared verb always wins (that's how `POST /api/memory/search` becomes reachable for a read-only role once increment 5 assigns it a `*.read.*` verb).
- **Fail-closed default:** narrow (non-wildcard) user + verb-less non-GET route = 403. That's why the 149-route backlog burn-down (increment 5) is a *prerequisite* for useful narrow roles, not parallel hygiene.

## 3. The decisions embedded above, in one list

1. **`grantsAll` wildcard on the default `admin` role** — the yellow-flag one. Alternative was "admin lists all 39 verbs", but that still 403s the 149 verb-less routes, so enabling the flag would NOT be a no-op. Wildcard is the only faithful encoding of "current capability" until the backlog shrinks. ✅ **Approved (Taras, 2026-07-08): wildcard admin stays the default for backward compat.**
2. **Default-role attachment = migration backfill + `AFTER INSERT ON users` trigger** — airtight across all 3 user-insert paths (createUser, findOrCreateUserByEmail, raw test INSERTs), no import cycles. Cost: first trigger in the codebase; a future users-table rebuild silently drops it → mitigated by migration-header warning + `ensureRbacSeedsSynced()` recreating it at every boot + a unit test. ✅ **Approved (Taras, 2026-07-08).**
3. **Builtin role verb-sets are code-authoritative** — `BUILTIN_ROLES` in `src/be/rbac-roles.ts` re-syncs `role_permissions` at boot (insert missing / delete extras, builtins only). Migration SQL is just the initial snapshot; new verbs can join `requester` without a migration.
4. **Union resolution is per-request, uncached** — one indexed query on in-process SQLite; TTL cache deferred until measured need.
5. **Admission sits inside `handleCore` right after auth** (not the index.ts handler loop) — covers inline core routes AND all `route()` routes AND the in-process test mini-servers for free.
6. **CLI is `rbac bootstrap`** (not `rbac:bootstrap`) — follows the `scripts reembed` subcommand precedent; no colon-commands exist.
   **When does it run?** Never *required* in the happy path — migration 109 backfills existing users, the trigger covers new ones, and boot re-syncs builtin roles + trigger automatically. It's an idempotent operator tool for three moments: (a) **pre-enable audit** — run it right before flipping `RBAC_ENABLED=true` on an existing deployment; the summary (roles, verb counts, attached-user counts, users with zero roles, flag state) tells you enabling is safe; (b) **drift recovery** — a user stripped of all roles (accident, restored/hand-edited DB) gets the default back; (c) **post-restore/merge sanity** after any manual DB surgery. Safe to run any time; second run is a no-op.
7. **Admission audit rows only for non-wildcard grants** — default-role traffic adds zero rows; narrow-role allows AND denies both land in `permission_audit` (`resourceType='http-route'`).
