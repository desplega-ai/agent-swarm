---
date: 2026-10-20T13:39:50+02:00
author: Taras
topic: "Sessions UI for power users: learnings from the my-swarm app groups"
tags: [brainstorm, ui, sessions, grouping, power-users, my-swarm]
status: complete
exploration_type: workflow
last_updated: 2026-10-21
last_updated_by: Claude
---

# Sessions UI for power users: learnings from the my-swarm app groups (Brainstorm)

> The mockups moved out of the repo on 2026-10-22 (Taras: keep 48k lines of HTML out of PR #2329). They live in agent-fs at `/mockups/agent-swarm/sessions-v2/`, with the same layout. Every `mockups/sessions-v2/` path in this document points there.

## Context

Two inputs drive this exploration:

1. **The my-swarm iOS app** (`~/Documents/my-swarm/swarm-app`, Expo). It has a "groups" implementation (`src/lib/groups.ts`, `src/use-groups.ts`, `src/group-folds.ts`, `src/app/(tabs)/groups.tsx`, `src/app/group.tsx`) built across the v2 milestones (M2 inbox, M8 folders/bulk/settings, M9 thread readability, M11 to M14 polish). Goal: an initial analysis of what it does and what transfers.
2. **A customer call** (2026-10-20 11:30 BCN). The transcript is on agent-fs under `exty/recordings/2026-10-20/`. The user likes the dashboard sessions UI a lot and cares about grouping.

Target: iterate on the dashboard sessions UI (`apps/ui/src/pages/sessions/`, the contextual session panel from #1688, titles from #1000, sharing and presence from #2249) to make it better and nicer for power users.

### Initial analysis

#### A. The my-swarm app "groups" (what we built)

- **A group is a key prefix on the root task.** It uses the asset key (`task.key`), for example `shared/swarm-app/ios/`. There is no group entity on the server. Each `/` nests one level, and missing parents become implicit nodes (`swarm-app/src/lib/groups.ts`, `lib/folders.ts`). "Folder" is the storage term, "group" is the UI term. They are the same thing.
- **Only my threads.** Agent-started threads are filtered out (`isMine`). Slack and Telegram roots get the default key `shared/task:<rootId>/`, so they land in "No group" until you move them.
- **Membership is user-driven.** You create a group with `+`, or send from a group composer ("New thread in #ios", like a message in a channel). You move a thread with "Move to folder" (`PATCH /api/assets/task/{rootId}/key`, `cascade: true`).
- **State lives in three places.** Membership: `task.key` on the server. Empty groups: KV `swarm-app:<userId>` / `folder:<key>`. Read, done, and later: `/api/inbox-state` (server). Folds: device-local file.
- **The glanceable model works.** Each row shows needs (amber), unread (grey), and running (arc). A folded group shows the roll-up of its subtree. A row with news takes two lines (with a preview of the newest thread). A quiet row takes one grey line.
- **Group screen.** Crumb, `# name`, bell (bulk mute), subgroup chips, threads split by Today / Yesterday / Earlier, swipe Done / Later, and long-press Rename / Move / Read. One tree spans all accounts.
- **Known gaps.** No group rename, delete, reorder, or search. Mute is a one-time bulk per-thread mute (new threads are not muted). No bulk actions on the Groups screens. `/api/sessions` has no key filter, so the group screen loads `/api/tasks?keyPrefix=…&limit=1000` and rebuilds threads on the client, with a 10 s poll.

#### B. The dashboard sessions UI today

- **A session is a root task plus its chain.** There is no session table (`src/http/sessions.ts`).
- **The list is a flat 300 px sidebar** (`apps/ui/src/components/sessions/sessions-shell.tsx`). It shows the newest 50 only: no paging, no virtualization. Rows show a status dot, the title, and "relative time · N tasks".
- **Filters are minimal.** The defaults are `source = ui` and `requestedByUserId = me`. One checkbox, "Show system tasks", drops the source filter, so Slack sessions appear only together with schedule and system noise. Search is a server-side substring match on title and text. A second section, "Shared with me", comes from #2249.
- **Detail view.** Editable title, presence avatars, share dialog, meta (status, agents, cost), a linear timeline, and a composer that steers or chains.
- **Power-user affordances.** Present: Cmd+K (no session entries), Cmd+I (context panel), URL state (`?q`, `?system`, `?rail`). Missing: grouping, unread state, pin or archive, bulk actions, list keyboard navigation, a session quick switcher, saved filters, and more than one open session.
- **Grouping primitives already exist but the list does not use them:**
  - `task.key` (asset namespace): `/api/tasks?keyPrefix=` supports it, `/api/sessions` does not.
  - `contextKey`: `/api/sessions?contextKeyPrefix=` supports it. Only the contextual panel uses it, for per-page sessions.
  - `tags`: in the slim summary, not rendered.
  - `slackChannelId` / `slackThreadTs`, `vcsRepo`, `workflowRunId`: on tasks, not used.

#### C. The customer call (2026-10-20 11:30 BCN)

- **The customer values sessions for context management.** "Estoy muy acostumbrado... a organizar muy bien las sesiones y controlas mejor el contexto" [00:12:54]. Slack is for quick things. For long, multi-topic work, the dashboard is "más estructurado" [00:10:30, 00:58:21].
- **They want Slack threads to land in sessions** [00:10:30]. Today they are hidden behind "Show system tasks", and the list filters on `requestedByUserId = me`.
- **Finding past sessions is the key need.** "Quieres ir al pasado, a ver qué hicimos en esta otra sesión... la búsqueda" [00:14:00].
- **They work in parallel.** "Cuatro sesiones de navegador diferentes, cada una en un escritorio virtual, con cada una task verticales" [00:15:52].
- **They did not name "groups", "folders", or "tags".** The grouping need is implicit: separate contexts per topic, organize them, and return to them. Caveat: transcript quality is low (gpt-4o-mini, Spanish/Catalan, speaker attribution unreliable).
- **Other pains.** Concept overload in the dashboard (pages, apps, scripts, workflows, connections, integrations, secrets). Session message ordering bug on v1.68 (may be fixed). API-key auth friction.
- **Taras's Slack workaround is a fork pattern.** "Envíame un DM para cada topic" to reset a sprawling thread while it keeps context [00:58:48]. This is a "split or fork a session" feature in disguise.

#### D. First read: what transfers

| App concept | Transfers to the dashboard? | Change needed |
|---|---|---|
| Key-prefix tree (`groups.ts`, pure TS) | Yes, as the sessions sidebar | `/api/sessions?keyPrefix=` plus `key` in the slim summary |
| needs / unread / running glyphs and roll-ups | Yes | Adopt `/api/inbox-state` in the dashboard (shared with the app) |
| Composer that starts a session in a group | Yes | Pass `key` on create |
| Move to group | Yes, plus multi-select and drag | Reuse `PATCH /api/assets/task/{id}/key` |
| Today / Yesterday / Earlier | Yes | None |
| Swipe, haptics, deck, Live Activity | No | Keyboard equivalents instead |
| Device-local folds | Partly | localStorage, or the same KV namespace to sync |

## Exploration

### Q: Which power-user jobs should this iteration cover?
All four: Organize, Find and resume, Triage, and Parallel work. (Recommendation was the first three, with Parallel work next.)

**Insights:** Scope is wider than the app's groups. Parallel work (tabs or split, fork) is the most expensive job and the most layout-shaping. It must inform the sidebar and routing design from the start, even if it ships last. Taras's Slack "DM per topic" trick and the customer's four browser windows both point at it.

### Q: What is a group in the dashboard?
The `task.key` prefix on the root task, the same model as the app. No KV metadata and no new entity for now.

**Insights:** App and dashboard share one tree, so a group made on the phone shows on the desktop and back. Consequences: one group per session; no color, order, or group-level mute that covers future sessions (the app has the same limit). Server work: `/api/sessions` needs a `keyPrefix` filter, and the slim summary needs `key`. `lib/groups.ts` and `lib/folders.ts` from the app are pure TS and can be ported almost unchanged. Fact found: Slack tasks set `requestedByUserId` when the Slack user resolves to a swarm user (`src/slack/assistant.ts:175`), so a "mine" filter can include Slack sessions.

### Q: Which sessions go into the tree by default?
Taras: "Mine and shared for now, but we should have a way to see other sources too, e.g. from Slack. They should be differentiated clearly."

**Insights:** Default tree = my dashboard sessions plus sessions shared with me. External sources (Slack, Telegram, chat-sdk channels, and so on) are opt-in and must look clearly different from dashboard sessions. Open sub-questions: where shared sessions sit (their keys belong to the owner), and how the external-source view looks.

### Q: How do other sources show up, clearly differentiated?
Taras: "Could it be with icons / labels or something? Then filters (3, no?)". Chosen: one mixed tree, a source icon or label on every row, and source filter chips.

**Insights:** Claude agrees, with one caveat. A mixed tree is the most unified and fits the power-user goal. The default chip state follows the previous answer: Dashboard (and Shared) on, external sources off. The risk is that external sessions have the default key `shared/task:<rootId>/`, so all of them land in "No group" and make it a dump. The next question addresses that.

### Q: Where should ungrouped external sessions go?
Taras chose real default keys per source (for example `shared/slack/<channel>/`): "Would be amazing as we could replicate Slack convos in the swarm."

**Insights:** This changes the server's default-key contract for new external roots, and the app gets the same tree for free. Facts to confirm (a background research agent is running): what depends on `shared/task:<rootId>/`, how `cascade` moves work, whether one Slack thread is one root, whether channel names are available (key segments allow only `[a-z0-9._-]`), and what a dashboard reply on a Slack session does today. Privacy is a new branch: a private channel or DM under `shared/` may expose content (see `2026-10-10-team-scoped-privacy.md`).

### Q: What does "replicate Slack convos in the swarm" mean?
Two-way. A channel becomes a group and a thread becomes a session. The session timeline also shows the human messages of the thread. A reply from the dashboard composer posts back into the Slack thread.

**Insights:** This is the largest scope item so far. The dashboard becomes a Slack client for swarm threads. It needs a stored per-thread message log, a mapping from the dashboard user to a Slack identity (post as the user, or as the bot "on behalf of"), and a rule for messages not addressed to the bot. It also makes privacy harder: human messages from a private channel become visible to anyone who can read the session. Facts pending from the research agent: whether a thread transcript is already stored, and what a dashboard reply on a Slack session does today.

### Q: Where do sessions shared with me sit in my tree?
In their real key path. A shared session with a `shared/...` key sits in that group, marked with the owner's avatar. A session with `personal/<owner>/...` sits under "Shared with me › <owner>".

**Insights:** Team groups appear on their own when people use `shared/` keys. Keys are labels, not visibility: `src/assets/key.ts:114-118` says personal keys are "labels, not a privacy or read-visibility guarantee". The tree only lists sessions I can already read (mine plus shares), so putting a key in the tree does not leak anything.

### Research facts (background agent, 2026-10-20)

- **The default key is stored at insert and children inherit it.** `defaultAssetKey` (`src/assets/key.ts:81-84`) gives `shared/task:<uuid>/`. A child copies its parent's key (`src/be/db.ts:2683-2685`). Validation has no character allowlist: keys are lowercased, at most 255 characters, root `shared/` or `personal/<uid>/`.
- **Nothing parses `shared/task:<id>/`.** Only tests assert its shape. The per-task leaf exists only so unrelated assets do not collapse into one key. A new default for Slack roots breaks nothing found.
- **Cascade move** re-keys the root, its descendants, and their attachment-file mappings in one transaction. It does not move pages, workflows, schedules, or KV.
- **One Slack thread is not always one root.** A lead mention chains to the newest task in the thread. A worker-agent mention, or the no-agent-online path, creates a new root with the same channel and thread. The thread identity already exists as `contextKey = task:slack:<channelId>:<threadTs>` (`src/tasks/context-key.ts:108`).
- **Only the Slack channel ID is stored.** There is no channel-name cache. chat-sdk (Telegram, Discord) stores only thread ids such as `telegram:<chatId>:<topicId>`.
- **A dashboard reply on a Slack session today** creates a `source: "ui"` task. It inherits `slackChannelId`, `slackThreadTs`, `key`, and `contextKey`. The Slack thread-tree render includes it. The result relay does not post it back, because the relay triggers need `source = 'slack'` (`migrations/144_slack_relay_obligations.sql`). Two-way is half plumbed.
- **Human Slack messages are not stored.** Thread context is fetched live with `conversations.replies` and folded into the task text. `slack_messages` holds bot-owned messages only. chat-sdk does persist history for Telegram and WhatsApp (`msg-history:<threadId>` in `chat_lists`).

### Q: What key shape for Slack roots?
`shared/slack/<channelId>/thread:<ts>/`. A final `<kind>:<id>` segment is a session leaf, not a group, so the group is "slack › <channel>".

**Insights:** This is the general rule for the tree: groups come from key segments, but a final `<kind>:<id>` segment is a leaf and never a node. The app already does this for `task:<id>`. Attachment files stay isolated per thread. All roots of one thread share one key, so the dashboard can find them all with one prefix query. The channel ID is stable across renames, so the UI needs a name lookup for its label. Other sources follow the same pattern: `shared/telegram/<chatId>/thread:<topicId>/`, `shared/discord/<guild>/<channel>/...` (exact shapes for /research).

### Q: One Slack thread can hold several roots. What is the session?
Taras: "It makes sense to have 2. I see this as a feature, this way you can essentially have forks and stuff like this, right? (like pi-mono)". Root task = session. Several roots in one thread are forks of one conversation.

**Insights:** This reframes the "fork a session" idea from the Parallel work job. A conversation (Slack thread, or a dashboard session) can hold several sessions, each its own root with its own agent context. It matches Taras's Slack trick ("send me a DM per topic") and the customer's "separate sessions to control context". It also amends the leaf rule from the previous answer: a `thread:<ts>` leaf with two or more roots must show as one expandable conversation row with its forks inside, not as two unrelated rows. New branches: how forks show in the tree, how a user creates a fork from the dashboard, and what context a fork carries.

### Q: How should forks look and be created in the dashboard?
Nested, plus "Fork from here". A conversation row shows a fork count and expands to its forks. Any message in a session offers "Fork from here": a new root with the same key and a `forkedFrom` pointer (task and message), seeded with the parent's context up to that point. Slack-origin forks look the same.

Taras, on top: "I think this concept should be there, it's how the groups thing really is supposed to be."

**Insights:** This is the core reframe of the brainstorm. Groups are not only folders. The real hierarchy is **group (key path) › conversation (thread leaf) › session (root task, one per fork)**. The app's groups stop one level short: they show sessions directly under a group. Slack already produces this shape. The dashboard adds the missing creation path ("Fork from here"). Consequence: the app should adopt the same hierarchy later, so both clients show the same tree (scope call pending). A dashboard-native conversation needs a leaf too. The root of the first session can mint `.../conv:<id>/`, so later forks join it by key.

### Q: What context does a fork start with?
A summary plus a pointer. The fork's first task gets a short generated summary of the parent up to the fork point, plus the parent task and message ids, so the agent can fetch detail with `get-task-details`.

**Insights:** This keeps the fork's context window clean, which is the reason to fork. The summary is an LLM call, so it should go through the reusable structured-output helper (see memory: internal AI abstraction), not a one-off summarizer. For a Slack-origin fork, "up to the fork point" includes the human thread messages, which links this to the next question (where those messages come from).

### Q: Where does the timeline get the human Slack messages?
Taras: "We do store them, check ssh swarm examples and code. It's part of the task input, no?"

**Insights (verified, correcting the research agent):** Taras is right. Human messages are stored, as a snapshot inside each task's input:
- `getThreadContext` (`src/slack/handlers.ts:~328-375`) calls `conversations.replies` with `limit: 20`. It renders a `<thread_context>` block through the `slack.message.thread_context` template, and prepends it to the task text.
- In prod, 993 of the 1,379 Slack tasks from the last 30 days carry a `<thread_context>` block (read-only `sqlite3` on `swarm`, 2026-10-20).
- The format is lossy for a timeline. Lines are `<@U…>: text` or `[Agent]: text`, with no message `ts` or id. Bot messages are cut at 500 characters. Consecutive tasks repeat the same messages. Messages after the newest task appear only when the next task is created.
- Probable bug (verify in /research): the code comment says "Last 20 messages max". But `conversations.replies` pages from the parent forward, so on a long thread `limit: 20` likely returns the first 20 messages, not the last 20.

Follow-up decision: keep the snapshot for the agent, and also store each message in structured form (channel, thread, ts, author, text) where we already call `conversations.replies`. The timeline interleaves by `ts`. Taras asked to reuse an existing table instead of creating one.

### Q: Which existing table stores the structured thread messages?
`chat_lists`, in the Chat SDK `SerializedMessage` shape, under our own key prefix (for example `thread-history:slack:<channelId>:<threadTs>`). No expiry. Skip message ids already present.

**Insights:** No migration. The timeline reads one message shape for Slack, Telegram, and WhatsApp (chat-sdk already persists `msg-history:<threadId>` there, `src/integrations/chat-sdk/state.ts:228-243`). We use our own prefix so we never share a key the SDK owns (trim and expiry rules). Accepted costs: a generic list (`key`, `seq`) with no `ts` index and no text search, and edits are not synced. Rejected alternative: extending `slack_messages` (it has the right `(channel_id, ts)` unique index, but its `kind` CHECK needs a SQLite table rebuild, and it is Slack-only). Dashboard replies from the two-way composer go into the same list.

### Q: Who posts a dashboard reply into the Slack thread?
The swarm bot, attributed: the message plus a context line "via dashboard · <name>" (with a username or icon override where Slack allows it). The task is created as a normal Slack follow-up, so the existing relay posts the result in the thread.

**Insights:** No per-user Slack OAuth and no user tokens. The fix for today's gap is in task creation, not in the relay: a dashboard reply on a Slack session must create a task that the relay triggers accept (they require `source = 'slack'`, `migrations/144_slack_relay_obligations.sql`). Either the composer sets the Slack source for Slack sessions, or the trigger condition widens to "has Slack thread fields". That choice is for /create-plan. The same pattern applies to chat-sdk channels (relay triggers on `source = 'chat'`).

Taras, follow-up: "It can be grayed out and clearly stated that was from outside." Claude's reading: in Slack, a dashboard-originated message renders muted (a grey context block) with a clear "sent from the agent-swarm dashboard by <name>" line, so nobody mistakes it for a native Slack message. The mirror rule already holds in the dashboard: external-source messages and rows carry a source icon or label and are visually distinct.

### Q: How does the tree show readable names for source keys?
A server label map. The API resolves source segments to names (Slack `conversations.info`, Telegram and Discord titles), caches them, and returns a labels map next to the sessions list. The dashboard and the app both render "Slack › #eng". DMs render as the other person's name.

**Insights:** Keys stay stable (IDs), labels stay fresh (renames show up). This is the only group metadata so far, and it is derived, not user-edited, so it does not conflict with the "no KV metadata" decision. The cache can live in `chat_state_kv` (it has `expires_at`), in line with the "no new tables" preference.

### Q: What triage state does the dashboard use?
The app's: `/api/inbox-state` for read, done, and later, plus the same glyphs (needs you, unread, running) and roll-up rule (a folded node shows its subtree totals, an open node its own). Actions: mark read or unread, Done, Later, from the row menu and from the keyboard.

**Insights:** Read state syncs between phone and desktop with no new API. Fact for /research: how `/api/inbox-state` keys its items (per root task?) and whether forks and Slack-origin sessions produce `to_read` items today.

**Correction (research, 2026-10-20):** in the app, "Needs you" means an unread root whose latest status is `failed`. Approvals and HITL requests are not part of it. Items are keyed `(userId, itemType, itemId)`, with `itemId` = root task id, and only clients write them. The dashboard derives unread on the client today. Whether dashboard "Needs you" adds approvals and HITL is an open decision for /create-plan. See `thoughts/taras/research/2026-10-20-sessions-ui-power-users.md`.

### Q: What does the dashboard offer for parallel work?
Taras: "I like the idea of browser-like tabs, but I would not get crazy on commands as they might interfere with the browser. Also split view (single) would be nice too."

**Insights:** In-app session tabs, plus one split view (two panes, not a grid). Shortcuts must not collide with browser combos: no Cmd+W, Cmd+T, Cmd+1..9, or Cmd+Shift+[ ]. Tabs open and close with the mouse (click, middle-click, close button) and through the existing Cmd+K palette. Tabs show the triage glyph, so a background session that finishes lights up. The tab set should live in the URL, so reload and deep links keep it. Extra browser windows still work through deep links.

### Q: What is the keyboard model?
Palette first, plus list keys. Cmd+K (already global) gains sessions: fuzzy search over all sessions and groups, and actions (new session in a group, move, fork, open in split, mark read). Plain single keys work only when the session list has focus and no input has focus: `j`/`k` move, Enter opens, `x` selects, `e` marks done, `m` moves.

**Insights:** Nothing a browser or the OS owns. The palette doubles as the quick switcher that "find and resume" needs, so it must search all sessions on the server, not only the newest 50.

### Q: What group management is in scope?
Full for my groups: create, rename, delete (its sessions go to "No group"), and multi-select plus drag to move. Source groups ("slack › #eng") are read-only: no rename or delete, but sessions can move out of them into my groups.

**Insights:** Server work: one "move prefix" endpoint that re-keys every root under a prefix in one transaction, with the same cascade and attachment re-keying as `moveAssetKey`. Rename and delete are both prefix moves. The UI must tell source groups apart from user groups by prefix (`shared/slack/`, `shared/telegram/`, and so on). A reserved-prefix list on the server should also stop users from creating keys under a source prefix. Deferred: mapping a Slack channel to a user group as its default key (per-channel routing config).

### Q: Do we backfill existing Slack and chat sessions into source keys?
Yes, only roots whose key is still the untouched default (`shared/task:<rootId>/`) and that have Slack or chat thread fields. It runs through the same move path, so attachments follow. Sessions a user moved stay where they are.

**Insights:** The tree is useful on day one, and old threads become findable by channel. Run it as an idempotent job, not a SQL migration, because the re-key must also update `asset_key_mappings` and write `asset_key_history`, which `moveAssetKey` already does. Scale: about 1,379 Slack tasks in 30 days on prod, so batch the job and keep it off the boot path.

### Q: How do we sequence the my-swarm app?
Taras: "We will work here on the dashboard. I might move the things to the app later on."

**Insights:** This effort is the server plus the dashboard only. The app is out of scope. It keeps working because it reads keys: backfilled Slack threads move out of its "No group" into `slack / <channelId>` nodes (raw IDs until the app reads the label map). One side effect to note: the app's `folders.ts` treats only `shared/task:<id>/` as "not a folder". It will show a `thread:<ts>` leaf as a group node until it adopts the leaf rule. Taras ports to the app later, by hand.

### Q: How does the dashboard tree load at scale?
A server tree summary plus paged groups. One endpoint returns the group nodes I can see: prefix, counts (sessions, unread, needs, running), last activity, and the label map. Expanding a group pages its conversations, 50 at a time.

**Insights:** Roll-ups come from SQL, so the sidebar cost does not grow with the session count. The endpoint must apply the same visibility as the list (mine plus shared, source chips) and join `/api/inbox-state` for unread and needs. The app's `groups.ts` tree logic still helps on the client to nest prefixes and apply the leaf rule, but the counts come from the server. Fact for /research: an index on `agent_tasks(key)` for prefix `LIKE` scans, and how `requestedByUserId` plus shares combine in one query.

### Q: What ships first?
Tree, then sources, then forks, then two-way, then tabs. Each slice is usable alone, and every later slice renders inside the tree.

### Q: Do we keep the current view as "Legacy Sessions"?
Taras: "We should offer the new one and a way to go back to the current one ('Legacy Sessions') that should look exactly like now." Rollout: the new view is the default from slice 1. A "Legacy Sessions" link in the sessions header switches views, and the choice is remembered per user. `/sessions/:id` opens in the user's chosen view. Legacy is removed after slice 5 ships.

**Insights:** This is a good safety net, because slices land one at a time and users like the customer rely on today's view. "Exactly like now" means the UI is frozen: today's shell, timeline, and query (`source = ui`, mine, newest 50). Server changes (backfilled keys, the relay fix) still apply under it, and the frozen UI does not show them. Implementation note for /create-plan: freeze legacy as today's components with every new feature off, not as a copied fork, so shared fixes land once. The sunset date stops two UIs from living forever. The contextual session panel (Cmd+I) follows the new view.

## Synthesis

### The model

```
group (key path, from slashes)    shared/northwind/pricing/        slack › #eng (source group, read-only)
└─ session (root task)            sessions sit at the group key    thread:<ts> with 1 root: a plain row
                                                                   thread:<ts> with 2+ roots: a nested group
```

### Amendments (2026-10-21, after UI spike round 1)

These override the Key Decisions below where they conflict.

- **A1. Forks are out.** Taras: "Maybe we could leave forks out? I think it is too complex, and no one asked for it." No "Fork from here", no `forkedFrom`, no fork summary, no fork vocabulary in the UI. Decision 9 is withdrawn. The earlier "group › conversation › session" reframe is withdrawn with it.
- **A2. A Slack thread with 2 or more roots is a nested group.** Taras: "Just nested groups, you know?" A thread with one root is a plain session row in its channel group. Decision 3 changes accordingly: a final `thread:<ts>` segment is a nested group only when it holds 2 or more roots. Dashboard sessions no longer mint a `conv:<id>` leaf. They sit directly at their group key, as in the app.
- **A3. No source chips.** Taras asked what "Dashboard" and "Shared" sources mean, and proposed: "Just show in the sidebar all the sources by default, but Slack, Telegram, etc. collapsed by default." The sidebar always shows every section: my groups, Shared with me, No group, and one section per external source (Slack, Telegram, …). External source sections start collapsed. Rows keep their source icon. Decision 5 changes accordingly.
- **A4. Layout: A's sidebar plus B's tabs.** Taras: "I like the sidebar of A and the tabs of B. C not really." Round 2 builds one merged mockup: A's sidebar (Inbox, Later, Done, groups, shared, sources), A's session list, and B's per-pane session tabs, split, and status bar. Mockup C is dropped.
- **A5. No customer names** in mockups or docs. Demo data uses the invented company "northwind" and invented people.
- **A6. New sessions open as a tab (round 3).** Taras: "For the new session, I would like to see it in the tab as a new tab, instead of up there... and then we could adapt the composer to choose where you want to start it. Also in the sidebar there should be a + or new session icon in each group for easy start." A new session opens a "New session" tab with a composer that has a "Start in" group picker (user groups, `~/`, No group; no source groups). Each user group in the sidebar shows a "+" that opens that tab with the group preselected. The group-level composer at the top of the list is removed.
- **A7. No day headers.** Taras asked for the same order as Legacy. Chosen: one flat list, newest activity on top, with a relative time on each row. The Today / Yesterday / Earlier blocks (taken from the app) are dropped.
- **A8. Show who is involved.** Taras: "Would be nice to have a way to see who is involved in the threads." Chosen: an avatar stack (max 3, then +N) on list rows for people, and a "People" popover in the session header with each person's source, last message, and live presence, plus each agent's task count. Cmd+K gets a "with: <name>" filter. Data note for /create-plan: people come from the requester, the stored Slack message authors, `session_shares`, and presence.
- **A9. Sessions live in the sidebar; no middle column.** Taras: "The inbox now is too hard to follow... the problem is with the collapsible second sidebar." Inbox, Later, Done, No group, groups, and sources expand in the sidebar to show sessions as one-line rows. Tabs take the full width. "No group" sits at the top of the groups area, right under Inbox, Later, and Done (Claude's reading of "the no group should be at the top").
- **A10. First-visit guide.** A short step modal on first load explains each part. It is dismissible, and the Keys button reopens it.
- **A11. Hide sources with a filter icon.** Taras: "I'm ok being able to hide sources (Slack, Telegram) with a small filter icon." Sources show collapsed by default. The filter icon hides them, including from Inbox, Later, and Done.
- **A12. Tooltips on every icon-only button.**
- **A13. Later = snooze with a browser notification.** Taras: Later "sends notifications (browser for now) and you should choose when to snooze them (later we can link them to schedules... a small script schedule with some seeded script that bumps a task)". The data model exists: `inbox_item_state` has `status = 'snoozed'` and `snoozeUntil` (research Q2). v1: the dashboard checks wake times while it is open and fires the Notification API plus a toast. Deferred, with default: a seeded swarm script on a schedule that wakes due snoozes server-side and notifies (web push, Slack DM, or the app's push). Not built in v1.
- **A14. A clear read/unread convention.** Taras: "How you present unread vs read is unclear." Unread = bold title plus a solid dot in a fixed left slot. Read = regular, muted title, no dot. Activity (running, needs you, failed) uses its own slot and is never the read marker. The same rule applies to rows, tabs, and group counts.
- **A15. Group counts stay visible on hover.** The "+" sits next to the counts, never in their place.
- **A16. Group labels.** Taras: "The ~/ wtf is that? Remove it, top level is just top level, and show # still on ones that have subgroups, just show a dropdown." Personal groups show by name at the top level, with no `~/`. A lock icon appears only when a personal and a shared group share a name. Every group shows `#`; groups with subgroups add a dropdown chevron.
- **A17. External sources: off by default, DMs first (security).** Taras: "Slack and other sources should be under an env, disabled by default, as there might be a security issue... you might expose chats you should not." Also: "Maybe we could start showing DMs only." Decided:
  - New operator setting `SESSIONS_EXTERNAL_SOURCES`, default empty (off). Register it in the Settings > Configuration catalog (`apps/ui/src/lib/configuration-catalog.ts`) with a validator in `VALIDATED_KEYS`, and update the configuration docs page in the same PR.
  - First allowed value: `dm`. Only 1:1 DMs between a user and the bot (Slack DM, Telegram or Discord 1:1), shown only to that user (the mapped requester).
  - Capture and store human messages (decision 10) only for enabled scopes. With the flag off, nothing new is stored.
  - Channels come later, behind a second value (for example `channels`), and only for dashboard users who are members of that Slack channel. This needs a Slack-user to swarm-user mapping and a membership check.
  - Existing exposure, independent of this work: `/api/sessions` default scope shows roots with `requestedByUserId IS NULL` to everyone (research Q3), and Slack tasks from unmapped Slack users have no requester. Flag this in /create-plan.
  - Deferred, with default: DM key root stays `shared/slack/<dmChannelId>/thread:<ts>/` (keys are labels, visibility comes from the requester). Revisit `personal/<uid>/slack/…` in /create-plan.
- **A18. Less chrome.** Taras: the header icons and the subtitle are redundant; "just add the number of sessions to the right of the title". The "Next" unread bar is removed ("wtf is NEXT??"), and next-unread stays as the `n` key and a palette action. Empty states are centered.
- **A19. Flat Inbox, Later, Done.** Taras: "In the inbox there should be no carousels, all items should be in a single level." These views list every session at one level, with the group as a muted label. Nesting exists only under groups.
- **A20. Hover checkbox.** Taras: use the checkbox space better. The left slot shows the unread dot and turns into a checkbox on hover or focus. Selecting one row enters selection mode and shows the bulk bar.
- **A21. Big groups: latest 10, then a group tab.** Each group shows its 10 newest sessions, then "Show 10 more" once, then "View all N", which opens a group tab with the full list, a group-scoped search, status filters, and server paging by 50. This matches decision 13 (paged groups).
- **A22. First run after the release: guide plus an empty-groups call to action.** Existing users start with every old session in No group (default keys). The guide opens once. My groups shows "Group your sessions" with a "New group" button and the move hint. No automatic grouping. Deferred, with default: suggested groups (by repo or agent) are not built.
- **A23. Search in the sidebar.** Taras: "We should have an easy way to search." An always-visible search field at the top of the sidebar (`/` focuses it) filters the sidebar in place across all sessions on the server. Tokens: `with:`, `in:`, `is:unread`, `is:running`, `is:later`. Cmd+K stays for actions. The "Next" bar is gone (A18, Round 5).
- **A24. Keep sharing and presence (#2249).** Taras: "We should keep the share session feature we shipped this week, no? It seems it's missing now." The new view keeps the Share button (owner only), the share dialog (people with Can view or Can edit, plus General access), presence avatars and "typing…", and the read-only notice for view-only shares. The People popover shows each person's share level and links to the dialog. This is a constraint for /create-plan: the new view reuses `share-session-dialog.tsx` and `session-presence.tsx`, and must not rebuild them.
- **A25. No "Lead" label.** Taras: "As we always talk with the lead (this is key), we should remove the lead indicator, no?" Claude agrees, with one condition: lead replies become the swarm's voice (no name, no avatar), but worker tasks keep their agent name as delegated steps under the lead turn, because who did the work matters when something fails. Retries collapse to one line. Internal follow-up, deferred, resume, and superseded tasks are hidden by default behind "Handoffs".
- **A26. Realistic complexity from prod, content scrubbed.** Taras asked to use prod examples without committing them, then: "Or scrub stuff but take examples of how they look, their complexity." Prod shapes are recorded without ids or text in `mockups/sessions-v2/PROD-SHAPES.md`. Example: a 40-task Slack session with 2 people taking turns, the lead on every human turn, 3 workers, 6 failures, 11 internal follow-ups. Dashboard sessions over 20 tasks are rare (3 of 87 in 30 days); Slack ones are common (61 of 456). The mockup adds two invented sessions with those shapes (`demo-data-big.js`).
- **A27. A two-row session header.** Taras: the Share button and the People button repeat each other. Row 1 holds the crumb, presence avatars, a People pill (icon and count), the triage icons, and a Share icon at the far right (owner only). Row 2 holds the title and, on its right, the meta line (status, tasks, cost, started, Handoffs). The third row is gone. Narrow panes drop "started", then cost, then worker avatars.
- **A28. Rename a session.** Taras asked for a way to edit the session name. This already ships: `PATCH /api/tasks/{id}/title` sets `agent_tasks.title` (migration 120, max 120 characters, empty clears it), and today's page has a hover pencil. The new view keeps the same behavior (pencil, double-click, Enter saves, Escape cancels) for the owner and Can edit, plus a Cmd+K action. No new backend.
- **A29. Worker steps fold into one line.** Taras likes the step block with the vertical line, but wants it collapsed: "N workers worked for X time". One worker shows its name. Running and failed states show on the folded line. Handoffs On opens every block.
- **A30. One turn shape everywhere.** Taras: the examples must follow "human message, then lead work, then workers". Every person message gets a swarm reply. Workers only appear under the reply that started them. The swarm posts a result before the next person writes. Header numbers (tasks, agents) match the timeline. This is also the grouping rule the real timeline uses (lead task, then its children, until the next human message).
- **A31. Mobile: list, then detail.** Taras: "Probably like Slack? First screen the list (sidebar), on click the details (tab)." Under 768 px (the `useIsMobile` breakpoint) the sidebar is the home screen and a session pushes a detail screen with a back chevron and history support. Tabs, split, and the status bar do not exist on phones. Popovers become bottom sheets. Hover features get touch equivalents: swipe left for Done, swipe right for Later, long-press to select. This replaces today's "Switch session" select in `sessions-shell.tsx`.
- **A32. Round 9 polish.** A 4-lens UX review (icons, motion, desktop feel, phone feel) found 95 issues. The mockup fixes them. The apps/ui checklist is `mockups/sessions-v2/UX-REVIEW-R9.md`.
- **A33. Message anatomy and copy (round 10).** No name on my own bubbles. Avatars sit beside bubbles. Time and via notes sit below each message. Swarm replies lose the hexagon mark. A Copy icon is always visible on swarm replies and shows on hover on bubbles. Every title truncates with an ellipsis. Details: SPEC.md Round 10.
- **A34. One PR (2026-10-21).** Taras chose one PR with the full mockup UI plus the backend it needs (prefix filter and counts, bulk and prefix move, people per session). The source sections, the backfill, and two-way Slack are follow-up PRs. The group tab uses `DataGrid` plus `ListPager`. The new view is the default, with the Legacy toggle. The one-shot scope gate fired (about 7 phases in 2 subsystems), so Taras chose `/desplega:create-plan` then `/desplega:implement-plan`, both in autopilot, on one branch with one PR.
- **A35. Plan review answers (2026-10-21).** After the plan review, Taras chose: the Cmd+I panel moves to the new turn timeline in this PR, `vaul` stays for the phone bottom sheet, and this PR also closes the old move route (a read-only sharee could move a session). Plan: `thoughts/taras/plans/2026-10-21-sessions-v2-power-users.md`.
- **Order (decision 16) without forks:** (1) tree, triage, and palette search; (2) source keys, backfill, labels, and source sections; (3) two-way Slack; (4) tabs and split.

### Key Decisions

1. **Scope:** all four power-user jobs (Organize, Find and resume, Triage, Parallel work). Server plus dashboard only. The my-swarm app is out of scope, and Taras ports later.
2. **Group = `task.key` prefix** on the root, the same model as the app. No group entity, no user-edited group metadata.
3. **Leaf rule (changed by A2):** a final `<kind>:<id>` key segment is a conversation, not a group. A conversation with two or more roots shows as one expandable row with its forks.
4. **Default tree content:** my sessions plus sessions shared with me. Shared sessions sit at their real key path, with the owner's avatar. `personal/<owner>/…` keys sit under "Shared with me › <owner>".
5. **External sources (changed by A3):** one mixed tree. Every row carries a source icon or label. Source filter chips: Dashboard and Shared on, external sources off by default.
6. **Source keys:** new Slack roots get `shared/slack/<channelId>/thread:<ts>/`. Telegram, Discord, and other chat-sdk channels follow the same pattern. Source groups are read-only.
7. **Backfill:** an idempotent, batched job re-keys roots whose key is still the default `shared/task:<rootId>/` and that have Slack or chat thread fields. It reuses `moveAssetKey`, so attachments and history follow. Sessions a user moved stay put.
8. **Labels:** a server label map resolves source IDs to names (channel, chat, or the DM partner). It is cached, with `chat_state_kv` as a candidate, and returned next to the tree.
9. **Forks (withdrawn by A1):** "Fork from here" on any message creates a new root with the same conversation key and a `forkedFrom` pointer (task and message). The fork starts with a short generated summary plus the parent ids. The summary uses the reusable structured-output LLM helper.
10. **Two-way Slack:**
    - The timeline shows human thread messages next to swarm tasks.
    - We keep the `<thread_context>` snapshot in the task input for the agent.
    - We also store each message in Chat SDK `SerializedMessage` shape in `chat_lists`, under our own prefix, deduped by id, with no expiry.
    - A dashboard reply is posted by the bot with attribution. In Slack it is muted and clearly marked as sent from the dashboard by <name>.
    - The reply task must satisfy the relay triggers, so the result also lands in the thread.
11. **Triage:** the dashboard uses `/api/inbox-state` (synced with the app), with the needs / unread / running glyphs and roll-ups.
12. **Group management:** full for user groups: create, rename, delete, multi-select, and drag to move. This needs one transactional "move prefix" endpoint. Source groups: move sessions out only.
13. **Loading:** a server tree-summary endpoint returns nodes, counts, last activity, and labels. Each group pages its conversations, 50 at a time.
14. **Parallel work:** browser-like session tabs (state in the URL) plus one split view (two panes). No browser-owned shortcuts.
15. **Keyboard:** palette first. Cmd+K searches all sessions and groups and runs actions. Single keys (`j`, `k`, Enter, `x`, `e`, `m`) work only when the list has focus.
16. **Order (changed by A1, see Amendments):** (1) tree, triage, and palette search; (2) source keys, backfill, labels, and chips; (3) conversations and forks; (4) two-way Slack; (5) tabs and split.
17. **Legacy Sessions:** the new view is the default. A header link switches to "Legacy Sessions", a frozen copy of today's UI and query. The choice is remembered per user, and `/sessions/:id` honors it. Legacy is removed after slice 5.
18. **Deferred, with defaults:**
    - A Slack channel → user group mapping (per-channel default key). Default: not built. Users move threads by hand.
    - Group-level mute that covers future sessions. Default: not built (it needs group metadata). Per-session mute only.
    - Group colors and manual order. Default: order by last activity, as in the app.
    - The dashboard composer source for Slack replies vs. widening the relay trigger. Default: decided in /create-plan after reading the relay code.
    - Context-panel sessions (`contextKey` per page). Default: they are ordinary dashboard sessions in the tree. Nesting them by page is a later idea.
    - Narrow screens (below `lg`). Default: keep a compact picker. Tabs and split are desktop-only. Phone users have the app.
    - Search depth. Default: server-side search over title and task text. It already covers Slack human messages through the `<thread_context>` snapshot. No search over `chat_lists`.
    - Dashboard-native conversations (withdrawn by A2). Was: a new session mints `<group>/conv:<rootId>/`, and its forks share that key.

### Open Questions (for /research)

1. Does `getThreadContext`'s `conversations.replies` call with `limit: 20` return the first 20 messages on long threads instead of the last 20 (`src/slack/handlers.ts:~338`)?
2. How does `/api/inbox-state` key its items? Do Slack-origin sessions and forks produce `to_read` items today? What exactly drives "needs you"?
3. Is there an index that serves prefix scans on `agent_tasks.key`? What query shape gives the tree summary with visibility (requester, shares, source) and inbox-state joins?
4. What are the exact thread ids and readable-name sources for Telegram, Discord, WhatsApp, and Kapso?
5. Where must Slack messages be captured? List every `conversations.replies` call site and every inbound message event in swarm threads. Does the bot receive all thread messages, or only mentions?
6. What fields does the Chat SDK `SerializedMessage` have, and how do Slack messages map to it (id = ts, author, text, attachments)?
7. Does the Slack app have `chat:write.customize` for a username or icon override? What does a muted "from dashboard" context block look like?
8. How do the relay triggers in `144_slack_relay_obligations.sql` and `217_chat_sdk_state.sql` decide on dashboard follow-ups? Which other Slack code paths gate on thread fields only?
9. How does `can(task.fs.mutate)` scale for a prefix move over hundreds of roots, and what does `auditAssetKeys` block?
10. Does the customer's session message-ordering bug (seen on v1.68) still reproduce on v2.4.x?

### Constraints Identified

- **Architecture rules.** The API is the sole DB owner. DB access goes through the async seam (`getDbClient()`). New routes use `route()` with an RBAC posture and a response schema, then `docs:openapi`. Prompt text (the fork seed) goes through the `src/prompts/` template registry.
- **No new tables** (Taras's preference). Reuse `chat_lists` and `chat_state_kv`.
- **Key rules.** At most 255 characters, normalized to lowercase, root `shared/` or `personal/<uid>/`. Keys are labels, not visibility. Visibility comes from the requester and shares.
- **No shortcuts that a browser or the OS owns.**
- **Slack API rate limits** apply to label lookups and the backfill.
- **External content must stay visibly external,** both in the dashboard and in Slack.
- **Frontend PR rules.** Screenshots plus a recording for flow changes, captured with `agent-browser`.
- **App compatibility.** The app reads the same keys. It shows `thread:<ts>` leaves as group nodes until Taras ports the leaf rule.

### Core Requirements

1. **Tree.** The sessions sidebar becomes a key-prefix tree with folding, roll-up glyphs, Today / Yesterday / Earlier inside a group, and "No group". It is fed by a tree-summary endpoint and paged per group.
2. **Find.** Cmd+K searches all sessions and groups on the server and runs session actions. List keys work when the list has focus.
3. **Triage.** Read, unread, Done, and Later through `/api/inbox-state`, with the needs / unread / running glyphs.
4. **Organize.** Create, rename, and delete a group. Move sessions by multi-select or drag. "New session in this group". One "move prefix" endpoint.
5. **Sources.** Source keys for new Slack and chat roots, a backfill job, a label map, source icons on rows, and filter chips (external off by default). Source groups are read-only.
6. **Conversations and forks (withdrawn by A1).** The leaf rule, expandable conversation rows, "Fork from here", and a seeded summary plus a pointer.
7. **Two-way Slack.** Structured message capture into `chat_lists`, a timeline that interleaves human messages, an attributed and muted bot reply, and a relayed result.
8. **Tabs and split.** URL-backed session tabs with glyphs, and one two-pane split.
9. **Legacy Sessions.** A per-user toggle back to today's exact UI. Old deep links work in both views. Legacy is removed after slice 5.

## Next Steps

From Taras's file review (2026-10-20):

- **Research now.** Run `/desplega:research` on the 10 open questions above, with a Workflow fan-out.
- **UI spike in parallel.** While research runs, do a UI spike with three variants, then iterate on the winner. Precedent: `mockups/onboarding/` and `mockups/session-logs/`: one shared `SPEC.md`, then `option-a-*`, `option-b-*`, and `option-c-*` as static HTML on the shared tokens, with later rounds kept beside the original. Target folder: `mockups/sessions-v2/`.
- **Then `/create-plan`,** using this brainstorm, the research doc, and the chosen mockup.
