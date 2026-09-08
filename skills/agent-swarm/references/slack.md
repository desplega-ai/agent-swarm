# Slack

Slack uses Socket Mode, so it does not need a public webhook URL.
Re-fetch the [manifest](https://github.com/desplega-ai/agent-swarm/blob/main/slack-manifest.json) and [Slack guide](https://docs.agent-swarm.dev/docs/integrations/slack).

1. Create a Slack app from a manifest at `https://api.slack.com/apps`.
2. Import the current `slack-manifest.json`. It supplies scopes, bot events, Socket Mode, Interactivity, and Assistant View.
3. Generate an app-level token with `connections:write`. Save it as `SLACK_APP_TOKEN` (`xapp-`).
4. Install the app to your workspace. Save the Bot User OAuth Token as `SLACK_BOT_TOKEN` (`xoxb-`).
5. Save both tokens as global secrets through Settings → Secrets, or execute the commands below.

Export `API_KEY` and `MCP_BASE_URL` for your deployment. Export both Slack tokens in the same shell without adding them to shell history.
The commands use jq to construct JSON and send it through stdin. They do not print the tokens.

```bash
curl -fsS https://raw.githubusercontent.com/desplega-ai/agent-swarm/main/slack-manifest.json \
  -o /tmp/slack-manifest.json
jq -n '{scope:"global",key:"SLACK_BOT_TOKEN",value:env.SLACK_BOT_TOKEN,isSecret:true}' \
  | curl -fsS -X PUT "$MCP_BASE_URL/api/config" \
      -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' --data-binary @- > /dev/null
jq -n '{scope:"global",key:"SLACK_APP_TOKEN",value:env.SLACK_APP_TOKEN,isSecret:true}' \
  | curl -fsS -X PUT "$MCP_BASE_URL/api/config" \
      -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' --data-binary @- > /dev/null
curl -fsS -X PUT "$MCP_BASE_URL/api/config" \
  -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
  -d '{"scope":"global","key":"SLACK_DISABLE","value":"false"}' > /dev/null
curl -fsS -X POST "$MCP_BASE_URL/api/config/reload" \
  -H "Authorization: Bearer $API_KEY"
```

Global saves automatically reload integrations. The explicit reload waits for a result you can inspect.
Deployment environment values win at boot. Stored values win after reload. Remove duplicate token values from deployment configuration to prevent stale credentials after restart.
`SLACK_SIGNING_SECRET` is unnecessary for the current Socket Mode implementation.
The development API blocks Socket Mode unless `SLACK_ALLOW_DEV_SOCKET_MODE=true`. Use a dedicated development Slack app for that setting.

If you instead put tokens in Compose `.env`, recreate the API container to apply the changed environment:

```bash
docker compose -f docker-compose.example.yml --env-file .env up -d --force-recreate api
```

A plain `docker compose restart` does not apply changes from `.env`.

Send the bot a DM: `Say hello and report which workers are online.`
Confirm that a task appears in the UI and the bot replies. For channel work, invite the bot and mention it.
Read the [integration configuration code](https://github.com/desplega-ai/agent-swarm/blob/main/src/http/core.ts) for reload behavior.
