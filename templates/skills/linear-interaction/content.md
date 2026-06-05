# Linear Interaction (Outbound Push)

**Before attempting any API call below, check if the token has been renewed:**
```bash
# Use db-query MCP tool
db-query: SELECT accessToken, expiresAt FROM oauth_tokens WHERE provider = 'linear'
```
If `expiresAt` is in the past, do NOT attempt the API calls — just report the needed update in your task output.

To re-authorize, use your swarm API base URL with `/api/trackers/linear/authorize` (potentially needing to remove the app and re-auth). Only mention this if you can confirm the token is expired or not present.

---

## Critical Context

The swarm's Linear integration is **inbound-only**: Linear → swarm. This means:
- When a Linear issue is created/updated, it creates swarm tasks automatically
- But when you complete a swarm task, the Linear issue is **NOT** updated automatically
- To push status changes, comments, or create issues in Linear, you must use the **Linear GraphQL API directly**

The available MCP tracker tools (`tracker-link-task`, `tracker-link-epic`, `tracker-sync-status`, `tracker-map-agent`, `tracker-unlink`) are for managing sync mappings, NOT for pushing updates to Linear.

## When to Transition (Timing)

- **Direct-to-main work:** Transition the Linear ticket to **Done** the moment the worker reports ship (commits on `main`). Do NOT wait for review, test-run, or merge when there is no PR to wait for. Waiting causes blocker digests to flag RESOLVED-STALE tickets.
- **Standard PR workflow:** Transition to **In Review** on PR open, **Done** after merge. If the ticket is still "In Progress" 30 min after the PR merges, you're late.
- **Blocked:** If a ticket is stuck on a dependency, add a comment linking the blocker — don't leave it silent.

## Authentication

The OAuth token is stored in the swarm database (`oauth_tokens` table, provider = 'linear').

**To get the token:**
```bash
# Use db-query MCP tool
db-query: SELECT accessToken FROM oauth_tokens WHERE provider = 'linear'
```

> **Worker agents (non-lead):** If you are a non-lead agent and cannot access the Linear token via `db-query`, message the lead agent in the task and request the token. Do not complete the task without updating Linear.

**Token details:**
- Scopes: `app:assignable app:mentionable comments:create issues:create read write`
- Tokens expire — check `expiresAt` column. If expired, the user needs to re-authorize via the OAuth flow.
- API endpoint: `https://api.linear.app/graphql`

## Making API Calls

All Linear API calls use GraphQL via POST to `https://api.linear.app/graphql`.

```bash
curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <ACCESS_TOKEN>" \
  -d '{"query": "<GRAPHQL_QUERY>"}'
```

## Agent Interaction API — `action` vs `thought`

Linear's **Agent Interaction API** (different from issue mutations above) supports two activity payload kinds. Use this section whenever emitting `agentActivityCreate` mutations.

| Activity kind | When to use | `parameter` field |
|---|---|---|
| `thought` | Narrative status updates, reasoning, mid-task progress, anything you want to **read in the Linear timeline** but doesn't represent a concrete operation | Not required — free-form `body` |
| `action` | Discrete operation the agent **performed** — branch create/merge, PR open, code commit, file write, message sent | **Required**, non-empty string. Linear rejects empty parameter |

**Mapping rule (canonical):** if you can't fill `parameter` with a real noun (branch name, PR URL, file path, recipient), it's a `thought`, not an `action`.

**Common mappings from swarm events:**

| Swarm event | Linear activity | parameter |
|---|---|---|
| `task.progress` (tool call narration) | `thought` | n/a |
| `task.created` | `action` | `"task: <description>"` |
| `task.completed` | `action` | `"completed: <output preview>"` |
| `task.failed` | `action` | `"failed: <reason>"` |
| Branch create / merge / delete | `action` | branch name |
| PR open / review / merge | `action` | PR URL |

**Why this trips people:** "action" reads naturally as "every tool call IS an action…". But Linear uses `action` to mean *parameterized operation Linear can index/route on*, not *task-progress-narration*. Narration is `thought`.

## Common Operations

### 1. Update Issue Status (e.g., mark as Done)

**Step 1: Get the issue ID and team workflow states**

```graphql
query {
  issue(id: "<ISSUE-IDENTIFIER>") {
    id
    identifier
    state { id name }
    team {
      id
      states { nodes { id name type } }
    }
  }
}
```

Note: `<ISSUE-IDENTIFIER>` can be the issue UUID or the human-readable identifier like "DES-12".

**Step 2: Find the target state ID**

From the response, find the state you want in `team.states.nodes`. Common state types:
- `backlog` — Backlog
- `unstarted` — Todo/Unstarted
- `started` — In Progress
- `completed` — Done
- `canceled` — Canceled

**Step 3: Update the issue**

```graphql
mutation {
  issueUpdate(id: "<ISSUE-UUID>", input: { stateId: "<TARGET-STATE-UUID>" }) {
    success
    issue { id identifier state { name } }
  }
}
```

**Known state IDs:**
- Store your team's common state UUIDs in local notes or swarm config; do not hardcode another team's IDs into this template.

### 2. Add a Comment to an Issue

```graphql
mutation {
  commentCreate(input: {
    issueId: "<ISSUE-UUID>"
    body: "Your comment text here. Supports **markdown**."
  }) {
    success
    comment { id body }
  }
}
```

### 3. Create a New Issue

```graphql
mutation {
  issueCreate(input: {
    teamId: "<TEAM-UUID>"
    title: "Issue title"
    description: "Issue description in **markdown**"
    priority: 2
  }) {
    success
    issue { id identifier url }
  }
}
```

Priority values: 0 = No priority, 1 = Urgent, 2 = High, 3 = Medium, 4 = Low

### 4. Assign an Issue

```graphql
mutation {
  issueUpdate(id: "<ISSUE-UUID>", input: { assigneeId: "<USER-UUID>" }) {
    success
    issue { id identifier assignee { name } }
  }
}
```

### 5. Add Labels to an Issue

```graphql
mutation {
  issueUpdate(id: "<ISSUE-UUID>", input: { labelIds: ["<LABEL-UUID-1>", "<LABEL-UUID-2>"] }) {
    success
    issue { id identifier labels { nodes { name } } }
  }
}
```

### 6. Query Issues (for lookup)

```graphql
query {
  issues(filter: { team: { key: { eq: "DES" } }, state: { type: { neq: "completed" } } }) {
    nodes { id identifier title state { name } priority assignee { name } }
  }
}
```

## Complete Workflow Example: Close a Linear Ticket

This is the most common scenario — completing a Linear-sourced swarm task and updating the ticket:

```bash
# 1. Get the token
TOKEN=$(db-query result from oauth_tokens)

# 2. Get issue details and team states
curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"query": "{ issue(id: \"DES-12\") { id team { states { nodes { id name type } } } } }"}'

# 3. Find the "Done" state UUID from the response (type: "completed")

# 4. Update the issue
curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"query": "mutation { issueUpdate(id: \"<ISSUE-UUID>\", input: { stateId: \"<DONE-STATE-UUID>\" }) { success issue { identifier state { name } } } }"}'
```

## Important Notes

- **Always update Linear when completing Linear-sourced tasks.** The user expects the ticket to reflect the swarm's work. Marking only the swarm task as complete is insufficient. Do not complete only the swarm task — failing to update Linear breaks the sync and wastes resources.
- **Transition timing:** see the "When to Transition" section above. Direct-to-main work transitions on ship, not on merge.
- **Token expiry:** Check `expiresAt` before making calls. If expired, notify the user — they need to re-authorize.
- **Rate limits:** Linear has rate limits. For bulk operations, add small delays between calls.
- **Issue identifiers vs UUIDs:** The human-readable identifier (e.g., "DES-12") works for queries but the `issueUpdate` mutation requires the actual UUID. Always fetch the UUID first via a query.
- **Markdown support:** Linear supports markdown in descriptions and comments.

## Error Handling

Common errors:
- `401 Unauthorized` → Token expired or invalid, needs re-auth
- `Forbidden` → Token doesn't have required scope
- `Entity not found` → Wrong issue ID/identifier
- `"parameter must not be empty"` (or similar on Agent Interaction API) → You sent an `action` activity without a `parameter` — convert to `thought` or fill in a real noun. See "Agent Interaction API — action vs thought" above.
- Rate limited → Back off and retry after delay
