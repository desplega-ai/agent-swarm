# Kapso WhatsApp

Kapso (https://kapso.ai) is a WhatsApp platform vendor for the Meta Cloud API. A swarm can provision one or more phone numbers and use either native inbound handlers or workflows to dispatch a task per inbound message.

## When to use MCP tools vs this skill's REST recipes

Some deployments expose **thin MCP-tool wrappers for the common case only**:

| Tool | Use for |
|---|---|
| `send-whatsapp-message` | Free-form text within the 24h session window. |
| `reply-whatsapp-message` | Same as above but quote-threads to an inbound WAMID. |
| `register-kapso-number` / `unregister-kapso-number` | Provisioning a phone number's webhook + KV mapping. |

**For ANYTHING else, drop to the REST recipes in this skill** — these are the canonical reference, and the MCP tools deliberately do NOT duplicate them:

- **Template messages** (outside 24h window) → §"Send a template" below.
- **Media** (image / document / audio / video, including wide-image padding and PTT voice notes) → §"Sending media".
- **Reactions** (👀 / ✅ / clear) → §"Send a reaction".
- **Typing indicator + mark-as-read** → §"Mark as read + typing indicator".
- **Signature verify (manual)** → §"Webhook signature verification".
- **Contact resolution → swarm user** → §"Resolve a contact to a swarm user".
- **Conversation history / message detail / templates list** → §"Read conversation context".

If the MCP-tool send returns a 24h-window error (`sessionWindowExpired: true`), fall through to the template path in §"Send a template" — this is exactly what the tool's structured-error points at.

## Setup

Swarm config keys (resolve with `get-config key:<NAME> includeSecrets:true` — Lead-only for secrets; workers should ask Lead if they need a value injected):

| Key | Value |
|---|---|
| `KAPSO_API_BASE_URL` | `https://api.kapso.ai` (host only, no `/platform/v1`) |
| `KAPSO_API_KEY` | API key (`X-API-Key` header) |
| `KAPSO_PHONE_NUMBER_ID` | Provisioned number's Meta ID |
| `KAPSO_WEBHOOK_HMAC_SECRET` | Shared HMAC secret. Kapso signs every webhook request with `X-Webhook-Signature: <hex>` |

The Kapso CLI is NOT installed in worker containers. Use direct HTTP or clone the `gokapso/agent-skills` repo for fallback scripts.

```bash
git clone --depth=1 https://github.com/gokapso/agent-skills /tmp/kapso-skills
cd /tmp/kapso-skills/skills/integrate-whatsapp && npm i  # or observe-whatsapp / automate-whatsapp
```

The Meta Cloud API is proxied at `$KAPSO_API_BASE_URL/meta/whatsapp/v24.0/...` (auth: `X-API-Key`). Kapso's own platform endpoints live at `$KAPSO_API_BASE_URL/platform/v1/...`.

## Inbound webhook payload (v2)

Your inbound workflow receives `whatsapp.message.*` and `whatsapp.conversation.*` events at `POST <SWARM_API_BASE_URL>/api/webhooks/<workflow-id>`.

Shape (top-level keys):

```json
{
  "message": {
    "id": "wamid.HBgL...",            // Meta message id (WAMID)
    "from": "15550100000",            // dummy E.164 without +
    "from_user_id": "ES.26772...",    // Meta-internal user id
    "timestamp": "1779281573",        // unix seconds (string)
    "type": "text",                   // text | image | audio | video | document | sticker | location | contacts | reaction | ...
    "text": { "body": "ola" },        // only for type=text
    "context": null,                  // present when the user quote-replied another message
    "kapso": {
      "direction": "inbound|outbound",
      "status": "received|delivered|read|sent|failed",
      "processing_status": "pending|completed",
      "origin": "cloud_api",
      "has_media": false,
      "content": "ola"                // text representation (caption / filename / body)
    }
  },
  "conversation": {
    "id": "bd7e888e-...",
    "phone_number": "15550100000",
    "phone_number_id": "<phone-number-id>",
    "contact_name": "Example Contact",
    "status": "active",
    "last_active_at": "...",
    "created_at": "...",
    "kapso": {
      "messages_count": 10,
      "last_message_id": "wamid...",
      "last_message_text": "ola",
      "last_inbound_at": "...",
      "last_outbound_at": "..."
    }
  },
  "is_new_conversation": false,
  "phone_number_id": "<phone-number-id>"
}
```

**ALWAYS filter on `message.kapso.direction == "inbound"`** — Kapso fires the webhook for our own outbound sends, deliveries, reads, and failures too. Only inbound events from real humans warrant a task.

Test payloads include `"test": true` and `wamid.TEST_...` ids — handle gracefully (treat as a real inbound but mark it test in your reply; do not send a real WhatsApp reply to test payloads).

## Non-text message types

`message.type` can be `text`, `image`, `audio`, `video`, `document`, `sticker`, `location`, `contacts`, `reaction`, `button`, or `interactive`. Non-text inbound messages carry a type-specific object:

| type | object | key fields |
|---|---|---|
| `image` | `message.image` | `id` (media id), `mime_type`, `sha256`, `caption?` |
| `audio` | `message.audio` | `id`, `mime_type`, `voice` (true = voice note), `sha256` |
| `video` | `message.video` | `id`, `mime_type`, `sha256`, `caption?` |
| `document` | `message.document` | `id`, `mime_type`, `filename`, `sha256`, `caption?` |
| `sticker` | `message.sticker` | `id`, `mime_type`, `animated`, `sha256` |
| `location` | `message.location` | `latitude`, `longitude`, `name?`, `address?` |
| `contacts` | `message.contacts[]` | `name`, `phones[]`, `emails[]`, ... |
| `reaction` | `message.reaction` | `message_id` (wamid being reacted to), `emoji` |

`message.kapso.has_media` is `true` for image/audio/video/document/sticker. `message.kapso.content` carries a text representation where one exists (caption, filename). `message.transcript` may be present for audio if Kapso pre-transcribed it.

### Downloading media

Media messages carry a Meta **media id** (`message.<type>.id`), not a URL. Two-step download via the Kapso proxy:

1. Resolve the media id to a temporary URL + metadata:
   ```bash
   curl -s -H "X-API-Key: $KAPSO_API_KEY" \
     "$KAPSO_API_BASE_URL/meta/whatsapp/v24.0/<MEDIA_ID>"
   # → { "url": "https://lookaside.fbsbx.com/...", "mime_type": "...", "file_size": ..., "id": "...", "sha256": "..." }
   ```
2. Download the binary from that `url` (Meta lookaside URLs expire fast — download immediately):
   ```bash
   curl -sL -H "X-API-Key: $KAPSO_API_KEY" "<url>" -o /tmp/media.bin
   ```

NB: verify the exact proxy path against a real media message — the swarm has only received `text` inbound so far. If the lookaside `url` 403s with `X-API-Key`, retry through `$KAPSO_API_BASE_URL/meta/whatsapp/...`.

### Recommended handling per type

- **audio / voice notes** → download, then transcribe with ElevenLabs Scribe. Workers should NOT call ElevenLabs directly — the Lead owns audio (see `TOOLS.md`); ask the Lead to transcribe, or escalate. Feed the transcript into the conversation as if it were a text message.
- **image** → download, then describe / answer with a Claude vision model. A screenshot captioned "debug this" should get a real answer, not "I can't read images".
- **document** → download; read the text content (PDF/txt/etc.) and act on it.
- **video** → acknowledge + ask for specifics unless there is a clear transcription need.
- **location** → use `latitude` / `longitude` directly.
- **sticker** → treat as a lightweight reaction; usually no substantive reply needed.
- **reaction** → a user reacting to one of OUR messages. Usually acknowledge silently — do NOT trigger a full reply loop. (The inbound-demo workflow's `debounce` node naturally drops reaction-only events.)
- **contacts** → extract the shared contact info; act per the conversation.

## Resolve a contact to a swarm user

Two paths in order:

1. By name: `resolve-user name:"<contact_name>"` (fuzzy substring match). Returns the canonical profile if there's one. Useful for known team members.
2. If no match — the contact is unknown. Lead can run `manage-user create name:"<contact_name>" notes:"WhatsApp +<phone>"` to register them. Workers should NOT create users autonomously; ask Lead.

Always quote the phone number in `manage-user notes` so future lookups by phone work (until we add a `phone` column to the user registry).

## Read conversation context

Use the Kapso platform endpoints via curl (no CLI needed):

```bash
API_BASE=$(get-config KAPSO_API_BASE_URL)   # https://api.kapso.ai
API_KEY=$(get-config KAPSO_API_KEY)

# List conversations for our number
curl -s -H "X-API-Key: $API_KEY" \
  "$API_BASE/platform/v1/whatsapp/conversations?phone_number_id=$KAPSO_PHONE_NUMBER_ID&status=active" | jq

# Get a single conversation
curl -s -H "X-API-Key: $API_KEY" \
  "$API_BASE/platform/v1/whatsapp/conversations/<conversation_id>" | jq

# List messages for a conversation — USE THE QUERY-PARAM FORM.
# (The conversation-scoped path /conversations/<id>/messages returns 404.)
curl -s -H "X-API-Key: $API_KEY" \
  "$API_BASE/platform/v1/whatsapp/messages?conversation_id=<conversation_id>&limit=20" | jq

# Single message detail
curl -s -H "X-API-Key: $API_KEY" \
  "$API_BASE/platform/v1/whatsapp/messages/<wamid>" | jq
```

The message list is returned newest-first.

## Send a free-form text (within the 24h session window)

Per WhatsApp policy, free-form text is only allowed within 24h of the last inbound message. Outside that window you MUST use a pre-approved template (see "Send a template" below).

**Common case shortcut:** call the `send-whatsapp-message` MCP tool — it wraps exactly this REST call. The recipe below is the canonical reference and the fallback when you need fields the tool doesn't expose.

```bash
TO="15550100000"
TEXT="Hi there"

curl -s -X POST -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d "{
    \"messaging_product\": \"whatsapp\",
    \"recipient_type\": \"individual\",
    \"to\": \"$TO\",
    \"type\": \"text\",
    \"text\": { \"preview_url\": false, \"body\": \"$TEXT\" }
  }" \
  "$API_BASE/meta/whatsapp/v24.0/$KAPSO_PHONE_NUMBER_ID/messages" | jq
```

Returns `{ "messages": [{ "id": "wamid..." }] }` on success. Log the wamid.

### Quote-reply (thread to the original message)

Add a `context` object to make the message render as a reply to a specific inbound message. The `reply-whatsapp-message` MCP tool wraps exactly this; use the raw recipe when you need to combine quote-reply with media / templates / reactions (the tool only does text).

```json
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "<phone>",
  "context": { "message_id": "<inbound_wamid>" },
  "type": "text",
  "text": { "preview_url": false, "body": "<reply>" }
}
```

Prefer quote-replies when answering a specific question — it keeps long conversations legible.

## Sending media (image, document, audio, video)

Two-step pipeline through Kapso's Meta proxy: **upload, then send by id**. Sending by `id` is more reliable than `link` because it does not require the media to be hosted at a public URL.

### 1. Upload

```bash
curl -s -X POST -H "X-API-Key: $API_KEY" \
  -F "messaging_product=whatsapp" \
  -F "type=<mime>" \
  -F "file=@/path/to/file.ext;type=<mime>" \
  "$API_BASE/meta/whatsapp/v24.0/$KAPSO_PHONE_NUMBER_ID/media"
# → {"id":"<media-id>"}
```

### 2. Send by id

```json
{ "type": "image",    "image":    { "id": "<id>", "caption": "..." } }
{ "type": "document", "document": { "id": "<id>", "filename": "name.ext", "caption": "..." } }
{ "type": "audio",    "audio":    { "id": "<id>" } }
{ "type": "video",    "video":    { "id": "<id>", "caption": "..." } }
```

Quote-reply works on media too — add `"context": { "message_id": "<wamid>" }` at the top level.

### Wide images: pad to ~square, send as image

WhatsApp scales `type:image` to bubble width + recompresses, so a wide 1200×630 social card renders as a tiny shrunken strip. **The fix is NOT `type:document`** — a `.png` sent as a document shows a plain file card with NO inline preview (must tap+download). Bad UX both ways.

Correct approach: **letterbox/pad the wide image onto a ~1:1 (1080×1080) or 4:5 (1080×1350) canvas** with a solid bg fill (white, or a colour sampled from the card's corner), card centered, then send THAT as `type:image`. WhatsApp shows ~1:1–4:5 images large WITH a preview and won't shrink them.

Pad with Pillow (ImageMagick is NOT installed in workers; `pip`/`python3 -c` with PIL works):

```python
from PIL import Image
src = Image.open("in.png").convert("RGB"); w,h = src.size
bg = src.getpixel((0,0))                       # sample corner for fill
card = src.resize((1080, round(h*1080/w)), Image.LANCZOS)
canvas = Image.new("RGB", (1080,1080), bg)
canvas.paste(card, (0,(1080-card.height)//2)); canvas.save("out.png")
```

Reserve `type:document` for ACTUAL files — PDFs (which DO render a preview), spreadsheets, etc. — never for images.

### Voice notes (PTT play bar)

For PTT (play bar in the bubble), the audio MUST be `audio/ogg` with Opus. MP3 sends as a generic audio attachment, no PTT bar.
```bash
ffmpeg -i in.mp3 -c:a libopus -b:a 32k -application voip out.ogg
```

## Mark as read + typing indicator

The mark-as-read endpoint doubles as the typing indicator. POST to the same `/messages` endpoint with `status: "read"` and an optional `typing_indicator`:

```bash
curl -s -X POST -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{
    "messaging_product": "whatsapp",
    "status": "read",
    "message_id": "<inbound_wamid>",
    "typing_indicator": { "type": "text" }
  }' \
  "$API_BASE/meta/whatsapp/v24.0/$KAPSO_PHONE_NUMBER_ID/messages"
# → {"success":true}
```

The typing indicator ("typing…" dots) auto-clears after ~25 seconds OR the moment you send any message. For long-running work, re-fire this call every <25s (e.g. right before you POST your reply) to keep the dots visible. Drop the `typing_indicator` field to mark-as-read only.

## Send a reaction

```bash
curl -s -X POST -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{
    "messaging_product": "whatsapp",
    "recipient_type": "individual",
    "to": "<phone>",
    "type": "reaction",
    "reaction": { "message_id": "<wamid>", "emoji": "👀" }
  }' \
  "$API_BASE/meta/whatsapp/v24.0/$KAPSO_PHONE_NUMBER_ID/messages"
```

A user can have only ONE reaction per message — sending a new emoji REPLACES the previous one (no explicit remove needed). Send `"emoji": ""` to clear a reaction entirely.

## Send a template (outside the 24h window)

If `send-whatsapp-message` returns `sessionWindowExpired: true`, fall through to this path. WhatsApp only allows pre-approved templates outside the 24h customer-service window.

```bash
curl -s -X POST -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{
    "messaging_product": "whatsapp",
    "to": "15550100000",
    "type": "template",
    "template": {
      "name": "<template_name>",
      "language": { "code": "en_US" }
    }
  }' \
  "$API_BASE/meta/whatsapp/v24.0/$KAPSO_PHONE_NUMBER_ID/messages"
```

List approved templates first: `GET $API_BASE/platform/v1/whatsapp/templates?phone_number_id=$KAPSO_PHONE_NUMBER_ID`.

## Webhook signature verification

Every Kapso webhook delivery includes `X-Webhook-Signature: <hex>` (HMAC-SHA256 of the raw body using `KAPSO_WEBHOOK_HMAC_SECRET`). Native handlers and workflow webhook triggers should verify the signature automatically; if you configure a custom trigger, set its HMAC header to `X-Webhook-Signature` and resolve the secret from swarm config.

To verify manually:

```bash
echo -n "$RAW_BODY" | openssl dgst -sha256 -hmac "$HMAC_SECRET" -hex | awk '{print $2}'
# Compare hex output with X-Webhook-Signature header (constant-time compare in production).
```

## Reply etiquette

- Same language as the inbound message (Spanish/English/Catalan — match what they wrote).
- Brief. WhatsApp is not Slack — 1-3 short messages max.
- Identify yourself if it's a first interaction in the conversation: "Hi! This is the agent handling this WhatsApp inbox."
- Quote-reply (`context.message_id`) when answering a specific question.
- If you can't help (no skill for the request, out of scope) — say so and either escalate to Lead or ask the human to use Slack instead.
- Always log the outbound wamid in your task output so it's traceable.

## Where this fits in the swarm

Two common inbound paths exist:

- **Native handler** (`/api/integrations/kapso/webhook`) — fires for any phone number registered via `register-kapso-number`. Verifies HMAC, dedupes by message id, reads the routing mapping, and either dispatches an inbound-message task or delegates to a workflow trigger.
- **Workflow trigger** (`<workflow-id>`) — useful when you want custom routing, batching, triage, or approval steps before a reply is sent. A typical pipeline marks the message read, debounces rapid-fire bursts, routes to an agent task, and optionally sends a final reaction or status update.

**Debounce / batching:** the demo workflow's `debounce` node waits ~8s after each message and only the LAST message of a burst proceeds to the agent task — so a user firing 3 quick messages produces ONE task, not three. The agent is told the `batchSize` and should read trailing history and answer the whole burst in one reply. When >1 messages are collapsed, the user sees a "🧵 Got your N messages" note.

The agent-task triages like any other interaction; route heavier work to specialists via `send-task` (always include the WhatsApp source context so they can reply back).

HMAC verification is enforced (signed mode) on both paths.

## Common gotchas

- Phone numbers from Kapso are E.164 **without `+`** (e.g. `15550100000`). Add `+` when displaying to humans, drop it when calling the API.
- `message.text.body` is only present for `type:"text"`. For other types read `message.<type>` (see the table above) or `message.kapso.content` for a text representation.
- Outbound status events (`delivered`, `read`) are NOT a customer interaction — skip them. Filter by `message.kapso.direction == "inbound"`.
- Real inbound messages commonly arrive with `status: "delivered"` (delivered to us). Do NOT skip on status — only `direction` signals inbound vs outbound.
- Kapso sometimes sends test payloads with `"test": true` and `wamid.TEST_*` ids. Don't reply to test payloads — just complete the task with a note.
- The provisioned phone number id is your sender number, not the recipient's. The recipient is in `message.from` / `conversation.phone_number`.
- The message-list endpoint is `/platform/v1/whatsapp/messages?conversation_id=X` — the conversation-scoped `/conversations/<id>/messages` path 404s.
- **Wide images shrink — pad them, don't send as document.** `type:image` scales to bubble width; a wide social card becomes a strip. Sending it as `type:document` removes the preview entirely. Fix: pad onto a ~1:1/4:5 canvas and send as `type:image`. See "Sending media".
- **MCP tools cover text-only.** `send-whatsapp-message` and `reply-whatsapp-message` are deliberately thin — templates / media / reactions / typing / mark-as-read are NOT in the tool surface. For those, use the REST recipes in this skill directly.
