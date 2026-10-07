# Linear Interaction (Outbound Push)

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

## Authentication: script credential binding

Use the `swarm-scripts` skill and `script-run` (`args` first, `ctx` second) for every authenticated request. The API server resolves an OAuth authorization, refreshes it when needed, and substitutes `[REDACTED:LINEAR_OAUTH_ACCESS_TOKEN]` in the request header only for the binding's allowed hosts. Never read credential tables, request a raw token from Lead, or copy a token into source, arguments, environment variables, logs, or task output.

Try the conventional binding key `LINEAR_OAUTH_ACCESS_TOKEN` first, using `Authorization: Bearer [REDACTED:LINEAR_OAUTH_ACCESS_TOKEN]` for `api.linear.app`. Do not ask Lead before the first try. `credential-bindings` is lead-only; workers cannot list bindings.

On HTTP 401 with the conventional key, report the missing binding or authorization to Lead as a blocker. The fetch wrapper in `src/scripts-runtime/credential-broker/fetch-patch.ts` drops any header with an unresolved `[REDACTED:` placeholder, so a missing binding sends an unauthenticated request that yields 401, never a credential leak.

Lead uses `credential-bindings` action `list` to check the binding. If missing, Lead registers/authorizes the provider and creates a binding visible to the agent with `configKey: "LINEAR_OAUTH_ACCESS_TOKEN"`, `authKind: "oauth"`, `oauthAuthorizationId`, `allowedHosts: ["api.linear.app"]`, and `headerTemplate: "Authorization: Bearer [REDACTED:LINEAR_OAUTH_ACCESS_TOKEN]"`.

An expiring authorization is refreshed server-side; a refresh failure, revoked/missing authorization, or persistent 401 needs Lead/user re-authorization through `credential-bindings` action `oauth-authorize-url`. Do not query expiry/token columns or loop on 401s.

Supported implementation: `src/be/script-credential-broker.ts` loads scoped relational bindings and calls `resolveOAuthBindingToken` from `src/be/oauth-credential-bindings.ts`. The scripts runtime substitutes placeholders at egress for allowed hosts.

## Making API calls

Allowed host: `api.linear.app`. Send GraphQL queries and mutations with `script-run`; the common operations below supply the `query` and optional `variables`:

```typescript
export default async function (args, ctx) {
  const response = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer [REDACTED:LINEAR_OAUTH_ACCESS_TOKEN]",
    },
    body: JSON.stringify({ query: args.query, variables: args.variables ?? {} }),
  });
  if (!response.ok) throw new Error(`Linear HTTP ${response.status}`);
  const result = await response.json();
  if (result.errors?.length) throw new Error(JSON.stringify(result.errors));
  return result.data;
}
```

Return only the issue fields needed for the task; never return request headers or credentials.

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

Run the query in operation 1 through the script above to get the issue UUID and team states. Select the state whose `type` is `completed`, then run `issueUpdate` with that state UUID through the same script. Check GraphQL errors and mutation `success` before reporting the ticket updated.

## Important Notes

- **Always update Linear when completing Linear-sourced tasks.** The user expects the ticket to reflect the swarm's work. Marking only the swarm task as complete is insufficient. Do not complete only the swarm task — failing to update Linear breaks the sync and wastes resources.
- **Transition timing:** see the "When to Transition" section above. Direct-to-main work transitions on ship, not on merge.
- **Authorization failures:** Report refresh failures or persistent 401s to Lead/user for re-authorization; the server handles normal expiry.
- **Rate limits:** Linear has rate limits. For bulk operations, add small delays between calls.
- **Issue identifiers vs UUIDs:** The human-readable identifier (e.g., "DES-12") works for queries but the `issueUpdate` mutation requires the actual UUID. Always fetch the UUID first via a query.
- **Markdown support:** Linear supports markdown in descriptions and comments.

## Error Handling

Common errors:
- `401 Unauthorized` → Report the missing binding or authorization to Lead as a blocker; Lead checks provisioning or re-authorization
- `Forbidden` → Token doesn't have required scope
- `Entity not found` → Wrong issue ID/identifier
- `"parameter must not be empty"` (or similar on Agent Interaction API) → You sent an `action` activity without a `parameter` — convert to `thought` or fill in a real noun. See "Agent Interaction API — action vs thought" above.
- Rate limited → Back off and retry after delay
