---
target: task details page (desktop + mobile), after phase 7
total_score: 27
p0_count: 0
p1_count: 2
timestamp: 2026-10-05T18-02-35Z
slug: apps-ui-src-pages-tasks-id-page-tsx
---
Method: dual-agent (A: Opus design review · B: Sonnet detector and browser overlay), synthesized by the phase 7 agent with its own measurements.
Target: task detail page, apps/ui/src/pages/tasks/[id]/page.tsx, desktop and mobile, branch feat/task-detail-overhaul after phase 7 (uncommitted). QA stack: seeded API with grafted real Claude session logs, vite on 5275. Baseline: 2026-10-05T10-22-58Z (20/40, 12/20).

## Design Health Score (Nielsen): 27/40 (Acceptable, top of the band; baseline 20)

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of system status | 3 | Live footer, amber status, waiting lines are clear. A 5-hour-old draft still says "Uploading attachments…" and "Queued 5 hours ago" carries no staleness signal. |
| 2 | Match system / real world | 3 | Slack syntax is gone and Activity reads in words. Jargon remains: "this harness can't be steered", "queues at the next turn boundary", "Context formula", "HOOKS SessionStart RUNS 1 hook". |
| 3 | User control and freedom | 3 | Every status has a next action. A stuck pending or offered task offers only Cancel (no reassign). |
| 4 | Consistency and standards | 2 | The hero says "PR #1871" while the rail says "Source: API". The hero names "Taras" while the rail says "Requested by: e2e-user". |
| 5 | Error prevention | 3 | Cancel confirms. Retry fires in one click and does not say what it reuses. |
| 6 | Recognition over recall | 3 | Under 64rem, Pause, Cancel and Retry live in "...". |
| 7 | Flexibility and efficiency | 2 | No page shortcuts. `document.title` is the same on every task. |
| 8 | Aesthetic and minimalist | 3 | Source info repeats in 4 places (hero line, Summary, Source control card, Technical details). |
| 9 | Error recovery | 3 | Open error callout with Retry, Copy diagnostics, Get help. The durations disagree: "Failed after 21ms" vs "after 14m 02s" in the reason vs "ran 1ms" in the rail. |
| 10 | Help and documentation | 2 | The cost-source chip and the context figures have no explanation or docs link. |

## Technical Audit Score: 16/20 (Good; baseline 12)

| # | Dimension | Score | Key finding |
|---|---|---|---|
| 1 | Accessibility | 3 (was 2) | One `main`, a skip link (first Tab), h1 then h2 only, amber focus rings on the log, the narrow tab panels and the chips, a polite status region on the log footer. Contrast sweep: 0 failures in 24 states, minimum 4.59:1 light, 5.68:1 dark (pixel-verified). Gaps: the shared composer's sr-only file input is a ghost Tab stop, 36 Tab stops between Follow up and the rail with no skip to the rail, markdown headings in log messages join the page outline. |
| 2 | Performance | 3 (was 2) | Finished tasks make no log or context requests after load. The log virtualizes above 120 rows. Streamed rows animate for 420 ms to 1.5 s, over the 300 ms budget. |
| 3 | Responsive | 3 (was 2) | Layout follows the page width (64rem container query). 0 controls under 44 px and 0 horizontal overflow at 390 on every tab. A 1280x800 window with the sidebar open gets the narrow layout, with 44 px targets for pointer users. |
| 4 | Theming | 4 (was 3) | Tokens throughout, `check:tokens` passes, both themes pass contrast. A named type scale (`text-data`, `text-meta`) replaced 64 arbitrary pixel sizes in the page files and the log. |
| 5 | Anti-patterns | 3 (was 3) | Detector CLI: 0 findings. Overlay: real line-length hits in log prose (104 to 111 characters per line at 1440). Uppercase tracked labels head every rail section. |

## Anti-patterns verdict
Not slop. No gradients, glass, hero metrics or card grids, and status color is semantic. Two template tells remain: 7 uppercase tracked section labels (SUMMARY, SOURCE CONTROL, PROGRESS, CONTEXT, ACTIVITY, TECHNICAL DETAILS, MESSAGE) with three letter-spacing values, and amber spent on non-actions (selected segmented options, the "Started by" history entry, the floating jump pill with `shadow-lg`).
Detector CLI: 0 findings on the page folder and 5 shared components (it sees static class strings only; a seeded control file fired 4 rules, so the clean result is real). Overlay on 5 views: 13 to 39 hits per view. Real: line-length (log prose and the Output block), tiny-text (composer hint, mono timestamps at 11 px), cramped padding inside the Messages/Everything control. False positives: text-overflow (closed command palette), clipped-overflow (shell panes), layout-transition (sidebar shell), overused-font (Space Grotesk is the system font), gradient-text (the sanctioned shimmer), most nested-cards (the inset shell and in-panel dividers).

## What's working
1. One action model feeds the hero, the sticky bar, the failure callout and the phone menu, and the primary action follows the status (Follow up, Retry, Pause, Cancel).
2. The source line turns raw Slack into "Taras · 3 earlier messages", and the prompt dialog quotes the thread and copies the exact prompt.
3. Contrast and type: every text style is at least 4.5:1, and no page text in the page files or the log is under 11 px.

## Priority issues
1. [P1] Conflicting numbers on one screen. The rail sums `session_costs` ($1.21, ran 2m 56s). The log end line reads the harness result event ($1.42, 4m 7s). `failedAfter` counts created to finished (queue time included), the rail counts started to finished. The QA fixture mixes sources, which inflates it, but the definitions really differ. Fix: one run-time definition, and label each figure's source. Command: /impeccable clarify.
2. [P1] A 1280x800 laptop with the sidebar open gets the phone layout (976 px of content): actions in "...", the rail as a tab, 44 px pointer targets, a "Tasks" back link under the breadcrumb. This is the approved 64rem container switch; the cost is real on a common size. Fix: a middle tier with visible hero actions and a narrower rail, touch sizing on `pointer: coarse`. Command: /impeccable adapt.
3. [P2] Stalled states only spectate. Draft, pending and offered show one dashed line and Cancel. Fix: age-aware copy, Reassign, the prompt inline when there is no log. Command: /impeccable harden.
4. [P2] Keyboard path. A ghost Tab stop (the composer's sr-only file input), 36 stops to the rail, hover-only full timestamps. Command: /impeccable audit.
5. [P3] Amber and label sprinkle: neutral selected states, one label style. Command: /impeccable quieter.

## Persona red flags
- Alex (power user): no shortcuts to focus the box, switch the log view or copy the id. Tabs are indistinguishable. A live task opens on Everything, the noisiest view.
- Sam (keyboard and screen reader): the ghost file-input stop; 36 stops to the rail; an agent's "## Summary" becomes a page h2 inside the log.
- Casey (one-handed phone): Pause and Cancel live in "..." at the top of a hero that scrolls away; the jump pill covers row text; spawned titles cut to about 12 characters.
- Morgan (non-engineer operator): turn-boundary and harness jargon; "Source: API" next to a GitHub PR line; "1 event" is the first line of Messages.

## Minor observations
- Cancel dialog buttons use title case ("Cancel Task", "Keep Task").
- Off-scale values remain outside the page files: `py-[7px]` rows, the 15 px composer textarea, the 10 px composer key hint (shared composer), the 9 px cost-source chip (`Badge size="tag"`).
- In-progress at 1440: sticky chrome takes 316 px, the log rows get 528 px (59%).
- The inactive Messages/Everything label sits at 4.59:1 on the tinted toolbar: it passes with little margin.

## Questions to consider
- Messages already folds tools. Why does a live task open on Everything?
- Should a task that waited 5 hours look the same as one that waited 5 seconds?
- Is container width the right signal for touch-sized controls?
