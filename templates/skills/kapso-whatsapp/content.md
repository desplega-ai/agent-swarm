# Kapso WhatsApp

Kapso (https://kapso.ai) is the WhatsApp platform vendor for the Meta Cloud API. The swarm has one phone number provisioned for inbound/outbound WhatsApp messaging.

## When to Use MCP Tools vs. REST Recipes

The swarm ships **thin MCP-tool wrappers for the common case only**:

| Tool | Use for |
|---|---|
| `send-whatsapp-message` | Free-form text within the 24h session window. |
| `reply-whatsapp-message` | Quote-thread reply to an inbound WAMID. |

**For ANYTHING else, use the REST recipes in this skill:**
- Template messages (outside 24h window)
- Media (image / document / audio / video)
- Reactions (👀 / ✅ / clear)
- Typing indicator + mark-as-read
- Webhook signature verification
- Conversation history

## Setup

Swarm config keys:

| Key | Value |
|---|---|
| `KAPSO_API_BASE_URL` | `https://api.kapso.ai` |
| `KAPSO_API_KEY` | API key (`X-API-Key` header) |
| `KAPSO_PHONE_NUMBER_ID` | `1035039933036854` — our provisioned number's Meta ID |

## Inbound Webhook Payload Shape (Key Fields)

```json
{
  "message": {
    "id": "wamid.HBgL...",
    "from": "34679077777",           // E.164 without +
    "type": "text",                  // text | image | audio | video | document | reaction | ...
    "text": { "body": "ola" },       // only for type=text
    "kapso": {
      "direction": "inbound|outbound",
      "has_media": false,
      "content": "ola"               // text representation
    }
  },
  "conversation": { "id": "bd7e888e-...", "contact_name": "Taras" }
}
```

**ALWAYS filter on `message.kapso.direction == "inbound"`** — Kapso fires webhooks for outbound sends, deliveries, reads, and failures too.

## Send a Free-Form Text (within 24h Window)

```bash
curl -s -X POST -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"messaging_product":"whatsapp","recipient_type":"individual","to":"34679077777","type":"text","text":{"preview_url":false,"body":"Hi Taras 👋"}}' \
  "$API_BASE/meta/whatsapp/v24.0/1035039933036854/messages"
```

Returns `{ "messages": [{ "id": "wamid..." }] }` on success.

## Mark as Read + Typing Indicator

```bash
curl -s -X POST -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"messaging_product":"whatsapp","status":"read","message_id":"<inbound_wamid>","typing_indicator":{"type":"text"}}' \
  "$API_BASE/meta/whatsapp/v24.0/1035039933036854/messages"
```

Typing indicator auto-clears after ~25s OR when you send a message. Re-fire every <25s for long-running work.

## Send a Reaction

```bash
curl -s -X POST -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"messaging_product":"whatsapp","recipient_type":"individual","to":"<phone>","type":"reaction","reaction":{"message_id":"<wamid>","emoji":"👀"}}' \
  "$API_BASE/meta/whatsapp/v24.0/1035039933036854/messages"
```

Send `"emoji": ""` to clear a reaction.

## Sending Media (Two-Step: Upload Then Send)

```bash
# 1. Upload
curl -s -X POST -H "X-API-Key: $API_KEY" \
  -F "messaging_product=whatsapp" -F "type=<mime>" -F "file=@/path/to/file.ext;type=<mime>" \
  "$API_BASE/meta/whatsapp/v24.0/1035039933036854/media"
# → {"id":"<media-id>"}

# 2. Send by id
# Image: {"type":"image","image":{"id":"<id>","caption":"..."}}
# Document: {"type":"document","document":{"id":"<id>","filename":"name.ext"}}
# Audio: {"type":"audio","audio":{"id":"<id>"}}
```

**Wide images shrink — pad them first.** WhatsApp scales `type:image` to bubble width; a wide 1200×630 card becomes a strip. Letterbox/pad onto a ~1:1 (1080×1080) canvas and send as `type:image`. Never send images as `type:document` — it removes the preview.

**Voice notes (PTT play bar):** Audio MUST be `audio/ogg` with Opus. MP3 sends as a generic attachment.

## Send a Template (Outside 24h Window)

If `send-whatsapp-message` returns `sessionWindowExpired: true`:

```bash
curl -s -X POST -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"messaging_product":"whatsapp","to":"34679077777","type":"template","template":{"name":"<template_name>","language":{"code":"en_US"}}}' \
  "$API_BASE/meta/whatsapp/v24.0/1035039933036854/messages"
```

List approved templates: `GET $API_BASE/platform/v1/whatsapp/templates?phone_number_id=1035039933036854`

## Common Gotchas

- Phone numbers from Kapso are E.164 **without `+`** (e.g. `34679077777`).
- `message.text.body` is only present for `type:"text"`. Read `message.<type>` for other types.
- Outbound status events are NOT a customer interaction — filter by `message.kapso.direction == "inbound"`.
- The message-list endpoint is `/platform/v1/whatsapp/messages?conversation_id=X` — not `/conversations/<id>/messages` (that 404s).
- **MCP tools cover text-only.** Templates / media / reactions / typing are NOT in the tool surface — use the REST recipes directly.

## Reply Etiquette

- Match the language of the inbound message (Spanish/English/Catalan).
- Brief — 1–3 short messages max.
- Quote-reply (`context.message_id`) when answering a specific question.
- If out of scope, say so and escalate to Lead or ask the human to use Slack.
- Log the outbound wamid in your task output for traceability.
