---
date: 2026-09-29T20:56:38+02:00
author: Taras
topic: "Comb: agent-fs as a shared review space inside the swarm dashboard"
tags: [brainstorm, agent-fs, ui, collaboration, comments, mentions, spaces, comb]
status: complete
exploration_type: idea
last_updated: 2026-09-29
last_updated_by: Claude
---

# agent-fs as a shared space inside the swarm dashboard — Brainstorm

## Context

Taras wants agent-fs to feel like part of the swarm dashboard (apps/ui) when agent-fs is connected. Today the dashboard only knows agent-fs as a file provider behind `/api/fs/*` (task attachments). Human-facing file links go to raw endpoints or out to agent-fs's own UI.

Initial ideas from Taras:

- An iframe of the agent-fs live UI is one option, but maybe not the best.
- Alternative: let the user log in to agent-fs from the dashboard (token in localStorage, the same way the agent-fs live UI does it). Then render agent-fs content natively in the dashboard.
- Links should not leave the dashboard.
- Use live collaboration to leave comments on files. Then "@" an agent to review comments one at a time or in batches.
- Copy the idea of ChatGPT Spaces (https://chatgpt.com/features/space/). Taras believes the swarm already has all the needed components.
- Give it an interesting name. Expect few new primitives.

Relevant prior work:

- `thoughts/taras/brainstorms/2026-06-25-agent-fs-first-class.md` and the shipped PR #850 (provider abstraction, `/api/fs/*`, per-agent agent-fs credentials, task attachments).
- `thoughts/taras/brainstorms/2026-08-04-realtime-collab-primitive.md` (Yjs rooms on KV snapshot, issue #1090). Status to verify.
- DES-670: render files in-app instead of dead `/api/fs` links.
- agent-fs sibling repo: `/Users/taras/Documents/code/agent-fs` (v0.14.x, has a `live/` UI).

Background research (running at session start):

1. ChatGPT Spaces product mechanics.
2. agent-fs `live/` UI, auth, embedding constraints, comments, realtime.
3. agent-swarm agent-fs integration today (server + UI).
4. agent-swarm collaboration primitives inventory (rooms, comments, mentions, identity, HITL, pages, apps).

## Research Findings

### R1. ChatGPT Space (launched 2026-09-29 at DevDay)

Sources read: the feature page, help.openai.com "Getting started with Space" and "sharing, data, and controls", learn.chatgpt.com Space docs + collaboration page. It launched today, so no hands-on reviews exist yet.

- **Object model.** "Space" is the home for your pages and files, "like they would in a drive". It replaces the old Library. A *space* is a container for a topic or team. It holds **pages** (interactive living documents with charts, checklists, trackers, dashboards) and uploaded files. Pages nest as **subpages**. There are no folders. Views: Your items, Shared with you, Suggested, Recents. Slides and Sheets are "coming soon".
- **Two ways to ask the AI.** (a) **Comments**: select text, comment the change you want, and "@mention ChatGPT or your dot in a comment to help make changes". (b) **Page chat**: for broader questions or changes across the whole document.
- **Agents are addressable.** You tag "ChatGPT, Codex, or your dot" (dots = always-on agent coworkers with their own cloud computer). The same agent identity is reachable from Slack and Teams.
- **Review loop.** "Tell ChatGPT what to update on your page, which sources to use, and when to check. Come back to review what changed and decide what comes next." No documented suggest/accept (tracked changes) model. No documented batch "@ on N comments". Threading and resolve are not documented.
- **Access.** Three levels: View, Comment, Edit. Access to a space applies to all its pages. Sharing a page also shares its subpages (inheritance, direct vs inherited shown in the UI). Files uploaded into a page follow page permissions. A link to a separately stored file does not grant access.
- **Known gaps and criticisms.** Unclear approval model for agent edits. Scheduled "keep updated" is not shipped at launch. Content an agent copies onto a page leaks past source permissions.
- **Names to avoid:** Space, Pages, Dots, Library, Workspace (and our own "pages" is already taken).

**Insight:** the thing to copy is the *loop*, not the editor: a shared container of living docs + anchored comments + @agent inside a comment + "review what changed". Their weak spot (no approval model, no batch review) is exactly where the swarm is strong (tasks, HITL, versions in agent-fs).

### R2. agent-fs `live/` UI, auth, comments, embedding (repo `../agent-fs`, v0.14.x)

- **`live/` is a separate private SPA** (`agent-fs-live`, Vite + React 19, react-router 7, TanStack Query, Tailwind 4, Monaco, MDXEditor, DuckDB-WASM, shiki, mermaid; pnpm). Deployed on Vercel as `live.agent-fs.dev`. The agent-fs server does not serve it. It is stateless: you point it at any API URL.
- **Routes:** `/file/~/:orgId/:driveId/*` (browser + tree), `/detail/~/...` (full-page viewer), `/sql/~/...`, `/credentials`. Deep-link builder in `packages/core/src/ops/urls.ts:8`.
- **Views:** file tree, folder list/grid, recent activity, viewer + editor, upload/rename/delete, search (hybrid, semantic, FTS, glob), version history + diff, comments sidebar + threads + notifications, outline, SQL workbench.
- **Renderers:** markdown (react-markdown, MDXEditor rich edit, Monaco source/split), code (Monaco), images, video, PDF, CSV/TSV/NDJSON/parquet/xlsx/sqlite via DuckDB grid. **HTML renders as source text** (no preview).
- **Human auth:** no email/password, no magic link, no OAuth, no sessions. You paste an API key + endpoint, or self-register by email via public `POST /auth/register` (no email verification). `?apiUrl=&apiKey=` auto-connects. **Key = opaque `af_<64hex>`, no expiry, no scopes, one per user**, reset via `POST /auth/reset-key` or admin `members/:userId/reset-key`. Stored in localStorage (`agent-fs-credentials`, `agent-fs-active-*`). No cookies.
- **Embedding:** API CORS defaults to `*` (no credentials), so cross-origin Bearer fetch from the dashboard **works today**. The live app sets no frame headers, so it is **frameable today**, but: the only key handoff is `?apiKey=` in the URL (then persisted to the iframe origin's localStorage), third-party storage partitioning applies, and there is **no postMessage bridge** (no theme, navigation, or events). Share pages are `frame-ancestors 'none'`/`'self'`.
- **Raw bytes:** `GET/PUT /orgs/:org/drives/:drive/files/<path>/raw` (forces `attachment` disposition). The live client uses signed URLs, so for S3 backends the **bucket's CORS** applies, not the API's.
- **Ops cover everything a viewer needs:** `ls`, `tree`, `reveal`, `stat`, `cat`, `log`, `diff`, `revert`, `recent`, `fts`, `grep`, `glob`, `search`, `vec-search`, `signed-url`, `share-create/revoke`, `write`, `edit`, `mv`, `cp`, `rm`, `sql`, `comment-*`.
- **Comments are already rich** (`packages/core/src/db/schema.ts:132-162`): one level of threading (`parentId`), line range + text-quote anchor (`quoteExact/Prefix/Suffix`), `fileVersionId`, `author` (agent-fs user id), `resolved/resolvedBy/resolvedAt`, soft delete. Ops: add, list (default: unresolved roots), get, update, delete, resolve, notification-list/read. Live UI **re-anchors comments across versions via diff** (`hooks/use-comment-anchors.ts`) and highlights with the CSS Custom Highlight API. **No @-mentions. No realtime** (comments poll every 10 s; "live" is just the product name).
- **No reusable UI package.** Published packages: core, server, mcp, cli, just-bash, fuse helpers. The HTTP client and all viewer/anchoring code live inside the private `live/src`.

**Insight:** agent-fs already owns the hard parts of "comment on a file" (anchors, re-anchoring across versions, threads, resolve, notifications). The swarm owns the parts agent-fs lacks (identity of humans, @agents → tasks, realtime rooms, HITL). "Few new primitives" holds if we split along that seam.

### R3. agent-fs in the swarm today (server + dashboard)

- **API surface is task-attachment-only.** `src/http/fs.ts`: capabilities, per-agent credentials, member invite, and `tasks/{taskId}/files` list/upload/metadata/raw/signed-url/delete. No generic browse-by-path, no search, no comments, no versions route.
- **Provider is richer than the routes.** `src/fs/agent-fs-provider.ts` implements search, comments (`comment-add`/`comment-list`), versions (`log`/`revert`), list, signed URLs. All unexposed. `list`/`search` are scoped to `tasks/<taskId>/`.
- **One shared org + one shared drive per swarm.** The API data plane always calls agent-fs with the **bootstrap key**. Agents have their own keys (registered as `<agentId>@swarm.local`, invited as editor).
- **Humans: invited, never credentialed.** The provision seeder invites every swarm user with an email into the shared org (`src/be/seed/agent-fs-provision.ts:68-120`, editor or viewer by role). The swarm never gets or stores a human agent-fs key. So the dashboard has **no human agent-fs identity** today.
- **"Connected" signal exists but is unused.** `GET /status` returns `agent_fs.configured` (`src/http/status.ts:688`). `useFsCapabilities` (`apps/ui/src/api/fs.ts:135`) has no callers.
- **Dashboard file UI is only the task attachments section** (`apps/ui/src/components/shared/task-attachments-section.tsx`). Previews: image, video, PDF (blob iframe, no sandbox), text (`<pre>`, 512 KB). No markdown, no code highlighting, no HTML render. No files route, no sidebar entry.
- **Links leave the dashboard.** agent-fs attachments link to `${VITE_AGENT_FS_LIVE_URL || https://live.agent-fs.dev}/file/~/<org>/<drive>/<path>` with `target=_blank` (`task-attachment-link.tsx`). Server side uses `AGENT_FS_LIVE_URL` (`src/utils/constants.ts:79-140`) for Slack + prompts. The two env names differ. The UI builder has no default org/drive fallback. Markdown links and citations also open new tabs. `src/be/memory/link-resolver.ts:44` already parses live URLs into `agent-fs-file` links.
- **Pages precedent for embedding.** `/pages/:id` renders HTML pages in an `<iframe>` from the API origin with `sandbox="allow-scripts allow-forms allow-same-origin allow-popups"`. Authed pages mint a `page_session` cookie via `POST /api/pages/:id/launch` first. Server CSP sets `frame-ancestors 'self'` + configured app URLs.
- **DES-670** ("render files in-app") exists only as a mention. No plan or code.

**Insight:** there is a proven server-proxy path (bootstrap key) and a proven viewer shell (attachments). The missing piece is not data access. It is (a) whose identity the read/comment carries and (b) a drive-wide browser + rich viewer.

### R4. Swarm collaboration primitives (verdict: "we have everything" is PARTIALLY true)

| Needed capability | Status | Where | Gap |
|---|---|---|---|
| Live multi-user state + presence | SHIPPED | `src/realtime/rooms.ts` (Yjs, KV snapshot under `_room/`), `src/realtime/transport.ts` (WS upgrade on API origin), `src/tools/rooms.ts` | Dashboard shell has no realtime client. Only pages/apps get the browser SDK (`src/realtime/browser.ts`). |
| Comment model + threads | ABSENT in swarm DB, PARTIAL via agent-fs | `src/fs/capabilities.ts:44-45`, `src/fs/agent-fs-provider.ts:215-232` (`comment-add` / `comment-list` ops, `body` + optional `range`) | No swarm HTTP routes, tools, or UI for comments. Comments live in agent-fs. |
| Human @agent picker | ABSENT | none in `apps/ui/src` | New component. |
| Agent mention data | SHIPPED (chat) | `src/tools/post-message.ts:13`, `apps/ui/src/api/client.ts:865` | Mentions notify only. They do not spawn tasks. |
| Comment/mention → task | PARTIAL | `src/tools/send-task.ts` (`requestedByUserId`), steer | No glue that composes N comments into one task. |
| Human identity for attribution | PARTIAL | `src/http/auth.ts:46-60` (`aswt_` user tokens), `apps/ui/src/contexts/current-user-context.tsx` | localStorage user picker is an untrusted claim under a shared operator key. |
| RBAC per space | PARTIAL | `src/rbac/admission.ts` | `grantsAll` in prod. No space-level permission. |
| HITL / approvals | SHIPPED | `approval_requests`, `request-human-input`, `/approval-requests` routes | Question-form shaped, not comment-shaped. |
| Inbox | SHIPPED | `use-inbox*.ts`, `inbox_item_state` | No comment/mention item type. |
| Custom UI hosting | SHIPPED | pages, Swarm Apps | json-render has no rich file viewer or mention control. |
| State storage | SHIPPED | KV, rooms, app models | Pick one. |

Realtime QA evidence: `thoughts/taras/qa/2026-09-09-realtime-rooms-1090.md`.

## Exploration

### Decision frontier (open branches)

1. Core job for v1: review loop on agent output, drive browser, or co-authored living docs.
2. Identity: whose agent-fs identity a human's reads and comments carry (browser-held key, swarm proxy with bootstrap key, or swarm-held per-human key).
3. Rendering: iframe of `live/`, native dashboard views, or a shared UI package extracted from `live/`.
4. Comment source of truth: agent-fs comments, Yjs rooms, or a swarm table.
5. Realtime: polling vs rooms for presence and live comment updates.
6. "@" semantics: one comment → one task, batch → one task, and how results land (reply, edit + new version, resolve).
7. Approval model for agent edits: direct write + version revert, or proposed diff + human accept.
8. The "space" container: shared drive + folders, one drive per space, or a swarm-side object.
9. Links: in-dashboard route scheme and rewriting of `live.agent-fs.dev` links.
10. Behavior when agent-fs is not connected (local-fs provider).
11. Permissions per space.
12. Name.

[Q&A pairs accumulate below]

### Q1: What is the core job of v1?
**Review loop.** Humans open files that agents wrote, comment on passages, and "@agent" to act on one comment or a batch. Taras: "1 could be nice".

**Insights:** This closes frontier item 1. The drive browser becomes a means (you need to open a file to comment on it), not the goal. Living-doc co-editing (Yjs on files) is out of v1. The weak spots of ChatGPT Space (no batch review, no approval model) become the product's focus.

### Q2: How should the file view and comments render inside the dashboard?
**Native in the dashboard.** The swarm UI renders files and owns the comment composer. Reuse the attachments previews and Streamdown. Copy only the comment re-anchoring logic from `live/`.

**Insights:** Closes frontier item 3. The iframe option is out, so agent-fs needs no embed mode, no postMessage bridge, and no URL key handoff. The @agent picker, task links, and inbox integrate natively. Links stay in the app because the dashboard owns the route. Cost: the dashboard needs a viewer set it lacks today (markdown via Streamdown, code highlighting, maybe HTML preview), and a copy of `use-comment-anchors.ts` from `live/`. Extracting a shared package stays possible later if duplication hurts.

**Follow-up from Taras (mid-session):** "we can start w simplified version of what live supports, but should be easy to extend / copy stuff around tbh". So v1 ships a subset of the `live/` viewers. The dashboard code must mirror `live/`'s shapes (client method names, component boundaries, file-type routing) so that more viewers can be copied across later with little rework.

### Q3: Whose agent-fs identity does a human's read or comment carry?
**Browser key in localStorage** (Taras's original idea, same model as `live/`). The dashboard holds the human's own `af_` key and calls agent-fs directly. I recommended a swarm-held key instead. Taras chose the browser key knowing the cost.

**Insights:**
- Closes frontier item 2. The viewer read path does not touch the swarm API at all. CORS `*` on agent-fs makes this work today. The swarm API is only needed for "@agent → task".
- Comments get real human authorship in agent-fs (`author`, `resolvedBy`, notifications all work).
- Risk accepted: a non-expiring, full-power key in localStorage, in an app that renders agent-written content. Mitigations to carry into the plan: namespace the key by `swarmId` + agent-fs URL (per the 2026-05-08 per-swarm localStorage learning), never send it to the swarm API, add a "disconnect" that clears it, keep agent-written HTML out of the dashboard origin (pages already iframe from the API origin).
- **Fact found:** agent-fs `inviteToOrg` fails when the email has no agent-fs user yet (`packages/core/src/identity/orgs.ts:217-230`, "User with email X not found"). So the seed-time human invite silently fails for anyone who never registered. The connect flow must register first, then invite. The swarm already has `POST /api/fs/members/invite` (`src/http/fs.ts:100`) for exactly this ("Connect to Drive").
- **Deferred, defaulting to:** a "Connect agent-fs" card in the dashboard. It offers "register with my swarm email" or "paste an existing key", then calls `POST /api/fs/members/invite` so the key can see the swarm's shared drive. agent-fs allows one key per user, so an existing account must paste its key (register returns 409).

### Q4: How does "@agent" on comments turn into agent work, one at a time or in batches?
**Draft review, then send** (GitHub's "Add single comment" vs "Start a review" model). "@agent" on one comment + Send creates one task now. Or the human queues several comments and uses "Send N to @agent" to create ONE task that carries every anchor, quote, and body.

**Insights:**
- Closes frontier item 6 (the trigger half). One task per batch means one agent edits a file at a time. That avoids N agents racing and writing conflicting versions of the same file.
- The task prompt must carry, per comment: comment id, path, `fileVersionId`, line range, text-quote anchor, body, author. That is enough for the agent to act without re-reading the whole thread.
- **Fact found:** agents can already close the loop from their side. The agent-fs CLI has `comment add | reply | list | get | update | delete | resolve | reopen | notifications | read` (`packages/cli/src/commands/comment.ts`). Agents hold their own agent-fs keys, so replies and resolves are authored by the agent, not by a shared admin.
- Open sub-question (result landing): does the agent reply + resolve each comment, and does it write a new version directly? This ties to frontier item 7 (approval model).

### Q5: Where do comments and the draft review live?
**agent-fs comments are the only comment store.** Drafts stay in the browser until Send. On Send, the swarm creates one task that holds the comment ids. No new swarm table. The "@agent" lives in the comment body.

**Insights:**
- Closes frontier item 4. The swarm adds no comment primitive. It only adds "comments → task" glue.
- Comments stay visible to agents (CLI) and to `live/` at the same time. The dashboard and `live/` become two clients of one store.
- The link from a comment to its task has to live somewhere. Simplest: the swarm (or the agent at claim time) posts a reply on each sent comment, e.g. "Sent to @agent in task <link>". That keeps agent-fs the source of truth and needs no schema change.
- Drafts in the browser are lost if the tab closes. Acceptable for v1. localStorage persistence per file is a cheap upgrade.
- Consequence for realtime (frontier item 5): with agent-fs as the store, "live" updates mean polling agent-fs (as `live/` does, 10 s), unless agent-fs gains events later.

### Q6: When the agent acts on a batch, how do its edits land and who approves them?
**Default: write, reply, human resolves.** The agent writes a new file version directly and replies on each comment with what it changed. The human opens "Review changes" (agent-fs `diff`: commented version → new version), then resolves each comment or reverts. Taras: "generally 1, but I see how agents sometimes do 3" (the agent resolves itself).

**Insights:**
- Closes frontier item 7. No suggestion/accept primitive. agent-fs versions are the undo (`revert`), and resolve is reversible (`comment reopen` exists).
- Agent self-resolve is allowed, not forbidden. The task prompt states the default ("reply, do not resolve"), and an agent may resolve when the comment asks for it or the change is trivially complete. The review view must show agent-resolved comments too, so nothing is silently closed.
- "Review changes" is the product's differentiator against ChatGPT Space: every agent edit is a diffable version tied to the comments that caused it.

### Q7: What is a "space" in v1?
**The dashboard shows the swarm's shared drive.** A "space" is not fixed to one container type. Taras: "sometimes it could be a single file, or a folder, etc. Let's think on how we should org it."

**Insights:**
- The unit of collaboration is a **path scope**: one file, or a folder with everything under it. That matches ChatGPT Space's page + subpages (folder ≈ page with subpages) without a new container.
- A drive-level container (one drive per space) is too coarse for "a single file" spaces. It stays available later for permission boundaries.
- **Fact found:** `user_favorites` (migrations 105 + 116) already stars pages, workflows, and schedules per user. Its `itemType` has a CHECK constraint (`'page','workflow','schedule'`), so adding a path type needs a migration. It is the natural "pin this path as a space" store.
- Follow-up question Q8 decides how a path becomes a named space.

### Q8: How does a file or folder become a named "space"?
**Any path + pins.** No space object. Every file and folder can be opened, commented on, and sent to an agent. A folder view rolls up the open comments of every file below it, so one batch can span a folder. Sidebar "spaces" are pinned paths (`user_favorites` gets a path item type).

**Insights:**
- Closes frontier item 8. The only schema change so far is widening the `user_favorites.itemType` CHECK (a table-rebuild migration in SQLite).
- Folder roll-up needs "list unresolved comments under a path prefix". Fact to check: whether `comment-list` filters by path prefix or only by exact path. If exact only, the dashboard fans out per file (fine for small folders), or agent-fs gains a prefix filter.
- Deferred, defaulting to: a folder's `AGENTS.md` (if present) is passed to the agent as space instructions. Agents already read `AGENTS.md` by convention, so this costs one line in the task prompt. Not v1-critical.
- Permissions per space (frontier item 11) are deferred: v1 uses agent-fs drive membership (the whole swarm drive). Per-folder permissions would need agent-fs support. Defaulting to drive-level only.

### Q9: How should links to agent-fs files work, so they stay in the dashboard?
**Mirror `live/` routes.** Dashboard route `/files/~/<org>/<drive>/<path>`, the same scheme as `live/`. When a key is connected, every `live.agent-fs.dev` link opens in-app: attachments, markdown links, citations, memory links. Slack and agent prompts point to `APP_URL/files/...` when `APP_URL` is set. Without a key, the `live/` link stays.

**Insights:**
- Closes frontier item 9. Same scheme means a live URL maps to a dashboard URL by swapping the origin. Code and links copy across in both directions (matches Taras's "easy to copy stuff around").
- Server-side builders to change: `buildAgentFsLiveUrl` (`src/utils/constants.ts`), `taskAttachmentDisplayUrl` (`src/utils/task-attachment-links.ts`), Slack blocks (`src/slack/blocks.ts:208`). Client-side: `task-attachment-link.tsx`, plus a link interceptor in `markdown-view.tsx` for live URLs.
- Fix on the way: the UI (`VITE_AGENT_FS_LIVE_URL`) and server (`AGENT_FS_LIVE_URL`) env names differ, and the UI builder lacks the default org/drive fallback.
- Server-side links cannot know whether the clicker has a key. So a dashboard `/files/...` route without a key must render a "Connect agent-fs" prompt, plus an "Open in agent-fs" fallback link.

### Q10: Who can be @-mentioned in a comment, and where does the task go?
**Lead only.** Every send goes to the lead, which delegates. I recommended "any agent, lead default". Taras chose lead only.

**Insights:**
- Closes frontier item 6 (the target half). No agent picker in v1. The "@" is a marker that says "this comment is for the swarm", not a choice of agent. A single "@swarm" (or "@lead") token is enough, plus the "Send N to swarm" button.
- Comments without the marker stay human-to-human discussion and are not sent. So the marker also filters what goes into a batch.
- The lead's routing (and its prompt) must learn a new task shape: "review batch on agent-fs path X, comments [...]". That is a registered prompt template in `src/prompts/`, not string concatenation (project invariant).
- A direct agent picker stays an easy v2 add, because `send-task` already supports a target agent.

**Amendment (Taras, mid-session):** "I like the human too, and we could use the notification in the UI." So v1 also supports **@human**: mentioning a teammate notifies them through the dashboard notification bell.

**Insights on @human:**
- **Fact found:** the bell (`apps/ui/src/components/notifications/notification-panel.tsx`) is backed by the inbox model. Inbox items are *derived* from source queries (approval requests, failed tasks, sessions) and joined with per-user `inbox_item_state` rows (dismiss / snooze / done). A new source bucket fits that model with no new swarm table.
- **Fact found:** agent-fs comment notifications are a **broadcast**. Every comment creates a `comment_notification` event for every drive member except the author (`packages/core/src/ops/comment.ts:55-88`). That includes every agent, because agents are drive members. There is no targeted mention notification.
- So @human needs one of: agent-fs gains mentions (targeted notifications), a client-side filter over the broadcast, or a swarm-side notification. Decided in Q12.

### Q11: How "live" must v1 be?
**Yjs room per file.** I recommended polling plus a refresh when the task status changes. Taras chose realtime rooms.

**Insights:**
- Reuses the shipped rooms primitive (`src/realtime/rooms.ts`, Awareness for presence). Gives presence ("Taras is viewing") and instant "comments changed" pings between dashboard clients.
- **Fact found (blocker to design around):** the dashboard cannot open the realtime socket today. `/@swarm/realtime` authenticates non-page clients only through an `Authorization: Bearer` header (`src/http/auth.ts:13-18`, `src/realtime/transport.ts`). The browser `WebSocket` API cannot set headers. The page path uses a same-origin `page_session` cookie, and the dashboard is a different origin. So v1 needs a small **realtime ticket**: the dashboard POSTs with its bearer, gets a short-lived signed ticket, and passes it as a query param on upgrade (same shape as the page-session path).
- Agent writes via the agent-fs CLI do not ping the room. So the dashboard still needs a slow poll (or a ping from the swarm when the batch task changes status) underneath the room.
- Room caps: 100 rooms per namespace, 1000 active rooms (`rooms.ts:16-18`). One room per *open* file is fine. Idle eviction keeps the count low.
- Open: what the room carries beyond presence (Q13).

### Q12: How does "@teammate" reach the notification bell?
**agent-fs gains mentions.** A small cross-repo change: `comment-add` (and reply/update) accepts `mentions[]` (agent-fs user ids), and agent-fs creates a targeted `comment_mention` notification. The dashboard bell gets an "agent-fs mentions" bucket, derived like the other inbox sources, using the human's own key.

**Insights:**
- Closes the @human half of frontier item 6. One new capability in agent-fs, zero new swarm tables.
- `live/` and the CLI get mentions too. Agents can "@human" back (e.g. "@taras I need a decision on X"), which makes the loop two-way.
- The mention picker needs a people list. With the human's key, the dashboard can call agent-fs `GET /orgs/:orgId/drives/:driveId/members` and map members to swarm users by email.
- "@swarm" can stay a body marker (the lead-only route in Q10), or become a mention of the lead's agent-fs user. Defaulting to the body marker plus an explicit Send button, because the task is created by the swarm, not by agent-fs.
- Side issue to note for agent-fs: the broadcast notification on every comment reaches every agent in the drive. Mentions make it possible to later narrow the broadcast (e.g. notify file author + mentioned + thread participants only).

### Q13: When does an "@swarm" comment become visible to others?
**Post now, batch = unsent.** Every comment posts to agent-fs immediately. Co-reviewers see it at once through the room ping. The "batch" is the set of unresolved @swarm comments that are not sent yet. "Send N" creates one task, and the swarm replies "Sent in task X" on each comment. Taras adds: use localStorage or a custom KV for persistence in case of a lost connection or a browser restart.

**Insights:**
- This refines Q4 and Q5: there are no private drafts. The batch is derived state (unsent @swarm comments), so any co-reviewer can send it.
- The "sent" marker must be machine-readable, not only a human reply. Options: a reply with a fixed prefix plus the task id, or agent-fs comment metadata if it gains a field alongside mentions. Defaulting to a structured reply prefix (no agent-fs schema change beyond mentions).
- Persistence covers what is not yet in agent-fs: the comment being typed and an outbox of comments that failed to post (offline). Defaulting to localStorage, namespaced by `swarmId` + agent-fs URL + path. Swarm KV (`kv-storage`) is the upgrade when cross-device drafts matter.
- Race: two reviewers press Send on overlapping batches. The swarm create-task route should skip comments that already carry a "sent" marker (idempotency by comment id). Swarm KV is a natural place for an idempotency key per comment id.

### Q14: What does the dashboard show when agent-fs is not usable?
**Gate on config + key.** The Files nav appears only when `status.agent_fs.configured` is true. If agent-fs is configured but this user has no key: a "Connect agent-fs" card (register with the swarm email, or paste a key, then invite to the swarm drive). Local-fs swarms get no Files space. Task attachments work as today.

**Insights:**
- Closes frontier item 10. No swarm proxy routes for drive-wide reads. No local-fs comment store.
- Uses the existing, unused signals: `GET /status` → `agent_fs.configured` and `useFsCapabilities`.
- The connect card is the one place that calls the swarm for agent-fs setup (`POST /api/fs/members/invite`). Everything after that talks to agent-fs directly with the human's key.

### Q15: Which file types does the v1 viewer render?
**Markdown, code, PDF, images, video, a default fallback, and maybe simple tables.** Taras: "sql and all that fancy shit not needed for now. Maybe table-like files would be nice, but no DuckDB."

**Insights:**
- v1 viewers: markdown (Streamdown), code/text (syntax highlight), PDF, image, video (reuse the attachments previews), CSV/TSV as a plain table (parse in the browser, no DuckDB), fallback = metadata + download + "Open in agent-fs".
- Out of v1: SQL workbench, DuckDB, parquet, xlsx, sqlite, Monaco.
- Defaulting to: inline anchored comments on markdown and code/text. File-level comments on PDF, image, video, and tables. agent-fs anchors are line and text-quote based, so they fit text formats only.
- Keep the file-type routing table shaped like `live/`'s `FileViewer.tsx` (extension → viewer), so a new viewer copies over as one entry plus one component.

### Q16: Can humans edit file content in the dashboard in v1?
**Read + comment only.** Humans comment and @swarm. Agents make the edits, and every edit is a diffable version. "Open in agent-fs" covers hand edits.

**Insights:** No editor in the bundle, no etag conflict handling between human and agent writes in v1. Plain source edit is the natural v2 step.

### Q17: What do we call it?
**Comb.** Honeycomb: each file is a cell the swarm works on. Fits the swarm brand, short.

**Insights:** Closes frontier item 12. Nav label "Comb". Route stays `/files/~/<org>/<drive>/<path>` (mirrors `live/`, per Q9), so the name is UI copy, not a URL. Check that "comb" does not clash with the "hive" theme preset naming in apps (memory: app theming has a `hive` preset). Different word, so low risk.

## Synthesis

**Comb** = the swarm's agent-fs drive, browsable inside the dashboard, where humans comment on agent-written files and send those comments to the swarm, one at a time or in batches. Agents answer with new file versions and replies. Humans review the diff and resolve.

### Key Decisions
1. **Core job:** the review loop on agent output. Browsing is a means, not the goal. (Q1)
2. **Rendering:** native in the dashboard. No iframe. Start with a subset of `live/`, and mirror its shapes (client methods, component boundaries, extension → viewer table) so more of `live/` copies over later. (Q2)
3. **Identity:** the human's own agent-fs key, held in the browser (localStorage), calling agent-fs directly (CORS `*`). Chosen over my recommendation of a swarm-held key, with the XSS cost accepted. (Q3)
4. **Comment store:** agent-fs comments only. No swarm comment table. (Q5)
5. **Send model:** comments post to agent-fs immediately. The batch = unresolved "@swarm" comments not yet sent. "Send N to swarm" creates ONE task, and the swarm replies "Sent in task X" on each comment. (Q4, Q13)
6. **Target:** agent work always goes to the lead, which routes it. "@swarm" is a marker, not an agent picker. (Q10)
7. **@human:** supported. agent-fs gains `mentions[]` + targeted `comment_mention` notifications. The dashboard bell shows them as a derived inbox bucket. (Q10 amendment, Q12)
8. **Approval:** the agent writes a new version and replies. By default the human resolves after reviewing the diff. Agents may self-resolve when asked or when trivially done. Versions are the undo. (Q6)
9. **Container:** no space object. Any file or folder path is a unit. Folder views roll up comments below them. Sidebar pins via `user_favorites` (new path item type). (Q7, Q8)
10. **Links:** dashboard route `/files/~/<org>/<drive>/<path>` mirrors `live/`. Connected users open agent-fs links in-app. Slack and prompts link to `APP_URL/files/...`. (Q9)
11. **Realtime:** a Yjs room per open file for presence + change pings. agent-fs stays the source of truth. A slow poll covers agent CLI writes. (Q11)
12. **Persistence:** in-progress comment text and an offline outbox in localStorage (namespaced by `swarmId` + agent-fs URL + path). Swarm KV is the upgrade path. (Q13)
13. **Gating:** Comb appears only when `status.agent_fs.configured`. No key → "Connect agent-fs" card. Local-fs swarms get no Comb. (Q14)
14. **Viewers:** markdown, code/text, PDF, image, video, CSV/TSV plain table, fallback. No DuckDB, SQL, parquet, sqlite, Monaco. Inline anchored comments on markdown + code. File-level comments on the rest. (Q15)
15. **Human edits:** none in v1. Read + comment only. (Q16)
16. **Name:** Comb. (Q17)
- Deferred: per-space permissions. Defaulting to agent-fs drive membership (the whole swarm drive).
- Deferred: folder `AGENTS.md` as space instructions for the agent. Defaulting to "pass it in the task prompt if present", not v1-critical.
- Deferred: the connect flow detail. Defaulting to "register with swarm email, or paste an existing key (409 on existing account), then `POST /api/fs/members/invite`".
- Deferred: the "sent" marker format. Defaulting to a structured reply prefix with the task id, plus a swarm KV idempotency key per comment id.
- Deferred: a direct agent picker. v2, because `send-task` already supports a target agent.

### Open Questions
Fact-shaped, for `/desplega:research`:
- Does agent-fs `comment-list` filter by path prefix (needed for folder roll-up), or only by exact path?
- agent-fs `diff` op: output format, and whether it diffs any two versions (`fileVersionId` on a comment → current). How does `live/`'s `DiffViewer.tsx` render it?
- How portable is `live/src/hooks/use-comment-anchors.ts` (dependencies on the `live/` client, router, AuthContext)? Can it run over Streamdown output with the CSS Custom Highlight API?
- Is Streamdown in `apps/ui` today, and can its rendered DOM carry text-quote anchors?
- Rooms: what is a "namespace" for the 100-rooms cap, what is the idle eviction timing, and can a room be presence-only (no KV snapshot)?
- Realtime ticket: what is the smallest safe design to authenticate a dashboard WebSocket (signed short-lived ticket in the query, mirroring `page_session`)? Which dashboard identity does it carry (`aswt_` user token vs. shared operator key + user picker)?
- How does the dashboard's current user (`current-user-context.tsx`) map to an agent-fs user (by email)? Is the email always present?
- Byte loading for PDF/image/video from the browser: does `/raw` (forced `attachment`) work via blob + object URL, and does prod agent-fs (Tigris) allow browser CORS on signed URLs?
- `user_favorites.itemType` CHECK after migration 116: what change adds a path type?
- Which prompt template and lead routing path does a "Comb review batch" task need (`src/prompts/` registry)?
- agent-fs prod deployment (`agent-fs-taras.fly.dev`): current version, and the release path for the mentions change.

### Constraints Identified
- The `af_` key has full user power and never expires. It sits in localStorage inside an app that renders agent-written content. Required mitigations: namespace by `swarmId` + agent-fs URL, never send it to the swarm API, a "Disconnect" action that clears it, and keep agent-written HTML out of the dashboard origin (HTML shows as source only).
- agent-fs has no realtime and no mentions today. Mentions are a cross-repo change that must ship and deploy in agent-fs before @human works in production.
- Browser WebSockets cannot set an `Authorization` header. The dashboard needs a new realtime auth path.
- Agent CLI writes do not ping rooms. Polling stays underneath.
- Room caps: 100 per namespace, 1000 active.
- `inviteToOrg` fails for emails with no agent-fs user. The seed-time human invite silently fails today for anyone who never registered.
- Project rules: new routes via `route()` with RBAC + OpenAPI; new task prompt text via the `src/prompts/` registry; frontend PRs need agent-browser screenshots + a recording.
- Two env names for the live URL (`VITE_AGENT_FS_LIVE_URL` vs `AGENT_FS_LIVE_URL`) must be unified when links are rewritten.

### Core Requirements
1. **Connect:** a user can connect their agent-fs identity from the dashboard (register or paste key), get invited to the swarm drive, and disconnect.
2. **Browse:** a Comb nav entry lists the swarm drive (tree + folder view). Any file or folder can be pinned to the sidebar.
3. **View:** md, code/text, PDF, image, video, CSV/TSV, fallback. Unsupported types offer "Open in agent-fs".
4. **Comment:** add, reply, and resolve comments. Inline anchors on md and code. File-level on the rest. Comments re-anchor across versions.
5. **Mention:** "@teammate" notifies that person in the dashboard bell. "@swarm" marks a comment for the swarm.
6. **Send:** "Send N to swarm" on a file or a folder creates one lead task with every comment's id, path, version, anchor, quote, body, and author. It is idempotent per comment and marks each comment as sent.
7. **Agent loop:** the agent writes a new version, replies per comment, and resolves only when asked or trivially done.
8. **Review changes:** a diff view from the commented version to the new version, with resolve / reopen / revert.
9. **Live:** presence and instant comment updates between dashboard viewers of the same file.
10. **Links stay in-app:** agent-fs links in the dashboard, Slack, and prompts open Comb for connected users.
11. **Resilience:** in-progress comment text and unsent comments survive reloads and connection loss.

## Next Steps

- Handoff: **research** (Taras, 2026-09-29). Done: `thoughts/taras/research/2026-09-29-comb-agent-fs-review-space.md` answers all 11 Open Questions.
- Corrections from research that affect decisions above:
  - Q12 insight is wrong about the people list: agent-fs member listings are **admin-only**, so an editor's key cannot list drive members. The mention picker needs another source (swarm users list, or a new agent-fs endpoint).
  - Q11: one Yjs room per file does not scale as designed. Every room persists a KV row with no expiry, and the 100-room cap per namespace counts those rows. Channels (ephemeral pub/sub) fit presence + pings without persistence.
  - Q8: folder roll-up cannot use `comment-list` by prefix (exact path only).
  - The notification bell renders static code-defined notifications today. A source-driven bucket is new UI work.

## Amendments (2026-09-30, after research)

Taras: agent-fs changes are fine, they are just steps in the v-plan. Both projects run against `main`, so the feature ships gated.

- **Live updates (replaces Q11 / Key Decision 11):** an **agent-fs change stream**. agent-fs sends write + comment events on a streamed endpoint with Bearer auth (fetch-based SSE, because `EventSource` cannot set headers). The dashboard subscribes with the user's key. Agent CLI edits and replies show up live. **No swarm realtime work, no Yjs rooms, no socket ticket.** Presence is deferred. Fact: agent-fs emits no events for file writes today (only `comment_created`, `comment_deleted`, `comment_notification`), so writes need a new publish point.
- **People list for @ (amends Q12):** a new agent-fs op lets any drive member list the drive's members as `{userId, displayName, email}`. The picker hides agent accounts (`@swarm.local`). Mention targets are agent-fs user ids, and the bell reads notifications with the user's own key, so no swarm-user ↔ agent-fs-user mapping is needed.
- **Folder roll-up (amends Q8):** add a path-prefix filter to agent-fs `comment-list`.
- **agent-fs work list for the v-plan:** `mentions[]` + targeted `comment_mention` notifications, drive-members op for members, `comment-list` prefix filter, change stream, and new entries in `/health` `features` so the dashboard can detect support.
- **Gating (default, not asked):** a swarm config flag (off by default, Settings → Configuration) plus a beta nav item. The dashboard also checks agent-fs `/health` `features` and hides the parts an older agent-fs lacks.
- **Markdown anchoring (fact from research):** the Comb viewer renders Streamdown with `mode="static"`, `parseIncompleteMarkdown={false}`, and a line-stamping rehype plugin placed before `defaultRehypePlugins`. `MarkdownView` elsewhere stays unchanged.
