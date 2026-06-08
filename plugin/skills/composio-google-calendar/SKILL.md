---
name: composio-google-calendar
description: Per-app playbook for driving Google Calendar through Composio (toolkit slug `googlecalendar`). Verified GOOGLECALENDAR_* tool slugs and argument shapes for listing, finding, creating, and updating events plus free/busy. Use alongside the `composio` hub skill. CRITICAL — covers the "events from a year ago" trap: GOOGLECALENDAR_EVENTS_LIST has no default timeMin, so you MUST pass timeMin/orderBy/singleEvents to get upcoming events.
---

# Composio · Google Calendar

Toolkit slug: **`googlecalendar`**. Read the [[composio]] hub first for the call
model. `calendarId` defaults to `"primary"`. Times are **RFC3339**
(`2026-06-02T15:00:00Z` or with offset).

```bash
agent-swarm x composio POST /tools/execute/<SLUG> \
  --body '{"user_id":"t@desplega.ai","connected_account_id":"ca_…","arguments":{ … }}'
```

## Headline tools

| Slug | What | Key args |
|---|---|---|
| `GOOGLECALENDAR_EVENTS_LIST` | List events on a calendar | `calendarId` (def `primary`), **`timeMin`**, `timeMax`, `singleEvents`, `orderBy`, `q`, `maxResults`, `timeZone`, `pageToken` |
| `GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS` | List across all calendars | `timeMin`, `timeMax`, `singleEvents`, `orderBy` |
| `GOOGLECALENDAR_FIND_EVENT` | Search for an event | `query`, `timeMin`, `timeMax` |
| `GOOGLECALENDAR_EVENTS_GET` | One event by id | `calendar_id`, `event_id` |
| `GOOGLECALENDAR_CREATE_EVENT` | Create event | **`start_datetime`** (required), `end_datetime` / `event_duration_minutes` (def 30), `summary`, `description`, `location`, `attendees`, `timezone`, `calendar_id`, `send_updates`, `create_meeting_room` (def true) |
| `GOOGLECALENDAR_QUICK_ADD` | NL event ("lunch tmrw 1pm") | `calendar_id`, `text` |
| `GOOGLECALENDAR_UPDATE_EVENT` / `GOOGLECALENDAR_PATCH_EVENT` | Edit event | `calendar_id`, `event_id`, fields |
| `GOOGLECALENDAR_DELETE_EVENT` | Delete | `calendar_id`, `event_id` |
| `GOOGLECALENDAR_FIND_FREE_SLOTS` | Free slots | `items` (def `["primary"]`), `time_min`, `time_max`, `timezone` |
| `GOOGLECALENDAR_LIST_CALENDARS` | List the user's calendars | — |
| `GOOGLECALENDAR_GET_CURRENT_DATE_TIME` | Server "now" (use for timeMin) | `timezone` |

Full set: 48 tools — `agent-swarm x composio GET "/tools?toolkit_slug=googlecalendar&limit=100" | jq -r '.items[]|"\(.slug)\t\(.name)"'`.

## ⚠️ The "events from a year ago" trap

`GOOGLECALENDAR_EVENTS_LIST` has **no default `timeMin`**. Calling it with no time
window returns old/arbitrary events (this is exactly how "what's on my calendar?"
came back with stuff from a year ago). To get **upcoming** events you MUST set the
window and ordering explicitly:

```bash
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
agent-swarm x composio POST /tools/execute/GOOGLECALENDAR_EVENTS_LIST \
  --body "{\"connected_account_id\":\"ca_…\",\"arguments\":{
    \"calendarId\":\"primary\",
    \"timeMin\":\"$NOW\",
    \"singleEvents\":true,
    \"orderBy\":\"startTime\",
    \"maxResults\":10
  }}"
```
- `timeMin` = now (or the start of the window you care about).
- `singleEvents:true` expands recurring events into individual instances — required
  for `orderBy:"startTime"` to be valid.
- Add `timeMax` to bound the window (e.g. next 7 days).
- For "today/this week" prefer computing `timeMin`/`timeMax` locally, or call
  `GOOGLECALENDAR_GET_CURRENT_DATE_TIME` first to anchor to the server's clock.

## Create an event

```bash
agent-swarm x composio POST /tools/execute/GOOGLECALENDAR_CREATE_EVENT \
  --body '{"connected_account_id":"ca_…","arguments":{
    "summary":"Norrsken <> Desplega",
    "start_datetime":"2026-06-05T15:00:00+02:00",
    "event_duration_minutes":30,
    "timezone":"Europe/Madrid",
    "attendees":["someone@example.com"],
    "send_updates":"all"
  }}'
```
- Either `end_datetime` OR `event_duration_minutes` (default 30).
- `create_meeting_room` defaults true (adds Google Meet) — set false to skip.
- Create/update/delete are **write actions** — only on explicit request.

## Gotchas

- The year-ago trap above is the #1 issue. `timeMin` is not optional in practice.
- `orderBy:"startTime"` requires `singleEvents:true` or the API errors.
- Output uses the event's own timezone; pass `timeZone` to normalize display.
