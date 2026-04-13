---
description: Investigate and triage a Sentry error issue
argument-hint: <sentry-issue-url-or-id>
---

# Investigate Sentry Issue

Investigate a Sentry issue to understand the error, gather context, and prepare for fixing or triaging.

## Prerequisites

`SENTRY_AUTH_TOKEN` and `SENTRY_ORG` must be set. Verify with `sentry-cli info`.

## Arguments

- `sentry-issue-url-or-id`: A Sentry issue URL or just the issue ID (e.g., `123456`)

## Workflow

### 1. Parse the Input

If given a URL (`https://sentry.io/organizations/{org}/issues/{issue_id}/`), extract the issue ID.

### 2. Get Issue Overview

```bash
sentry-cli issues list --id <issue-id>
```

### 3. Get Detailed Info via REST API

Use `https://sentry.io/api/0/organizations/${SENTRY_ORG}/issues/<issue-id>/` for metadata (first/last seen, event count, user impact, status).

### 4. Get Full Stacktrace

Use the recommended event endpoint: `.../issues/<issue-id>/events/recommended/`

Key jq paths for the response:
- `.entries[] | select(.type == "exception")` — exception with stacktrace
- `.entries[] | select(.type == "exception") | .data.values[].stacktrace.frames` — stack frames
- `.entries[] | select(.type == "breadcrumbs")` — actions leading to the error
- `.tags` — environment, browser, OS info
- `.context` — custom context data

### 5. Analyze and Report

1. Identify the failing file and line number
2. Understand the error type and message
3. Review breadcrumbs for the sequence of events
4. Check tags for environment-specific issues

### 6. Take Action (if appropriate)

```bash
sentry-cli issues resolve <issue-id>    # Resolve
sentry-cli issues mute <issue-id>       # Mute
sentry-cli issues unresolve <issue-id>  # Unresolve
```

## Search Query Syntax

Use these filters with `sentry-cli issues list --query`:

| Filter | Example | Description |
|--------|---------|-------------|
| `is:` | `is:unresolved` | Issue status |
| `lastSeen:` | `lastSeen:-2d` | Seen within time range |
| `message:` | `message:undefined` | Match error message |
| `issue.category:` | `issue.category:error` | Error category |

## Tips

- Always get the recommended event first — it's curated for debugging
- Check breadcrumbs to understand user actions before the error
- If investigating from a Slack alert, the issue URL is in the alert message
