# Jira Interaction (Read + Outbound Push)

The swarm has Jira OAuth connected but **no inbound sync** (unlike Linear). Every read or write is a direct API call against the Atlassian REST API v3.

## TL;DR — minimum knowledge

1. Pull the access token from `oauth_tokens` (provider = `jira`).
2. Hit `https://api.atlassian.com/ex/jira/<CLOUD_ID>/rest/api/3/...` — not your site hostname directly. 3LO bearer tokens only work via the `api.atlassian.com` proxy.
3. Bodies for descriptions/comments must be in **ADF** (Atlassian Document Format), not plain text or markdown.

## Deployment constants

- Site: `<your-site>.atlassian.net`
- Cloud ID: `<cloud-id>`
- Default project: `<PROJECT>`
- Scopes on the stored token: confirm from `oauth_tokens.scope` before write operations

If the cloudId ever changes, rediscover it:
```bash
curl -s -H "Authorization: Bearer $TOKEN" -H "Accept: application/json" \
  https://api.atlassian.com/oauth/token/accessible-resources | jq '.'
```

## Authentication

The OAuth token is in the swarm DB (`oauth_tokens`, provider = `jira`).

```sql
-- via the db-query MCP tool
SELECT accessToken, expiresAt, scope FROM oauth_tokens WHERE provider = 'jira';
```

**Always check `expiresAt` first.** Atlassian access tokens are short-lived (~1h). If expired, do NOT keep retrying — report it. Re-auth path:

```
<SWARM_API_BASE_URL>/api/trackers/jira/authorize
```
(User may need to remove the app and re-auth.)

## Calling pattern

Every endpoint below is relative to:
```
https://api.atlassian.com/ex/jira/<CLOUD_ID>/rest/api/3
```

Standard header set:
```bash
-H "Authorization: Bearer $TOKEN"
-H "Accept: application/json"
-H "Content-Type: application/json"   # only on POST/PUT
```

## Common operations

### 1. List projects

```bash
curl -s -H "Authorization: Bearer $TOKEN" -H "Accept: application/json" \
  "https://api.atlassian.com/ex/jira/$CLOUD_ID/rest/api/3/project/search" \
  | jq '.values[] | {key, name, id, projectTypeKey}'
```

### 2. Get a project (with issue types + lead)

```bash
curl -s -H "Authorization: Bearer $TOKEN" -H "Accept: application/json" \
  "https://api.atlassian.com/ex/jira/$CLOUD_ID/rest/api/3/project/$PROJECT_KEY" \
  | jq '{key, name, lead: .lead.displayName, issueTypes: [.issueTypes[] | {id, name, subtask}]}'
```

### 3. Search issues with JQL

Use the **`/search/jql`** endpoint (the older `/search` is deprecated for cloud).

```bash
curl -s -G \
  -H "Authorization: Bearer $TOKEN" -H "Accept: application/json" \
  --data-urlencode 'jql=project = <PROJECT> AND statusCategory != Done' \
  --data-urlencode 'fields=summary,status,assignee,priority' \
  "https://api.atlassian.com/ex/jira/$CLOUD_ID/rest/api/3/search/jql" \
  | jq '[.issues[] | {key, summary: .fields.summary, status: .fields.status.name, assignee: .fields.assignee.displayName}]'
```

### 4. Create an issue

Description must be ADF. Minimal valid ADF:

```bash
curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" -H "Accept: application/json" -H "Content-Type: application/json" \
  "https://api.atlassian.com/ex/jira/$CLOUD_ID/rest/api/3/issue" \
  -d '{
    "fields": {
      "project": { "key": "<PROJECT>" },
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

Returns `{ id, key, self }` on success (HTTP 201). The `key` (e.g. `<PROJECT>-7`) is what humans use; URL is `https://<your-site>.atlassian.net/browse/<KEY>`.

Available issue types are project-specific; list the project before creating issues.

### 5. Transition issue status (e.g. → Done)

Transitions are project- and workflow-specific. Always discover them first:

```bash
curl -s -H "Authorization: Bearer $TOKEN" -H "Accept: application/json" \
  "https://api.atlassian.com/ex/jira/$CLOUD_ID/rest/api/3/issue/<KEY>/transitions" \
  | jq '.transitions[] | {id, name, to: .to.name}'
```

Transition IDs are project-specific. Do not copy IDs between Jira projects; discover them for the issue you are about to update.

Transition (returns HTTP 204 on success, no body):

```bash
curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" -H "Accept: application/json" -H "Content-Type: application/json" \
  "https://api.atlassian.com/ex/jira/$CLOUD_ID/rest/api/3/issue/<KEY>/transitions" \
  -d '{"transition":{"id":"<TRANSITION_ID>"}}'
```

### 6. Comment on an issue

ADF body again:

```bash
curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" -H "Accept: application/json" -H "Content-Type: application/json" \
  "https://api.atlassian.com/ex/jira/$CLOUD_ID/rest/api/3/issue/<KEY>/comment" \
  -d '{
    "body": {
      "type": "doc", "version": 1,
      "content": [ { "type": "paragraph", "content": [ { "type": "text", "text": "Update from the swarm." } ] } ]
    }
  }'
```

### 7. Assign an issue

Atlassian Cloud uses **accountId**, not username. Find one via:

```bash
curl -s -G -H "Authorization: Bearer $TOKEN" -H "Accept: application/json" \
  --data-urlencode 'query=<name-or-email>' \
  "https://api.atlassian.com/ex/jira/$CLOUD_ID/rest/api/3/user/search" \
  | jq '.[] | {accountId, displayName, emailAddress}'
```

Assign:
```bash
curl -s -X PUT \
  -H "Authorization: Bearer $TOKEN" -H "Accept: application/json" -H "Content-Type: application/json" \
  "https://api.atlassian.com/ex/jira/$CLOUD_ID/rest/api/3/issue/<KEY>/assignee" \
  -d '{"accountId":"<ACCOUNT_ID>"}'
```

To unassign: `{"accountId": null}`.

### 8. Edit fields on an existing issue

```bash
curl -s -X PUT \
  -H "Authorization: Bearer $TOKEN" -H "Accept: application/json" -H "Content-Type: application/json" \
  "https://api.atlassian.com/ex/jira/$CLOUD_ID/rest/api/3/issue/<KEY>" \
  -d '{ "fields": { "summary": "New summary", "labels": ["swarm","auto"] } }'
```

Returns HTTP 204.

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

- **Token-expiry first.** Always check `expiresAt`. Don't loop on 401s.
- **Use the proxy.** All authenticated calls go through `api.atlassian.com/ex/jira/<cloudId>/...`. Hitting `<your-site>.atlassian.net/rest/api/3/...` with a 3LO bearer token will fail.
- **Discover transitions per issue** before transitioning — different projects/workflows have different IDs.
- **Use `/search/jql`**, not the legacy `/search` (which is deprecated and may be removed).
- **ADF is mandatory** for `description`, `comment`, and rich text fields. Plain strings will be rejected.
- **Account IDs, not usernames** for assignment, mentions, and filters.
- **Rate limits:** Atlassian rate-limits per app and per user. For bulk transitions/comments, sleep ~200–500 ms between calls.
- **Don't leak tokens.** Never echo the access token to logs or Slack. Read it into an env var only.

## Error handling

| Status | Likely cause | Action |
|---|---|---|
| 401 | Token expired/invalid | Check `expiresAt`. Notify user to re-auth. Don't retry. |
| 403 | Missing scope, or restricted issue | Check the `scope` column. For `write:jira-work` operations, confirm scope is present. |
| 404 | Wrong key, wrong cloudId, wrong project | Re-verify with a project list call. |
| 400 | Body shape wrong (often ADF or required field) | Inspect `errorMessages` / `errors` in the response JSON. |
| 429 | Rate-limited | Back off, retry after `Retry-After` seconds. |

## Complete worked example: clean a project

```bash
TOKEN=$(db-query "SELECT accessToken FROM oauth_tokens WHERE provider='jira'")
CLOUD_ID="<cloud-id>"
PROJECT_KEY="<PROJECT>"

# 1. List open issues in KAN
curl -s -G -H "Authorization: Bearer $TOKEN" -H "Accept: application/json" \
  --data-urlencode "jql=project = $PROJECT_KEY AND statusCategory != Done" \
  --data-urlencode 'fields=summary,status' \
  "https://api.atlassian.com/ex/jira/$CLOUD_ID/rest/api/3/search/jql" \
  | jq -r '.issues[].key' > /tmp/keys.txt

# 2. Transition each to Done using the transition ID discovered for this workflow
for KEY in $(cat /tmp/keys.txt); do
  curl -s -X POST \
    -H "Authorization: Bearer $TOKEN" -H "Accept: application/json" -H "Content-Type: application/json" \
    "https://api.atlassian.com/ex/jira/$CLOUD_ID/rest/api/3/issue/$KEY/transitions" \
    -d '{"transition":{"id":"<DONE_TRANSITION_ID>"}}'
  sleep 0.3
done
```

## Notes for swarm sync (future)

- The MCP tracker tools (`tracker-link-task`, `tracker-sync-status`, etc.) are designed for two-way sync mappings. Jira tracker support exists at the schema level but is not currently wired up to inbound webhooks. Until it is, all Jira interaction must go through this skill.
- If/when inbound Jira webhooks land, this skill should add a "When to transition" section mirroring the Linear one.
