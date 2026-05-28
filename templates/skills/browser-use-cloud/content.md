# Browser Use Cloud (Universal IP-Block / Web-UI Workaround)

The swarm container runs on a datacenter IP. Many public sites — YouTube, Cloudflare-protected pages, login walls — block that IP outright. When direct HTTP (curl, WebFetch, yt-dlp) returns a bot challenge or a JS-only shell, the cleanest fallback is **Browser Use Cloud** — a hosted real-browser service that runs an LLM-driven agent inside Chrome.

## When to Use This vs. Alternatives

| Situation | Use this? |
|---|---|
| YouTube transcript / metadata | **Yes.** YouTube blocks the swarm IP. Browser Use is the only path without cookies. |
| Cloudflare-protected site | **Yes.** WebFetch returns the JS challenge HTML. Browser Use solves it automatically. |
| Login-walled content the user authorizes you to access | **Yes** — pass the credentials in the task prompt. |
| Plain server-rendered HTML | **No.** Use `curl` / WebFetch — Browser Use is overkill and ~$0.05+/task. |
| Site has a public API or RSS | **No.** Always prefer the API. |

## Auth & Base URL

- **Base URL:** `https://api.browser-use.com/api/v2`
- **Auth header:** `X-Browser-Use-API-Key: <key>` (NOT `Authorization: Bearer` — that returns 404)
- **Stored in swarm config:** key `BROWSER_USE_API_KEY`

## Core Endpoints

| Endpoint | Purpose |
|---|---|
| `POST /api/v2/tasks` | Create a task. Body: `{"task": "<instructions>"}`. Returns `{id, sessionId}`. |
| `GET /api/v2/tasks/{id}` | Poll status + output. Fields: `status` (`started` → `finished`/`failed`), `output`. |

## Quickstart — YouTube Transcript

```bash
K=$(get-config BROWSER_USE_API_KEY)

# 1. Create the task
TASK=$(curl -s -X POST "https://api.browser-use.com/api/v2/tasks" \
  -H "X-Browser-Use-API-Key: $K" \
  -H "Content-Type: application/json" \
  -d '{"task":"Open https://www.youtube.com/watch?v=VIDEO_ID. Dismiss any cookie/consent dialog. Click Show transcript. Scroll fully to the bottom. Output the COMPLETE transcript verbatim."}')

TASK_ID=$(echo "$TASK" | jq -r .id)

# 2. Poll until finished
while true; do
  R=$(curl -s "https://api.browser-use.com/api/v2/tasks/$TASK_ID" \
    -H "X-Browser-Use-API-Key: $K")
  S=$(echo "$R" | jq -r .status)
  echo "status=$S"
  [ "$S" = "finished" ] || [ "$S" = "failed" ] && break
  sleep 30
done

# 3. Extract output
echo "$R" | jq -r '.output'
```

## Writing Good Task Prompts

1. **Exact start URL** — full `https://...` link, not "search for X"
2. **Pre-emptive dismissals** — "Dismiss any cookie/consent dialog"
3. **A concrete click path with fallbacks** — give it two ways to find the button
4. **Explicit scroll instructions** — `"scroll the panel fully to the bottom so every line loads"`
5. **The exact output format** — `"output the COMPLETE transcript verbatim, all lines, in order"`

## Output Shape Gotchas

- `output` is a single string. Multi-line content has `\n` escaped as two chars in JSON — unescape with `replace('\\n', '\n')` before writing to disk.
- If `status: failed`, look at the last step's `error` field. Common cause: the agent couldn't find the click target — refine the click path and re-run.

## Cost & Limits

- **Paid per task.** ~$0.05–$0.15 per task. Don't loop; use it once you've actually hit a block.
- **Rate-limited.** Don't fire >1 task per ~10s.
- **Typical duration:** 2–4 min for a 15-min YouTube video transcript.

## Trade-offs

**Browser Use is slow and paid.** Always try direct HTTP first. Reserve Browser Use for genuine bot walls. For public APIs, RSS, or plain HTML pages, plain curl is free and instant.

**Non-deterministic.** Same task can take different steps or produce slightly different output across runs, depending on site state and the LLM driving the browser.
