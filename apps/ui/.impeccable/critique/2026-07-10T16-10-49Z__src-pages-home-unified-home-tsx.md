---
target: home
total_score: 28
p0_count: 0
p1_count: 3
timestamp: 2026-07-10T16-10-49Z
slug: src-pages-home-unified-home-tsx
---
Method: dual-agent (A: design review, Opus · B: detector + browser evidence, Sonnet)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Rich live feedback (pulse, "now" line, counts); empty state falsely implies nothing ever happened |
| 2 | Match System / Real World | 3 | "superseded", raw token counts, zoom presets are dense for non-dev operators |
| 3 | User Control and Freedom | 3 | Zoom/pause/reset/load-older present, but unreachable from the empty state |
| 4 | Consistency and Standards | 3 | Home bypasses `PageHeader`; hand-rolled `h1 text-2xl` off the headline token |
| 5 | Error Prevention | 3 | Version gate blocks broken states; little to prevent here |
| 6 | Recognition Rather Than Recall | 2 | No status-color legend; 8 colors carry all meaning, hover-only decode |
| 7 | Flexibility and Efficiency | 3 | Pinch-zoom, live-follow, virtualization; no zoom hotkeys, no filter by agent/status |
| 8 | Aesthetic and Minimalist Design | 3 | Populated view dense-but-ordered; empty state is a full-page void |
| 9 | Error Recovery | 3 | API-dead callout near-exemplary; task-fetch failure masked as "no activity" |
| 10 | Help and Documentation | 2 | No legend, no "what am I looking at", no docs link |
| **Total** | | **28/40** | **Good (low end)** |

## Anti-Patterns Verdict

**LLM assessment:** Not slop — passes the Linear/Vercel trust test. No card-grid templates, no eyebrows, no gradient text, no glassmorphism. Amber genuinely rationed to the One-Voice rule (live pulse, "now" line only). The timeline is a real custom artifact (interval-graph row packing, cluster chips, drift-transform live-follow). The risk runs the other way: **under-designed emptiness** — the control center's front door opens on a greeting and a void with no action.

**Deterministic scan:** 9 findings, all `design-system-font-size` — off-ramp `text-[10px]`/`text-[11px]` literals, all in `src/components/dashboard/agent-activity-timeline.tsx` (lines 533, 1103, 1142, 1156, 1187, 1205, 1226, 1263, 1277). No mechanical false positives (all live JSX className literals). Converges with the human review's contrast concern on 10px muted text over tinted fills. `unified-home.tsx`, `alert-callout.tsx`, `skeleton.tsx`: clean.

**Visual overlays:** Injection succeeded on the live page; a manually-triggered `impeccableScan()` reported 6 anti-patterns in the rendered (empty-state) DOM via console. Overlay server started and cleanly stopped.

## Overall Impression

The populated timeline is the strongest surface in the app — genuinely mission-control — but the page most operators will actually see (quiet window, first run) is a dead-end void that hides existing history, offers zero steering actions, and teaches nothing. Biggest opportunity: make the home never-empty and give it its primary verb.

## Priority Issues

- **[P1] The empty state is a dead end that lies.** `visibleTasks.length === 0` renders a terminal `EmptyState` before the toolbar exists, so "Load older" / zoom are unreachable. 58 real tasks sat ~30h old, just outside the 24h window, while the copy claimed "No task activity yet." Also masks task-fetch errors as emptiness. **Fix:** always render the toolbar; window-aware copy ("No activity in the last 8h — load older / widen to 7d") with working actions; distinguish `isError` from empty.
- **[P1] No primary action — the control center spectates, not steers.** No "New task" anywhere on `/`, contradicting Design Principle #1. **Fix:** primary action in a `PageHeader` action slot + as the empty-state CTA.
- **[P1] No status-color legend.** Eight semantic colors, meaning hover-only; WCAG 1.4.1 color-alone violation; non-dev operators can't read the chart. **Fix:** compact always-visible legend; status in each bar's accessible name.
- **[P2] Home bypasses `PageHeader` and the headline token.** Hand-rolled `h1 text-2xl` on the most-visited route; breaks type rhythm and forfeits the action slot. **Fix:** render greeting through `PageHeader`.
- **[P2] Two sequential onboarding gates before any value.** Connection form → identity modal → void. **Fix:** collapse to one step (auto-accept generated connection name), make identity deferrable.

## Persona Red Flags

**Alex (power user):** two forced gates, no skip; no zoom/pan hotkeys (+/-/0); no filter-by-agent/status on a 1,200-task chart; no quick-create path.

**Sam (accessibility):** status by color alone (1.4.1) with hover-only decode; keyboard/SR coherence of absolutely-positioned bars in a scroll region unproven; `animate-ping`/`shimmer-bar` reduced-motion degradation unverified; 10px labels on tinted fills at contrast risk (matches detector findings).

**Morgan (non-developer operator, from PRODUCT.md):** lands on a Gantt with "30s/2m/8h" presets, "clusters", a "now" line — zero explanation; "superseded"/raw token counts are jargon; no plain-language fleet summary ("3 agents idle · 0 running · 1 approval waiting") — the one thing she most needs.

## Minor Observations

- Empty-state clock icon too small for a full-viewport card; weak central mass.
- Three near-identical zoom icon buttons; window label separated from them; "8h" vs "(24h window)" vocabulary mismatch.
- Sidebar fixed 255px at 900px viewport (~28% of width); no collapse below ~1024px.
- Version-gate copy leaks "API 1.76+" with no upgrade guidance.
- Greeting uses raw username; long-name truncation untested.

## Questions to Consider

1. What if the home led with a one-line plain-language fleet state ("3 agents idle · 0 running · 1 approval waiting · $0 today") and made the timeline the second glance?
2. Should the window auto-widen to the most recent activity so the first glance is never empty when history exists?
3. What's the one action an operator should take from this page in under 5 seconds — and why is there currently no button for it?
