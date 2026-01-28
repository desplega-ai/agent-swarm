---
description: Investigate and triage a Sentry error issue
argument-hint: <sentry-issue-url-or-id>
---

# Investigate Sentry Issue

Investigate a Sentry issue to understand the error, gather context, and prepare for fixing or triaging.

## Prerequisites

Environment variables `SENTRY_AUTH_TOKEN` and `SENTRY_ORG` must be set (they are pre-configured in the worker environment).

Verify authentication:
```bash
sentry-cli info
```

## Arguments

- `sentry-issue-url-or-id`: Either a Sentry issue URL (e.g., `https://sentry.io/organizations/myorg/issues/123456/`) or just the issue ID (e.g., `123456`)

## Workflow

### 1. Parse the Sentry URL

If given a URL, extract the issue ID:
```bash
# URL format: https://sentry.io/organizations/{org}/issues/{issue_id}/
# Extract issue_id from the URL path
```

### 2. Get Issue Overview

Use `sentry-cli` to list the issue:
```bash
sentry-cli issues list --id <issue-id>
```

### 3. Get Detailed Issue Information

For more context, use the REST API:
```bash
curl -s "https://sentry.io/api/0/organizations/${SENTRY_ORG}/issues/<issue-id>/" \
  -H "Authorization: Bearer ${SENTRY_AUTH_TOKEN}" | jq
```

This returns:
- Error title and metadata
- First/last seen timestamps
- Event count and user impact
- Assigned user and status

### 4. Get Full Stacktrace

The recommended event provides the best debugging context:
```bash
curl -s "https://sentry.io/api/0/organizations/${SENTRY_ORG}/issues/<issue-id>/events/recommended/" \
  -H "Authorization: Bearer ${SENTRY_AUTH_TOKEN}" | jq
```

Key fields in the response:
- `.entries[] | select(.type == "exception")` - The exception with stacktrace
- `.entries[] | select(.type == "breadcrumbs")` - Actions leading to the error
- `.tags` - Environment, browser, OS info
- `.context` - Custom context data

### 5. Extract Stacktrace Frames

To see the actual stack:
```bash
curl -s "https://sentry.io/api/0/organizations/${SENTRY_ORG}/issues/<issue-id>/events/recommended/" \
  -H "Authorization: Bearer ${SENTRY_AUTH_TOKEN}" | \
  jq '.entries[] | select(.type == "exception") | .data.values[].stacktrace.frames'
```

### 6. Analyze and Report

Based on the stacktrace and context:
1. Identify the failing file and line number
2. Understand the error type and message
3. Review breadcrumbs for the sequence of events
4. Check tags for environment-specific issues

### 7. Take Action (if appropriate)

**Resolve an issue:**
```bash
sentry-cli issues resolve <issue-id>
```

**Mute an issue:**
```bash
sentry-cli issues mute <issue-id>
```

**Unresolve an issue:**
```bash
sentry-cli issues unresolve <issue-id>
```

## Common CLI Commands

```bash
# Verify authentication
sentry-cli info

# List unresolved issues
sentry-cli issues list --query "is:unresolved"

# List recent issues (last 2 days)
sentry-cli issues list --query "lastSeen:-2d"

# List issues matching a message
sentry-cli issues list --query "message:undefined"

# Bulk resolve issues
sentry-cli issues resolve <id1> <id2> <id3>
```

## Search Query Syntax

Use these filters with `--query`:

| Filter | Example | Description |
|--------|---------|-------------|
| `is:` | `is:unresolved`, `is:resolved` | Issue status |
| `lastSeen:` | `lastSeen:-2d` | Seen within time range |
| `message:` | `message:undefined` | Match error message |
| `issue.category:` | `issue.category:error` | Error category |

## Tips

- Always get the recommended event first - it's curated for debugging
- Use `jq` to filter large JSON responses
- Check breadcrumbs to understand user actions before the error
- Look at tags for environment info (browser, OS, etc.)
- If investigating from a Slack alert, the issue URL is in the alert message
