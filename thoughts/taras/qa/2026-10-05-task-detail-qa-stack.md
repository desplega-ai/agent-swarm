---
date: 2026-10-05
topic: task detail page QA stack
related_plan: thoughts/taras/plans/2026-10-05-task-detail-page-overhaul.md
---

# Task detail QA stack

A throwaway local stack that renders the task detail page with production-like data:
- a seeded API from `packages/ui-e2e`;
- real Claude session logs grafted onto the seeded tasks;
- a Vite dev server on port 5275.

The 2026-10-05 UI audit used it, and the overhaul plan uses it for Automated QA.

Ports 3013 and 5274 may belong to another worktree. This stack never uses them.

## Start

Save the two scripts at the end of this file to `/tmp/task-audit/graft.ts` and `/tmp/task-audit/connect.sh` (`chmod +x`). Then:

```bash
mkdir -p /tmp/task-audit
# 1. Seeded API. Integrations OFF: the repo .env carries real Slack tokens.
cd packages/ui-e2e && (tail -f /dev/null | E2E_KEEP=1 bun boot/sut.ts \
  --sut-env APP_URL=http://localhost:5275 --sut-env SLACK_DISABLE=true \
  --sut-env GITHUB_DISABLE=true --sut-env JIRA_DISABLE=true \
  --sut-env LINEAR_DISABLE=true --sut-env GITLAB_DISABLE=true \
  > /tmp/task-audit/sut.out 2> /tmp/task-audit/sut.err &)
# Wait until /tmp/task-audit/sut.out has the {"apiUrl":...} line.

# 2. Graft real logs, cost, context and a Slack-style prompt. Prints the task routes.
bun /tmp/task-audit/graft.ts

# 3. UI. Use plain vite: `bun run dev` needs the portless proxy.
cd apps/ui && VITE_PROXY_TARGET=$(bun -e 'console.log(JSON.parse(require("fs").readFileSync("/tmp/task-audit/sut.out","utf8")).apiUrl)') \
  bunx vite --port 5275 --strictPort

# 4. Open a route in an agent-browser session. The connection is same-origin via the vite proxy.
/tmp/task-audit/connect.sh <session> /tasks/<id>
```

Routes printed by `graft.ts`:
- completed: mirrors the prod Slack task
- in progress: live log, PR source
- failed: OOM reason
- pending
- offered
- draft

## Known gaps

- The seed sets `STEERING_ENABLED=false`, so the steer composer does not render. To see it, mock `/api/stats` in your own browser session (`agent-browser network route`). Or send `PUT /api/config` with `{"scope":"global","key":"STEERING_ENABLED","value":"true"}` to the throwaway API.
- `graft.ts` reads specific orphan `session_logs` rows (`d8ce6e81...` and `0e392c4f...`) from the local dev DB `./agent-swarm-db.sqlite`. On another machine, use any Claude session log instead.
- CORS: the API does not allow `localhost:5275`, so the connection must use the vite proxy origin. `connect.sh` handles this.

## Measurements used as acceptance checks

Run them with `agent-browser --session <s> eval "<js>"`.

```js
// Height of the session-log scroll viewport. The scroller is the overflow-y-auto element inside the log card.
(() => { const s=[...document.querySelectorAll('[class*="overflow-y-auto"]')].find(e=>e.closest('[data-slot="session-log-viewer"], .rounded-lg') && e.scrollHeight>e.clientHeight); return s ? Math.round(s.getBoundingClientRect().height) : null })()
// Horizontal overflow of the document.
document.documentElement.scrollWidth > innerWidth
// Visible text elements under 11px.
[...document.querySelectorAll('main *')].filter(e=>e.childNodes.length&&[...e.childNodes].some(n=>n.nodeType===3&&n.textContent.trim())&&e.offsetParent&&parseFloat(getComputedStyle(e).fontSize)<11).length
```

## Stop

```bash
pkill -f "boot/sut.ts --sut-env APP_URL=http://localhost:5275"   # SIGTERM stops the API
lsof -nP -iTCP:5275 -sTCP:LISTEN -t | xargs kill                    # vite only (keep the LISTEN filter)
rm -rf /tmp/e2e-*                                                   # E2E_KEEP leftovers
```

## Scripts

### `/tmp/task-audit/graft.ts`

```ts
// Grafts realistic data onto the seeded e2e tasks so the task detail page
// renders like production. Throwaway QA helper for the 2026-10-05 UI audit.
import { Database } from "bun:sqlite";

const sut = JSON.parse((await Bun.file("/tmp/task-audit/sut.out").text()).trim());
const manifest = JSON.parse(await Bun.file(sut.manifestPath).text());
const devDb = new Database("/Users/taras/Documents/code/agent-swarm/agent-swarm-db.sqlite", {
  readonly: true,
});
const db = new Database(sut.dbPath);
db.exec("PRAGMA busy_timeout = 5000");

const workerA = manifest.agents.workerA as string;
const t = manifest.tasks;

async function api(method: string, path: string, body?: unknown, agentId?: string) {
  const res = await fetch(`${sut.apiUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${sut.apiKey}`,
      "Content-Type": "application/json",
      ...(agentId ? { "X-Agent-ID": agentId } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

function realLines(taskId: string): string[] {
  return (
    devDb
      .query("SELECT content FROM session_logs WHERE taskId = ? ORDER BY iteration, lineNumber")
      .all(taskId) as { content: string }[]
  ).map((r) => r.content);
}

const now = Date.now();
const iso = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();

// ── Completed task: mirror the prod Slack task from Taras's screenshot ──
const slackPrompt = `<@U08NR6QD6CS|Taras>: <@U0A3YMSRKJB> (that's you) what are the events we support via the extensions of the swarm?

<thread_context>
Thread in #swarm-dev (3 earlier messages)
- Taras: we should make the extension system the default way to hook into the swarm
- Lead: agreed, the contract lives in src/extensions/contract.ts
- Taras: ok so which ones can I subscribe to today?
</thread_context>

Reply in the thread. Keep it short and link the doc if one exists.`;

const output = `First PR is §4 item 1 of the doc: bridge the 5 already-emitted events (\`post.vcs.event\` incl. GitHub/GitLab, \`post.approval.resolved\`, plus budget, email, Kapso). Jackknife is building it (\`ef3a67a9\`). \`post.harness.tool.call\` goes in PR 2. I'll post the PR link here once it opens.`;

const completedSession = "f533c9e7-7255-42a0-bb5d-5e6ffc056cdb";
db.query(
  `UPDATE agent_tasks SET task = ?, source = 'slack', taskType = 'question', tags = ?, priority = 50,
     provider = 'claude', harnessVariant = 'stock', harnessVariantMeta = ?, providerMeta = ?,
     model = 'opus', resolvedModel = 'claude-opus-5-5', modelSource = 'agent', swarmVersion = '1.163.0',
     claudeSessionId = ?, credentialKeySuffix = 'D4wAA', credentialKeyType = 'CLAUDE_CODE_OAUTH_TOKEN',
     requestedByUserId = ?, parentTaskId = ?, output = ?, effort = 'high',
     createdAt = ?, finishedAt = ?, lastUpdatedAt = ?
   WHERE id = ?`,
).run(
  slackPrompt,
  JSON.stringify(["slack", "extensions"]),
  JSON.stringify({ version: "2.1.289 (Claude Code)" }),
  JSON.stringify({ transport: "sdk" }),
  completedSession,
  manifest.user.id,
  t.pool[0],
  output,
  iso(12),
  iso(9),
  iso(9),
  t.completed,
);

await api("POST", "/api/session-logs", {
  sessionId: completedSession,
  iteration: 1,
  taskId: t.completed,
  cli: "claude",
  lines: realLines("d8ce6e81-58ed-4c9d-be5c-1617e0b25316"),
});
await api("POST", "/api/session-costs", {
  sessionId: completedSession,
  taskId: t.completed,
  agentId: workerA,
  totalCostUsd: 1.2141,
  inputTokens: 5_900,
  outputTokens: 15_000,
  cacheReadTokens: 1_300_000,
  cacheWriteTokens: 80_900,
  durationMs: 176_000,
  numTurns: 26,
  model: "claude-opus-5-5",
});
for (const [pct, used] of [
  [4, 40_000],
  [7, 70_000],
  [9, 86_700],
] as const) {
  await api(
    "POST",
    `/api/tasks/${t.completed}/context`,
    {
      eventType: pct === 9 ? "completion" : "progress",
      sessionId: completedSession,
      contextUsedTokens: used,
      contextTotalTokens: 1_000_000,
      contextPercent: pct,
      contextFormula: "input-cache-output",
    },
    workerA,
  );
}

// ── In-progress task: a live session with real logs, steering on ──
const liveSession = "903fd38b-3dd7-402f-887e-4cc82fc25d6f";
db.query(
  `UPDATE agent_tasks SET task = ?, source = 'api', provider = 'claude', harnessVariant = 'stock',
     harnessVariantMeta = ?, model = 'sonnet', resolvedModel = 'claude-sonnet-5-5', swarmVersion = '1.163.0',
     claudeSessionId = ?, progress = ?, dir = '/workspace/repos/agent-swarm', vcsProvider = 'github',
     vcsRepo = 'desplega-ai/agent-swarm', vcsNumber = 1871, vcsUrl = 'https://github.com/desplega-ai/agent-swarm/pull/1871',
     vcsAuthor = 'tarasyarema', vcsEventType = 'pull_request', lastUpdatedAt = ?
   WHERE id = ?`,
).run(
  "Review PR #1871 (dreaming-v2 seed patches) and leave inline comments on anything that breaks the seeded-skill invariants. Focus on templates/skills/*/config.json drift and the bundled-files manifest.",
  JSON.stringify({ version: "2.1.289 (Claude Code)" }),
  liveSession,
  "Reading templates/skills/dreaming/content.md and comparing against the generated SKILL.md",
  iso(1),
  t.inProgress,
);
await api("POST", "/api/session-logs", {
  sessionId: liveSession,
  iteration: 1,
  taskId: t.inProgress,
  cli: "claude",
  lines: realLines("0e392c4f-e5c7-4450-86f6-d3ac22b1fe9b"),
});
await api("POST", `/api/tasks/${t.inProgress}/context`, {
  eventType: "progress",
  sessionId: liveSession,
  contextUsedTokens: 412_000,
  contextTotalTokens: 1_000_000,
  contextPercent: 41,
  contextFormula: "input-cache-output",
}, workerA);

// ── Failed task: realistic failure reason ──
db.query(
  `UPDATE agent_tasks SET task = ?, failureReason = ?, provider = 'codex', model = 'gpt-5.6-terra', swarmVersion = '1.163.0'
   WHERE id = ?`,
).run(
  "Bump the pi harness to 1.0.3 in Dockerfile.worker and verify the slim image still boots.",
  "Worker exited with code 137 after 14m 02s (OOM while building `worker-full`).\n\n```\n#23 ERROR: process \"/bin/sh -c bun install --frozen-lockfile\" did not complete successfully: exit code: 137\n```\n\nThe slim target never ran. Retry with `--target worker-slim` or raise the builder memory.",
  t.failed,
);

db.close();
console.log(
  JSON.stringify({
    ui: "http://localhost:5275",
    completed: `/tasks/${t.completed}`,
    inProgress: `/tasks/${t.inProgress}`,
    failed: `/tasks/${t.failed}`,
    pendingLead: `/tasks/${t.pendingLead}`,
    offered: `/tasks/${t.offered}`,
    draft: `/tasks/${t.draft}`,
  }),
);
```

### `/tmp/task-audit/connect.sh`

```bash
#!/usr/bin/env bash
# Usage: connect.sh <session-name> [route]
# Opens the audit dashboard (localhost:5275) in an agent-browser session, writes the
# connection + identity + dismissed-feedback localStorage keys, then opens <route>.
set -euo pipefail
S="$1"
ROUTE="${2:-/tasks}"
SUT=$(cat ${SUT_OUT:-/tmp/task-audit/sut.out})
API=http://localhost:5275  # same origin: vite proxies /api to the audit API
KEY=$(printf '%s' "$SUT" | bun -e 'console.log(JSON.parse(await Bun.stdin.text()).apiKey)')
MANIFEST=$(printf '%s' "$SUT" | bun -e 'console.log(JSON.parse(await Bun.stdin.text()).manifestPath)')
USER_ID=$(bun -e "console.log(JSON.parse(await Bun.file('$MANIFEST').text()).user.id)")
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

agent-browser --session "$S" open "http://localhost:5275/" >/dev/null
agent-browser --session "$S" eval "
localStorage.setItem('agent-swarm-connections', JSON.stringify({connections:[{id:'conn_audit',name:'audit',apiUrl:'$API',apiKey:'$KEY'}],activeId:'conn_audit'}));
localStorage.setItem('swarm:v1:$API:current-user', '$USER_ID');
localStorage.setItem('swarm:feedback-popup:v1:$API:$USER_ID', JSON.stringify({version:1,lastSubmittedAt:null,lastDismissedAt:'$NOW',submissionCount:0}));
'ok'" >/dev/null
agent-browser --session "$S" open "http://localhost:5275$ROUTE" >/dev/null
echo "session=$S opened http://localhost:5275$ROUTE"
```
