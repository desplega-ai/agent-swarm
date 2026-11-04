---
date: 2026-11-03T15:28:40+01:00
author: Claude (with Taras)
topic: "Post-onboarding: early-user feedback, integrations, swarm checklist, prompting"
tags: [brainstorm, user-feedback, schedules, sessions, agent-fs, pages, workstream, onboarding]
status: complete
exploration_type: problem
last_updated: 2026-11-04
last_updated_by: Claude
---

# Post-onboarding (early-user feedback): Brainstorm

## Context

Source: a Lead write-up of feedback from an early user (2 Nov 2026). Its code facts were checked against main `c0a456ddd` (2 Nov). This worktree is at main `fd6131322`.

**The user's use case:** a recurring research job. Twice a week, track open- and closed-source competitors of their team's product, and use memory to compare against earlier runs. The swarm made a recurring task (schedule) and a Page.

**Their feedback (5 points):**
1. No command center for long-running or recurring work. Home is good for activity and token use. Sessions shows their session as Done. Tasks feel too low-level ("give me a summary" on one task loses wider context and memory). Pages has the result, but they must find it. They want one place per use case to see, steer and chat with it.
2. Task vs session is confusing for a one-off job that returns a result later.
3. Results land in different places. An agent-fs link asked for a second login ("I don't have the password"). They asked for a Page instead.
4. Positive: the opinionated preset (lead, researcher, skills, prompts, memory) is the value. They like the "company OS" idea.
5. They guess Slack is the intended command center and ask if that is right.

**What Taras told the user:** use Slack (best) or Telegram groups. Sessions aim for Slack-style channels but are not there yet. The filesystem is core, use Files in the app. Users should be auto-registered on agent-fs, so a "register your user" prompt is an onboarding bug. For their use case: start with a planning session and build an app.

**Lead's four candidate iterations (proposed order 3, 2, 1, 4):**

| # | Name | Size | Today | Proposal |
|---|------|------|-------|----------|
| 1 | Workstream view | M | `/schedules/:id` has next run, past runs, Run now. No outputs, no chat. Pages carry no task or schedule link (key `shared/page:<id>/`). Schedules is admin-only in the nav. | Outputs tab keyed on the run's key, plus a chat box that steers the next run. |
| 2 | Active in Sessions + copy | S-M | Sessions auto-Done after 24h quiet (`session-tree.ts:71`). `create-schedule` stores no source task. Runs hidden by the default filter. No copy explains task vs session. | Store the source task on the schedule, keep its session out of Done with a next-run chip, nest runs under it, one line in the first-run guide. |
| 3 | Delivery + agent-fs (bug, first) | M | Links open in-app only with the user's own agent-fs key, else live.agent-fs.dev and a second login. Invite exchange never creates the agent-fs account. | Create the account at invite exchange, drop the external fallback, default to Files with Pages opt-in. |
| 4 | Slack/Telegram nudge | S, last | `/setup` has Slack but no Telegram. Checklist is admin-only. | Nudge after the first schedule ("post runs to a channel?"). |

**Open question from the doc:** workstream on the schedule page (Lead's pick) or as a Sessions group type?

**Possible goal from the doc:** an invited non-admin opens a result file in-app with zero extra logins. Check: an e2e run on a fresh invite.

**Related prior work:** agent-fs onboarding (PR #2442, merged 2026-10-27) added boot provisioning, invites and the `/agentfs` proxy. Brainstorm `thoughts/taras/brainstorms/2026-10-25-agent-fs-onboarding.md`. Sessions v2 (#2329) and source sections (#2408) shaped the Sessions page.

### Facts (code read on main `fd6131322`, 3 Nov)

1. **Schedule page.** `/schedules/:id` has a Schedule tab (next run, task template) and a Tasks tab (past runs, no output column), plus Run Now, Edit, Delete. The global contextual session panel opens on every page, but it only adds a `schedule <id>` footer to a new session. Only the nav entry is `adminOnly`. The routes are not admin-gated.
2. **Pages.** No task or schedule column. Default key `shared/page:<id>/`. `create-page` does not inherit the task's key. The only link is a task attachment (`kind='page'`) that the agent must add.
3. **Sessions.** A session = a root task plus its `parentTaskId` descendants. Auto-Done after 24h quiet, only in the Inbox scope with all tasks finished. Schedule runs are hidden twice by default: the "Mine" view excludes `source in (workflow, schedule, system)`, and the shown-sources default is `["comb","ui"]`. Each run is its own root session.
4. **Schedules.** `create-schedule` stores no source task or session (`scheduled_tasks.parentTaskId` exists, only `defer-task` sets it). Runs link back via `agent_tasks.scheduleId`, `source='schedule'`, `contextKey = task:schedule:<id>`, tags `scheduled` + `schedule:<name>`, and inherit the schedule `key` (default `shared/schedule:<id>/`).
5. **agent-fs links.** In-app (Comb `/file/~/...`) only when Comb is on AND this browser holds an agent-fs credential AND `me` succeeds. Else a new tab to `AGENT_FS_LIVE_URL` (default `https://live.agent-fs.dev`). Agents write `{{fileLinkBase}}/file/~/...`. The base is the live URL unless `AGENT_FS_LINK_TARGET=dashboard` with `APP_URL` set (the onboarding compose generator sets it, cloud/other installs may not).
6. **Invites and agent-fs.** The redeem handler does nothing with agent-fs. Boot provisioning skips users with no agent-fs account. After `/join`, with Comb on, the UI goes to `/file?connect=auto`, which registers the user in the browser and invites them (viewer unless `task.fs.mutate`). With Comb off, nothing is created. So the doc's claim is partly wrong: an auto path exists, but it is browser-side, Comb-gated and per-browser.
7. **Setup and channels.** `/setup` integrations: Slack, GitHub, GitLab, Bitbucket, Linear, Jira, Gmail, Microsoft, more. No Telegram. Telegram/Discord live under Integrations → Chat SDK (admin-only page). The first-run checklist needs `config.write.any`.
8. **Follow-ups.** A follow-up on a task creates a child task (same `key`, `contextKey`, requester, NOT `scheduleId`, so it never shows in the schedule's Tasks tab). Context = memories + a preamble (parent text 600 chars, parent output about 4.4k, up to 10 attachments, 4 ancestor pointers, about 8k cap). No session-history replay. Steering a schedule = Edit dialog or an agent calling `update-schedule` with a new `taskTemplate`. No dedicated flow.
9. **Grouping primitives.** No workstream/project table. Asset `key` is the grouping label across tasks, workflows, schedules, pages, apps, scripts and files (`GET /api/assets?keyPrefix=`). Sessions v2 groups are key prefixes. Slack/Telegram/Discord source sections are read-only key prefixes. Epics were dropped (migration 026).

## Exploration

### Q: What kind of exploration is this?
Taras: the post-onboarding problem. The doc's content, plus: adding integrations is key after onboarding, a default "onboarding checklist" for the swarm, some prompting changes, and more.

**Insights:** The scope is wider than the user's five points. The frame is "what happens after `/setup` finishes": first real use case, reach (integrations, channels), and the swarm's own guidance (checklist, prompts). The user's feedback is the evidence, not the whole scope. The asset `key` (fact 9) already ties a schedule, its runs and their outputs, which matters for any workstream design.

### Q: What is the one success moment that "post-onboarding works" means?
Taras: "Swarm connected" (channels + core integrations) and "first use case live" are the highest priority. "Team adopted" comes after, when the user is not solo. On "self-driving swarm": the swarm should naturally go in that direction.

**Insights:**
- Two co-equal goals: **reach** (the swarm is connected to where work happens) and **value** (one real use case runs and the user can see, steer and read it). They feed each other: a channel such as Slack is also the natural command center the user guessed at.
- Team adoption (invited non-admins) is phase 2. This lowers the priority of the doc's "invited non-admin opens a file with zero logins" goal, but the agent-fs wall also hits a solo owner in a new browser (fact 5: the credential is per browser).
- "Self-driving" is a direction, not a separate feature: the Lead's prompts and behavior should move users along. The UI should not be the only driver.
- Today's Home checklist mirrors the `/setup` steps (connect, name, ai, agents, memory, integrations, files) and hides once onboarding closes. It is admin-only (`config.write.any`). Nothing exists for after `/setup`.

### Q: Who drives the post-onboarding checklist?
Taras: both, signal-driven. One list. Items auto-check from real signals. Home shows it. The Lead reads the same state and proposes the next item at natural moments.

**Insights:**
- Needs a single source of truth that both the UI and the Lead can read: server-side state derived from signals (like `OnboardingSignals` in `src/be/onboarding.ts`), not a UI-only list.
- The Lead needs a prompt hook (a registered template in `src/prompts/`) that injects "next suggested step" only when relevant, so it does not nag on every turn (the one-shot NUDGES lesson from harness steering).
- The checklist must stay visible after `/setup` closes, and probably not only to admins (non-admins need at least "open Files" and "follow a use case").

### Q: Which items belong on the default post-onboarding checklist?
Taras: (1) connect a chat channel (Slack, Telegram or Discord), (2) connect work tools (GitHub/GitLab, Linear/Jira, Gmail, ...), (3) first use case, planned (a planning session that ends in a schedule, app or page). "Invite a teammate" is NOT on the default list.

**Insights:**
- Three items, all solo. Team adoption stays out of the default checklist (matches the north-star answer).
- Item 1 needs Telegram and Discord reachable from the checklist. Today they sit under Integrations → Chat SDK (admin-only) and `/setup` lacks them (fact 7).
- Item 3 needs a clear "done" signal. Candidate: a schedule or app exists AND one run delivered a result the user opened. That ties the checklist to the delivery fix (agent-fs wall).
- Item 2 is open-ended. "Done" likely means at least one work tool connected, while the Lead keeps suggesting more when a task needed one.

### Q: Where does a use case live in the dashboard?
Taras: a Sessions group by key. The planning session sets one asset key. The schedule, its runs, pages and files inherit it. Sessions shows it as a group with a header (next-run chip, outputs, steer box).

**Insights:**
- This answers the doc's open question against the Lead's pick (schedule page). It reuses existing primitives: groups are key prefixes, runs already inherit the schedule key (facts 4, 9).
- Gaps to close: (a) the planning session and the schedule must share one key (today the schedule defaults to `shared/schedule:<id>/`); (b) `create-page` must inherit the task key (fact 2); (c) schedule runs must show inside their group even though "Mine" hides `source='schedule'` (fact 3); (d) a group needs a header that knows about its schedule(s).
- The same key can map to a Slack/Telegram channel later (source sections are key prefixes too).
- The schedule page can still get a cheap "Outputs" link, but it is no longer the command center.

### Q: What is the default deliverable for a use case run? (first ask, answered with root-cause context)
Taras: the user probably had issues with Comb. Maybe it was not set up automatically, so their browser had no agent-fs credentials.

**Insights (code read, 3 Nov):**
- That matches the code. The agent-fs credential lives only in the browser's localStorage (fact 5). Without it, every file link opens `live.agent-fs.dev`.
- Auto-connect runs only once, on `/file?connect=auto` right after `/join` (`connect-card.tsx:42-63`). An owner in a new browser, or anyone who cleared storage, gets no auto-connect.
- **Likely root cause of "I don't have the password":** "Create with my email" calls agent-fs `/auth/register`. If the email already has an account (from another browser or from `/setup`), agent-fs returns 409 and the UI shows `email-taken` (`connect-flow.ts:101-103`). The only way forward is "Paste a key", and the user never saw that key. agent-fs has no password, OAuth or magic link.
- `AGENT_FS_PROXY` (`/agentfs/*` on the API) is off by default (`constants.ts:346`). Even when on, it is only a transport. The browser still sends its own agent-fs key.
- So the wall is not invite-specific. It hits every user on every new browser. The deliverable question is still open and comes back after the credential question.

### Q: Who should hold each user's agent-fs key?
Taras: the swarm server holds it (mint and store per user, dashboard reads via the `/agentfs` proxy authed by the swarm session). ALSO fix login in agent-fs itself: if an agent sends a live link anyway, the agent-fs UI must be seamless too.

**Insights:**
- Two layers. (1) In-app: the server-held key makes Files work on any device with zero setup. The proxy must be on by default, must inject the per-user key, and must never forward the swarm key (rule from #2442 review). (2) Out-of-app: `live.agent-fs.dev` needs a login path that works for a swarm user who never saw a key.
- Server-held keys change the trust model: the swarm API can act as any user on agent-fs. Store keys encrypted (same as other secrets) and scope proxy calls to the session's user.
- Existing users already have browser-only keys the server never saw. Migration needs a path: rotate (mint a new key through the bootstrap admin) or capture the key on the next connected visit.
- The layer-2 mechanism is a separate decision (next question). It is an agent-fs repo change.

### Q: How should live.agent-fs.dev become seamless for a swarm user without a key?
Taras: "Continue with your swarm". The agent-fs org records its swarm URL. With no key, the live UI offers "Continue with <swarm>", redirects to the swarm, which checks the session and hands back a short-lived token for that user.

**Insights:**
- Builds on the server-held key: the swarm can only vouch for a user it knows on agent-fs.
- Needs in agent-fs: an org-level "trusted swarm" record, a token type that a swarm can mint (or exchange), and the redirect UI. Needs in the swarm: an authorize endpoint that checks the session, the user's drive access, and an allowlisted return URL (open-redirect and token-leak risk; use a fragment or a one-time code exchange, the same lesson as the invite link in #2442).
- Self-hosted agent-fs servers get the same flow, since the org stores the swarm URL.

### Q: What is the default deliverable for a use-case run?
Taras: a file, shown in-app. Markdown in agent-fs under the use-case key, rendered inline in the Sessions group's outputs. A Page only when the user asks.

**Insights:**
- The group header's "Outputs" = files under the group key (agent-fs listing by path prefix), newest first. Runs can diff against earlier reports in the same folder, which serves the user's "compare with what it already knows".
- Prompt change implied: the Lead and workers write use-case results to `<key>/...` and link the in-app path, not a Page, unless asked.
- Depends on the server-held key. Without it, in-app rendering fails on a new browser again.

### Q: How does steering work in the use-case group?
Taras: the Lead decides. Chat in the group is a session with the Lead in that key. One-off asks run as normal tasks with the group's files and memory. Lasting changes make the Lead call `update-schedule` and show the template diff.

**Insights:**
- No new steering primitive. The Lead needs prompt guidance to tell "one-off" from "from now on" and to confirm lasting changes with a diff.
- Follow-up tasks today do not carry `scheduleId` (fact 8). With groups keyed by `key`, that stops mattering: they show in the group anyway because they inherit the key.
- The group header should show the current schedule template (read-only), so a lasting change is visible.

### Reframe (Taras, mid-session)
"The key here is how to navigate the UI. Most of the things are there, and there are ways to configure all. It's a UX/UI problem."

**Insights:**
- Agreed for most items: schedules, pages, files, Telegram/Discord, integrations and key-prefix groups all exist. Users cannot find or connect them.
- Not UI-only: the agent-fs credential wall (server-held key, "Continue with your swarm") is an auth bug. The use-case group also needs small data links: one shared key for the planning session and the schedule, `create-page` key inheritance, schedule runs visible inside their group.
- Current nav (`app-sidebar.tsx:126-218`): WORK = Home, Tasks, Sessions, Pages, Apps (admin), Files, Approvals. SWARM = Agents, People (admin), Workflows, Scripts, Schedules (all admin). RESOURCES = Skills, MCP Servers, Connections, Memory, Templates (all admin). Settings has 9 entries, Integrations admin-only. About 25 destinations, with no "use case" entry point.

### Q: Which Lead prompt changes are in scope?
Taras: all four. (1) Use-case planning + one key, then tell the user where it lives. (2) Files-first delivery under the key, in-app links only, Pages on request. (3) One-shot next-step nudges from checklist state, including a missing-integration hint when a task needed one. (4) When a chat channel is connected, offer to post each run's summary there (thread per use case).

**Insights:**
- All four are template changes in `src/prompts/`, plus one new template input: the checklist state (for nudges).
- (2) also needs `AGENT_FS_LINK_TARGET=dashboard` as the default where `APP_URL` is set, so `{{fileLinkBase}}` stops pointing at the live UI (fact 5).
- (3) must be one-shot per item (the NUDGES lesson). It needs a "nudged" marker in the checklist state.
- (4) needs a way to map a use-case key to a channel thread. Source sections are key prefixes, so this may already fit; research item.

### Note: the checklist is editable (Taras)
"All of them, but the list should be editable. Maybe a user does not use GitHub (non-tech), or they want multi-channel."

**Insights:**
- The three items are defaults, not a fixed list. A user (or the Lead, on request) can remove an item, add one, or repeat one (a second channel).
- "Connect work tools" is a set of sub-items the user picks, not "GitHub". A non-tech user may pick Gmail and Linear, or nothing.
- "Connect a chat channel" can hold several channels (Slack AND Telegram). Done = at least one, others stay optional.
- The Lead's nudges must read the edited list: never suggest a removed item.
- Editable state needs storage beyond derived signals: per-swarm item overrides (removed, added, order) on top of the auto-check signals.

### Q: What is the navigation model after onboarding?
Taras: open to rethinking the UI and the sidebar. A proper Home makes sense, a command center: pending stuff, WIP stuff, favorites (key + KV to favorite things), etc. Connections and Settings → Integrations should be one page. Provider keys should let you add new keys right there. "Let's rethink that."

**Insights:**
- Scope grows from "post-onboarding fixes" to an IA rethink of the dashboard. Two threads: (a) Home as the command center, (b) consolidation of overlapping config pages.
- Favorites on key + KV: reuse the asset `key` as the thing you favorite (a use case, a schedule, an app, a folder), stored per user in KV. No new table.
- This replaces the "use-case first" vs "Home as hub" choice: Home is the hub, use-case groups are what Home lists.

### Facts: dashboard IA today (code read, 3 Nov)

- **Home** (`pages/home/unified-home.tsx:51-118`): setup checklist (admin, while onboarding is open), admin nudges (automations needing setup, update, telemetry), fleet benchmark card, activity timeline. Mobile has `MobileNow`: approvals, "Working now", "Failed in 24h". Desktop has no "needs you" view.
- **Ready-made but unmounted:** `useBlockingInbox`, `useBrokenInbox`, `useToReadInbox`, `useToStartInbox` (`api/hooks/use-inbox.ts`). Session tree already counts `needsYou`, `unread`, `running`.
- **Favorites already exist** server-side: table `user_favorites`, `GET/PUT /api/favorites`, scope `user:<id>`. Types: `page`, `workflow`, `schedule`, `agent-fs-path`. Stars on Pages, Workflows, Schedules. Comb pins use agent-fs stars. No stars on sessions, apps, tasks, or keys. The UI has no per-user KV namespace.
- **Connect/config pages overlap:**
  - `/connections` = script connections + OAuth apps. `/settings/connections` = dashboard-to-swarm server list in localStorage. Same name, unrelated things.
  - `/settings/integrations` = fixed catalog written as global `swarm_config` rows (Anthropic, OpenRouter, OpenAI, Slack, GitHub, Linear, Chat SDK, ...).
  - OAuth for Linear, Jira, GitHub, Slack exists in both `/connections` OAuth Apps and the Integrations cards.
  - Global `swarm_config` rows are editable in Secrets, Integrations and Configuration.
  - **Provider keys cannot add a key.** It only lists, renames, sets plan, clears rate limits. Keys are added in Integrations (Anthropic/OpenRouter/OpenAI cards), `/setup`, or raw Secrets. No pointer from its empty state.
  - `/mcp-servers` env and header keys point at `swarm_config` keys, so they depend on Secrets.
- **Sidebar badges:** Tasks (running), People (user count), Usage ($ today). None on Approvals, Sessions or Schedules.
- **WIP gaps:** no global live workflow-runs endpoint (the UI fetches each workflow's runs one by one). No "stalled" signal in the UI.

### Q: Which sections go on the Home command center?
Taras: Needs you, In progress, Favorites. Plus the editable checklist. Not "Coming up" (next scheduled runs).

**Insights:**
- Needs you = approvals + sessions with `needsYou` + agents blocked on credentials + failed runs. The unmounted inbox hooks cover most of it.
- In progress = running sessions grouped by key. Workflow runs need a global endpoint (gap above) or stay out at first.
- Favorites = extend `user_favorites` with a `key` type (a use case) and maybe `session` and `app`. This replaces "key + KV": the per-user table already exists.
- Next runs still show inside each use-case group header, just not on Home.
- The activity timeline and fleet benchmark card need a new place or a lower slot (open decision).

### Q: What shape should the connect/config consolidation take?
Taras: one "Connect" hub. Top-level page with 3 sections: Channels (Slack, Telegram, Discord), Tools (integrations + OAuth connections + MCP servers as one catalog), AI providers (add key + health in one). Secrets stays as "Advanced". `/settings/connections` is renamed "Servers". Hard constraint: routes stay backward compatible as much as possible, with reasonable redirects.

**Insights:**
- Every old route (`/connections`, `/settings/integrations`, `/settings/integrations/:id`, `/mcp-servers`, `/settings/api-keys`, `/settings/connections`) must redirect to its new home, keeping query params and deep-link ids. Agent prompts, docs, skills and old Slack messages hold these URLs.
- Inbound links in code must move too (for example the task rail link to `/settings/api-keys`, `task-details-rail.tsx:753`). Research item: find all hard-coded dashboard paths in prompts, skills and docs.
- The Connect hub is also where checklist items 1 and 2 point. "Connect a chat channel" opens Channels, "Connect work tools" opens Tools.
- Data stays where it is (`swarm_config`, `script-connections`, `mcp_servers`). This is a UI regrouping, not a backend merge. The OAuth duplication (presets vs Integrations cards) needs one canonical flow per provider: research which one wins.

### Q: What is the sidebar shape?
Taras: Work / Connect / Build. WORK: Home, Sessions, Files, Apps, Pages. CONNECT: one hub entry. BUILD (collapsed): Agents, Schedules, Workflows, Scripts, Skills, Templates, Memory, Tasks. Settings and Usage at the bottom.

**Insights:**
- Tasks moves to Build. A new user meets Sessions first, which removes most of the task-vs-session confusion without new copy.
- MCP Servers and Connections leave RESOURCES for the Connect hub. People moves to Settings or Build (detail for the plan).
- Apps is admin-only today. In WORK it should be visible to anyone who can use an app (members can see it, building stays gated).
- Sidebar badges should follow the command center: a Needs-you count on Home or Sessions, not only "running tasks" on Tasks.

### Q: What is the delivery order?
Taras: a parallel DAG (v-plan). Independent tracks at once: agent-fs fix, IA (sidebar + Connect hub + redirects), use-case groups. Home comes last because it reads from all of them. Each prompt change ships with the feature it references.

**Insights:**
- Merge risk sits in `app-sidebar.tsx` and `routes.tsx`. Only the IA track should touch them. Other tracks add routes or entries through that track, or land after it.
- The agent-fs "Continue with your swarm" work is a separate repo (agent-fs) and a natural independent track.
- Home depends on: favorites `key` type (use-case track), Needs-you hooks (exist), checklist state (new server state), and the new nav (IA track).

### Q: Where do today's Home cards go, who owns the checklist, and what do non-admins get? (batched)
Taras: (1) the activity timeline stays on Home as a lower section, the fleet benchmark card moves to Usage. (2) The checklist is per swarm, maybe with some items per user. (3) Keep today's RBAC gates for non-admins.

**Insights:**
- Natural split: swarm items (connect a channel, connect work tools) are swarm-wide. "First use case" fits per user.
- Default edit rights (not discussed, my recommendation): admins edit swarm items, each user edits their own items, the Lead edits on request.
- Members see WORK and their own Home items. Connect and Build stay admin-only. Team adoption flows are a later brainstorm.

## Synthesis

### Key Decisions
- **Frame:** this is the post-onboarding problem. Most features exist and are configurable. The core issue is UI navigation, plus one real auth bug (the agent-fs wall). The user's feedback is the evidence.
- **North star:** "swarm connected" (channels + work tools) and "first use case live" (see, steer, chat, read results with zero extra logins). "Team adopted" comes later, when the user is not solo.
- **Self-driving direction:** the Lead moves users along through prompts. The UI is not the only driver.
- **Post-onboarding checklist:** one list, auto-checked from real signals, shown on Home and read by the Lead. Default items: connect a chat channel, connect work tools, first use case (planned). No "invite a teammate" by default. The list is editable: remove (no GitHub for a non-tech user), add, or repeat (several channels). Per swarm, with some items per user.
- **Use-case home:** a Sessions group by asset key. The planning session sets one key. The schedule, its runs, pages and files inherit it. The group header shows the schedule (next run, template, Run now), outputs and a chat box.
- **Steering:** the Lead decides. One-off asks run as normal tasks with the group's files and memory. Lasting changes use `update-schedule` and show the template diff.
- **Deliverable:** a file under the use-case key, shown in-app. Pages only on request.
- **agent-fs keys:** the swarm server holds each user's agent-fs key. The dashboard reads files through the `/agentfs` proxy, authed by the swarm session.
- **Live agent-fs UI:** "Continue with your swarm" handshake in agent-fs (org records its swarm URL, swarm returns a short-lived token).
- **Prompt changes (all four):** use-case planning + one key; files-first delivery with in-app links; one-shot next-step nudges, including missing-integration hints; offer to post run summaries to a connected channel (thread per use case).
- **Home = command center:** Needs you, In progress (by key), Favorites, the editable checklist. Activity timeline below. Fleet benchmark card moves to Usage. No "Coming up" section (next runs live in group headers).
- **Favorites:** extend the existing `user_favorites` table (add a `key` type, maybe `session` and `app`). Not KV.
- **Connect hub:** one top-level page with Channels (Slack, Telegram, Discord), Tools (integrations + OAuth connections + MCP servers), AI providers (add key + health). Secrets stays as Advanced. `/settings/connections` becomes "Servers".
- **Sidebar:** WORK (Home, Sessions, Files, Apps, Pages), CONNECT (hub), BUILD collapsed (Agents, Schedules, Workflows, Scripts, Skills, Templates, Memory, Tasks), Settings and Usage at the bottom.
- **Routes:** backward compatible, with redirects that keep query params and deep-link ids.
- **Delivery:** parallel DAG (v-plan). Tracks: agent-fs wall (swarm), "Continue with your swarm" (agent-fs repo), IA, use-case groups. Home last. Each prompt change ships with its feature.
- **Members:** today's RBAC gates stay.
- Deferred: team adoption (invite item, member-safe Connect, member Home). Defaulting to today's gates unless revisited.
- Deferred: checklist edit rights. Defaulting to: admins edit swarm items, each user edits their own items, the Lead edits on request.
- Deferred: where People goes (Settings or Build). Defaulting to Settings.
- Deferred: the one-line task-vs-session copy in the first-run guide. Defaulting to skip, since Tasks moves to Build.

### Open Questions
Fact-shaped, input for `/research`:
- The user's deployment: cloud tenant or self-hosted? Were Comb, `AGENT_FS_PROXY` and `AGENT_FS_LINK_TARGET` on? Did they hit the 409 `email-taken` path? (confirms the root cause)
- Server-held keys: can the bootstrap admin mint or rotate a key for an existing agent-fs user? Which agent-fs API? How do existing browser-only keys migrate?
- agent-fs: what exists for org metadata, short-lived tokens and auth routes that "Continue with your swarm" can build on?
- Which dashboard paths are hard-coded in prompts, skills, docs, Slack/Telegram templates and `getAppUrl()` link builders? (redirect coverage)
- OAuth duplication: per provider (Slack, GitHub, Linear, Jira), which flow is canonical, the `/connections` OAuth presets or the Integrations cards?
- Channels: can a Slack/Telegram/Discord thread map to a use-case key today (source sections are key prefixes)? How would a schedule run post its summary to that thread?
- Sessions groups: does the "Mine" filter (hides `source='schedule'`) also apply inside a key-prefix group?
- In progress: what does a global live workflow-runs endpoint cost (today the UI fetches runs per workflow)?
- Why does `create-page` not inherit the task key? Any reason to keep that?
- Checklist state: can the onboarding state in `src/be/onboarding.ts` (signals, steps) extend past `/setup`, or does it need new storage?

### Constraints Identified
- Old routes keep working through redirects (query params and ids kept).
- Prompt text goes through the `src/prompts/` template registry. Nudges are one-shot per item.
- The `/agentfs` proxy never forwards the swarm key. It scopes every call to the session's user. Stored agent-fs keys are encrypted.
- The live-UI handshake works without SMTP (self-hosted) and avoids open redirects and token leaks (fragment or one-time code).
- RBAC gates stay as today. New non-GET routes declare RBAC, typed responses, OpenAPI regen, and black-box E2E scenarios.
- In the parallel DAG, only the IA track edits `app-sidebar.tsx` and `routes.tsx`.
- UI PRs need screenshots and recordings (agent-browser).
- New tables or columns need a migration ordinal above main's tail.

### Core Requirements
**Track A: agent-fs wall (swarm repo)**
- The server mints and stores each user's agent-fs key (at user creation, invite redeem, or first need). Existing users get a migration path.
- The `/agentfs` proxy is on by default and injects the session user's key.
- File links default to in-app when `APP_URL` is set. The live URL is only a fallback with no dashboard.
- Prompt: files-first delivery under the use-case key, in-app links, Pages on request.
- Check: the owner in a fresh browser AND an invited non-admin open a result file in-app with zero extra logins (E2E).

**Track B: "Continue with your swarm" (agent-fs repo)**
- The org records its trusted swarm URL. With no key, the live UI offers "Continue with <swarm>".
- The swarm authorize endpoint checks the session, drive access and an allowlisted return URL, then returns a one-time code that agent-fs exchanges for a short-lived token.

**Track C: IA**
- Sidebar WORK / CONNECT / BUILD, Settings and Usage at the bottom.
- Connect hub: Channels, Tools, AI providers (add + health), Secrets as Advanced. "Servers" rename.
- Redirects for every moved route. Inbound links updated.
- Fleet benchmark card moves to Usage.

**Track D: use-case groups**
- The planning session and the schedule share one key. `create-page` inherits the task key. Schedule runs show inside their group.
- Group header: schedule(s) with next run, read-only template, Run now. Outputs = files under the key. Chat box to the Lead.
- `user_favorites` gains a `key` type.
- Prompts: use-case planning + key; offer to post run summaries to a connected channel thread.

**Track E: Home (after A, C, D)**
- Sections: Needs you (approvals, `needsYou` sessions, credential-blocked agents, failed runs), In progress (by key), Favorites, checklist. Activity timeline below.
- Checklist: default items, auto-checks from signals, editable (remove, add, repeat), per-swarm items plus some per-user items. The Lead reads it and nudges once per item, including missing-integration hints.
- A Needs-you badge in the sidebar.

## Next Steps

- Research next (Taras, 2026-11-04): `/desplega:research` on the 10 fact-shaped Open Questions. Then `/desplega:v-plan` (parallel DAG: tracks A-E).
