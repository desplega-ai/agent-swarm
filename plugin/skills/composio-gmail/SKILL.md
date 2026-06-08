---
name: composio-gmail
description: Per-app playbook for driving Gmail through Composio (toolkit slug `gmail`). Verified GMAIL_* tool slugs and argument shapes for reading, searching, sending, drafts, labels, and threads. Use alongside the `composio` hub skill whenever a task reads or sends Gmail for a connected user. Covers the metadata-first reads, the GMAIL_SEND_EMAIL HTML flag, and reply-to-thread.
---

# Composio · Gmail

Toolkit slug: **`gmail`**. Read the [[composio]] hub first for the call model
(`agent-swarm x composio …`, user_id, connected accounts, the 4302 gotcha).
Tool `arguments` go inside the request body; `user_id` defaults to `"me"` (the
authorized account) — you usually don't need to set it.

```bash
# Direct execute (reliable path — pin the ACTIVE ca_… from the hub Recipe B)
agent-swarm x composio POST /tools/execute/<SLUG> \
  --body '{"user_id":"t@desplega.ai","connected_account_id":"ca_…","arguments":{ … }}'
```

## Headline tools

| Slug | What | Key args |
|---|---|---|
| `GMAIL_FETCH_EMAILS` | List/search emails | `query`, `max_results` (def **1** — set it!), `include_payload` (def true), `verbose` (def true), `ids_only`, `label_ids`, `page_token` |
| `GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID` | Full single message | `message_id`, `include_payload` |
| `GMAIL_FETCH_MESSAGE_BY_THREAD_ID` | All messages in a thread | `thread_id` |
| `GMAIL_LIST_THREADS` | List threads | `query`, `max_results`, `page_token` |
| `GMAIL_SEND_EMAIL` | Send | `recipient_email`, `subject`, `body`, `is_html` (def false), `cc`, `bcc`, `extra_recipients`, `attachment` |
| `GMAIL_REPLY_TO_THREAD` | Reply in-thread | `thread_id`, `message_body`, `recipient_email` |
| `GMAIL_CREATE_EMAIL_DRAFT` / `GMAIL_SEND_DRAFT` | Draft then send | `body`, `subject`, `recipient_email` / `draft_id` |
| `GMAIL_GET_PROFILE` | Whose mailbox is this? | — |
| `GMAIL_LIST_LABELS` / `GMAIL_CREATE_LABEL` / `GMAIL_ADD_LABEL_TO_EMAIL` | Labels | `message_id`, `label_ids` (use LIST_LABELS for custom IDs) |
| `GMAIL_GET_CONTACTS` / `GMAIL_SEARCH_PEOPLE` | Contacts | `query` |
| `GMAIL_GET_ATTACHMENT` | Download attachment | `message_id`, `attachment_id` |

Full set: 63 tools — list with
`agent-swarm x composio GET "/tools?toolkit_slug=gmail&limit=100" | jq -r '.items[]|"\(.slug)\t\(.name)"'`.
Avoid the ones marked Deprecated (`GMAIL_LIST_MESSAGES`, `GMAIL_REMOVE_LABEL`).

## Read recipe (metadata-first)

```bash
agent-swarm x composio POST /tools/execute/GMAIL_FETCH_EMAILS \
  --body '{"connected_account_id":"ca_…","arguments":{"max_results":5,"include_payload":false,"verbose":false}}'
```
- **Always set `max_results`** — the default is `1`.
- Use Gmail `query` syntax: `"is:unread"`, `"from:foo@bar.com newer_than:7d"`,
  `"subject:invoice has:attachment"`.
- Keep `include_payload:false` + `verbose:false` unless the user needs full bodies
  (token-heavy). Use `ids_only:true` for the cheapest listing.

## Send recipe

```bash
agent-swarm x composio POST /tools/execute/GMAIL_SEND_EMAIL \
  --body '{"connected_account_id":"ca_…","arguments":{
    "recipient_email":"someone@example.com",
    "subject":"Hello",
    "body":"<p>Hi there</p>",
    "is_html":true,
    "cc":["cc@example.com"]
  }}'
```
- Set `is_html:true` when `body` contains HTML, otherwise it sends as literal text.
- `recipient_email` is the primary; add more via `extra_recipients` / `cc` / `bcc`.
- **Sending is a write action** — only do it when the task explicitly asks.

## Reply in a thread

```bash
agent-swarm x composio POST /tools/execute/GMAIL_REPLY_TO_THREAD \
  --body '{"connected_account_id":"ca_…","arguments":{
    "thread_id":"<thread_id>","recipient_email":"someone@example.com","message_body":"thanks!"
  }}'
```

## Gotchas

- Default `max_results` is `1` — forgetting it makes "list my emails" return a
  single message.
- Bodies/attachments are token-heavy and may contain secrets — default to
  metadata; the secret-scrubber doesn't run on Composio tool output.
- If you get `ToolRouterV2_NoActiveConnection`, switch to direct execute with the
  pinned `connected_account_id` (hub Gotchas).
