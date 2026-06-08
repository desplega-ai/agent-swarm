---
name: composio-google-docs
description: Per-app playbook for driving Google Docs through Composio (toolkit slug `googledocs`). Verified GOOGLEDOCS_* tool slugs and argument shapes for searching, reading plaintext, creating (incl. from markdown), and editing documents. Use alongside the `composio` hub skill whenever a task reads or writes Google Docs for a connected user.
---

# Composio · Google Docs

Toolkit slug: **`googledocs`**. Read the [[composio]] hub first for the call model.
A document is identified by its `document_id` (the id in the Docs URL).

```bash
agent-swarm x composio POST /tools/execute/<SLUG> \
  --body '{"user_id":"t@desplega.ai","connected_account_id":"ca_…","arguments":{ … }}'
```

## Headline tools

| Slug | What | Key args |
|---|---|---|
| `GOOGLEDOCS_SEARCH_DOCUMENTS` | Find docs (Drive search) | `query`, `max_results` (def 10), `order_by` (def `modifiedTime desc`), `modified_after`, `created_after`, `starred_only`, `shared_with_me`, `response_detail` (def `minimal`) |
| `GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT` | Read doc as text | **`document_id`**, `include_tables` (def true), `include_headers`, `include_footers`, `include_footnotes`, `include_tabs_content` |
| `GOOGLEDOCS_GET_DOCUMENT_BY_ID` | Full structured doc JSON | `document_id` |
| `GOOGLEDOCS_CREATE_DOCUMENT` | Create blank/with text | `title`, `text` |
| `GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN` | Create from markdown | **`title`**, `markdown_text`, `image_assets` |
| `GOOGLEDOCS_UPDATE_DOCUMENT_MARKDOWN` | Replace body with markdown | `document_id`, `markdown_text` |
| `GOOGLEDOCS_INSERT_TEXT_ACTION` | Insert text at index | `document_id`, `text`, `index` |
| `GOOGLEDOCS_REPLACE_ALL_TEXT` | Find & replace | `document_id`, `find`, `replace` |
| `GOOGLEDOCS_COPY_DOCUMENT` | Duplicate a doc | `document_id`, `title` |
| `GOOGLEDOCS_EXPORT_DOCUMENT_AS_PDF` | Export to PDF | `document_id` |

Full set: 35 tools — `agent-swarm x composio GET "/tools?toolkit_slug=googledocs&limit=100" | jq -r '.items[]|"\(.slug)\t\(.name)"'`.
Prefer the `*_MARKDOWN` create/update tools for authoring; the granular
`INSERT_*`/`DELETE_*`/table tools are for surgical structural edits.

## Search recipe

```bash
agent-swarm x composio POST /tools/execute/GOOGLEDOCS_SEARCH_DOCUMENTS \
  --body '{"connected_account_id":"ca_…","arguments":{"query":"workshop","max_results":5}}'
# → results under .data.files[]  (id, name, modifiedTime …)
```
- Results are Drive file entries at **`.data.files[]`** — grab `.id` to read.
- `order_by` defaults to `modifiedTime desc` (most recent first).
- Use `modified_after` / `shared_with_me` to narrow.

## Read recipe

```bash
agent-swarm x composio POST /tools/execute/GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT \
  --body '{"connected_account_id":"ca_…","arguments":{"document_id":"<id>","include_tables":true}}'
```
Use `GET_DOCUMENT_PLAINTEXT` for reading content; only reach for
`GET_DOCUMENT_BY_ID` when you need the structured JSON (styles, indices) for an
edit.

## Create-from-markdown recipe

```bash
agent-swarm x composio POST /tools/execute/GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN \
  --body '{"connected_account_id":"ca_…","arguments":{
    "title":"Weekly updates","markdown_text":"# Heading\n\n- point one\n- point two"
  }}'
```

## Gotchas

- Search returns Drive metadata, not document content — do a second
  `GET_DOCUMENT_PLAINTEXT` call with the `.id` to read.
- Doc bodies can be long/token-heavy and may contain secrets — read only what you
  need (`include_headers/footers/footnotes` default off for a reason).
- Create/update/replace are **write actions** — only on explicit request.
