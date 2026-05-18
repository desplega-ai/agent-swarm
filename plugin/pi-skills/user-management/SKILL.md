---
name: user-management
description: "How to manage the user registry — creating users for new Slack/GitHub/GitLab/Linear identities, managing aliases, resolving users across platforms. Use when a new human interacts with the swarm or when user identity needs updating."
---

# User Management

Manage the swarm's user registry — creating, updating, resolving, and listing users. Users link human identities across platforms (Slack, GitHub, GitLab, Linear, email) so the swarm can track who requested work.

> **Migration note (2026-05)**: the old top-level identity fields (`slackUserId`, `linearUserId`, `githubUsername`, `gitlabUsername`) and the fuzzy `name` lookup were removed in lockstep with the user-identity refactor. Use the new `{kind, externalId}` shape instead. Old payloads now fail Zod validation at runtime — there is no compatibility shim.

## When to Create Users

Create a new user when:
- An **unknown Slack user** sends a message to the swarm (`resolve-user` with `{kind: "slack", externalId: "<U_X>"}` returns no match)
- An **unknown GitHub user** opens an issue or PR that triggers a task
- An **unknown GitLab user** creates an issue or MR
- An **unknown Linear user** is assigned to or creates a synced issue
- A human explicitly asks to be registered

**Do NOT** create duplicate users. Always call `resolve-user` first — by `{kind, externalId}` AND, when you have it, by `email` — to check if the person already exists under a different platform identity.

## Tools

Two MCP tools handle user management:

### `resolve-user` — Find an existing user

Looks up a user by an `(kind, externalId)` pair OR by email (primary or alias). Use this BEFORE creating a new user. Caller MUST supply either `(kind + externalId)` OR `email` — empty input is rejected.

```
# Lookup by platform identity
resolve-user with:
  kind: "slack"
  externalId: "U12345"

# OR
resolve-user with:
  kind: "github"
  externalId: "octocat"

# OR
resolve-user with:
  kind: "gitlab"
  externalId: "octocat"

# OR
resolve-user with:
  kind: "linear"
  externalId: "uuid-from-linear"

# OR lookup by email (primary or alias)
resolve-user with:
  email: "user@example.com"
```

Email lookup is case-insensitive and checks the primary `email` column AND every entry in `emailAliases`.

### `manage-user` — CRUD operations

Identities are managed via a declarative `identities: [{kind, externalId}, ...]` array:

- On **create**: every entry in `identities` is linked (each emits `identity_added`).
- On **update**: `identities` is treated as the full desired set. Helper computes a diff against the user's current identities — adds emit `identity_added`, removes emit `identity_removed`. Omit the field entirely to leave identities untouched.

```
# Create a new user
manage-user with:
  action: "create"
  name: "Jane Doe"                            # Required
  email: "jane@company.com"                   # Optional
  role: "engineering lead"                    # Optional, free-form
  identities:                                 # Optional
    - kind: "slack"
      externalId: "U12345"
    - kind: "github"
      externalId: "janedoe"
    - kind: "linear"
      externalId: "uuid-from-linear"
  emailAliases: ["jane.doe@company.com"]      # Optional
  timezone: "America/New_York"                # Optional
  notes: "Prefers async communication"        # Optional
  dailyBudgetUsd: 25.0                        # Optional — null/omitted = unlimited
  status: "active"                            # Optional — "invited" | "active" | "suspended"

# List all users
manage-user with:
  action: "list"

# Get a specific user
manage-user with:
  action: "get"
  userId: "<uuid>"

# Update a user (declarative — pass the FULL desired set for `identities`)
manage-user with:
  action: "update"
  userId: "<uuid>"
  identities:                                 # FULL desired set; diff is applied
    - kind: "slack"
      externalId: "U12345"
    - kind: "github"
      externalId: "janedoe-new"               # renamed → identity_added + identity_removed
  emailAliases: ["jane.doe@company.com", "jd@example.com"]   # emits email_added/email_removed per delta

# Delete a user
manage-user with:
  action: "delete"
  userId: "<uuid>"
```

## Workflow: New Slack User

1. Receive a message from an unknown Slack user (e.g., external ID `U_NEW123`).
2. Call `resolve-user` with `{kind: "slack", externalId: "U_NEW123"}` — returns null.
3. Get the user's Slack profile (name, email) via `slack-read` or from the message metadata.
4. Call `resolve-user` with `{email: "<their-email>"}` — check if they exist under a different platform.
5. If found: call `manage-user` with `action: "update"`, passing the user's FULL identity set including the new Slack entry.
6. If not found: call `manage-user` with `action: "create"`, including `name`, `email`, and `identities: [{kind: "slack", externalId: "U_NEW123"}]`.

## Workflow: New GitHub User

1. Receive a webhook from an unknown GitHub user (e.g., login `octocat`).
2. Call `resolve-user` with `{kind: "github", externalId: "octocat"}` — returns null.
3. Call `manage-user` with `action: "create"`, including at minimum `name` and `identities: [{kind: "github", externalId: "octocat"}]`.
4. If you know their email (from the webhook payload), include it.

## Workflow: Linking Identities

When you discover a known user is also active on another platform:

1. Call `resolve-user` to find them by their known identity.
2. Call `manage-user` with `action: "update"`, passing the FULL desired `identities` set (existing + the new one).

Example: You know "Jane" by Slack ID, and discover her GitHub login:

```
resolve-user kind: "slack" externalId: "U_JANE"
→ returns user with id "abc-123" (identities currently: [{kind: "slack", externalId: "U_JANE"}])

manage-user action: "update" userId: "abc-123"
  identities:
    - kind: "slack"
      externalId: "U_JANE"
    - kind: "github"
      externalId: "janedoe"
→ adds GitHub identity (emit identity_added). Slack identity unchanged.
```

## Important Notes

- `manage-user` is **lead-only** — workers cannot use it for any action (the lead check happens before action dispatch). Workers must use `resolve-user` for lookups.
- The `(kind, externalId)` PK on `user_external_ids` means the same identifier cannot be linked to two different users — a re-link to a different user surfaces as a PK collision (the operator can investigate via the People page merge flow).
- Deleting a user clears `requestedByUserId` on all their associated tasks (sets to null).
- Email aliases are case-insensitive for resolution. Editing them via `manage-user update` emits `email_added` / `email_removed` events per delta.
- The `preferredChannel` field defaults to `"slack"` and can be `"slack"`, `"email"`, `"github"`, `"gitlab"`, or any custom string.
- `dailyBudgetUsd` is `null` = unlimited.
- `status` lifecycle: `invited` → `active` → `suspended`. The CHECK constraint rejects other values.
