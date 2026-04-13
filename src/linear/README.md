# Linear Integration

Bidirectional sync between Agent Swarm and Linear. Webhook-driven inbound (Linear issues become swarm tasks) and event-bus-driven outbound (task completion/failure posts comments back to Linear).

## Setup

1. **Create OAuth Application** at `linear.app/settings/api/applications`
2. **Set callback URL** to your server's `/api/trackers/linear/callback`
   - Local: `http://localhost:3013/api/trackers/linear/callback`
   - Production: `https://your-domain.com/api/trackers/linear/callback`
3. **Set Actor** to "Application" (enables `actor=app` in OAuth flow)
4. **Enable webhooks** and select "Issue" events in the app settings
5. **Copy credentials** to `.env`:
   ```bash
   LINEAR_CLIENT_ID=<from app settings>
   LINEAR_CLIENT_SECRET=<shown once on creation>
   LINEAR_SIGNING_SECRET=<from webhook settings>
   # LINEAR_TEAM_ID=<optional: scope to a specific team>
   ```
6. **Start server**: `bun run start:http`
7. **Run OAuth flow**: visit `http://localhost:3013/api/trackers/linear/authorize` in your browser
8. **Verify connection**:
   ```bash
   curl -H "Authorization: Bearer $API_KEY" http://localhost:3013/api/trackers/linear/status
   ```
9. **Local webhook testing**: use ngrok or cloudflared to create a tunnel, then configure the public URL as the webhook URL in your Linear app settings:
   ```bash
   ngrok http 3013
   # Then set webhook URL in Linear to: https://<ngrok-id>.ngrok.io/api/trackers/linear/webhook
   ```

## Scopes

The OAuth flow requests these scopes:

| Scope | Purpose |
|-------|---------|
| `read` | Read workspace data (teams, issues, users) |
| `write` | Update issues and projects |
| `issues:create` | Create new issues |
| `comments:create` | Add comments to issues |
| `app:assignable` | App appears in the assignee dropdown |
| `app:mentionable` | App can be @mentioned in issues and comments |

## Architecture

```
src/linear/
  app.ts        # Initialization, env config, route registration
  client.ts     # Linear GraphQL API client wrapper
  oauth.ts      # OAuth route handlers (authorize, callback, status)
  webhook.ts    # Inbound webhook handler (issue events -> swarm tasks)
  outbound.ts   # Outbound sync (event bus -> Linear comments)
  sync.ts       # Sync helpers (status mapping, etc.)
  types.ts      # TypeScript types for Linear payloads
  index.ts      # Public exports
```

**Key design decisions:**

- **Generic OAuth layer** (`src/oauth/`, `oauth_apps`, `oauth_tokens` tables) serves any provider. Linear-specific code only lives in `src/linear/`.
- **Generic tracker tables** (`tracker_sync`, `tracker_agent_mapping`) serve any tracker. The `provider` column distinguishes Linear from future integrations.
- **Inbound**: Webhook events create swarm tasks via `createTaskExtended(source: "linear")`. The webhook handler verifies HMAC signatures using `LINEAR_SIGNING_SECRET`.
- **Outbound**: Subscribes to the workflow event bus for `task.completed` and `task.failed` events. Posts completion/failure comments back to the linked Linear issue.
- **Loop prevention**: A 5-second window prevents outbound sync from firing immediately after an inbound webhook (checked via `lastSyncOrigin` + `lastSyncedAt` on the tracker_sync row).
