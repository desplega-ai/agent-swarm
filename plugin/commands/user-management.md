---
description: "How to manage the user registry — creating users for new Slack/GitHub/GitLab identities, managing aliases, resolving users across platforms. Use when a new human interacts with the swarm or when user identity needs updating."
argument-hint: [action]
---

# User Management

Manage the swarm's user registry — creating, updating, resolving, and listing users. Users link human identities across platforms (Slack, GitHub, GitLab, Linear, email) so the swarm can track who requested work.

## When to Create Users

Create a new user when:
- An **unknown Slack user** sends a message to the swarm (no `resolveUser` match for their `slackUserId`)
- An **unknown GitHub user** opens an issue or PR that triggers a task
- An **unknown GitLab user** creates an issue or MR
- An **unknown Linear user** is assigned to or creates a synced issue
- A human explicitly asks to be registered

**Do NOT** create duplicate users. Always call `resolve-user` first to check if the person already exists under a different platform identity.

## Tools

Two MCP tools handle user management:

### `resolve-user` — Find an existing user

Looks up a user by any platform identity. Use this BEFORE creating a new user.

```
resolve-user with:
  slackUserId: "U12345"       # Slack member ID
  # OR
  githubUsername: "octocat"    # GitHub username
  # OR
  gitlabUsername: "octocat"    # GitLab username
  # OR
  linearUserId: "uuid"        # Linear user UUID
  # OR
  email: "user@example.com"   # Primary email or alias
  # OR
  name: "Jane Doe"            # Fuzzy name search (least specific)
```

Priority order: platform IDs > email > name. Platform IDs are exact matches; email checks aliases (case-insensitive); name is substring match.

### `manage-user` — CRUD operations

```
# Create a new user
manage-user with:
  action: "create"
  name: "Jane Doe"                          # Required
  email: "jane@company.com"                 # Optional
  role: "engineering lead"                  # Optional, free-form
  slackUserId: "U12345"                     # Optional
  githubUsername: "janedoe"                 # Optional
  gitlabUsername: "janedoe"                 # Optional
  linearUserId: "uuid-from-linear"          # Optional
  emailAliases: ["jane.doe@company.com"]    # Optional
  timezone: "America/New_York"              # Optional
  notes: "Prefers async communication"      # Optional

# List all users
manage-user with:
  action: "list"

# Get a specific user
manage-user with:
  action: "get"
  userId: "<uuid>"

# Update a user (only send fields to change)
manage-user with:
  action: "update"
  userId: "<uuid>"
  githubUsername: "new-username"

# Delete a user
manage-user with:
  action: "delete"
  userId: "<uuid>"
```

## Workflow: New Slack User

1. Receive a message from an unknown Slack user (e.g., `slackUserId: "U_NEW123"`)
2. Call `resolve-user` with `slackUserId: "U_NEW123"` — returns null
3. Get the user's Slack profile (name, email) via `slack-read` or from the message metadata
4. Call `resolve-user` with `email: "<their-email>"` — check if they exist under a different platform
5. If found: call `manage-user` with `action: "update"` to add their `slackUserId`
6. If not found: call `manage-user` with `action: "create"` including name, email, and slackUserId

## Workflow: New GitHub User

1. Receive a webhook from an unknown GitHub user (e.g., `githubUsername: "octocat"`)
2. Call `resolve-user` with `githubUsername: "octocat"` — returns null
3. Call `manage-user` with `action: "create"` including at minimum `name` and `githubUsername`
4. If you know their email (from the webhook payload), include it

## Workflow: Linking Identities

When you discover a known user is also active on another platform:

1. Call `resolve-user` to find them by their known identity
2. Call `manage-user` with `action: "update"` to add the new platform identity

Example: You know "Jane" by Slack ID, and discover her GitHub username:
```
resolve-user slackUserId: "U_JANE"  → returns user with id "abc-123"
manage-user action: "update" userId: "abc-123" githubUsername: "janedoe"
```

## Important Notes

- `manage-user` is **lead-only** — workers cannot use it for any action (the lead check happens before action dispatch). Workers must use `resolve-user` for lookups.
- `slackUserId`, `githubUsername`, `gitlabUsername`, and `linearUserId` have **unique constraints** — duplicates will error.
- Deleting a user clears `requestedByUserId` on all their associated tasks (sets to null).
- Email aliases are case-insensitive for resolution.
- The `preferredChannel` field defaults to `"slack"` and can be `"slack"`, `"email"`, `"github"`, or `"gitlab"`.
