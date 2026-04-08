---
topic: Slack Message Deduplication — Improving Agent Thread Experience
status: complete
exploration_type: workflow_to_improve
created: 2026-04-08
---

## Context

User feedback reported that when an agent works on a Slack-triggered task, the resulting Slack thread contains **two messages with overlapping content**:

1. **Automatic progress/outcome message** — linked to the task, updates with progress, and on completion posts the task outcome (e.g., "Answered Marcel's hypothetical question about creating custom Iterable user properties with daily updates...")
2. **Agent's actual Slack reply** — the detailed answer posted via the `slack-reply` tool (e.g., the full response about Iterable's User Update API)

The problem: on task completion, the outcome summary and the agent's final reply are very similar. The outcome says something like "Replied in Slack thread with details about X" while the actual reply IS those details. Users see two bot messages from the same agent saying essentially the same thing.

Additional observation: both messages sometimes appear to come from the lead, not the worker — adding to the confusion about who is saying what.

### Technical Reality (from code exploration)

There are **two independent message flows** that both post to the same Slack thread:

| Aspect | Evolving Message (Watcher) | slack-reply Tool |
|--------|---------------------------|--------------------|
| **Trigger** | DB polling every 3s (task status) | Agent explicitly calls tool |
| **Method** | `chat.update` — transforms same message | `chat.postMessage` — always new message |
| **Lifecycle** | Assignment → Progress → Completion | Any time during execution |
| **Completion format** | `✅ AgentName (task-id) · duration` + `task.output` | Agent's actual detailed response |

When an agent's task involves replying in Slack (via slack-reply), the thread ends up with:
1. The agent's detailed reply (via `chat.postMessage`)
2. The evolving message updated to final state with `task.output` which often says something like "Answered question about X, confirmed feasibility..." — a summary of the reply that's already there.

Both messages appear under the same bot identity.

## Exploration

### Q: What's the primary purpose of the evolving message?
Status/progress indicator. Its value is showing the task is in-progress/done — the outcome text is secondary when the agent already replied.

**Insights:** This means when the agent has already replied via slack-reply, the evolving message's completion state doesn't need to repeat the content. It just needs to signal "done" and maybe link to the reply. The outcome text is really only important when there's no other visible artifact in the thread.

### Q: Should the system track whether the agent replied via slack-reply, or keep it simpler?
Collapse outcome conditionally — show outcome in the evolving message only if no slack-reply was sent during that task. Middle ground between precision and simplicity.

**Insights:** This requires some mechanism to track whether `slack-reply` was called during a task's lifecycle. Could be a simple flag/counter on the task record (`slackReplySent: boolean`), set when the slack-reply tool executes. The watcher then checks this flag at completion time to decide whether to include the full outcome or just a status line.

### Q: What should the collapsed completion message look like?
Minimal status line only: `✅ Neo (c3cc6f51) · 2m 14s` — no outcome text at all. Clean and trusts the reply speaks for itself.

**Insights:** This is the cleanest option. The reply IS the outcome. No need to repeat or summarize it. The status line confirms the task completed and how long it took — that's all the metadata needed.

### User interjection: "Adding clear links to the UI would be key, so we never lose context!"

**Insights:** Even with a minimal status line, the completion message should link to the task in the dashboard UI. This way users can always drill into full details (outcome, logs, progress history) without cluttering the Slack thread. The task ID is already there — making it a clickable link to `APP_URL/tasks/<id>` would be the simplest way.

### Q: Is APP_URL available to the Slack integration?
Yes, APP_URL is available.

**Insights:** Great — we can make the task ID a Slack mrkdwn link: `<${APP_URL}/tasks/${taskId}|${shortId}>`. This turns the minimal status line into a useful entry point for deeper investigation.

### Note: Agent identity
"Neo" in the screenshot is a client's agent name. Our default app identity is "Agent Swarm". The bot name in Slack depends on how the Slack app is configured, not something we control per-message (unless using `username` override in `chat.postMessage`).

### Q: Should the evolving message show the worker's identity when a worker is assigned?
Show both but minimal, like a small delegation tree, with task links.

**Insights:** This gives visibility into who assigned and who executed, while keeping it compact. Combined with clickable task links, users can always trace the full chain. The tree metaphor also works well for multi-agent scenarios where a lead delegates to multiple workers.

### Q: Which tree format for the completion message?
Option A (Inline tree) — but should show all task links including the lead's task, and should handle multiple child tasks (multi-worker delegation).

**Insights:** The tree naturally extends to multi-child scenarios. The lead task is the root, and each worker task is a child node. This mirrors the actual parent-child task relationship in the DB (`parentTaskId`). For a lead that delegates to 2 workers, it would look something like:

```
✅ Lead (a1b2c3d4) · 5m 30s
├ Worker1 (e5f6g7h8) · 2m 14s ✅
└ Worker2 (i9j0k1l2) · 3m 45s ✅
```

Each ID is a clickable link to the dashboard. This is both informative and compact.

### Q: Should the tree update live as children complete, or only render at the end?
Live updates — the tree grows as each child completes. Users see the tree fill in progressively.

**Insights:** This is the most engaging UX but has implementation complexity:
- The watcher already polls every 3s and calls `chat.update` — the infrastructure is there
- Need to track parent-child relationships in the message tracking (currently only tracks one task per message)
- When a child completes, we'd need to find its parent task's tracked message and rebuild the tree
- Race conditions: two children completing simultaneously could cause conflicting updates (but Slack's `chat.update` is eventually consistent)
- The `taskMessages` map would need to work bidirectionally: child → parent's tracked message

### Q: Scope check — full vision or tight fix?
Full vision. We'll brainstorm the complete tree UX now and scope the implementation later.

**Insights:** Good — this means we can explore the ideal end state without being constrained by implementation phases yet. The planning phase will handle phasing.

### Q: Should the worker's reply be separate or embedded in the tree?
Embed in tree (option 2), and importantly — one tree message per thread for follow-ups too. The tree grows as the conversation continues.

**Insights:** This is a fundamental shift. Instead of multiple evolving messages (one per task), there'd be ONE tree message per Slack thread that tracks the entire conversation:

```
⏳ Lead (a1b2c3) · working...
├ ✅ Worker1 (e5f6g7) · 2m
│   "Here's how Iterable's User Update API works..."
├ ✅ Worker2 (i9j0k1) · 3m
│   "The backend integration is ready at..."
└ ⏳ Follow-up (m3n4o5) · working...
    Assigned to Worker1
```

This means:
- The tree message becomes the **single source of truth** for the thread's agent activity
- Follow-up tasks get appended as new children in the same tree
- Slack-reply content gets embedded under the relevant child node
- Major reduction in message count per thread

### Q: How to handle long replies that exceed Slack's block limits?
Truncate + link to full. Show first ~200 chars of the reply in the tree, with a "View full response" link to the dashboard.

**Insights:** This keeps the tree compact while still giving immediate context. The dashboard link ensures nothing is lost.

### Q: Should slack-reply update the tree or stay as-is?
**No** — slack-reply should continue working as-is (posting separate messages). The tree/pinned message is only about **status tracking** (assignment → progress → completion + links). It's not the content delivery mechanism.

**Insights — KEY CORRECTION:** This reshapes the mental model:
- **Tree message** = pure status tracker. Shows who's working, progress, completion, and dashboard links. One per thread, evolves in place.
- **slack-reply messages** = agent's actual content. Separate messages in the thread. Unchanged behavior.
- **Deduplication** = the tree does NOT paste `task.output` when the agent already replied via slack-reply. It just shows `✅ completed · link`.
- The "embed reply content" answer earlier was about previewing/summarizing in the tree, not replacing slack-reply.

### Q: Confirmed mental model?
Yes, exactly:
- **slack-reply used** → tree shows `✅ + link` only (no outcome text)
- **no slack-reply** → tree shows `✅ + truncated outcome + link`
- The tree is always status-first, content is conditional

### Q: One tree per thread or per round?
New tree per round. Each user message creates a new tree message. Keeps trees focused on one interaction round.

**Insights:** This is more manageable:
- One tree per "user message → task(s) created" cycle
- If a lead delegates to 3 workers for one request, those 3 are all in the same tree
- If the user sends a follow-up, a fresh tree is created for that round
- Avoids infinitely growing trees in long threads
- The current `registerTaskMessage()` mechanism maps naturally: register at assignment time, one message per round

### Q: How to handle failures in the tree?
Always show the error. Failures are exceptional — always surface the error regardless of slack-reply usage.

**Insights:** Makes sense. A failure needs immediate visibility. The tree would show `❌ Worker (id) · error summary + link`. This is different from the success case where we conditionally show/hide outcome. Asymmetric behavior (successes can be minimal, failures are always verbose) matches user expectations.

### Q: DM/assistant threads — tree or current behavior?
Tree for DMs too. Unify the experience across all contexts.

**Insights:** Currently DMs use `setAssistantStatus()` for typing indicators, which is a completely different code path. Unifying means DMs would also get a tree message posted (via `chat.postMessage`) instead of relying on assistant status. This simplifies the watcher logic — one code path for all contexts. The assistant typing indicator could still be used in parallel for UX ("is typing..." while the tree shows progress).

### Q: Should cancelled tasks appear in the tree?
Yes, show 🚫. Cancelled tasks show in the tree so users know something was started then stopped.

**Insights:** This provides audit trail in the thread. Users can see "oh, that task was cancelled" rather than it silently disappearing. Consistent with the principle that the tree is the single source of truth for what happened in that round.

### Q: Progress text during execution — per-child or aggregated?
Per-child progress. Each child node shows its own progress text.

**Insights:** This is the most informative option. Users can see exactly what each worker is doing. Combined with the 3-second polling interval, it gives near-real-time visibility. The tree grows naturally:

```
⏳ Lead (a1b2c3)
├ ⏳ Worker1 (e5f6g7)
│   Researching Iterable API docs...
└ ⏳ Worker2 (i9j0k1)
    Setting up Cloud Function...
```

Potential concern: with many workers (5+), the message could get tall. But this is unlikely in practice and the truncation could handle it.

## Synthesis

### Key Decisions

1. **The evolving message is a pure status tracker** — not a content delivery mechanism. `slack-reply` continues to post standalone messages for actual agent content.

2. **Conditional outcome display** — when the agent used `slack-reply` during a task, the completion state shows only `✅ + link` (no outcome text). When no `slack-reply` was used (e.g. code tasks), show truncated outcome (~200 chars) + dashboard link.

3. **Tree-based status message** — replace the current flat evolving message with a delegation tree showing lead → worker(s) hierarchy with per-node status, progress, and clickable dashboard links.

4. **One tree per interaction round** — each user message that creates task(s) gets its own tree message. Follow-up messages create new trees. No infinitely growing trees.

5. **Live updates** — the tree updates in place via `chat.update` as children change state (progress text, completion, failure). Polling infrastructure already exists (3s interval).

6. **All task IDs are clickable links** — `<${APP_URL}/tasks/${taskId}|${shortId}>` format. Both lead and worker task links visible. No context is ever lost.

7. **Unified experience** — DMs/assistant threads get the same tree treatment as channel threads. One code path for all contexts.

8. **Failures always show error** — asymmetric with success: failures always surface error text + link, regardless of slack-reply usage.

9. **Cancelled tasks show 🚫** — visible in the tree for audit trail.

10. **Per-child progress text** — each worker node shows its own progress during execution.

### Visual Reference

**During execution:**
```
⏳ Lead (a1b2c3)
├ ⏳ Worker1 (e5f6g7)
│   Researching Iterable API docs...
└ ⏳ Worker2 (i9j0k1)
    Setting up Cloud Function...
```

**On completion (slack-reply was used):**
```
✅ Lead (a1b2c3) · 5m 30s
├ ✅ Worker1 (e5f6g7) · 2m 14s
└ ✅ Worker2 (i9j0k1) · 3m 45s
```

**On completion (no slack-reply — e.g. code task):**
```
✅ Lead (a1b2c3) · 5m 30s
└ ✅ Worker1 (e5f6g7) · 2m 14s
    Created PR #42 with the new validation logic for...
    View full response →
```

**Mixed states:**
```
⏳ Lead (a1b2c3)
├ ✅ Worker1 (e5f6g7) · 2m 14s
├ ❌ Worker2 (i9j0k1) · 45s
│   Error: API rate limit exceeded
└ 🚫 Worker3 (m3n4o5) — Cancelled
```

### Implementation Requirements

1. **Track `slackReplySent` flag on tasks** — set by the `slack-reply` tool when called. The watcher checks this flag to decide outcome display behavior.

2. **Tree message builder** — new Block Kit builder that renders the delegation tree using Slack mrkdwn. Needs to handle variable depth (lead + N workers) and mixed states.

3. **Parent-aware message tracking** — extend `taskMessages` map to support multiple tasks per message (one tree message → multiple task IDs). Child tasks need to find their parent's tracked message.

4. **Unified watcher code path** — remove the DM-specific branch in the watcher. Both channel threads and DMs get tree messages.

5. **Dashboard link generation** — read `APP_URL` env var in the Slack context, construct task links.

### Open Questions (Resolved)

1. **Tree rendering** → Use Unicode box-drawing characters (├ └ │) but must be visually tested in Slack to ensure it renders well and links remain clickable.
2. **Lead with no children** → Show a single tree node. No special handling needed.
3. **APP_URL fallback** → Should be set in env, but fallback to `https://app.agent-swarm.dev` if missing. Never show a plain-text unlinked ID.
4. **Max children shown** → 8 children visible, then collapse with "and N more..." text for the rest.

### Constraints Identified

- Slack `chat.update` must include the full message content on every update (no partial patches)
- Slack block limit: 50 blocks per message, 3000 chars per text block
- `chat.update` rate limits (~50 per minute per token) could be hit with many concurrent tasks
- The 3-second polling interval means tree updates have up to 3s latency
- DM unification requires the Slack app to have `chat:write` scope for DM channels (likely already granted)

### Core Requirements

- R1: When an agent uses `slack-reply` during a task, the evolving/tree message must NOT include outcome text on completion
- R2: All task IDs in the tree message must be clickable links to the dashboard
- R3: The tree message must show the lead → worker delegation hierarchy with per-node status
- R4: The tree must update live as child tasks change state
- R5: One tree message per interaction round (per user message that creates tasks)
- R6: Failures always show error text regardless of slack-reply usage
- R7: DMs and channel threads use the same tree-based status message
