# Jira Interaction (Read + Outbound Push)

The swarm has Jira OAuth connected but **no inbound sync** (unlike Linear). Every read or write is a direct API call against the Atlassian REST API v3.

## TL;DR — Minimum Knowledge

1. Pull the access token from `oauth_tokens` (provider = `jira`).
2. Hit `https://api.atlassian.com/ex/jira/<CLOUD_ID>/rest/api/3/...` — NOT `desplega.atlassian.net`. 3LO bearer tokens only work via the `api.atlassian.com` proxy.
3. Bodies for descriptions/comments must be in **ADF** (Atlassian Document Format), not plain text.

## Known Constants (Desplega Tenant)

- Site: `desplega.atlassian.net`
- Cloud ID: `0054e739-8d39-4f01-8d6a-431619cae8fc`
- Default project: `KAN` ("Swarm")

If the cloudId changes, rediscover it:
```bash
curl -s -H "Authorization: Bearer $TOKEN" -H "Accept: application/json" \
  https://api.atlassian.com/oauth/token/accessible-resources | jq '.'
```

## Authentication

The OAuth token is in `oauth_tokens` table, provider = `jira`.

```sql
-- via db-query MCP tool
SELECT accessToken, expiresAt, scope FROM oauth_tokens WHERE provider = 'jira';
```

**Always check `expiresAt` first.** Atlassian tokens are short-lived (~1h). If expired, report it — do NOT retry.

## Common Operations

### Search Issues with JQL

```bash
curl -s -G \
  -H "Authorization: Bearer $TOKEN" -H "Accept: application/json" \
  --data-urlencode 'jql=project = KAN AND statusCategory != Done' \
  --data-urlencode 'fields=summary,status,assignee,priority' \
  "https://api.atlassian.com/ex/jira/$CLOUD_ID/rest/api/3/search/jql"
```

Use `/search/jql` — the legacy `/search` is deprecated.

### Create an Issue

```bash
curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" -H "Accept: application/json" -H "Content-Type: application/json" \
  "https://api.atlassian.com/ex/jira/$CLOUD_ID/rest/api/3/issue" \
  -d '{
    "fields": {
      "project": { "key": "KAN" },
      "summary": "Short title",
      "issuetype": { "name": "Task" },
      "description": {
        "type": "doc",
        "version": 1,
        "content": [
          { "type": "paragraph", "content": [ { "type": "text", "text": "Body goes here." } ] }
        ]
      }
    }
  }'
```

Returns `{ id, key, self }` on success (HTTP 201). The `key` (e.g. `KAN-7`) is the human-readable ID.

### Transition Issue Status

Known transition IDs for project `KAN`:

| Transition ID | Target state |
|---|---|
| `11` | To Do |
| `21` | In Progress |
| `31` | In Review |
| `41` | Backlog |
| `51` | **Done** |

```bash
curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" -H "Accept: application/json" -H "Content-Type: application/json" \
  "https://api.atlassian.com/ex/jira/$CLOUD_ID/rest/api/3/issue/KAN-3/transitions" \
  -d '{"transition":{"id":"51"}}'
```

### Comment on an Issue

```bash
curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" -H "Accept: application/json" -H "Content-Type: application/json" \
  "https://api.atlassian.com/ex/jira/$CLOUD_ID/rest/api/3/issue/KAN-3/comment" \
  -d '{
    "body": {
      "type": "doc", "version": 1,
      "content": [ { "type": "paragraph", "content": [ { "type": "text", "text": "Update from the swarm." } ] } ]
    }
  }'
```

## ADF Cheat-Sheet

ADF = JSON tree. Always wrap in `{ "type": "doc", "version": 1, "content": [...] }`.

- Paragraph: `{ "type": "paragraph", "content": [ { "type": "text", "text": "hi" } ] }`
- Bold: `{ "type": "text", "text": "x", "marks": [{ "type": "strong" }] }`
- Code block: `{ "type": "codeBlock", "attrs": { "language": "bash" }, "content": [ { "type": "text", "text": "echo hi" } ] }`

## Operational Rules

- **Token-expiry first.** Always check `expiresAt`. Don't loop on 401s.
- **Use the proxy.** All authenticated calls go through `api.atlassian.com/ex/jira/<cloudId>/...`.
- **ADF is mandatory** for `description`, `comment`, and rich text fields. Plain strings will be rejected.
- **Account IDs, not usernames** for assignment and mentions.
- **Rate limits:** sleep ~200–500 ms between calls for bulk operations.

## Error Handling

| Status | Likely cause | Action |
|---|---|---|
| 401 | Token expired/invalid | Check `expiresAt`. Notify user to re-auth. |
| 403 | Missing scope | Check `scope` column. |
| 404 | Wrong key, wrong cloudId | Re-verify with a project list call. |
| 400 | Body shape wrong (often ADF) | Inspect `errorMessages` / `errors` in the response. |
| 429 | Rate-limited | Back off, retry after `Retry-After` seconds. |
