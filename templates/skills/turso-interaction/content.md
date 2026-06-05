# Turso Interaction

## The two-token model (READ THIS FIRST)

Turso has two separate auth planes — they do NOT cross over.

| Token type | Where it works | Stored in swarm config as | Signature | Expiry |
|---|---|---|---|---|
| **Platform JWT** (management plane) | `api.turso.tech/v1/*` — list orgs, list DBs, mint DB tokens, group/db CRUD; also what the `turso` CLI uses | `TURSO_API_TOKEN` | Clerk-issued RS256 | ~7 days — Clerk rotates it |
| **DB token** (data plane) | `https://<db-host>/v2/pipeline` — SELECT/INSERT/etc. against a specific DB | `TURSO_DB_TOKEN` (content-state), `TURSO_X_POSTS_DB_TOKEN` (x-posts), etc. | EdDSA | non-expiring (mint with `--expiration none`) or per-token TTL |

Using the **platform JWT against `/v2/pipeline` returns `HTTP 401 "invalid JWT token: can't be decoded with any of the existing keys"`** on every DB — that's by design, not a bug. If you see that error, you reached for the wrong token. Use the DB-specific one.

The platform JWT *can*, however, **mint** a DB token for any DB (see "Mint a DB token via API" below) — that's how you bootstrap access to a DB whose token isn't stored in config.

## Swarm config inventory

Always fetch with `get-config includeSecrets=true` and adapt the key list to your deployment:

| Key | Plane | Scope | Notes |
|---|---|---|---|
| `TURSO_API_TOKEN` | Platform | global | Clerk JWT. Expires periodically. When expired, surface it to the configured token owner. |
| `TURSO_DB_TOKEN` | Data (content-state) | global | EdDSA, non-expiring. Used with `TURSO_DB_URL` for `/v2/pipeline`. |
| `TURSO_DB_URL` | Data | global | `https://<db-name>-<org>.aws-eu-west-1.turso.io` (HTTPS form — required for HTTP API). |
| `TURSO_X_POSTS_DB_TOKEN` | Data (x-posts) | global | EdDSA, non-expiring. |
| `TURSO_X_POSTS_DB_URL` | Data | global | `libsql://<db-name>-<org>.aws-eu-west-1.turso.io` — **swap `libsql://` → `https://` before hitting `/v2/pipeline`**. |

`dummy-test-db` has no stored DB token. Mint one via the API on demand (recipe below).

## Querying via HTTP API `/v2/pipeline` (the workflow path)

Workflow script nodes hit the DB over HTTP. This is the pattern to use anywhere outside the CLI.

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

Response shape (success):
```json
{"results":[{"type":"ok","response":{"type":"execute","result":{"cols":[{"name":"name","decltype":"TEXT"}],"rows":[[{"type":"text","value":"posts"}]]}}}, {"type":"ok","response":{"type":"close"}}]}
```

Always include `{"type":"close"}` as the last request. Use parameterized statements (`stmt.args`) for user-supplied values, not string-built SQL.

**URL form**: `/v2/pipeline` only accepts `https://`. If a config key holds the `libsql://` form, rewrite the scheme:
```bash
URL="${TURSO_X_POSTS_DB_URL/libsql:\/\//https:\/\/}"
```

## Mint a DB token via the platform API

When a DB has no stored token (e.g., `dummy-test-db`), mint one with the platform JWT:

```bash
DB=dummy-test-db
DB_TOKEN=$(curl -s -X POST \
  "https://api.turso.tech/v1/organizations/$TURSO_ORG/databases/$DB/auth/tokens?authorization=read-only" \
  -H "Authorization: Bearer $TURSO_API_TOKEN" | jq -r '.jwt')
```

`authorization` can be `read-only` or `full-access`. Add `?expiration=1d` (or `7d`, `never`) to control TTL.

## CLI installation

```bash
curl -sSfL https://get.tur.so/install.sh | bash
export PATH="$HOME/.turso:$PATH"
```

The binary lives at `~/.turso/turso`. PATH must be exported in the same session.

## CLI authentication

The CLI uses the **platform JWT**, not a DB token:

```bash
turso config set token "$TURSO_API_TOKEN"
turso org switch "$TURSO_ORG"
turso db list   # verify
```

Do NOT use `turso auth login` — it needs a browser. Always feed the config token in.

If `turso db list` returns 401, the platform JWT has expired — refresh `TURSO_API_TOKEN` in swarm config or ask the configured token owner.

## CLI database operations

```bash
turso db create <name>                       # default group, aws-eu-west-1
turso db list
turso db show <name>                         # URL, region, size
turso db shell <name>                        # interactive
turso db shell <name> "SELECT * FROM t;"     # one-shot
turso db shell <name> < dump.sql             # pipe file
turso db destroy <name>                      # !!!
```

## CLI DB-token generation

```bash
turso db tokens create <name>                       # default TTL
turso db tokens create <name> --expiration none     # non-expiring (what we store in config)
turso db tokens create <name> --read-only           # SELECT-only
```

After generating, write back to swarm config with `set-config` (mark `isSecret=true`).

## Seeding a Turso DB from local SQLite

```bash
sqlite3 local.db .dump > dump.sql
turso db create <name>
turso db shell <name> < dump.sql
```

## Connection-URL pattern

```
libsql://<db-name>-<org>.aws-eu-west-1.turso.io   # for libsql:// clients
https://<db-name>-<org>.aws-eu-west-1.turso.io    # for HTTP API /v2/pipeline
```

Same host, two schemes. Some config keys store the libsql form, some the https form — normalize before use.

## Key databases

| Database | HTTPS URL | Token config key | Used by |
|---|---|---|---|
| `<db-name>` | `https://<db-name>-<org>.aws-eu-west-1.turso.io` | `<TOKEN_CONFIG_KEY>` | Describe what uses this DB |

## Groups

```bash
turso group list
turso group create <name> --location <location>
```

Default group: `default` in `aws-eu-west-1`.

## Local development

```bash
turso dev    # starts a local LibSQL server
```

## Full bootstrap from scratch

```bash
curl -sSfL https://get.tur.so/install.sh | bash
export PATH="$HOME/.turso:$PATH"
# Fetch TURSO_API_TOKEN via get-config includeSecrets=true
turso config set token "$TURSO_API_TOKEN"
turso org switch "$TURSO_ORG"
turso db list
```

## Health-check recipe (verify all 3 DBs in <30s)

```bash
# Platform plane
curl -s -H "Authorization: Bearer $TURSO_API_TOKEN" \
  "https://api.turso.tech/v1/organizations/$TURSO_ORG/databases" | jq '[.databases[].Name]'

# Data plane — one /v2/pipeline call per DB
for pair in "$TURSO_DB_URL|$TURSO_DB_TOKEN" "$TURSO_SECONDARY_DB_URL|$TURSO_SECONDARY_DB_TOKEN"; do
  url="${pair%|*}"; tok="${pair#*|}"
  curl -s -X POST "$url/v2/pipeline" -H "Authorization: Bearer $tok" \
    -H "Content-Type: application/json" \
    -d '{"requests":[{"type":"execute","stmt":{"sql":"SELECT 1"}},{"type":"close"}]}' \
    | jq -c '.results[0]'
done
```

If either plane returns 401, treat as a blocker — surface in HEARTBEAT.md, do not retry silently.

## When tokens expire / get rotated

- **`TURSO_API_TOKEN` expired** → CLI breaks, can't mint new DB tokens, `api.turso.tech` returns 401. Existing DB tokens keep working (data plane is independent). Action: the token owner rotates via Turso dashboard and updates config.
- **A DB token expired/revoked** → that specific DB returns 401 on `/v2/pipeline`. Other DBs unaffected. Action: mint a new one (CLI or platform API), update the corresponding config key.

Don't conflate the two failure modes. The blocker-digest writer should name the exact key that needs rotation.
