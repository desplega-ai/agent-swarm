# Sessions v2 mockups: shared spec

## Round 10 changes (2026-10-21). Message anatomy, copy, long titles. These override earlier rounds where they conflict.

### 10.1 Person messages (bubbles)

- Remove the name above **my own** bubbles. Other people's bubbles keep their name, because a multi-person session needs it.
- The avatar sits beside the bubble (right of my bubbles, left of other people's), centered on the bubble's first line. It no longer sits on a header line above the bubble.
- The meta row moves **below** the bubble, aligned to the bubble's outer edge. Mine: "30m ago". Others: "Lena · 30m ago". The via note ("Posted to the Slack thread by the swarm bot", "via Telegram") joins the same row after a " · ".
- A **Copy** icon sits at the end of that row. On desktop it fades in when you hover the message (150 ms). On touch screens it is always visible at 70 % opacity. This mirrors `OutcomeCopyShell` in `apps/ui/src/components/sessions/task-outcome.tsx` (`opacity-70 md:opacity-0 md:group-hover:opacity-70`).

### 10.2 Swarm replies (agent output)

- Remove the hexagon mark. The reply text comes first.
- Below the text, a footer row: the time ("29m ago") and a **Copy** icon. On swarm replies the Copy icon is always visible, muted (60 % opacity, full on hover). The worker line follows below the footer, as before.
- Expanded worker step outputs get the hover Copy icon from 10.1. Internal lines and approval cards get no Copy icon.
- Copy behavior everywhere: copy the plain text, swap the icon from lucide `Copy` to `Check` for 1.5 s, accessible name "Copy message", then "Copied". Use `CopyValueButton` or `useCopyToClipboard` in apps/ui.

### 10.3 Long titles always truncate

- A title is at most 120 characters (the rename limit). Every place that shows a title keeps it on one line with an ellipsis, and the full title shows in a tooltip (desktop) or in the rename field (phone).
- Places: sidebar rows, tabs, the header title (row 2), the split pane header, the "All tabs" menu, the group tab rows, Cmd+K rows, the move picker, toasts, the phone list row, and the phone detail top bar.
- A long title never pushes the header meta line, the tab close button, or the row time out of view. A long unbroken word (a URL or a branch name) truncates the same way.
- The demo data includes one session with a 120-character title that contains a long unbroken token.

### 10.4 Typing bubble and the Latest pill

- "Lena is typing" is a bubble row in the timeline flow: her avatar, then a small bubble (same look as other people's bubbles) with three pulsing dots. The text goes to an `aria-live` label. The row takes its own space, so it never overlaps a message. It fades in and out (150/100 ms, `ease-snappy`).
- The "Latest" pill sits 8 to 12 px above the composer's top edge, centered on the timeline column. It never covers the composer or the typing bubble, also when the composer grows and on phones with the safe-area inset.

## Round 9 changes (2026-10-21). UX/UI polish. Full findings and fixes: [`UX-REVIEW-R9.md`](./UX-REVIEW-R9.md).

- **Icons.** Every lifecycle state uses the shipped `TaskStatusIcon` and `StatusBadge`. Rows, counts and tabs show a still ring. Only live lines (the worker line, the status-bar count) turn. Workers use `AgentAvatar`.
- **One meaning per glyph.** Done is lucide `Archive`. Later is `AlarmClock`. No group is `SquareDashed`. Split is `Columns2`. The swarm mark is a plain `Hexagon`. Needs you is `Hourglass`. `Clock` stays only for a deferred handoff and "In 1 hour".
- **Pressed triage state.** When a session is in Done or Later, its button shows `Inbox` with `aria-pressed`, plus muted text ("In Done", "Back Thu 09:00").
- **Motion tokens.** Menus and popovers 150/100 ms and dialogs 200/150 ms on `ease-snappy`. Sheets 400/250 ms and the phone push 300/250 ms on `ease-swift`. Every close path runs the exit. Reduced motion keeps the fades.
- **Tab strip.** It keeps its scroll, reveals the active tab, fades at the edges, and has an "All tabs" menu.
- **Timeline.** It follows new lines when the reader is within 100 px of the bottom. It holds still when a step expands. Phones get a "Latest" pill.

## Round 8 changes (2026-10-21). Apply after round 7. These override earlier rounds where they conflict.

### 8.1 A shorter session header (two rows, not three)

- **Row 1.** Left: the crumb (as now). For a nested Slack thread, the "N sessions in this thread" link moves here, after the crumb. For a session shared with me, "Shared by Lena · can view" moves here too, muted. Right, in this order: the presence avatars (people viewing now, as in round 7), the **People pill**, the triage icons (Mark read, Done, Later, Move), and a **Share icon** at the far right.
  - The People pill is a rounded pill with the users icon and the count only ("👥 2"). No "People" word. Tooltip: "People in this session". It opens the People popover (as in round 7).
  - The Share icon is an icon button with no text. Tooltip: "Share". Only the owner sees it. It opens the Share dialog. The People popover keeps its "Share…" row.
- **Row 2.** Left: the title (truncates with an ellipsis). Right, where the Share button was: the meta line: status chip, the Later chip (when snoozed), the worker avatars, tasks, cost, "started …", and the Handoffs toggle at the end.
- Remove the third row (the old meta row). Remove the "From Slack" chip from the header: the crumb icon already shows the source.
- When the pane is narrow (a split, or a window under 1360 px), the meta line drops items in this order: "started …", then cost, then the worker avatars. The status chip and the Handoffs toggle always stay. Use a container query on the pane, not the window width.

### 8.2 Rename a session (mirror the shipped feature)

The shipped page already has this (`apps/ui/src/pages/sessions/[rootTaskId]/page.tsx`, `PATCH /api/tasks/{id}/title`, `agent_tasks.title`, max 120 characters). Mirror it:
- A pencil icon shows next to the title on hover or focus. Click the pencil, or double-click the title, to edit the title inline. Enter or blur saves. Escape cancels. An empty title clears the override and the session falls back to its first message (show that text as the input placeholder). Toast: "Renamed".
- The new title shows at once in the tab, the sidebar row, the group tab, and search.
- Who can rename: the owner, and people with Can edit. No pencil on Can view sessions, or on Slack and Telegram sessions that another person started.
- Also add "Rename session" to the Cmd+K palette (for the focused session).

### 8.3 Worker steps fold into one line

- Under a swarm reply, the worker steps (the block with the vertical line) are **collapsed by default** to one line: a small stack of the worker avatars, then "2 workers worked for 26m", then a chevron. Click the line to open or close the steps (the round 7 block). Remember the state per turn.
- One worker: use its name ("Writer worked for 12m"). Two or more: "N workers" where N counts distinct agents (retries of the same agent count once).
- The time is wall clock: from the start of the first step to the end of the last step (the same end rule as the round 7 "done in" text).
- States of the collapsed line:
  - All done: check icon, "2 workers worked for 26m". Add a muted "· 2 retries" when tries failed before they passed.
  - Any step running (and the session runs): spinner and shimmer, "Coder is working · 3m" or "2 workers working · 3m".
  - The last try of a step failed: the red mark, "2 workers worked for 1h 4m · 1 failed".
- **Handoffs On** opens every step block in the session (so the internal rows show). Turning Handoffs Off restores the per-turn state.

### 8.4 One consistent shape for every example

Every demo session (in `demo-data.js` and `demo-data-big.js`) follows the same turn shape, the same as prod:
1. A person writes (dashboard, Slack, or Telegram).
2. The swarm replies (a `lead` item). The reply says what it does next ("Sending it to the Coder", or a direct answer).
3. Zero or more worker steps (`work` items) that this reply started, with one internal `follow-up` after each worker finishes (and `deferred` / `resume` items when the lead waits).
4. The swarm posts the result (a second `lead` item) before the next person writes. Exceptions: the last turn of a running session, and a session that waits on an approval.

Rules:
- Every person message gets a swarm reply. No person-to-person chat without a reply. A Slack message from before the swarm was mentioned folds into the first mention.
- Worker steps only appear under a swarm reply. A session never starts with a worker.
- Every session has a full timeline. Remove the synthesized one-row timeline. A 1-task session is a person message plus a direct swarm answer.
- The header numbers match the timeline: `tasks` = the number of `lead`, `work` (each try), and `internal` items; `agents` = the lead plus the workers that appear; `created` = the first item; `last` = the last item; `status` comes from the latest swarm reply or step.
- Live simulation follows the same shape: sending a message adds the swarm reply (working), then after about 2 s the reply text and a running worker, then after about 6 s the worker finishes, a follow-up (hidden), and the swarm's result. The background session that finishes (`finishesInSeconds`) also ends with a swarm result.
- Names stay invented (only the people in the demo data). Keep every id, key, title, source, owner, and share as it is.

### 8.5 Mobile (phones, under 768 px; `useIsMobile` in apps/ui uses 768)

Today the shipped sessions page on a phone shows a "Switch session" select above one session (`sessions-shell.tsx`). Replace that with two screens and push navigation, as in Slack or Mail:

- **List screen (home)** is the sidebar at full width. Top bar: "Sessions" (large), then the source filter icon and the New session icon on the right, and an overflow "⋯" with Legacy sessions, Theme, and the Mock menu. Below it: the search field. Then the same sections and rules as the desktop sidebar (Inbox, Later, Done, No group, My groups, Shared with me, sources). Rows are taller (at least 52 px) with two lines: the title, then a muted line with the group, the time, and the people or status. Counts are always visible (no hover).
- **Detail screen** opens when you tap a row. It slides in from the right (300 ms enter, 250 ms exit, `ease-swift`; a fade only with reduced motion). The browser back gesture and the back chevron return to the list (push `?open=` to history). Top bar: back chevron, the title (one line; tap it to rename when allowed), the People pill, and "⋯". Below it, one meta line: status chip, tasks, cost. Then the timeline (person bubbles at most 85 % wide, the collapsed worker lines from 8.3), and the composer pinned to the bottom with `env(safe-area-inset-bottom)`. The Slack or Telegram target note shrinks to one line.
- **"⋯" opens an action sheet**: Mark read or unread, Done, Later…, Move to group…, Rename, Share… (owner), Handoffs On or Off.
- **Sheets, not popovers.** Snooze picker, Share dialog, People, Move to group, the Start-in picker, the source filter, and the action sheet all open as bottom sheets: rounded top, a grab handle, at most 85 % of the height, close on backdrop tap or swipe down.
- **Touch instead of hover.** Swipe a row left for Done, right for Later (opens the snooze sheet), with the action color behind the row and an 80 px threshold. Long-press a row to start selection: checkboxes on every row and a bottom bar (Done, Later, Read, Move, Cancel). Long-press a group for "New session here". No tooltips, no keyboard hints.
- **"View all N"** pushes a group screen (the group tab content, full width) with its own back chevron.
- **New session** (top bar icon) pushes a full-screen New session view: the Start-in row (tap for the picker sheet, defaults to the group you came from), a large text box, and Send. Send pushes the new session's detail screen.
- **Search**: tap the field to enter search mode (a Cancel button replaces the top bar actions). Results as rows. Under the field, tappable token chips: `with:`, `in:`, `is:unread`, `is:running`.
- **No tabs, no split, no status bar, no app header** on phones. The first-run guide becomes a bottom sheet with 3 or 4 short cards.
- **Presence**: the People pill gets a small green dot when someone else views the session. "Lena is typing…" stays above the composer.
- **Preview page**: add `option-ab-merged/mobile.html`. It shows three phone frames (390 x 844, rounded) side by side, each an interactive iframe of `index.html`: the list screen, `?open=sB1`, and `?sources=dm,channels&open=sB2`. A light and dark switch at the top applies to all three. A short note at the top: "Tap to navigate. Swipe rows left or right. Long-press to select."
- Desktop (768 px and up) stays as it is.

## Round 7 changes (2026-10-21). Apply after round 6. These override earlier rounds where they conflict.

- **No "Lead" label.** People always talk to the lead, so the lead's replies render as the swarm's voice: no agent name, no "LD" avatar, no lead chip in headers, rows, or the People popover. Worker tasks keep their agent name, shown as delegated steps under the lead turn that started them ("Researcher · research · done in 4m"). A worker that failed and was retried shows one line ("Coder · implementation · failed 2 times, then done"), expandable. Internal tasks (`follow-up`, `deferred`, `resume`, `superseded`) are hidden by default behind the existing "Handoffs" toggle.
- **Large multi-person sessions.** Load `../demo-data-big.js` after `../demo-data.js`. It adds "Q4 pricing page rewrite" (dashboard, shared with Lena at Can edit, Taras and Lena take turns, 28 tasks, failures and retries, a deferred wake-up) and "Release checklist for v2.5" (Slack #eng thread, Marco and Taras, 40 tasks; listed only when channels are on). It uses the new timeline kinds documented at the top of that file (`human` with `via`, `lead`, `work`, `internal`). Each human message shows its author avatar and name; messages from other people sit on the left, mine on the right. Shapes follow `PROD-SHAPES.md`.
- **Keep session sharing and presence (shipped in #2249).** It must look and behave like the real feature in `apps/ui/src/components/sessions/share-session-dialog.tsx`, `session-presence.tsx`, and `[rootTaskId]/page.tsx`:
  - A **Share** button in the session header, shown only to the owner. It opens the share dialog: "Add people…" (a person picker; a new person lands at Can view), a list of people each with a Can view / Can edit / Remove select, and **General access**: Private / Everyone can view / Everyone can edit. Every change saves at once (toast "Saved"), as in the real dialog.
  - **Presence:** the header shows the avatars of people viewing now ("Viewing" or "Typing…" in the tooltip), and "Lena is typing…" above the composer while she types (simulate it once, a few seconds after opening a shared session).
  - **View-only share:** opening a session shared with me at Can view (Lena's "Pricing page teardown") replaces the composer with the read-only notice "You can view this session. Ask the owner for edit access." No Share button for non-owners.
  - The **People** popover joins the two: people involved, with their share level (Owner, Can edit, Can view, Everyone) and a live dot, plus a "Share…" row that opens the dialog (owner only).
  - Rows shared by me show a small "shared" icon (tooltip lists who). Shared with me stays its own sidebar section.

## Round 6 changes (2026-10-21). Apply after round 5. These override earlier rounds where they conflict.

- **Big groups.** An open group (and Inbox, Later, Done, No group) shows its 10 newest sessions, then a "Show 10 more" row once, then a "View all N" row. "View all" opens a **group tab** in the focused pane: the full list for that group, newest first, with a search box scoped to the group, status filter pills (All, Unread, Running, Needs you), and paging ("Load 50 more", as the API would page). Rows in the group tab are the same one-line rows as the sidebar, with the same hover checkbox and bulk bar. Opening a session from the group tab opens a session tab.
- **Scale demo.** `?scale=100` generates 100 extra sessions in `northwind › pricing` (invented titles, spread over the last 60 days, a few unread, one running), so the user can see the 10 + more + View all behaviour. Generate them in the page script, not in demo-data.js.
- **First-run variant.** `?firstrun=1` shows what an existing user sees on the first visit after the new version ships: every old session has the default key, so My groups is empty and every session sits in No group (use the demo sessions, re-keyed to no group, plus `?scale` if also given). The guide opens. My groups shows a centered empty state: "Group your sessions", a "New group" button, and the hint "Select sessions and press m to move them into a group." No group shows its 10 newest like any group. No automatic grouping.
- **Easy search in the sidebar.** An always-visible search field at the top of the sidebar ("Search sessions", key `/` when no input has focus). Typing filters the sidebar in place: matching sessions appear as one flat list (newest first, with the group as a muted label and the match highlighted), then matching groups. It searches titles, the first message, people, and group names across ALL sessions, not only the loaded rows (as the server would). Tokens: `with:lena`, `in:pricing`, `is:unread`, `is:running`, `is:later`. Escape or the clear button restores the tree. Cmd+K stays for actions and quick jumps.
- **A visible variant switcher.** A small "Mock" menu in the status bar (right side) links to the variants so the user can click between them: Default, First run (`?firstrun=1`), Big group (`?scale=100`), Sources off (`?sources=off`), Sources with channels (`?sources=dm,channels`), Legacy (`?legacy=1`), Guide (`?guide=1`). Mark it clearly as mockup chrome (muted, "Mock" label).

## Round 5 changes (2026-10-21). Apply after round 4. These override earlier rounds where they conflict.

- **No `~/`.** Personal groups (`personal/<me>/…`) show by name at the top level, like any other group. Only if a personal group and a shared group have the same name, the personal one gets a small lock icon with the tooltip "Only you".
- **Every group keeps its `#`.** A group with subgroups shows `#` plus a dropdown chevron to open or close its subgroups. The chevron is the only fold control.
- **Plain headers.** Any list or section header (Inbox, Later, Done, a group, a source) shows only its title with the number of sessions on the right. No subtitle line ("15 sessions · 1 needs you · 5 unread"), and no edit, collapse, or other icons in the header. Group actions stay in the row menu and the hover "+".
- **No "Next" bar.** Remove the "NEXT …" unread bar. Keep "Next unread" only as the `n` key and a Cmd+K action.
- **Centered empty states.** Every empty state (an empty group, empty Later, empty Done, the new-session tab, no search results) centers its icon and text in its container, horizontally and vertically.
- **Inbox, Later, and Done are flat.** No nested or expandable rows inside them: every session is its own row at one level, newest first. A row shows its group as a small muted label (for example `pricing` or `Slack DM`) instead of nesting. Nesting stays only under groups.
- **Checkbox in the left slot, on hover.** Rows reserve no checkbox column. The fixed left slot shows the unread dot; on hover or keyboard focus it turns into a checkbox (the title stays bold if unread, so read state is not lost). Once one row is selected, every row shows its checkbox (selection mode) and the bulk action bar appears (Done, Later, Mark read, Move, Clear). `x` still toggles selection; Escape clears it.
- **External sources are off by default, and DMs come first.** Show the state an operator gets with `SESSIONS_EXTERNAL_SOURCES=dm`: the Slack section lists only 1:1 DMs with the bot ("DM · Lena" becomes a DM between me and the bot, so rename it "DM with the swarm"), and Telegram shows its 1:1 chat. Channel threads such as "#eng" are not listed. The source filter menu shows a disabled row "Channels: off (an operator can enable them)" with a tooltip naming the setting. Add a `?sources=off` deep link that shows the default (no source sections at all, and a one-line hint in the filter menu: "External sources are off. An operator can enable them in Settings > Configuration.").

## Round 4 changes (2026-10-21). These override rounds 1 to 3 where they conflict.

Edit `option-ab-merged/index.html` in place. Round 3 is kept as `option-ab-merged/round-3.html`.

- **No middle column.** Remove the session list column and its collapse control. Sessions live in the sidebar: Inbox, Later, Done, No group, each group and subgroup, and each source expand in place to show their sessions. Session rows are one line: triage glyph, source logo when external, title, people avatars (max 3, then +N), relative time. A hover card shows the preview line (latest agent output). Clicking a row opens it in the focused pane's tab (middle-click or "Open in new tab" opens a new tab). `j`/`k`/Enter/`x`/`e`/`l`/`m`/`c` work when the sidebar has focus. Tabs get the full remaining width. Sidebar width about 320 px, resizable.
- **Sidebar order:** Inbox, Later, Done, then **No group**, then My groups, Shared with me, then the source sections.
- **Flat sort, no day headers.** Every list is newest activity first, like Legacy.
- **Hide sources:** a small filter icon in the sidebar header opens a menu with a checkbox per source (Slack, Telegram). Sources are shown (collapsed) by default. Hidden sources also leave Inbox, Later, and Done.
- **Tooltips:** every icon-only button (Done, Later, Mark read, Move, Split, New session, filter, close tab, and so on) has a tooltip with its name and key.
- **Later = snooze.** "Later" opens a small menu: In 1 hour, This evening (18:00), Tomorrow (09:00), Next week (Monday 09:00), Pick a date and time, and "In 10 seconds (demo)". A snoozed session sits in Later with its wake time. When the time comes, the session goes back to Inbox as unread and the page shows a browser notification (Notification API; ask for permission on first use) plus an in-app toast as a fallback. Copy in the menu: "We notify you in this browser while the dashboard is open."
- **First-visit guide:** on first load, a modal walks through the parts in 4 to 5 short steps (sidebar and groups, sources and the filter, tabs and split, Done and Later with notifications, keys and Cmd+K, Legacy Sessions). Next, Back, Skip. "Don't show again" is stored in localStorage. The Keys button in the status bar (or `?`) reopens it. Deep link `?guide=1` forces it.
- **Who is involved:** see Round 3 ("Who is involved"). Rows in the sidebar carry the avatar stack.
- **Read vs unread must be obvious.** One convention everywhere (rows, tabs, counts): an unread session has a bold title in the full foreground color and a solid dot in a fixed slot at the left edge; a read session has a regular-weight, muted title and no dot. Activity state is a separate fixed slot and never doubles as the read marker: running = spinner, needs you = amber "Needs you" pill, failed = red mark. Group counts use the same words: "3 unread" style badges, with a tooltip that spells them out ("1 needs you · 1 running · 3 unread"). A row turns read when opened; "Mark unread" turns it back.
- **Counts stay visible on hover.** The "+" (new session) button on a group row appears next to the counts, never in their place. The counts must not move or hide on hover or focus.

## Round 3 changes (2026-10-21). These override rounds 1 and 2 where they conflict.

Edit `option-ab-merged/index.html` in place. Round 2 is kept as `option-ab-merged/round-2.html`.

- **A new session opens as a new tab.** Remove the "New session in …" composer from the top of the list. "New session" opens a tab named "New session" in the focused pane, with an empty-state composer in the middle of the pane.
- **The composer chooses where to start.** The new-session composer has a "Start in" picker: my groups and subgroups (shown as `northwind › pricing`), `~/` personal groups, and No group. Source groups (Slack, Telegram) are not in the list. The picker defaults to the group the user started from, else the group selected in the sidebar, else No group. Sending turns the tab into the running session (title from the first message), and the session appears at the top of that group in the list.
- **A "+" on each group in the sidebar.** Every user group row (and subgroup row) shows a "+" (new session) button on hover and on keyboard focus. It opens a new-session tab with that group preselected. Source groups and Shared with me get no "+".
- **Other entry points:** a "+" at the end of each pane's tab strip, the Cmd+K action "New session" and "New session in <group>", and the list key `c`. No Cmd+T.
- **Fixes:** indent `DM · Lena` under SLACK like `#eng`.
- **Sort (added after round 3 started):** drop the Today / Yesterday / Earlier blocks everywhere. Every list is one flat list, newest activity on top, exactly like Legacy. Each row keeps its relative time.
- **Who is involved (added after round 3 started):** list rows show a stack of up to 3 avatars for the people involved, then "+N"; agents keep their mono chips. People involved = the requester, Slack message authors in the timeline, people the session is shared with, and people viewing it now. The session header gets a "People" button that opens a popover: each person with their source (Slack, dashboard, shared view or shared edit), their last message time, and a "viewing now" dot; then each agent with its task count. Cmd+K accepts "with: <name>" to filter sessions by person.

## Round 2 changes (2026-10-21). These override round 1 where they conflict.

Taras reviewed round 1 (A, B, C). Round 2 is ONE merged mockup: `option-ab-merged/index.html`.

- **Layout:** A's sidebar and A's session list, plus B's session tabs. Keep A's left sidebar (Inbox, Later, Done; my groups; Shared with me; No group; source sections) and A's middle list (two-line rows with preview and time, Today / Yesterday / Earlier, the Next-unread bar, key hints). Replace A's detail tab strip with B's editor-style tabs: per-pane tab strips, an unread or running mark per tab, a close button, and drag a tab to the right edge to split. Add B's bottom status bar (running, needs you, unread counts as quick filters; tab and pane count). When a split is open, the middle list collapses to give both panes room. A button or the list key brings the list back.
- **No forks.** Remove "Fork from here", fork cards, fork counts, fork branches, and the word "fork" everywhere.
- **No source chips.** The sidebar always shows every section. External source sections (Slack, Telegram) show by default but start collapsed. Rows keep the source logo, and Slack messages in a timeline stay greyed with a "from Slack" label.
- **Slack threads with 2 or more root sessions** (in the demo data, "Why is CI red on main?") show as a nested group under the channel group, with its sessions inside. A thread with one root is a plain row.
- **Dashboard sessions** sit directly at their group key. There is no conversation layer.
- **Keep from C:** the "New session in #group" composer at the top of the list for user groups, and a read-only note for source groups.
- **Keep:** Legacy Sessions, Cmd+K palette (minus fork actions), list keys, select and move, group management, theme and deep links (`?chips=` is gone; add `?expand=slack` to expand a source section).
- Demo data now uses invented names only (northwind, Lena, Marco).

Static HTML mockups of the **power-user sessions view** for the dashboard (`apps/ui/`). Three directions, one per folder (`option-a-*`, `option-b-*`, `option-c-*`). No build, no server. Plain `index.html` plus inline `<script>`. Share `../../session-logs/demo-shared.css` for tokens (`--background`, `--card`, `--surface`, `--muted`, `--border`, `--primary`, `--success`, `--error`, `--info`, `--active`, `--font-sans`, `--font-mono`, `--radius`, `--shadow`; dark theme via `html.dark`). Load the demo data from `../demo-data.js` (`window.SV2`). Fonts: Space Grotesk and Space Mono, same `<link>` as `../../index.html`.

Brainstorm (source of every decision below): `thoughts/taras/brainstorms/2026-10-20-sessions-ui-power-users.md`.
Design system: `apps/ui/DESIGN.md` and `apps/ui/PRODUCT.md` ("Mission Control": zinc field, one amber accent for interactive or alive, flat border-defined depth, 36 px controls, 6 to 8 px radii, no gradients, shimmer only when something is running). Read both before drawing. Today's view for reference: `apps/ui/src/components/sessions/sessions-shell.tsx` and `session-conversation.tsx`.

## The model (same in every option)

```
group (key path)            e.g. northwind › pricing           or source group: Slack › #eng (read-only)
└─ conversation             one row; expands when it has 2+ sessions
   └─ session (fork)        a root task with its own agent context
```

- A **group** comes from the slashes of the root task key. `shared/` keys show without the prefix. `personal/<me>/x` shows as `~/x`.
- A **source group** (`shared/slack/…`, `shared/telegram/…`) is read-only: no rename, no delete. Sessions can be moved out of it.
- A **conversation** with 2 or more sessions shows a fork count and expands to its forks. With one session it is a plain row.
- **Shared with me:** a shared session with a `shared/…` key sits in that group with the owner's avatar. A `personal/<owner>/…` one sits under "Shared with me › <owner>".
- **No group** holds sessions with no group key.

## Content and states to show

Use `../demo-data.js`. Do not invent other data, so the three options are comparable.

- **Triage glyphs** on every conversation and session row: `needs` (amber, an approval or question waits on me), `unread` (grey dot), `running` (live arc or pulse), none. A folded group shows its subtree totals. An open group shows its own counts only.
- **Source marks:** every row from Slack or Telegram carries the source logo (simple inline SVG) or a label. External rows must be clearly different from dashboard rows.
- **Source filter chips:** Dashboard, Shared, Slack, Telegram. Dashboard and Shared on, Slack and Telegram off by default. Turning Slack on shows the Slack source groups in the tree.
- **Time split** inside a group: Today, Yesterday, Earlier.
- **Session timeline** (the detail): agent tasks and outputs as today. For Slack sessions, the human Slack messages interleave by time, rendered **muted (greyed)** with the Slack mark, the author, and a clear "from Slack" label. A reply sent from the dashboard on a Slack session shows "Posted to the Slack thread by the swarm bot · sent from the dashboard by Taras".
- **Fork from here:** hovering any message or task output shows "Fork from here". Clicking it adds a new session under the same conversation (the conversation now shows a fork count), opens it, and starts its timeline with a summary card: "Forked from <session title> at <message>. Summary: …".

## Required interactions (JS, no framework)

1. **Tree:** fold and unfold groups and conversations. Folded groups show roll-up counts.
2. **Triage:** opening a session marks it read. Row menu or keys: mark read or unread, Done, Later.
3. **Select and move:** `x` or a checkbox selects rows. A bulk bar shows Move, Done, Read. Move opens a group picker (fake). Drag a row onto a group to move it.
4. **Group management:** `+` creates a group (inline name). Rename inline. Delete with a confirm (its sessions go to No group). Source groups show no rename or delete.
5. **New session in a group:** a composer "New session in #pricing" at group level. Sending adds a running conversation at the top of that group.
6. **Keyboard:** list keys only when the list has focus and no input has focus: `j`/`k` move, Enter opens, `x` selects, `e` Done, `m` Move. **No browser-owned combos** (no Cmd+W, Cmd+T, Cmd+1..9, Cmd+Shift+[ ]).
7. **Cmd+K palette:** fuzzy search over all sessions and groups, plus actions: New session in group, Move, Fork, Open in split, Mark read, Open Legacy Sessions.
8. **Tabs:** opening a session opens it in the current tab. Middle-click or "Open in new tab" opens a new tab. Each tab has a close button and the triage glyph. Simulate a background session that finishes about 8 s after load: its tab and row light up as unread.
9. **One split view:** "Open in split" (row menu, palette, or dragging a tab to the right edge) shows two sessions side by side. Only one split. Closing a pane returns to one.
10. **Legacy Sessions:** a header link "Legacy Sessions" switches to a frozen replica of today's view (flat 300 px list of dashboard sessions, newest first, status dot, title, "relative time · N tasks", and the plain timeline). A link there returns to the new view.
11. **Theme and deep links:** light and dark toggle. `?theme=dark`, `?open=<sessionId>`, `?split=<sessionId>`, `?legacy=1`, `?chips=slack` so a screenshot can land on any state.

## Copy rules

- Short sentences. Verb-first buttons ("Fork from here", "Move to group", "Reply in Slack thread").
- No marketing words. No em dashes.

## Deliverables per option

- `option-<x>-<slug>/index.html`, self-contained apart from the shared CSS, `../demo-data.js`, and fonts.
- An HTML comment at the top: the direction in two sentences, and what it trades off.
- Renders at 1440×900 and 1280×800 with no horizontal scroll. Below 1024 px wide, a compact single-column fallback is enough.
