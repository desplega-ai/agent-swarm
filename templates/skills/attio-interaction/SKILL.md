---
name: attio-interaction
description: "How to read and write your Attio CRM via the REST API v2: query/filter records, upsert companies/people/deals with matching_attribute, write notes and tasks, manage list entries, and handle webhooks. Auth via ATTIO_API_KEY (Bearer token). Use this skill whenever you need to interact with Attio CRM data from the swarm."
user-invocable: false
agentAutoTrigger: When asked to read from, write to, search, query, or update Attio CRM records, deals, companies, people, notes, tasks, or lists. Also when a task references Attio data such as pipeline, ICP scoring, lead enrichment, stale deals, CRM hygiene, deal handoffs, or logging an interaction to Attio.
---

# Attio Interaction (Read + Write)

Use this skill to read and write your Attio CRM through the REST API v2. Every read or write is a direct API call; agent-swarm does not maintain a separate Attio sync.

## TL;DR

1. Resolve `ATTIO_API_KEY` from swarm config before making calls.
2. Base URL: `https://api.attio.com/v2/`
3. Use `Authorization: Bearer $ATTIO_API_KEY`, `Content-Type: application/json`, and `Accept: application/json`.
4. Prefer upsert over create for People, Companies, and Deals: `PUT /v2/objects/{slug}/records` with `matching_attribute`.
5. Rate limits: 100 reads/sec, 25 writes/sec. Pace write bursts to roughly 15-20/sec.
6. Attribute values are arrays, even for scalar values: `[{ "value": 42 }]`, never `42`.

## Authentication

```bash
ATTIO_API_KEY=$(get-config key="ATTIO_API_KEY" includeSecrets=true)

curl -sS "https://api.attio.com/v2/objects" \
  -H "Authorization: Bearer $ATTIO_API_KEY" \
  -H "Accept: application/json"
```

If calls return `401`, re-fetch the key from config. If it still fails, notify the Lead; the key may need rotation. Do not retry silently.

## Core object slugs

| Object | API slug | Primary matching attribute |
|---|---|---|
| Companies | `companies` | `domains` |
| People | `people` | `email_addresses` |
| Deals | `deals` | Usually no global dedupe key; link to company/person records |

Custom objects use their configured API slug. Discover them with `GET /v2/objects`.

## Common operations

### 1. Discover objects and slugs

```bash
curl -sS "https://api.attio.com/v2/objects" \
  -H "Authorization: Bearer $ATTIO_API_KEY" \
  -H "Accept: application/json" \
  | jq '.data[] | {slug: .api_slug, name: .title}'
```

### 2. Query records with filters and pagination

```bash
curl -sS -X POST "https://api.attio.com/v2/objects/companies/records/query" \
  -H "Authorization: Bearer $ATTIO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "filter": {
      "stage": { "$not_equal": "Won" }
    },
    "limit": 100,
    "offset": 0
  }' | jq '.data[] | {record_id: .id.record_id, name: .values.name[0].value}'
```

Paginate by increasing `offset` until `data` is empty. For no filter, omit the `filter` key.

### 3. Get a single record

```bash
curl -sS "https://api.attio.com/v2/objects/companies/records/{RECORD_ID}" \
  -H "Authorization: Bearer $ATTIO_API_KEY" \
  -H "Accept: application/json" \
  | jq '.data.values'
```

### 4. Upsert a company by domain

Use `PUT` with `matching_attribute`. It creates if not found and updates if found, so it is safe to call repeatedly.

```bash
curl -sS -X PUT "https://api.attio.com/v2/objects/companies/records" \
  -H "Authorization: Bearer $ATTIO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "values": {
        "name": [{ "value": "Acme Corp" }],
        "domains": [{ "domain": "acme.com" }],
        "employee_count": [{ "value": 150 }]
      }
    },
    "matching_attribute": "domains"
  }' | jq '{record_id: .data.id.record_id}'
```

### 5. Upsert a person by email

```bash
curl -sS -X PUT "https://api.attio.com/v2/objects/people/records" \
  -H "Authorization: Bearer $ATTIO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "values": {
        "name": [{ "first_name": "Jane", "last_name": "Doe" }],
        "email_addresses": [{ "email_address": "jane@acme.com" }],
        "job_title": [{ "value": "CTO" }]
      }
    },
    "matching_attribute": "email_addresses"
  }' | jq '{record_id: .data.id.record_id}'
```

### 6. Update specific attributes on an existing record

```bash
curl -sS -X PATCH "https://api.attio.com/v2/objects/companies/records/{RECORD_ID}" \
  -H "Authorization: Bearer $ATTIO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "values": {
        "icp_score": [{ "value": 85 }],
        "icp_tier": [{ "value": "Tier 1" }]
      }
    }
  }'
```

### 7. Write a note to a record

```bash
curl -sS -X POST "https://api.attio.com/v2/notes" \
  -H "Authorization: Bearer $ATTIO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "parent_object": "companies",
      "parent_record_id": "{RECORD_ID}",
      "title": "Enrichment - 2026-06-02",
      "content": "Employee count: 150. Funding stage: Series A. Tech stack: Node.js, React."
    }
  }' | jq '{note_id: .data.id.note_id}'
```

### 8. Create a task linked to a record

```bash
curl -sS "https://api.attio.com/v2/workspace_members" \
  -H "Authorization: Bearer $ATTIO_API_KEY" \
  -H "Accept: application/json" \
  | jq '.data[] | {member_id: .id.workspace_member_id, name: .name, email: .email_address}'

curl -sS -X POST "https://api.attio.com/v2/tasks" \
  -H "Authorization: Bearer $ATTIO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "content": "Follow up - no contact in 21 days",
      "is_completed": false,
      "assignees": [
        { "referenced_actor_type": "workspace-member", "referenced_actor_id": "{MEMBER_ID}" }
      ],
      "linked_records": [
        { "target_object": "deals", "target_record_id": "{DEAL_RECORD_ID}" }
      ]
    }
  }' | jq '{task_id: .data.id.task_id}'
```

### 9. Post a comment on a record

```bash
curl -sS -X POST "https://api.attio.com/v2/comments" \
  -H "Authorization: Bearer $ATTIO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "record": { "target_object": "companies", "target_record_id": "{RECORD_ID}" },
      "content": [
        { "type": "text", "text": "Possible duplicate of acme-corp-old - please review and merge." }
      ]
    }
  }' | jq '{comment_id: .data.id.comment_id}'
```

### 10. Query a list or pipeline view

```bash
curl -sS "https://api.attio.com/v2/lists" \
  -H "Authorization: Bearer $ATTIO_API_KEY" \
  -H "Accept: application/json" \
  | jq '.data[] | {list_id: .id.list_id, name: .title}'

curl -sS -X POST "https://api.attio.com/v2/lists/{LIST_ID}/entries/query" \
  -H "Authorization: Bearer $ATTIO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "limit": 100, "offset": 0 }' \
  | jq '.data[] | {entry_id: .id.entry_id, record_id: .record_id}'
```

### 11. Global search across objects

```bash
curl -sS -X POST "https://api.attio.com/v2/records/search" \
  -H "Authorization: Bearer $ATTIO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "query": "acme", "limit": 10 }' \
  | jq '.data[] | {object: .object_type, record_id: .id.record_id}'
```

## Webhooks

Attio delivers webhooks at least once. Payloads contain IDs only, so always re-fetch the full record via `GET` before acting.

Key event types:

- `record.created`, `record.updated`, `record.deleted`
- `list-entry.created`, `list-entry.updated`, `list-entry.deleted`
- `note.created`
- `task.created`, `task.completed`

Webhook timeout is 5 seconds. Respond `200` immediately and do async processing in a follow-up swarm task.

## Rate limits

| Operation | Hard limit | Safe working rate |
|---|---|---|
| Reads | 100 req/sec | ~80 req/sec |
| Writes | 25 req/sec | ~15-20 req/sec |

Add `sleep 0.05` between write calls in loops. Attio does not provide a native batch endpoint for these operations.

## Operational rules

- Upsert first. Use `PUT /records` with `matching_attribute` for create-or-update. `POST /records` can create duplicates.
- Re-fetch webhook records. Webhook payloads are event hints, not full source-of-truth records.
- Values are arrays. Every attribute value must be wrapped in an array.
- No merge endpoint. Attio has no API-level record merge; dedupe agents should flag duplicates as comments or tasks for human review.
- Check config first. Fetch `ATTIO_API_KEY` via `get-config includeSecrets=true`; never hardcode it.

## Error handling

| Status | Likely cause | Action |
|---|---|---|
| 401 | API key invalid or expired | Re-fetch from config. If still failing, notify Lead for rotation. |
| 403 | Key lacks permission | Check the Attio API key's workspace permissions. |
| 404 | Wrong object slug or record ID | Re-discover slugs with `GET /v2/objects`. |
| 400 | Malformed body | Ensure attribute values are wrapped in arrays. |
| 422 | Validation or conflict error | Read the `errors` array for field-level details. |
| 429 | Rate-limited | Back off and retry after `Retry-After` if provided. |

## Worked example: stale deal reactivation

```bash
ATTIO_API_KEY=$(get-config key="ATTIO_API_KEY" includeSecrets=true)

DEALS=$(curl -sS -X POST "https://api.attio.com/v2/objects/deals/records/query" \
  -H "Authorization: Bearer $ATTIO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"filter": {"stage": {"$not_equal": "Won"}}, "limit": 200}')

echo "$DEALS" | jq -r '.data[] | .id.record_id' | while read -r RECORD_ID; do
  RECORD=$(curl -sS "https://api.attio.com/v2/objects/deals/records/$RECORD_ID" \
    -H "Authorization: Bearer $ATTIO_API_KEY" \
    -H "Accept: application/json")
  # Compute staleness from the relevant date attribute. If stale, create a task.
  sleep 0.05
done
```

## Related references

- Official Attio REST API docs: https://developers.attio.com/reference
- Official Attio MCP overview: https://docs.attio.com/mcp/overview
