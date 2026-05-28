# Browser Use Cloud (universal IP-block / web-UI workaround)

The swarm container runs on a datacenter IP. A lot of public sites — YouTube,
Cloudflare-protected pages, login walls — block that IP outright. When direct
HTTP (curl, WebFetch, yt-dlp, `youtube-transcript-api`) returns a bot
challenge or a JS-only shell, the cleanest fallback is **Browser Use Cloud**
— a hosted real-browser service that runs an LLM-driven agent inside Chrome.
It loads pages, clicks things, scrolls, reads the DOM, and returns the
extracted content as text. Different IP, full JS, real browser fingerprint.

## When to use this vs. alternatives

| Situation | Use this? |
|---|---|
| YouTube transcript / metadata | **Yes.** YouTube blocks the swarm IP for `yt-dlp`, `youtube-transcript-api`, and the free transcript sites (Cloudflare). Browser Use is the only path without cookies. |
| Cloudflare-protected site (`youtubetranscript.com`, `youtubetotranscript.com`, similar) | **Yes.** WebFetch returns the JS challenge HTML. Browser Use solves the challenge automatically. |
| Login-walled content the user authorizes you to access | **Yes** — pass the credentials in the task prompt; Browser Use can fill forms. |
| Plain server-rendered HTML | **No.** Use `curl` / WebFetch — Browser Use is overkill and ~$0.05+/task. |
| Site has a public API or RSS | **No.** Always prefer the API. |
| `steipete/summarize` on a non-IP-blocked URL | **No.** Use summarize directly — it's free and faster. |

`steipete/summarize` is installed in the swarm (`npm i -g @steipete/summarize`)
and works fine for non-IP-blocked URLs and local files. It fails on YouTube
from the swarm because every YouTube-extraction path it uses (`web` caption
fetch, `yt-dlp` audio download, `apify` if no token) hits the same datacenter
IP wall.

## Auth & base URL

- **Base URL:** `https://api.browser-use.com/api/v2`
- **Auth header:** `X-Browser-Use-API-Key: <key>` (NOT `Authorization: Bearer`
  — that returns 404 on all endpoints, easy time-sink)
- **Stored in swarm config:** key `BROWSER_USE_API_KEY` (global, secret).
  Fetch via `get-config key=BROWSER_USE_API_KEY includeSecrets=true`.

## Core endpoints

| Endpoint | Purpose |
|---|---|
| `POST /api/v2/tasks` | Create a task. Body: `{"task": "<natural-language instructions>"}`. Returns `{id, sessionId}`. |
| `GET /api/v2/tasks/{id}` | Poll status + output. Fields: `status` (`started` → `finished` / `failed`), `steps[]`, `output` (the agent's final answer as a string). |
| `GET /api/v2/tasks` | List recent tasks (useful to inspect prior runs / patterns). |

The v1 endpoints (`/api/v1/...`) return `{"detail":"Not Found"}` — **always
use v2**.

## Quickstart — YouTube transcript

```bash
K=$(swarm-get-config BROWSER_USE_API_KEY)   # or pull via get-config MCP tool

# 1. Create the task
TASK=$(curl -s -X POST "https://api.browser-use.com/api/v2/tasks" \
  -H "X-Browser-Use-API-Key: $K" \
  -H "Content-Type: application/json" \
  -d '{"task":"Open https://www.youtube.com/watch?v=VIDEO_ID . Dismiss any cookie/consent dialog. Note the video title and channel name. Open the transcript: click \"...more\" in the description, then click \"Show transcript\" (or use the three-dot menu under the video and choose \"Show transcript\"). The transcript panel will appear on the right. Scroll the transcript panel fully to the bottom so every line loads. Then extract and output the COMPLETE transcript text verbatim, all lines, in order. Also output the video title and channel at the top."}')

TASK_ID=$(echo "$TASK" | jq -r .id)
echo "task: $TASK_ID"

# 2. Poll until finished (typical: 2-4 minutes for a ~15min video)
while true; do
  R=$(curl -s "https://api.browser-use.com/api/v2/tasks/$TASK_ID" \
    -H "X-Browser-Use-API-Key: $K")
  S=$(echo "$R" | jq -r .status)
  echo "$(date +%H:%M:%S) status=$S steps=$(echo "$R" | jq '.steps | length')"
  [ "$S" = "finished" ] || [ "$S" = "failed" ] && break
  sleep 30
done

# 3. Extract output — note: \n in the JSON is the literal two chars "\\n",
#    not a newline. Unescape before writing to disk.
echo "$R" | jq -r '.output' | python3 -c "import sys; sys.stdout.write(sys.stdin.read().replace('\\\\n','\n'))" \
  > /workspace/personal/tmp/transcript.md
```

**Polling cadence:** 30s is plenty. A 10-15min YouTube video transcript run
takes ~2-4 min and ~15-20 agent steps. Don't busy-poll faster — every poll
costs a request and Browser Use rate-limits aggressively.

## Writing good task prompts

The Browser Use agent is an LLM driving a browser — it follows instructions
literally and sometimes loops if the page changes mid-task. Give it:

1. **Exact start URL** — full `https://...` link, not "search for X".
2. **Pre-emptive dismissals** — "Dismiss any cookie/consent dialog" prevents
   it from getting stuck on EU cookie banners.
3. **A concrete click path** with fallbacks — `"click 'Show transcript' (or
   use the three-dot menu under the video and choose 'Show transcript')"` —
   sites move things around; give it two ways.
4. **Explicit scroll instructions** for lazy-loaded content — `"scroll the
   transcript panel fully to the bottom so every line loads"`. Without this
   you get the first ~50 lines and silent truncation.
5. **The exact output format** — `"output the COMPLETE transcript text
   verbatim, all lines, in order"`. If you want JSON, say "respond with valid
   JSON only, no prose".
6. **Don't ask it to summarize** unless that's the goal. You want the raw
   content; do the LLM work yourself in a separate step with full control of
   the model.

## Output shape gotchas

- `output` is a **single string**. Multi-line content has `\n` *escaped as
  two characters* inside that string (because the API returns JSON). When you
  pipe to a file, unescape with `replace('\\n', '\n')` or `printf '%b'` —
  otherwise the file looks like one giant line of `\n[0:01]...\n[0:03]...`.
- `steps` is an array of `{action, nextGoal, ...}` — useful for debugging a
  failed run, ignore on success.
- If `status: failed`, look at the last step's `error` field. Common cause:
  the agent couldn't find the click target (page changed, A/B test, region
  variation) — refine the click path and re-run.

## Cost & limits

- **Paid per task.** Roughly $0.05-$0.15 per task in practice; longer tasks
  with more steps cost more. Don't loop this; use it once you've actually
  hit a block.
- **Rate-limited.** Don't fire >1 task per ~10s.
- **No streaming.** You always poll for the final `output`.

## Worked example (the one that prompted this skill)

Task: get the transcript for `https://www.youtube.com/watch?v=t-G67yKAHBQ`.

What failed first:
- `yt-dlp` (all `--extractor-args "youtube:player_client=..."` variants: `tv`,
  `ios`, `web_safari`, `mweb`, `android`): all returned "Sign in to confirm
  you're not a bot".
- `youtube-transcript-api` (Python lib): `RequestBlocked` — same IP issue.
- `summarize "<url>" --extract --youtube web|auto|yt-dlp`: failed too — its
  `web` mode hits YouTube's HTML directly (gets the JS shell footer), and
  `yt-dlp` mode chains the same blocked tool.
- `curl` + `WebFetch` against `youtubetranscript.com` /
  `youtubetotranscript.com` / `tactiq`: Cloudflare interstitial / App Check
  rejection / 403.

What worked:
- One Browser Use Cloud task with the prompt above. ~17 steps, ~3 min,
  returned a clean 17.7 KB timestamped transcript ("How to Build a
  Self-Improving Company with AI", YC Root Access).

## Tips

- **Always save the `output` to a file under `/workspace/...`** before
  uploading to Slack — `slack-upload-file` will not read `/tmp/`. Use
  `/workspace/personal/tmp/` or `/workspace/shared/misc/<your-agent-id>/`.
- **For long videos** (>1h), warn the user this takes ~10 min and costs more
  per run. Consider chunking by timestamp range if you only need part of it.
- **For non-YouTube sites**, the same recipe applies — just change the URL
  and the click path. Browser Use is the swarm's general "I need a real
  browser" tool.
- **Don't store the API key in scripts you commit.** Pull it fresh from
  `get-config` each run.

