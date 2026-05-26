---
date: 2026-05-25
qa_engineer: Codex
feature: Client-side end-user MCP (DES-444)
plan: thoughts/taras/plans/2026-05-22-client-side-end-user-mcp.md
pr: https://github.com/desplega-ai/agent-swarm/pull/536
branch: feat-client-mcp-des-444
commit: 7729e522543f9b4ec0a280cb9d239b74464536d1
status: pass
verdict: PASS
---

# QA Report: Client-side End-user MCP (DES-444)

## Scope

Validate the hosted end-user MCP surface at `/mcp-user`, operator token mint/revoke routes,
ownership scoping for user task tools, owner `/mcp` regression safety, user-budget claim
admission, generated OpenAPI freshness, and the People-page token UI build health.

This QA used a fresh local API server session with an isolated SQLite database:

```bash
PORT=4313 \
DATABASE_PATH=/tmp/des444-qa.sqlite \
API_KEY=123123 \
AGENT_SWARM_API_KEY=123123 \
MCP_BASE_URL=http://127.0.0.1:4313 \
SLACK_DISABLE=true \
GITHUB_DISABLE=true \
JIRA_DISABLE=true \
LINEAR_DISABLE=true \
bun run start:http
```

The server applied migrations through `074_user_budget_scope` and served MCP at
`http://localhost:4313/mcp`.

## Test Cases

| ID | Scenario | Result | Evidence |
|---|---|---:|---|
| TC-1 | CI is green for PR #536 on the current head SHA | PASS | GitHub PR check rollup for `7729e522`: Merge Gate, Run Tests, Lint and Type Check, UI Lint and Type Check, OpenAPI Spec Freshness Check, Dockerfile builds, CodeQL, Vercel previews all `SUCCESS`. |
| TC-2 | Fresh DB/server boots and applies DES-444 migration chain | PASS | Fresh server on `/tmp/des444-qa.sqlite`; migrations `001` through `074_user_budget_scope` applied successfully. |
| TC-3 | Operator can create a user and mint an `aswt_` MCP token | PASS | `POST /api/users` returned user `6c3510a3...`; `POST /api/users/{id}/mcp-tokens` returned a one-time plaintext token with `aswt_` prefix and token summary. Plaintext token is not stored in this report. |
| TC-4 | `/mcp-user` rejects missing token | PASS | `POST /mcp-user initialize` without `Authorization` returned `401`. |
| TC-5 | `/mcp-user` initializes with valid active-user token and exposes exactly the user task tools | PASS | `initialize` returned an `mcp-session-id`; `tools/list` returned exactly `cancel-task,get-task-details,get-tasks,send-task,task-action`. |
| TC-6 | User `send-task` creates a task owned by the token user | PASS | `tools/call send-task` created task `c0c34301-...` with `requestedByUserId=6c3510a3...`. |
| TC-7 | User `get-tasks` is hard-scoped to the token user | PASS | Created a second task for user B through operator API. User A `/mcp-user get-tasks` had `contains_a=true contains_b=false`. |
| TC-8 | Foreign task details return explicit forbidden, not hidden/not-found | PASS | User A `get-task-details` for user B task returned `isError=true` and `structuredContent.code=forbidden`. |
| TC-9 | Owner `/mcp` route still initializes with swarm API key | PASS | `POST /mcp initialize` with `Authorization: Bearer 123123` and valid `X-Agent-ID` returned `200`. |
| TC-10 | Token revocation blocks the next request on an already-open MCP session | PASS | After `DELETE /api/users/{id}/mcp-tokens/{tokenId}`, reused `mcp-session-id` + old token on `tools/list`; server returned `401`. User events included `token_revoked`. |
| TC-11 | User-budget claim admission is covered by targeted regression | PASS | `src/tests/budget-user-scope.test.ts` includes `/mcp-user task is refused at worker admission when user budget is spent`; local targeted suite passed. |
| TC-12 | UI People Tokens changes are type/lint clean | PASS | `cd ui && pnpm lint` and `cd ui && pnpm exec tsc -b` passed after updating `ui/src/api/types.ts` so `BudgetScope` includes `"user"`. |
| TC-13 | Browser screenshot walkthrough of People -> Tokens tab | PASS | `agent-browser` walkthrough against local UI/API: selected the Browser QA user, opened People -> Tokens, captured the empty state, minted a token, verified client snippet modal actions, closed it without storing plaintext, then revoked the token. Screenshots: `thoughts/taras/qa/2026-05-25-client-side-end-user-mcp-screenshots/01-tokens-tab-empty.png`, `thoughts/taras/qa/evidence/2026-05-25-people-tokens-agent-browser.png`, `thoughts/taras/qa/evidence/2026-05-25-people-tokens-revoked-agent-browser.png`. |

## Commands Run

```bash
bun test src/tests/task-tools-ctx.test.ts \
  src/tests/task-tools-ownership.test.ts \
  src/tests/mcp-user-route.test.ts \
  src/tests/user-token-routes.test.ts \
  src/tests/budget-user-scope.test.ts \
  src/tests/budgets-routes.test.ts \
  src/tests/budget-admission.test.ts
```

Result: `57 pass, 0 fail`.

```bash
bun run tsc:check
bash scripts/check-db-boundary.sh
bash scripts/check-api-key-boundary.sh
bun run docs:openapi && git diff --exit-code openapi.json docs-site/content/docs/api-reference
cd ui && pnpm lint
cd ui && pnpm exec tsc -b
```

Result: all passed.

```bash
PORT=4313 \
DATABASE_PATH=/tmp/des444-browser-qa.sqlite \
AGENT_SWARM_API_KEY=qa-browser-key \
API_KEY=qa-browser-key \
MCP_BASE_URL=http://127.0.0.1:4313 \
bun src/http.ts

VITE_PROXY_TARGET=http://127.0.0.1:4313 \
pnpm exec vite --host 127.0.0.1 --port 5277

agent-browser --session des444-qa open \
  'http://127.0.0.1:5277/people/be53aff83a0e4ec8b9d7859b3371fbe7?tab=tokens'
agent-browser --session des444-qa snapshot -i
agent-browser --session des444-qa screenshot \
  thoughts/taras/qa/evidence/2026-05-25-people-tokens-agent-browser.png
agent-browser --session des444-qa screenshot \
  thoughts/taras/qa/evidence/2026-05-25-people-tokens-revoked-agent-browser.png
```

Result: browser walkthrough passed; screenshots captured at 1280x577. The one-time
plaintext token was not stored in this report.

## Evidence Details

Fresh-session MCP CLI evidence:

```text
missing token status: 401
tools: cancel-task,get-task-details,get-tasks,send-task,task-action
created task requestedByUserId: c0c34301-2ce9-47eb-b625-1480894fa3ae 6c3510a3b8ab47989e266d222c735671
get-tasks ownership filter: contains_a=true contains_b=false
foreign detail forbidden: isError=true code=forbidden
owner mcp initialize status: 200
revoked existing session status: 401
token revoked event count: 1
```

CI evidence:

```text
PR #536 head: 7729e522543f9b4ec0a280cb9d239b74464536d1
Merge Gate: SUCCESS
Run Tests: SUCCESS
Lint and Type Check: SUCCESS
UI Lint and Type Check: SUCCESS
OpenAPI Spec Freshness Check: SUCCESS
Docker Build Test (Dockerfile): SUCCESS
Docker Build Test (Dockerfile.worker): SUCCESS
CodeQL actions/javascript-typescript: SUCCESS
Vercel app/docs/templates previews: SUCCESS
```

People Tokens browser evidence:

```text
agent-browser snapshot: Tokens (1) tab selected for Browser QA User
token row after mint: label="browser qa token", preview="aswt_...1AyA", status="ACTIVE"
token row after revoke: label="browser qa token", preview="aswt_...1AyA", status="REVOKED"
API confirmation: revokedAt="2026-05-25T14:40:35.948Z"
screenshots:
  thoughts/taras/qa/2026-05-25-client-side-end-user-mcp-screenshots/01-tokens-tab-empty.png
  thoughts/taras/qa/evidence/2026-05-25-people-tokens-agent-browser.png
  thoughts/taras/qa/evidence/2026-05-25-people-tokens-revoked-agent-browser.png
```

## Issues Found

None.

## Verdict

PASS. The core DES-444 behavior works in a fresh local server session, targeted regression
tests pass, PR #536 CI is green, the stale UI `BudgetScope` type now includes `"user"`, and
the People -> Tokens mint/snippets/revoke flow has browser screenshot evidence.
