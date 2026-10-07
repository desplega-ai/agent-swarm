# Jira Interaction (Read + Outbound Push)

The swarm has Jira OAuth support but no inbound sync. Use Atlassian REST API v3 through script credential bindings.

## Authentication: script credential binding

Use the `swarm-scripts` skill and `script-run` (`args` first, `ctx` second) for every authenticated request. The API server resolves an OAuth authorization, refreshes it when needed, and substitutes `[REDACTED:<BINDING_KEY>]` in the request header only for the binding's allowed hosts. Never read credential tables, request a raw token from Lead, or copy a token into source, arguments, environment variables, logs, or task output.

Before running examples, ask Lead to confirm an active OAuth binding visible to your agent: its non-secret `configKey`, `allowedHosts`, and token status. Lead uses `credential-bindings` action `list`; if missing, Lead registers/authorizes the provider and creates a binding with `authKind: "oauth"`, `oauthAuthorizationId`, the allowed host below, and `headerTemplate: "Authorization: Bearer [REDACTED:<BINDING_KEY>]"`. Replace `<BINDING_KEY>` with that actual key, not a token. There is no assumed default Jira or Linear binding.

If access is unavailable, report the missing binding or authorization as a blocker. An expiring authorization is refreshed server-side; a refresh failure, revoked/missing authorization, or persistent 401 needs Lead/user re-authorization through `credential-bindings` action `oauth-authorize-url`. Do not query expiry/token columns or loop on 401s.

Supported implementation: `src/be/script-credential-broker.ts` loads scoped relational bindings and calls `resolveOAuthBindingToken` from `src/be/oauth-credential-bindings.ts`. The scripts runtime substitutes placeholders at egress for allowed hosts.

## Calling pattern

Allowed host: `api.atlassian.com`. Use the 3LO proxy `https://api.atlassian.com/ex/jira/<CLOUD_ID>/rest/api/3`, rather than the site hostname. Keep the site, cloud ID, and default project as deployment-specific values.

Run this source with `script-run`, supplying non-secret `args`: `cloudId`, `path`, optional `method`, `query`, and `body`. Replace `<BINDING_KEY>` with Lead's confirmed binding key.

```typescript
export default async function (args, ctx) {
  const url = new URL(`https://api.atlassian.com/ex/jira/${encodeURIComponent(args.cloudId)}/rest/api/3/${args.path}`);
  for (const [key, value] of Object.entries(args.query ?? {})) {
    url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, {
    method: args.method ?? "GET",
    headers: {
      Authorization: "Bearer [REDACTED:<BINDING_KEY>]",
      Accept: "application/json",
      ...(args.body ? { "Content-Type": "application/json" } : {}),
    },
    ...(args.body ? { body: JSON.stringify(args.body) } : {}),
  });
  if (!response.ok) throw new Error(`Jira HTTP ${response.status}: ${await response.text()}`);
  return response.status === 204 ? { success: true } : await response.json();
}
```

Return only the issue/project fields needed for the task, never headers or credentials. To discover the cloud ID, use the same script header in a GET to `https://api.atlassian.com/oauth/token/accessible-resources`; select the authorized site's resource ID and confirm its scopes permit the intended operation.

## Common operations

Pass these paths and payloads to the script above. GET is the default.

| Operation | Method and path | Query or body |
|---|---|---|
| List projects | GET `project/search` | Read `values` for keys, names, IDs |
| Get project and issue types | GET `project/<PROJECT_KEY>` | Read `issueTypes` before creating issues |
| Search issues | GET `search/jql` | `query: { jql: "project = <PROJECT> AND statusCategory != Done", fields: "summary,status,assignee,priority" }` |
| Create issue | POST `issue` | `body: { fields: { project: { key: "<PROJECT>" }, summary: "Short title", issuetype: { name: "Task" }, description: <ADF_DOC> } }` |
| Discover transitions | GET `issue/<KEY>/transitions` | Read `transitions` for the target status |
| Transition issue | POST `issue/<KEY>/transitions` | `body: { transition: { id: "<TRANSITION_ID>" } }` |
| Comment | POST `issue/<KEY>/comment` | `body: { body: <ADF_DOC> }` |
| Find account | GET `user/search` | `query: { query: "<name-or-email>" }` |
| Assign | PUT `issue/<KEY>/assignee` | `body: { accountId: "<ACCOUNT_ID>" }`; null unassigns |
| Edit fields | PUT `issue/<KEY>` | `body: { fields: { summary: "New summary", labels: ["swarm"] } }` |

Issue creation returns `{ id, key, self }` (201). The human URL is `https://<your-site>.atlassian.net/browse/<KEY>`. Transitions, assignment, and edits return 204 without a body.

## ADF cheat-sheet

ADF = JSON tree. Always wrap content in `{ "type": "doc", "version": 1, "content": [...] }`.

Common nodes:
- Paragraph: `{ "type": "paragraph", "content": [ { "type": "text", "text": "hi" } ] }`
- Bold: `{ "type": "text", "text": "x", "marks": [{ "type": "strong" }] }`
- Code inline: `{ "type": "text", "text": "x", "marks": [{ "type": "code" }] }`
- Code block: `{ "type": "codeBlock", "attrs": { "language": "bash" }, "content": [ { "type": "text", "text": "echo hi" } ] }`
- Bullet list: `{ "type": "bulletList", "content": [ { "type": "listItem", "content": [ { "type": "paragraph", "content": [...] } ] } ] }`
- Link: `{ "type": "text", "text": "click", "marks": [{ "type": "link", "attrs": { "href": "https://..." } }] }`

If you need rich content, build it in a script — don't try to write deep ADF inline in shell.

## Operational rules

- Discover transitions per issue; IDs vary by project and workflow.
- Use `/search/jql` for cloud searches.
- Descriptions, comments, and rich text fields require ADF documents.
- Assignment uses account IDs rather than usernames.
- For bulk work use the `swarm-scripts` skill, handle pagination, and back off on 429 using `Retry-After`.
- Check every response before reporting success. On 400 inspect `errorMessages`/`errors`; on 403 confirm scopes and issue permissions with Lead; on 404 verify the cloud ID, project, and issue key. On refresh failure or persistent 401 request re-authorization.

## Worked workflow: close an issue

1. Run GET `issue/<KEY>/transitions` through the script and select the intended transition from the returned workflow.
2. Run POST `issue/<KEY>/transitions` with the discovered transition ID.
3. Confirm the 204 success before reporting the issue transitioned. For multiple issues, discover transitions for each issue and process pagination rather than assuming all workflows match.

The MCP tracker tools manage sync mappings; they do not replace this authenticated Jira request path.
