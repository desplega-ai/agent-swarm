# OAuth token runbook

Operational notes for OAuth providers stored in `oauth_apps` and `oauth_tokens`, with Jira as the highest-risk provider because Atlassian rotates refresh tokens.

## Invariants

- `oauth_tokens` is authoritative for provider access and refresh tokens.
- Refresh tokens are server-side only. Tools and logs may return or display access tokens only when explicitly requested.
- Every successful `grant_type=refresh_token` exchange must persist the returned access token, refresh token, expiry, and `updatedAt` before the caller uses the new access token.
- Refresh persistence is compare-and-swap guarded by the previous refresh token. A caller that loses the race must not use the token it just received.
- Provider refreshes are serialized in-process and guarded with the `oauth_refresh_locks` table across API processes.
- Do not use provider-specific refresh-token config overrides as normal operation. For Jira, replaying a consumed refresh token can invalidate the rotating-token chain.

## Getting an access token

Use the MCP tool instead of reading SQLite directly:

```json
{
  "tool": "get-oauth-access-token",
  "arguments": {
    "provider": "jira",
    "minValiditySeconds": 300
  }
}
```

The tool:

- accepts any configured OAuth provider slug,
- refreshes the provider token if it is inside the requested validity window,
- returns `accessToken` and `expiresAt`,
- registers the returned access token with the volatile secret scrubber,
- never returns the refresh token.

## Local Jira smoke test

Use a temporary database when testing OAuth flows from a laptop so real integration state is not mutated:

```bash
DATABASE_PATH=/tmp/agent-swarm-oauth-smoke.sqlite \
JIRA_REDIRECT_URI=http://localhost:3013/api/trackers/jira/callback \
bun run start:http
```

The redirect URI must exactly match one of the callback URLs configured in the Atlassian app. If the browser shows "callback URL is invalid", the server is deriving a callback URL that is not registered. Set `JIRA_REDIRECT_URI` explicitly, restart the API, and retry `/api/trackers/jira/authorize`.

After consent, check status without printing tokens:

```bash
curl -s -H "Authorization: Bearer ${AGENT_SWARM_API_KEY:-123123}" \
  http://localhost:3013/api/trackers/jira/status | jq '{connected, expiresAt}'
```

Then call `get-oauth-access-token` with a validity window larger than the remaining lifetime to force one refresh. Verify only booleans/counts in ad-hoc scripts:

- the tool returned an access token,
- the returned token matches the `oauth_tokens.accessToken` row,
- `oauth_tokens.refreshToken` changed,
- `oauth_tokens.expiresAt` moved forward,
- `tracker-status` still reports connected.

Never paste token values, OAuth callback `code` or `state`, cloud IDs, account IDs, site URLs, or customer issue keys into logs, tickets, or chat.

## Troubleshooting

### `tracker-status` says disconnected

Check whether the provider app config exists and whether the OAuth callback completed. A missing row in `oauth_apps` means the environment was not loaded or the integration is disabled. A missing row in `oauth_tokens` means the user has not completed OAuth consent for that provider.

### Refresh returns `invalid_grant` or `unauthorized_client`

For rotating providers, assume the stored refresh token may already have been consumed. Do not retry the same refresh token repeatedly. Re-auth the provider once, then verify that subsequent refreshes update `oauth_tokens.refreshToken`.

### Concurrent refresh errors

The expected path is one caller obtains the provider lock, refreshes, and persists. Other callers wait, reread `oauth_tokens`, and return without refreshing if the row already changed. If multiple processes still hit the provider with the same refresh token, inspect `oauth_refresh_locks` and the API process clocks.

### Token appears in logs

All log/stdout/stderr egress should pass through `scrubSecrets`. HTTP request logs must redact query parameter values because OAuth callbacks carry temporary credentials in the query string. Add focused regression tests in `apps/swarm/src/tests/secret-scrubber.test.ts` or `apps/swarm/src/tests/http-log-scrubbing.test.ts` when expanding coverage.

## Related code

- `apps/swarm/src/oauth/ensure-token.ts` — shared near-expiry refresh path.
- `apps/swarm/src/oauth/wrapper.ts` — provider token exchange and persistence call.
- `apps/swarm/src/be/db-queries/oauth.ts` — token CAS update and refresh lock helpers.
- `apps/swarm/src/tools/oauth-access-token.ts` — MCP tool for provider access tokens.
- `apps/swarm/src/utils/secret-scrubber.ts` — egress scrubbing and volatile access-token registration.
