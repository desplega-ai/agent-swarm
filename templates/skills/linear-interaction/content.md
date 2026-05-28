# Linear Interaction (Outbound Push)

The swarm's Linear integration is **inbound-only**: Linear → swarm. When you complete a swarm task, the Linear issue is NOT updated automatically. To push status changes, comments, or create issues in Linear, use the Linear GraphQL API directly.

**Before any API call, check if the token is valid:**
```bash
# via db-query MCP tool
db-query: SELECT accessToken, expiresAt FROM oauth_tokens WHERE provider = 'linear'
```
If `expiresAt` is in the past, do NOT attempt the API calls — report the expired token.

## When to Transition (Timing)

- **Sprint cadence with direct-to-main commits:** Transition to **Done** the moment the worker reports ship. Do NOT wait for review — waiting causes HEARTBEAT/blocker-digest to flag RESOLVED-STALE tickets.
- **Standard PR workflow:** Transition to **In Review** on PR open, **Done** after merge.
- **Blocked:** If a ticket is stuck on a dependency, add a comment linking the blocker.

## Authentication

OAuth token is in `oauth_tokens` table, provider = `'linear'`.

- API endpoint: `https://api.linear.app/graphql`
- Auth: `Authorization: Bearer <ACCESS_TOKEN>`

## Making API Calls

All Linear API calls use GraphQL via POST:

```bash
curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <ACCESS_TOKEN>" \
  -d '{"query": "<GRAPHQL_QUERY>"}'
```

## Common Operations

### Update Issue Status

```graphql
# Step 1: Get issue + team states
query {
  issue(id: "DES-12") {
    id
    identifier
    state { id name }
    team {
      id
      states { nodes { id name type } }
    }
  }
}

# Step 2: Update to target state
mutation {
  issueUpdate(id: "<ISSUE-UUID>", input: { stateId: "<TARGET-STATE-UUID>" }) {
    success
    issue { id identifier state { name } }
  }
}
```

Known Done state ID for Desplega Labs: `83d3fcc6-dfeb-44fa-b719-64108ddc850d`

### Add a Comment

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

### Create a New Issue

```graphql
mutation {
  issueCreate(input: {
    teamId: "<TEAM-UUID>"
    title: "Issue title"
    description: "Description in **markdown**"
    priority: 2
  }) {
    success
    issue { id identifier url }
  }
}
```

Priority: 0 = None, 1 = Urgent, 2 = High, 3 = Medium, 4 = Low

## Agent Interaction API — `action` vs `thought`

Linear's Agent Interaction API supports two payload kinds:

| Kind | When to use | `parameter` field |
|---|---|---|
| `thought` | Narrative status updates, mid-task progress | Not required |
| `action` | Discrete operation performed (branch, PR, commit, file write) | **Required**, non-empty string |

Rule: if you can't fill `parameter` with a real noun (branch name, PR URL), it's a `thought`, not an `action`.

## Error Handling

| Status | Likely cause | Action |
|---|---|---|
| `401 Unauthorized` | Token expired/invalid | Check `expiresAt`, notify user to re-auth |
| `Forbidden` | Missing scope | Check `scope` column |
| `Entity not found` | Wrong issue ID | Re-verify with query |
| `"parameter must not be empty"` | `action` activity without a `parameter` | Convert to `thought` or fill a real noun |

## Important Notes

- **Always update Linear when completing Linear-sourced tasks.** Only marking the swarm task as complete is insufficient.
- **Issue identifiers vs UUIDs:** The human-readable identifier (e.g., "DES-12") works for queries but `issueUpdate` requires the actual UUID.
- **Worker agents** unable to access `db-query` should message the lead agent to get the token.
