# Session Logs — Redesign Mockups

Three redesigns of the **Task Details → Session Logs** panel
(`apps/ui/src/components/shared/session-log-viewer.tsx`, shown inside
`task-detail-sheet.tsx`).

**Start here:** open [`../index.html`](../index.html) — the router/gallery that
links to all three (mobile-friendly, tap a card to open). Or open an option
directly. No build, no server needed (plain files); a server is only needed for
the phone tunnel.

| Option | File | One-liner |
|---|---|---|
| **D — Spine + Stream** ⭐ | [`option-d-hybrid/index.html`](./option-d-hybrid/index.html) | **Recommended.** A×C hybrid: spine + dense filterable rows, grouped tool runs, hover-expand minimap. |
| **A — Timeline Spine** | [`option-a-timeline-spine/index.html`](./option-a-timeline-spine/index.html) | Calm, editorial. A vertical spine; every event hangs off a node. |
| **B — Grouped Turns** | [`option-b-grouped-turns/index.html`](./option-b-grouped-turns/index.html) | Refined chat. Avatar-led turns; each tool is a slim collapsible card. |
| **C — Structured Stream** | [`option-c-structured-stream/index.html`](./option-c-structured-stream/index.html) | Dense, power-user. Aligned columns + type filters + search + minimap. |

## Recommended — Option D (mix of A + C)

Per the steer ("a mix of 1 and 3"), **Option D** is the convergence and the one
to evaluate. Round-2 feedback addressed:

- **Stacked-task markers** — dividers now read "Stacked task N" (was "Iteration").
- **Grouped tool runs** — consecutive tool calls between agent outputs collapse
  into one group ("N steps · Read, Grep, Bash…"); expand to see each.
- **Truncated outputs** — tool results clamp to a few lines with **Show full
  output** / **Show less**.
- **No horizontal scroll** — long commands/paths truncate; output wraps.
- **Hover-expand minimap** — the right rail widens on hover into a clickable
  outline; click any event to scroll to it.
- **"N new messages" pill** — appears when you've scrolled up and events arrive.
- **Virtualization** is reserved for the real implementation (see below).

A, B, C remain as the earlier explorations / parents.

## Live demo controls (all three)

Driven by a **real 40-event session** (your `/tmp/demo-logs.json`).

- **Counter** `rendered / total` in the top bar.
- **Push next** — streams the next single event in (entrance animation).
- **Load all** — renders everything remaining.
- **Reset** — back to the opening view.
- **“Agent is working” footer** — pinned below the log while the session is in
  progress (i.e. while more events remain); flips to **“✓ Session complete”**
  when everything is loaded. This is the "it's running" indicator.
- **Light/dark toggle**, top-right.
- **Deep-links**: `?theme=light|dark` and `?n=<count>|all` (e.g.
  `…/index.html?theme=dark&n=all`) preset the theme and how many events render.

## What this fixes

The current panel re-fetches **all** logs every 5s (`useTaskSessionLogs`,
`refetchInterval: 5000`), re-parses + re-renders the whole timeline (no
virtualization), so new blocks **pop in** and the scroll jumps. Every mockup
shows the fix: press **Push next** —

- new events **fade + slide in** (`opacity`/`transform` only — no layout thrash);
- **scroll is anchored** — at the bottom it follows; scrolled up it does **not**
  yank you, a **"N new" pill** appears instead;
- tool calls are **folded** (call + its result paired into one collapsible row)
  instead of a full-width box per message.

All three respect `prefers-reduced-motion`, key off real app tokens
(amber-on-zinc OKLCH, Space Grotesk + Space Mono), and pass the cheap a11y
checks (real `<button>`s, `aria-label`s, `aria-live` on the stream, visible
focus).

## The three directions

- **A · Timeline Spine** — refined minimalism. A continuous spine; role shown
  once per node; tool calls are compact monospace rows. Best for a calm,
  premium "beautiful CI timeline" feel.
- **B · Grouped Turns** — approachable chat, elevated. Avatar + soft tinted
  bubble per turn; each tool is a slim collapsible card; sticky iteration
  headers. Best for the lowest-friction read.
- **C · Structured Stream** — dense and scannable. Fixed time/glyph/content
  columns, working type **filters** + **search** + a clickable **minimap**.
  Best when sessions get long and you want to scan/filter fast.

## Files

```
mockups/
  index.html                 ← root router / gallery (start here)
  compare.html               ← side-by-side compare (controls drive all panes in sync)
  session-logs/
    README.md                ← this file
    demo-shared.css          ← tokens + chrome + controls + running footer + prose (shared)
    demo-runtime.js          ← push/load-all/reset + counter + scroll-anchor + markdown + cross-frame sync (shared)
    demo-data.js             ← GENERATED, anonymized (window.DEMO_LOGS)
    build-demo-data.ts       ← generator + PII scrubber (reads private /tmp/demo-logs.json)
    option-d-hybrid/index.html          ← ⭐ recommended (A × C)
    option-a-timeline-spine/index.html
    option-b-grouped-turns/index.html
    option-c-structured-stream/index.html
```

`demo-data.js` is generated by `build-demo-data.ts` (`bun build-demo-data.ts`) —
it normalizes the raw `session_logs` format, pairs each `tool_use` with its
`tool_result`, computes per-call durations, drops hook noise, truncates large
bodies, and **anonymizes PII** (emails, names, agent codenames, the committer,
and every UUID → consistent fakes). Input is a private `/tmp/demo-logs.json`
(not committed); the committed `demo-data.js` is scrubbed.

## Implementation path (once you pick one)

- Visual layer drops into `session-log-viewer.tsx`; the existing parser
  (`ParsedMessage`/`ContentBlock`) + `Streamdown` markdown stay.
- Pair `tool_result` under its `tool_use` (by `tool_use_id`) for the grouped look.
- Kill the jank: render incrementally (entrance class only on newly-arrived
  `msg.id`s), anchor scroll with a stick-to-bottom hook + "jump to latest" pill.
- **Virtualization (required for big sessions):** windowed rendering via
  `@tanstack/react-virtual` so a 1000+ event session stays smooth — only visible
  rows mount. Key group/collapse state by id so it survives row recycling, and
  measure dynamic row heights (collapsed vs expanded tool groups).
- Colors already map to existing tokens, so `check:tokens` passes — no new literals.
```
