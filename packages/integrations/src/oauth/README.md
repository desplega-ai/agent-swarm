# Generic OAuth Module

Provider-agnostic OAuth 2.0 + PKCE wrapper used by tracker integrations (Linear, and any future providers).

## Database Tables

### `oauth_apps`

One row per provider. Stores the OAuth application configuration.

| Column | Description |
|--------|-------------|
| `provider` | Unique key (e.g. `"linear"`) |
| `clientId` | OAuth client ID |
| `clientSecret` | OAuth client secret (encrypted at rest is recommended for production) |
| `authorizeUrl` | Provider's authorization endpoint |
| `tokenUrl` | Provider's token exchange endpoint |
| `redirectUri` | Callback URL registered with the provider |
| `scopes` | Comma-separated list of granted scopes |
| `metadata` | JSON blob for provider-specific extras |

### `oauth_tokens`

One row per provider. Stores the current access/refresh tokens.

| Column | Description |
|--------|-------------|
| `provider` | Foreign key to `oauth_apps.provider` |
| `accessToken` | Current access token |
| `refreshToken` | Refresh token (nullable, depends on provider) |
| `expiresAt` | ISO 8601 expiry timestamp |
| `scope` | Scopes granted by the token exchange |

## How It Works

1. **`buildAuthorizationUrl(config)`** generates a PKCE-protected authorization URL and stores the code verifier in an in-memory map keyed by a random `state` parameter. Entries expire after 10 minutes.
2. The user visits the URL and authorizes the app.
3. The provider redirects to the callback with `code` and `state`.
4. **`exchangeCode(config, code, state)`** looks up the pending state, sends the code + code verifier to the token endpoint, and persists the resulting tokens via `storeOAuthTokens()`.
5. **`refreshAccessToken(config, refreshToken)`** exchanges a refresh token for a new access token and persists the result.

## Adding a New OAuth Provider

1. Define an `OAuthProviderConfig` with the provider's endpoints and scopes:
   ```ts
   const config: OAuthProviderConfig = {
     provider: "jira",
     clientId: process.env.JIRA_CLIENT_ID!,
     clientSecret: process.env.JIRA_CLIENT_SECRET!,
     authorizeUrl: "https://auth.atlassian.com/authorize",
     tokenUrl: "https://auth.atlassian.com/oauth/token",
     redirectUri: "http://localhost:3013/api/trackers/jira/callback",
     scopes: ["read:jira-work", "write:jira-work"],
     extraParams: { audience: "api.atlassian.com" }, // optional
   };
   ```
2. Register HTTP routes for `/authorize` (calls `buildAuthorizationUrl`) and `/callback` (calls `exchangeCode`).
3. Use `getOAuthTokens("jira")` to retrieve stored tokens when making API calls.
4. Optionally call `refreshAccessToken()` when `isTokenExpiringSoon()` returns true.

## In-Memory Pending State

PKCE code verifiers are stored in-memory (not in the database) with a 10-minute TTL. This means:
- The OAuth flow must complete within 10 minutes of starting.
- If the server restarts mid-flow, the user must restart the authorization.
- Expired entries are cleaned up lazily on the next `buildAuthorizationUrl` call.
