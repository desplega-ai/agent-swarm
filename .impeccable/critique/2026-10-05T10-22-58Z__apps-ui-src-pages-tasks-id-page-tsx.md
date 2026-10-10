---
target: task details page (desktop + mobile)
total_score: 20
p0_count: 1
p1_count: 4
timestamp: 2026-10-05T10-22-58Z
slug: apps-ui-src-pages-tasks-id-page-tsx
---
Method: dual-agent (A: Opus design review · B: Sonnet detector and measurements)
Target: task detail page, apps/ui/src/pages/tasks/[id]/page.tsx, desktop and mobile. Local seeded API with real Claude session logs grafted to mirror prod task cbd8616d.

## Design Health Score (Nielsen): 20/40 (Acceptable)

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of system status | 3 | Badge and live footer are clear. Pre-start tasks say "No session logs were recorded" (past tense). |
| 2 | Match system / real world | 1 | Raw Slack syntax in the title, literal `<thread_context>`, "STOCK 2.1.289 (CLAUDE CODE) · SDK", "INPUT-CACHE-OUTPUT", raw `in_progress → completed`. |
| 3 | User control and freedom | 2 | Finished tasks have zero actions. "Back to Tasks" drops list filters. |
| 4 | Consistency and standards | 2 | In progress is blue in the badge, amber elsewhere. Cost shows as `$1.2141` and `US$1.2141`. |
| 5 | Error prevention | 3 | Cancel confirms. Interrupt disabled with a reason. |
| 6 | Recognition over recall | 2 | `+6` chip popover is unlabeled (SLACK twice, bare P50). Activity hides behind a 24px chevron. |
| 7 | Flexibility and efficiency | 2 | Filter, minimap, URL state exist. No shortcuts, no copy output, no retry. |
| 8 | Aesthetic and minimalist | 2 | Title shows 3 times, final answer 3 times, 18 equal-weight rail rows. |
| 9 | Error recovery | 1 | Desktop Failure Reason is collapsed, 3.97:1 contrast, no Retry, auto modal says "Join Discord". |
| 10 | Help and documentation | 2 | Good tooltips. Nothing explains OFFERED, context usage, HARNESS. |

## Technical Audit Score: 12/20 (Acceptable)
Accessibility 2, Performance 2, Responsive 2, Theming 3, Anti-patterns 3.

## Anti-patterns verdict
Visual slop: pass. Product slop: fail (raw Slack syntax title, prompt repeated, 12 font sizes with 64% of text under 12px, 4 success signals for one outcome, sparkles on skill rows).
Detector CLI: 0 findings on 11 files (no rule for arbitrary `text-[Npx]`; the code has 74). Overlay at 1440: 61 hits. Real: 24 line-length, 18 tiny-text, 7 nested-cards, 1 skipped heading. False positive or out of scope: clipped-overflow, gradient-text (sanctioned shimmer), cmdk text-overflow, sidebar layout-transition.

## Priority issues
1. [P0] Log starves on common desktop sizes. Hero and Output are shrink-0, log gets the remainder: 301px at 1440x900, 178px at 1280x800, 51px with Activity open, 19px at 1024x768, 37px after "Show more". Tablet gets 496px. Fix: one scroll surface for the center column with a log min height, 3-column layout on content width (xl or container query), Activity auto-collapsed below xl.
2. [P1] Hero shows raw Slack syntax and repeats the prompt. lib/task-title.ts does not format mentions. collapsible-description.tsx:37 renders text.split("\n")[0], page.tsx:1204 dedupes only exact matches. Fix: mention formatter for breadcrumb/h1/list, skip title line and bare tags in the description.
3. [P1] Finished tasks have no next action (page.tsx:1210-1266, composer gated at 688-691). Fix: Follow up (primary), Retry for failed/cancelled, Copy output, Spawned tasks relationship, link task ids in output.
4. [P1] Failed state: reason collapsed on desktop (page.tsx:1346, mobile is defaultOpen at 956), 3.97:1 body text, "Need help?" modal reopens on every visit whenever lead credentials are fine (dismissal is component state, task-failure-help-dialog.tsx:31-35), primary action is Join Discord. Fix: open AlertCallout tone=error, Retry primary, inline Get help link.
5. [P1] Mobile: hero pins the tabs at y=410 of 844 (48.6%), log window 256px, composer only in tab 3 while a running task opens on Details, 84 of 86 Logs-tab targets under 44px, page uses no hit-area. Fix: hero scrolls away with sticky tabs, compact hero (title + status), bottom composer bar on every tab, 44px targets.

## Also worth fixing (P2)
- Type scale: 74 arbitrary text-[Npx] sizes, 64% of text under 12px, timestamps 2.32:1 (light), RAW 3.28:1, muted token has 0.33 headroom, proportional numbers next to mono numbers.
- Meta rail: 18 equal-weight rows, "Requested..." truncated, left rail scrolls at 1280 (Turns, Model cut), cost and duration duplicated in two formats.
- Log narration: 16 of 48 rows are "Thought for", final answer appears 3 times (Output, last message, ~720px RESULT card), lone "Logs" tab bar.
- Status semantics: active badge uses status-info-strong (task-status-icon.tsx:105) against DESIGN.md amber, raw enums in Activity, draft label, past-tense empty logs.
- Performance: ~300 KB session-logs refetched every 5s even for completed tasks (use-tasks.ts:85), ~2 requests/s on the page.
- Keyboard and semantics: 31 chrome tab stops before content, no skip link, h4 before h1, two h1 in DOM, nested main, log tabpanel has no focus ring.

## Persona red flags
- Alex (power user): no shortcuts, no copy session id or output, filter is text only, Back drops filters, no link to the spawned task.
- Sam (keyboard/screen reader): 31 stops to reach content, minimap and full timestamps unreachable, running state not announced, heading order broken.
- Casey (one-handed phone): top half pinned, Pause/Cancel at y~295 at 32px, Queue toggle 22px, steering in tab 3.
- Morgan (non-engineer operator): reads `<@U08NR6QD6CS|Taras>` and the question twice before the answer, jargon chips, failure says Join Discord not Try again.

## Minor observations
- "Back to Tasks" duplicates the breadcrumb.
- Output card capped at max-h-48 when logs exist.
- 3 to 4 levels of nested rounded-lg boxes in the log, radii not concentric.
- Collapsed composer reads like a footnote.
- Amber "scroll to latest" pill with shadow-lg covers log text and the Filter input on short screens.
- Mobile Details tab scrolls 8px sideways (sticky Activity heading -mx-3, page.tsx:936).

## Questions
1. Should a finished task read as a conversation (answer, then Follow up) instead of an archive?
2. Does the desktop meta rail need to exist, or can one summary line plus a Technical details section free a full-height log?
3. Should "Messages" be the default log view and "Everything" opt-in?
4. Does an auto-opening support modal on failure serve the operator or the support funnel?
