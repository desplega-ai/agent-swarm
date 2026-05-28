# Turso Interaction

## The Two-Token Model (READ THIS FIRST)

Turso has two separate auth planes — they do NOT cross over.

| Token type | Where it works | Stored in swarm config as | Expiry |
|---|---|---|---|
| **Platform JWT** (management plane) | `api.turso.tech/v1/*` — list orgs, list DBs, mint DB tokens | `TURSO_API_TOKEN` | ~7 days (Clerk rotates) |
| **DB token** (data plane) | `https://<db-host>/v2/pipeline` — SELECT/INSERT/etc. against a specific DB | `TURSO_DB_TOKEN`, etc. | non-expiring (mint with `--expiration none`) |

Using the **platform JWT against `/v2/pipeline` returns `HTTP 401`** — by design. If you see that error, you're using the wrong token. Use the DB-specific one.

## Swarm Config Inventory

| Key | Plane | Scope | Notes |
|---|---|---|---|
| `TURSO_API_TOKEN` | Platform | global | Clerk JWT. Expires ~weekly. |
| `TURSO_DB_TOKEN` | Data (content-state) | global | EdDSA, non-expiring. |
| `TURSO_DB_URL` | Data (content-state) | global | `https://content-state-desplega.aws-eu-west-1.turso.io` |
| `TURSO_X_POSTS_DB_TOKEN` | Data (x-posts) | global | EdDSA, non-expiring. |
| `TURSO_X_POSTS_DB_URL` | Data (x-posts) | global | `libsql://x-posts-desplega...` — swap `libsql://` → `https://` before hitting `/v2/pipeline` |

## Querying via HTTP API `/v2/pipeline`

```bash
curl -s -X POST "$DB_URL/v2/pipeline" \
  -H "Authorization: Bearer $DB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "requests": [
      {"type":"execute","stmt":{"sql":"SELECT name FROM sqlite_master WHERE type='\''table'\''"}},
      {"type":"close"}
    ]
  }'
```

Always include `{"type":"close"}` as the last request. Use parameterized statements for user-supplied values.

**URL form**: `/v2/pipeline` only accepts `https://`. Rewrite `libsql://` keys:
```bash
URL="${TURSO_X_POSTS_DB_URL/libsql:\/\//https:\/\/}"
```

## Mint a DB Token via the Platform API

When a DB has no stored token, mint one with the platform JWT:

```bash
DB=dummy-test-db
DB_TOKEN=$(curl -s -X POST \
  "https://api.turso.tech/v1/organizations/desplega/databases/$DB/auth/tokens?authorization=read-only" \
  -H "Authorization: Bearer $TURSO_API_TOKEN" | jq -r '.jwt')
```

## CLI Authentication

```bash
curl -sSfL https://get.tur.so/install.sh | bash
export PATH="$HOME/.turso:$PATH"
turso config set token "$TURSO_API_TOKEN"
turso org switch desplega
turso db list   # verify
```

Do NOT use `turso auth login` — it needs a browser. Always feed the config token in.

## CLI Database Operations

```bash
turso db create <name>
turso db list
turso db show <name>          # URL, region, size
turso db shell <name>         # interactive
turso db shell <name> "SELECT * FROM t;"  # one-shot
turso db shell <name> < dump.sql          # pipe file
turso db tokens create <name> --expiration none  # non-expiring token
```

## Key Databases (org = desplega)

| Database | HTTPS URL | Token config key |
|---|---|---|
| `content-state` | `https://content-state-desplega.aws-eu-west-1.turso.io` | `TURSO_DB_TOKEN` |
| `x-posts` | `https://x-posts-desplega.aws-eu-west-1.turso.io` | `TURSO_X_POSTS_DB_TOKEN` |
| `dummy-test-db` | `https://dummy-test-db-desplega.aws-eu-west-1.turso.io` | — (mint via API) |

## When Tokens Expire

- **`TURSO_API_TOKEN` expired** → CLI breaks, can't mint new DB tokens. Existing DB tokens keep working. Action: Taras rotates via Turso dashboard, updates config.
- **A DB token expired/revoked** → that specific DB returns 401. Other DBs unaffected. Action: mint a new one, update the config key.

Don't conflate the two failure modes.

## Trade-offs

**Two-plane auth:** The platform JWT and DB tokens are separate by design. The benefit is security (leaked DB token doesn't compromise management plane); the cost is remembering which token goes where. The 401 error from using the wrong token has burned multiple engineers.

**HTTP API vs CLI:** The HTTP `/v2/pipeline` API works from anywhere (workflow script nodes, curl in worker containers). The CLI is better for local dev and interactive queries. Workflow nodes should use the HTTP API.
