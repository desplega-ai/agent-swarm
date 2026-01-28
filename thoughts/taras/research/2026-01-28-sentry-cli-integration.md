---
date: 2026-01-28T14:46:00+00:00
researcher: Claude
git_commit: 1699caad0908ad26de3fc72c19600ce6789f27e3
branch: main
repository: agent-swarm
topic: "Sentry CLI Integration for Agent Workers"
tags: [research, sentry, cli, workers, slack, monitoring]
status: complete
autonomy: critical
last_updated: 2026-01-28
last_updated_by: Claude
---

# Research: Sentry CLI Integration for Agent Workers

**Date**: 2026-01-28T14:46:00+00:00
**Researcher**: Claude
**Git Commit**: 1699caad0908ad26de3fc72c19600ce6789f27e3
**Branch**: main

## Research Question

How to set up sentry-cli in agent-swarm workers so they can:
1. Receive Sentry issue links and get issue details for fixing
2. Add mentions in Slack Sentry alerts to the lead agent
3. Handle similar debugging/monitoring use cases

Environment variables already configured: `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`

## Summary

**`sentry-cli` supports issue investigation and triage.** While it's primarily known as a CI/CD and release management tool, it also has `issues` and `events` subcommands for querying and managing issues.

The recommended approach is to **install `sentry-cli` in the Docker worker image** and let agents know they can use it directly. Workers already have environment variables `SENTRY_AUTH_TOKEN` and `SENTRY_ORG` configured.

Key CLI commands for agents:
- `sentry-cli issues list` - List/search issues with query filters
- `sentry-cli events list` - List events for a project
- `sentry-cli issues resolve/mute/unresolve` - Bulk manage issues
- `sentry-cli info` - Verify authentication

The existing Slack integration (`src/slack/`) provides the infrastructure for routing Sentry alerts to agents - the lead agent receives Slack messages via the inbox system and can delegate to workers. Agents can parse Sentry URLs from alerts themselves to extract issue IDs.

## Detailed Findings

### sentry-cli Capabilities

The CLI provides:

**Issue Management:**
- `sentry-cli issues list` - List issues with filters (`--query "is:unresolved"`, `--status`, `--id`)
- `sentry-cli issues resolve` - Bulk resolve issues
- `sentry-cli issues mute` - Bulk mute issues
- `sentry-cli issues unresolve` - Bulk unresolve issues

**Event Listing:**
- `sentry-cli events list` - List events for a project (`--show-tags`, `--show-user`)

**Release Management:**
- `sentry-cli releases` - Create, finalize, manage releases
- `sentry-cli sourcemaps upload` - Upload JS source maps
- `sentry-cli debug-files upload` - Upload debug symbols

**Utilities:**
- `sentry-cli info` - Verify authentication and connection
- `sentry-cli send-event -m "message"` - Send test events

**Limitations:**
- Cannot retrieve full event stacktraces/breadcrumbs (use REST API for detailed event data)
- Cannot get detailed issue metadata beyond what `issues list` provides

### Sentry REST API (for Detailed Event Data)

While `sentry-cli` handles most issue operations, use the REST API for detailed event data (stacktraces, breadcrumbs):

#### 1. List Organization Issues
```bash
curl "https://sentry.io/api/0/organizations/${SENTRY_ORG}/issues/?query=is:unresolved" \
  -H "Authorization: Bearer ${SENTRY_AUTH_TOKEN}"
```

Query parameters:
- `query` - Search filter (default: `is:unresolved`). Use `query=` for all issues
- `sortBy` - Options: `date` (last seen), `new` (first seen), `freq` (events), `user` (users affected)
- `limit` - Max 100 results per page
- `cursor` - Pagination cursor from Link header

#### 2. Get Issue Details
```bash
curl "https://sentry.io/api/0/organizations/${SENTRY_ORG}/issues/{issue_id}/" \
  -H "Authorization: Bearer ${SENTRY_AUTH_TOKEN}"
```

#### 3. Get Event with Full Stacktrace
```bash
# Get recommended event (best for debugging)
curl "https://sentry.io/api/0/organizations/${SENTRY_ORG}/issues/{issue_id}/events/recommended/" \
  -H "Authorization: Bearer ${SENTRY_AUTH_TOKEN}"

# Or list events with full body
curl "https://sentry.io/api/0/organizations/${SENTRY_ORG}/issues/{issue_id}/events/?full=true" \
  -H "Authorization: Bearer ${SENTRY_AUTH_TOKEN}"
```

The `full=true` parameter includes complete stacktrace and breadcrumbs.

### Search Query Syntax

For filtering issues via the `query` parameter:

| Filter | Example | Description |
|--------|---------|-------------|
| `is:` | `is:unresolved`, `is:resolved`, `is:assigned` | Issue status |
| `lastSeen:` | `lastSeen:-2d` (within 2 days) | When last seen |
| `message:` | `message:undefined` | Match error message |
| `issue.category:` | `issue.category:error` | Error type |

### Event Payload Structure

When fetching an event with `full=true`:

```json
{
  "eventID": "...",
  "context": { ... },
  "tags": [{"key": "...", "value": "..."}],
  "entries": [
    {
      "type": "exception",
      "data": {
        "values": [{
          "type": "Error",
          "value": "Cannot read property 'x' of undefined",
          "stacktrace": { "frames": [...] }
        }]
      }
    },
    {
      "type": "breadcrumbs",
      "data": { "values": [...] }
    }
  ]
}
```

### Worker Configuration for Sentry Access

Workers receive environment variables through `docker-entrypoint.sh` and `runner.ts`. To add Sentry access:

1. **Environment Variables** (already set):
   - `SENTRY_AUTH_TOKEN` - Auth token with `event:read`, `project:read`, `org:read` scopes
   - `SENTRY_ORG` - Organization slug

2. **Worker Access Pattern**:
   Workers have full bash access and can use curl directly:
   ```bash
   curl "https://sentry.io/api/0/organizations/${SENTRY_ORG}/issues/${ISSUE_ID}/" \
     -H "Authorization: Bearer ${SENTRY_AUTH_TOKEN}"
   ```

### Slack Integration for Sentry Alerts

The existing Slack integration (`src/slack/handlers.ts:266-434`) already handles routing:

1. Sentry alerts posted to Slack channels are received via Socket Mode
2. The `routeMessage` function (`src/slack/router.ts:77-155`) determines target agents
3. Lead agents receive alerts as inbox messages
4. Lead can delegate to workers via `inbox-delegate` tool

**For Sentry-specific alerts:**
- Configure Sentry to post to a Slack channel the bot monitors
- Use `@<bot>` mention or `swarm#<agent-id>` to route to specific agents
- Lead can parse the Sentry URL from the alert and delegate with task instructions

### Token Scopes Required

Create an Organization Auth Token at `https://sentry.io/settings/{org}/auth-tokens/` with:
- `event:read` - Required for reading issues and events
- `project:read` - Required for project data
- `org:read` - Required for organization info

## Code References

| File | Line | Description |
|------|------|-------------|
| `docker-entrypoint.sh` | 1-352 | Docker container initialization, environment setup |
| `src/commands/runner.ts` | 1268-1340 | Worker environment variable reading |
| `src/slack/handlers.ts` | 266-434 | Slack message handling and routing |
| `src/slack/router.ts` | 77-155 | Message routing to agents |
| `src/tools/slack-reply.ts` | 1-130 | MCP tool for replying to Slack threads |
| `src/be/db.ts` | 3207-3370 | Inbox message operations |
| `Dockerfile.worker` | 21-118 | Worker image with pre-installed tools |

## Architecture Documentation

### Current Worker CLI Tool Pattern

Workers receive CLI tools through:
1. **Docker image**: Pre-installed tools (gh, jq, sqlite3, etc.) - `Dockerfile.worker:21-118`
2. **Claude marketplace plugins**: Installed via `claude plugin` during container startup - `docker-entrypoint.sh:148-167`
3. **Environment variables**: Passed through `Bun.spawn` in `runner.ts:1009`

For sentry-cli specifically:
- Can be added to `Dockerfile.worker` as a pre-installed tool
- Or workers can install on-demand via `npm install -g @sentry/cli`
- Environment variables `SENTRY_AUTH_TOKEN` and `SENTRY_ORG` are inherited from container env

### Existing Alert Flow Pattern (GitHub as Reference)

The GitHub integration (`src/github/`) shows the pattern for external alert handling:
1. Webhook receives event → `src/github/handlers.ts`
2. @mentions parsed → `src/github/mentions.ts`
3. Task created for matched agent → `createTask()` or `createInboxMessage()`
4. Agent polls and receives task → `poll-task` MCP tool

Sentry alerts via Slack follow the same pattern but use Slack message routing instead of webhooks.

## Historical Context (from thoughts/)

No previous research found on Sentry integration in the thoughts directory.

## Related Research

- `thoughts/taras/research/2026-01-28-sentry-cli-integration.md` - This document

## Decisions Made

1. **CLI vs MCP Tool**: Install `sentry-cli` in Docker worker image. No need for a dedicated MCP tool - agents can use the CLI directly.

2. **Issue URL Parsing**: Agents can parse Sentry URLs from Slack alerts themselves to extract issue IDs.

3. **Rate Limiting**: Not a concern for current usage patterns.

4. **Self-Hosted Sentry**: Not applicable - using Sentry cloud version.

## Next Steps

1. **Add sentry-cli to Dockerfile.worker** - Install `@sentry/cli` globally in the worker image
2. **Document for agents** - Add brief instructions in worker documentation about available Sentry commands
