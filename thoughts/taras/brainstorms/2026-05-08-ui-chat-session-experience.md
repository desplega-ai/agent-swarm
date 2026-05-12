---
date: 2026-05-08T00:00:00Z
author: taras
topic: "Chat/session experience in ui/ — sessions as task chains"
tags: [brainstorm, ui, sessions, chat, tasks, onboarding]
status: ready-for-research
exploration_type: idea
last_updated: 2026-05-08
last_updated_by: taras
post_research_decisions:
  - source_enum: drop SQL CHECK on agent_tasks.source; tighten HTTP route to AgentTaskSourceSchema.optional(); Zod becomes single source of truth
  - transcript_expansion: shadcn Sheet side-panel embedding existing SessionLogViewer for full transcripts; inline-expand reserved for short summaries
---

# Chat/Session Experience in ui/ — Brainstorm

## Context

Taras wants to explore a "chat" / "session"-like experience inside `ui/` (the dashboard, port 5274) so a user who has **not** connected Slack or GitHub can still get a similar feel from the app itself. Conceptually, a "session" is a chain of tasks — i.e. the same thread-of-conversation pattern that Slack threads or GitHub issue comments today produce in the swarm, but native to the UI.

Today in the swarm, "task chains" emerge from external integrations:
- Slack: a user @-mentions the bot in a thread, the swarm creates a task, follow-up replies in the thread create child/related tasks
- GitHub: an issue/PR comment chain similarly drives work

Without those integrations, a brand-new user opening `ui/` has nowhere to start a conversational task chain — they can create one-off tasks, but there's no thread/session abstraction to scaffold a flow of work.

The proposal: build a first-class chat/session UI inside the dashboard that produces task chains, so the swarm is usable end-to-end with **zero external integrations**.

### Surrounding context (what we know about the system)

- API server owns SQLite; `ui/` is a Next.js app on :5274.
- Tasks already exist as a concept (`agent_tasks` etc.) and have sources (Slack/GitHub/Linear/Jira/manual).
- Slack and GitHub both already model conversational chains externally; the swarm reads/writes to them.
- `AgentTaskSourceSchema` in `src/types.ts` enforces source values via a CHECK constraint — adding a new source ("ui-chat" / "session") would be a migration.

## Exploration

### Q: What's the core motivation — which gap are you most trying to close?
A mix of:
1. **Zero-integration onboarding** — new user, no Slack/GitHub, immediate time-to-first-value via chat
2. **Native chat UX over swarm** — first-class chat surface inside the app; Slack/GitHub become optional, not primary
3. **Continuity across tasks** — sessions make a chain feel like one continuous thing; context/history/follow-ups stay tied together

**Insights:**
- This is *not* purely an onboarding band-aid. It's a real first-class surface that should feel as good (or better) than Slack/GH for the daily case.
- That raises the bar: the chat UI has to be good enough that an integrated user *prefers* it for some flows — not just a fallback.
- The "continuity" angle is the most architecturally novel: today a Slack thread provides continuity *implicitly* (the thread = the chain). In ui/, we have to *model* the session explicitly. That's a real schema/API decision, not just a UI feature.

### Q: What is a "session" structurally?
**Initial answer:** "Session = the parent task" (option 2). First message creates the parent task; follow-ups become subtasks/comments on it. Hope: no backend changes.

**Refinement (Taras):** "It's like a session w the lead in which you focus on a topic essentially."

→ This actually pulls toward **option 3** (Session = an agent conversation), specifically a conversation with the **lead** agent. The lead is the orchestrator; during the session it spawns worker tasks as the topic demands. The "task chain" is a byproduct of the lead's work inside the session, not the session itself.

**Insights / pushback (revised under "session w lead" framing):**
- The lead agent is already a long-running, prompt-driven orchestrator. The new UI is essentially a **direct chat surface to the lead**, with task-spawning visible inline.
- "No backend changes" is still optimistic — the things actually missing:
  1. **A `sessions` (or `lead_conversations`) table.** The lead today reacts to externally-bound contexts (Slack thread, GitHub issue). A UI session needs its own first-class identity, owned by a user, with a transcript.
  2. **Source enum.** `AgentTaskSourceSchema` needs `ui-session` (or similar) so spawned tasks are attributable. Forward-only migration.
  3. **A "post message to session" API.** New endpoint owned by ui/ that hands a message to the lead in the context of a session id.
  4. **A "stream session" channel.** Lead's responses + spawned tasks need to push to ui/ live. SSE/WebSocket. Likely *some* of this exists for the dashboard, but probably not as a user-facing transcript.
  5. **Lead binding model.** Today, *which* lead handles *which* event is implicit (one lead per swarm, or routed by integration config). Per-session: is each session pinned to a lead instance? Does session state survive lead restarts? (Lead lives in Docker via PM2 — restarts happen.)
  6. **Topic / focus boundary.** Taras said "you focus on a topic" — that implies sessions should have scoped context (don't bleed memory from session A into session B). The lead's context window/memory store has to be partitioned per-session.
- Net: schema delta is small-to-medium (new `sessions` table + source enum), API surface is genuinely new, and the lead's prompt/context plumbing needs a session-scoped mode.

### Q: Default behavior of a follow-up message inside a session?
"Always create a child task" — every user message → a new task chained off the parent.

**Insights (re-read under "session w lead" framing):**
- Under the lead-conversation model, this becomes "every user message → the lead receives it; if the lead decides work is needed, it spawns a child task". So strictly speaking it's not "always create a task" — it's "always go through the lead, who almost always spawns a task because that's what it does."
- Worth confirming: does Taras want chat-style replies *from* the lead (e.g. "okay, working on it" or "are you sure?") visible in the transcript, or does the lead stay silent and the user only sees task cards spawning? Slack today has both (bot messages + task progress); ui/ should probably mirror that.
- Sub-questions still live: cancel semantics, course-correction mid-task, ack-only messages — all flow through the lead under this model.

### Q: Lead binding & session lifecycle — how do sessions map to lead instances?
**Taras (correction):** "nono, note that it's just one initial task and all goes from there you know? you would just see all in a single place"

**Re-anchored model:**
- A "session" is **not** a new backend entity, **not** a persistent lead conversation, **not** a binding to a specific lead instance.
- A session is purely a **UI grouping** on top of: one initial task + everything that chains off it. The lead does its normal job; the UI just renders the resulting tree as a chat-like transcript "in one place."
- Backend impact under this corrected framing is much smaller than I claimed. Realistically:
  1. Tasks need a way to be chained (parent_task_id or equivalent). If that already exists for Slack thread chains, we likely reuse it. If not, that's the one real schema add.
  2. Source enum: probably an additional `ui` value if not already there. Trivial migration.
  3. Endpoints: "create task from chat" almost certainly already exists (manual task creation). "Append follow-up to chain" is the only genuine API addition.
  4. Streaming task progress to ui/ — likely already wired for the existing dashboard.
- I was over-architecting (separate sessions table, lead binding model, per-session context partitioning). Drop those. The lead context bleeding / multiplexing question is moot because we're not modeling a persistent lead conversation at all — we're modeling task chains that the UI renders as if they were a chat.
- The remaining design weight shifts almost entirely to the **UI/UX side**: layout, message authoring, transcript rendering, entry points, discovery.

### Q: What appears in the session transcript?
**Taras:** "like 1, with expansion options + it would be nice to have a nice ui for parallel tasks + it should be timeline based"

So: **user messages + task cards** as the default surface, **expandable** per-card for deeper detail (intermediate output, agent reasoning, tool calls), with first-class rendering for **parallel tasks**, all laid out on a **timeline**.

**Insights:**
- "Timeline-based" is the key word. The transcript is not a flat chat scroll — it's a temporal axis where multiple tasks can be in flight at the same horizontal/vertical slice. Closer to a Gantt-meets-thread than a Slack thread.
- Parallel task UI is non-trivial. Two reasonable shapes:
  - **Lanes/swimlanes:** each parallel task gets its own lane next to the main thread. Good for ≤4-ish parallel tasks; breaks down at 10+.
  - **Stacked cards with parallel badge:** tasks render in chronological order of *spawn*, but a "parallel group" wraps them with shared start/end markers and live counts. Scales better.
- Expansion on a task card should reveal: live agent output (streaming), tool calls, file changes/PRs, sub-agents spawned. Cards collapsed by default = fits Taras's "scannable" aesthetic; expanded = power-user inspection.
- The timeline framing has knock-on questions: does the user scroll *down* (chrono down) or *right* (chrono right)? Where does the input box live relative to the timeline (always-pinned bottom? floating? top?)? How do completed-long-ago tasks look vs. live ones?
- This is more design-heavy than I'd assumed — it's a real custom UI, not a chat lib drop-in.

### Q: Where does this live in ui/, and how does it relate to existing surfaces?
**Taras:** "it should be 2 [new top-level page, coexists with tasks], but I would also revamp the dashboard, in fact I would like it to have a react flow with the agents (depending on tasks + usage) of the last 24h, action items to create a session (task) and other stuff like that"

**Two threads now:**

**Thread A — Sessions feature** (the original brainstorm):
- New top-level nav entry "Sessions". Coexists with Tasks/Agents.
- Each session entry → its timeline view (timeline + msg + task cards + expansion + parallel UI from earlier).

**Thread B — Dashboard revamp** (new scope):
- React Flow canvas with **agents** as nodes.
- Node size/position driven by **tasks handled + usage in the last 24h**.
- **Action items** surfaced on the dashboard, one of which is "create a session" (= start an initial task).
- "Other stuff like that" — open-ended placeholder for additional widgets.

**Insights:**
- These are related but separable. Threading them together is sensible because the dashboard is the *entry point* to sessions — you create a session from the dashboard's action items.
- React-flow-of-agents is a known pattern (n8n-style graph, Linear's neural map, observability service maps). Visually striking, but real engineering: layout, animation, click→drill-down, performance with N agents. Reference designs would help — does Taras have a specific app in mind to anchor the aesthetic?
- "Sized/positioned by tasks + usage" — needs clarification. Likely means node size = recent activity count, but layout could be force-directed (clusters by collaboration) or grid (predictable). The choice matters for whether the graph is "art" or "tool".
- "Action items" needs unpacking. Beyond "start a new session," candidates: pending PR reviews assigned to you, paused tasks waiting for input, integration setup nudges, recent failures, open questions from agents. This could become its own inbox concept.
- Scope risk: a sessions feature + react-flow agent canvas + action items inbox + "other stuff" is a major dashboard rework, easily a multi-week project. Worth deciding now whether to **ship sessions first as a standalone surface** and revamp the dashboard in a second pass, or **bundle them** so they launch coherently.

### Q: Sessions + dashboard revamp — how should they ship?
**Taras:** Bundle both, ship together.

**Insights:**
- Coherent UX moment is the right call narratively (one launch = one story: "sessions + new home"). But it means the brainstorm has to treat the *dashboard* as in-scope — we can't park it for later.
- Implication: we still need to nail the dashboard's other components, not just sessions. The react-flow viz, action items inbox, and "other stuff" all need shape before we can produce a coherent plan.
- Ship-together also raises the bar for the launch itself: a half-finished react-flow that lags or looks busted will tank the perceived quality of sessions even if sessions are great. We should design the dashboard so it has a **graceful degraded state** if any one widget isn't ready (e.g. ship without the react-flow if it's not polished, fall back to a simpler agent grid).
- Risk-reduction tactic: define a **"v1 minimum"** and a **"v1 stretch"** for each surface, so the bundle has a credible scope without dragging the launch.

### Q: Dashboard react-flow — what do nodes and edges represent?
**Taras:** Mix of 1 (org chart: lead → workers) and 2 (flow of work: agents + tasks as nodes), open to ideas.

**Proposed synthesis (open for revision):**
- **Spine = org chart.** Lead anchored at top/center. Workers as children. Stable layout, recognizable each visit.
- **Live overlay = flow of work.** Active tasks animate as edges traveling from lead → assigned worker, with lightweight task badges/cards riding the edges (or hovering near worker nodes).
- **Recency dimension = node size/heat.** Last-24h activity drives node size or glow intensity. Idle agents stay small/dim; busy ones pop.
- Click an agent node → side panel with that agent's recent sessions/tasks/usage. Click an in-flight task badge → opens its session.
- This gives the org-chart legibility ("who reports to whom") + the flow-of-work liveness ("look at the system actually working") without fully merging tasks-as-nodes (which gets cluttered).

**Insights / open ideas to consider:**
- A "live" feel matters more than a graph-theoretically pure model. Borrow from observability tools (Datadog service map, Honeycomb traces) where edges *pulse* when traffic is moving — that conveys liveness with minimal complexity.
- Tasks could be **lozenges that travel along edges** rather than nodes. They appear at the lead, animate to the worker, then "settle" near the worker until done, then fade. Conveys flow without permanent edge clutter.
- For the "no integrations / cold start" user, the dashboard graph would be empty/sparse. Need an empty-state design — maybe a placeholder lead node with "Start your first session" CTA where the worker pool would be.
- Question for later: do failures get a distinct visual? (red pulse, broken edge?) Worth surfacing, but probably stretch goal.
- Real engineering risks with react-flow at scale: layout reflow on every state change, animation perf with 50+ agents, mobile rendering, accessibility (graph view is hostile to screen readers — needs a tabular fallback).

### Q: Which action items belong on the dashboard?
**Taras:** All four — Things blocking progress, Things that broke, Things to read, Things to start (quick-starts).

So the dashboard's action-items area is a four-bucket inbox:

| Bucket | Examples | Source |
|---|---|---|
| **Blocking progress** | Paused tasks awaiting input, PRs awaiting human review, missing API keys, "are you sure?" prompts from agents | Task state, PR webhook integration, agent prompts |
| **Broken** | Failed tasks, errored sub-agents, sessions that crashed mid-run | Task state (failed/errored statuses), error logs |
| **To read** | Agent summaries, completion reports, decisions/surprises agents flagged | Agent output store, completion artifacts |
| **To start** | Quick-start templates ("Refactor file", "Investigate bug", "Write PR") | Static template registry, possibly user-customizable |

**Insights:**
- Bucket 1 (Blocking) is functionally an **inbox of pending decisions**. It's the most valuable bucket — without it, agents stall silently and the user doesn't notice.
  - Today this is partially Slack: agent posts a question to a thread, user sees it. Without Slack, there's nowhere for that to live. Sessions + this bucket together close the loop.
- Bucket 2 (Broken) overlaps with bucket 1 (a paused task = "broken-ish"). Need a clear distinction in the data model: *paused-by-design* (agent asked) vs *paused-by-failure* (errored). Probably the same `status` field with sub-states.
- Bucket 3 (To read) is the most subjective — what counts as worth surfacing? Probably needs a "did the agent flag this?" signal at write-time. Otherwise it's a firehose. Could start with a simple "every completed session generates a summary card" approach and tune later.
- Bucket 4 (Quick-starts) is also onboarding gold — it's the answer to "what do I even ask?" for a new user. Worth treating as a small first-class registry (templates with title, description, prefilled prompt).
- Cross-cutting: each bucket needs **dismiss / snooze / done** semantics so the dashboard doesn't become a graveyard. Without this, the inbox decays into noise.
- The four buckets together are essentially a **personal inbox for swarm work**. That framing is powerful and might actually be the headline value prop of the dashboard, more than the react-flow viz.

### Q: v1 minimum that still tells the story?
**Taras:** Sessions + minimal react-flow + action items. (Static org-chart react-flow with recency-based sizing; defer animated task lozenges and live edges to v2.)

**Insights:**
- This is a sensible cut. The narrative is preserved ("new home + chat-style sessions") while deferring the highest-risk visual engineering (animated graph) to v2.
- v1 react-flow becomes essentially: nodes + sizes + click-through. That's a few days of work, not weeks.
- v2 stretch: animate task lozenges traveling along edges, pulsing edges for live work, failure visuals.
- All four action-item buckets stay in v1. Each can be a simple list with cards; sophistication of "what counts as worth surfacing" can grow over time.
- Sessions feature in v1 includes the timeline + msg + task cards + expansion + parallel UI — that's the core feature; cutting any of those undermines the launch.

## Synthesis

### Key Decisions

- **The feature is a bundled launch:** new "Sessions" top-level page **+** revamped dashboard, shipped together as one coherent UX moment. Not two independent rollouts.
- **A "session" is a UI grouping, not a new backend entity.** It is one initial task plus everything that chains off it, rendered together. No new `sessions` table; no persistent lead conversation entity; no per-session lead binding.
- **Slack thread is the reference architecture.** The backend mechanism for sessions is structurally identical to how Slack threads work today: a task with `parent_task_id` set is queued to the lead, which extends the chain. UI sessions are the same flow on a different surface — no new chain primitive, no new lead routing, ideally no new endpoints.
- **Default behavior:** every user message in a session goes through the lead, which (as it does today) almost always spawns a child task. The chain *is* the session.
- **Sessions route & layout:** `/sessions` with a standard Split View — sidebar list of recent sessions on the left, selected session detail on the right.
- **Transcript shape (v1):** timeline-based view of user messages + task cards. Cards collapsed by default, expandable for live agent output / tool calls / sub-agents. First-class rendering for parallel tasks (lanes or parallel-group cards — design TBD).
- **Dashboard shape (v1):** new home page with two main areas:
  - **React-flow agent canvas** — org chart spine (lead → workers), node size driven by last-24h activity. v1 = static, click-through to agent detail. v2 = animated task lozenges on edges, pulse-on-active.
  - **Action items inbox** — four buckets: Blocking progress, Broken, To read, To start (quick-start session templates). List-based cards in v1.
- **Scope cut:** v1 ships sessions + minimal (static) react-flow + all four action-item buckets. Animated graph, "things to read" sophistication, and other niceties go to v2.
- **Empty state matters:** for the zero-integration onboarding angle, the dashboard's empty state must itself be useful — quick-start templates and a visible "Start your first session" CTA need to look healthy when the agent canvas is empty.

### Open Questions

These need verification or further decision before / during planning. They are not blockers, but they shape the work:

- **Slack-thread reference path.** Trace the existing Slack thread → `parent_task_id` → lead-queue flow end-to-end. This is the spec for sessions. Document which functions/handlers/queries to mirror so the UI session creation path is structurally identical.
- **Source enum: free-form or constrained?** Verify whether `agent_tasks.source` has a CHECK constraint listing allowed values (in which case `ui` is a one-line migration) or is free-form text (no migration needed).
- **Endpoints — confirm reuse.** Verify that "create task" + "create child task with `parent_task_id`" cover the full session flow. Expected: yes, no new endpoints required.
- **Live-update mechanism on task detail page.** Identify how the existing task-detail page receives live updates and reuse it for the session timeline. If it's polling, decide whether that's good enough for v1 or if we need streaming for the chat feel.
- **Parallel task UI shape.** Lanes/swimlanes vs. stacked-cards-with-parallel-group. Needs a design pass with mocks; can't pick from prose.
- **Action items source-of-truth.** Each bucket needs a query strategy:
  - Blocking → which task statuses count? Are PRs awaiting review queryable today (GitHub integration)? What about agent "asked a question" prompts when Slack is the typical surface?
  - Broken → which `status` values? failure logs?
  - To read → does any "agent flagged this" signal exist today, or invent one?
  - To start → static template registry; needs a small data model (title, description, prefilled prompt).
- **Action item lifecycle.** Dismiss / snooze / done semantics. Per-user state, presumably — needs a small persistence story.
- **Session privacy / multi-user.** Are sessions private to their creator, visible to the team, or shared? The swarm already has a team/user model; this should align with it. Worth a deliberate decision before building.
- **Lead context partitioning.** Even though we're not building a persistent per-session lead, we should ensure the lead's prompt-construction for an initial task scoped to a UI session does not drag in unrelated context from other sessions. Likely fine if the chain primitive is clean, but worth verifying.
- **Empty-state design.** Specifically what an empty react-flow looks like (placeholder lead node? text? art?), and whether quick-starts visibly grow the canvas as they execute.
- **Accessibility fallback for the graph.** Tabular agent list must be available alongside the canvas. Define before, not after.
- **Mobile/responsive.** Is ui/ expected to be usable on mobile for sessions? If yes, the timeline + parallel UI need responsive design from v1, not retrofitted.
- **Reference apps for the dashboard aesthetic.** Taras hasn't named one; one or two anchors (n8n? Datadog service map? Linear neural map? something else?) would sharpen design direction significantly.

### Constraints Identified

- **API server is the sole DB owner.** Any new DB writes must go through `src/be/db.ts`. Workers (lead included) talk over HTTP. Standard architecture; confirms there's no shortcut for "lead writes session state directly."
- **Forward-only SQL migrations.** Any schema add (chain field, source enum, action-item dismiss state) is a new migration in `src/be/migrations/`.
- **Frontend lives in `ui/` (Next.js, port 5274).** Existing tech stack — no new framework introduction needed or wanted.
- **Frontend PRs require qa-use sessions with screenshots** (per CLAUDE.md). Plan must include this.
- **OpenAPI freshness.** Any new HTTP route requires `bun run docs:openapi` and committed `openapi.json`.
- **Secret scrubbing.** Anything that surfaces agent output (transcript, action items "to read") must route through `scrubSecrets` if the path is logged or transported. Watch this in the streaming layer.
- **Lead runs in Docker (PM2-managed).** Restart-resilience: in-flight session state must be reconstructible from DB; nothing critical lives only in lead memory.
- **Chain primitive already exists.** `agent_tasks.parent_task_id` is the chain field; setting it queues the task to the lead. Slack threads use this exact mechanism today. UI sessions reuse it as-is. (Corrected from earlier in the brainstorm where I treated this as an open unknown — it's not.)

### Core Requirements

Lightweight PRD-style. v1 is the bundle Taras chose: Sessions + minimal react-flow + action items.

**Sessions (top-level page in ui/, route `/sessions`, Split View layout):**
- New nav entry "Sessions". Route `/sessions`.
- Layout: standard Split View — sidebar list of recent sessions for the current user on the left, selected session detail on the right.
- Session detail view = timeline of user messages + task cards.
- Cards collapsed by default; expand reveals live agent output, tool calls, sub-agents, file changes.
- First-class rendering for parallel tasks (specific design TBD).
- **Transcript expansion (revised post-research):** task cards collapse-by-default render a *summary* (status changes, key tool calls — short content). To see the full transcript, click the card → opens a shadcn `Sheet` side panel (`ui/src/components/ui/sheet.tsx`) embedding the existing `SessionLogViewer` (`ui/src/components/shared/session-log-viewer.tsx`) plus the existing taskId-keyed hooks (`useTaskSessionLogs`, `useTaskContext`, `useSessionCosts`). Same content surface as `/tasks/:id`. Side panel keeps the timeline layout stable during inspection (better for parallel-task scanning than inline-expand for tall content). Near-total reuse — no new viewer component required.
- Composer (input box) in session detail; submitting a message creates the next task in the chain via the lead.
- Live updates: agent progress streams into open cards without refresh.
- Empty session state: helpful prompt to start the first message.

**Dashboard revamp (replaces current home in ui/):**
- React-flow agent canvas — org chart layout (lead → workers), node size scaled by last-24h task count + token usage. Static in v1; click-through to agent detail. Tabular fallback always available.
- Action-items inbox with four buckets:
  - Blocking progress (paused tasks awaiting input, PRs awaiting review, missing setup)
  - Broken (failed tasks, errored agents)
  - To read (agent summaries, completion reports, flagged surprises)
  - To start (quick-start session templates — prefilled prompts that bootstrap an initial task)
- Each item supports dismiss / snooze / done.
- Empty states for both areas designed deliberately (especially for zero-integration users).

**Backend additions (minimal — Slack thread is the reference implementation):**

Architectural anchor (per Taras): **a UI session is the same shape as a Slack thread.** When a task has `parent_task_id` set, the system already queues it to the lead. All messages (i.e. tasks) in a session route to the lead via this exact mechanism. The UI surface changes; the backend flow does not. → research task: trace the existing Slack thread → `parent_task_id` → lead-queue path and treat it as the spec for sessions.

- **Source enum (revised post-research):** `agent_tasks.source` is `CHECK`-constrained (11 values, current at `src/be/migrations/043_jira_source.sql:16`) AND the HTTP route at `src/http/tasks.ts:65` declares only `source: z.string().optional()` — i.e. the SQL CHECK is the only enum gate today. **Decision:** drop the SQL CHECK in a forward-only migration, tighten the route to `AgentTaskSourceSchema.optional()` (`src/types.ts:56-69`), and let Zod become the single source of truth. No migrations for future source additions; the project rule "keep AgentTaskSourceSchema in sync with SQL CHECK" simplifies to "Zod owns the enum." Other write paths (Slack/GitLab/scheduler/workflows/agentmail) already pass typed literals into `createTaskExtended` and are TS-checked.
- **Chain primitive:** `parent_task_id` already exists and is what threads tasks to the lead. Reuse it. No schema add.
- **Endpoints:** likely no new endpoint required. Creating a session = creating an initial task (existing manual-task creation). Posting a follow-up = creating a task with `parent_task_id` set (same shape as a Slack reply spawning a child task). Confirm during research.
- **Streaming:** reuse the existing task-detail page's live-update mechanism for the session timeline. No new SSE/WebSocket layer in v1.
- **Schema for action-item dismiss state, per-user.** This is the only genuinely new persistence add.
- Lead prompt: confirmed unaffected — the lead already handles per-thread context via the same chain. No new "session-scoped mode" needed.

**Quality bars:**
- No regressions in current task flows.
- qa-use session with screenshots for every UI page touched.
- Performance: react-flow renders smoothly with realistic agent counts (target: 50+ agents, 60fps idle).
- Accessibility: tabular fallback for the graph; keyboard navigable transcript.

**v2 / stretch (out of scope for v1, capture for later):**
- Animated task lozenges on react-flow edges; pulse-on-active edges; failure visuals.
- Sophisticated "to read" signal (agent self-flags interesting outputs).
- Sharing / collaborator-visible sessions.
- Mobile-optimized session timeline.
- Custom user-authored quick-start templates.

## Next Steps

- **Handoff: Research.** Run `/desplega:research` using this brainstorm as input.
- **Research focus areas:**
  1. **Slack thread → `parent_task_id` → lead-queue flow.** End-to-end trace of how a Slack thread reply spawns a child task and how the lead picks it up. Document files, functions, queries, and queue mechanics. This becomes the spec the UI session flow mirrors.
  2. **`agent_tasks.source` enum constraint.** Verify whether it's CHECK-constrained or free-form. Determines whether we need a migration.
  3. **Task-detail page live-update mechanism in `ui/`.** How does the existing task-detail view get progress updates? Polling, SSE, WebSocket? Latency/feel? Reusable for the session timeline?
  4. **Existing manual-task creation path.** Confirm the API surface used to create a task from `ui/` today — same endpoint should serve "start session" with no `parent_task_id`, and "post follow-up" with one.
  5. **Existing dashboard primitives in `ui/`.** What's there today (agents view, tasks list, integrations panel)? What can be reused vs replaced for the revamped home?
  6. **React-flow availability / precedent.** Is react-flow already a dependency? Any existing graph viz in the codebase to learn from?
  7. **Action-item bucket sources.** For each of the four buckets (Blocking / Broken / To read / To start), identify the data source and queryability. Specifically: how does a "paused awaiting input" state surface today (Slack), and how do we surface it natively in `ui/`?
- After research → `/desplega:create-plan` with both the brainstorm and research doc as inputs.
