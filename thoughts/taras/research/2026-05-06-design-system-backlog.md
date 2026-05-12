---
date: 2026-05-06T00:00:00Z
topic: "Design-system migration backlog (open items vs. brand kit)"
status: open
author: Claude (phases 11, 12)
related_audit: thoughts/taras/research/2026-05-06-design-system-audit.md
related_plan: thoughts/taras/plans/2026-05-06-new-ui-design-system-migration.md
---

# Design-system migration — open backlog

The 2026-05-06 new-ui design-system migration deliberately did not adopt every brand-kit construct. This file is the consolidated, action-oriented backlog future plans can pick up. Each item: 1-line description, 1-line rationale, 1-line "when to revisit".

Source of detail: [`2026-05-06-design-system-audit.md` § Phase 11](./2026-05-06-design-system-audit.md#phase-11--closing-open-backlog-vs-brand-kit).

---

## Tokens

### 1. Spacing scale — `--space-{1,2,3,4,5,6,8,10,12,16,20,24,32}`
- **What**: Adopt brand-kit's explicit `--space-*` token surface in `new-ui/src/styles/globals.css`.
- **Why deferred**: new-ui uses Tailwind's default `p-*`/`gap-*` scale. Adopting tokens would touch every page (largest possible refactor) for marginal codification benefit; values are byte-equivalent.
- **When to revisit**: When unifying spacing across `landing/` + `new-ui/` + `templates-ui/` and explicit token surface becomes load-bearing for cross-surface consistency.

### 2. Type scale — `--t-display`, `--t-h1..h4`, `--t-body{,-lg,-sm}`, `--t-caption`, `--t-tag`
- **What**: Adopt brand-kit's type-scale tokens.
- **Why deferred**: Tailwind text utilities cover existing usage. Concrete signal: `--t-tag: 0.5625rem` (= 9px) is byte-equivalent to inline `text-[9px]` in `Badge size="tag"`.
- **When to revisit**: If type hierarchy needs cross-surface alignment, or `text-[9px]` arbitrary utility gets flagged as worth tokenising.

### 3. Line-height scale — `--lh-tight`, `--lh-snug`, `--lh-body`, `--lh-loose`
- **What**: Adopt brand-kit's line-height tokens.
- **Why deferred**: Tailwind's `leading-*` utilities cover existing usage.
- **When to revisit**: Pair with type-scale adoption; not standalone.

### 4. Shadow scale — `--shadow-{xs,sm,md,lg,xl}` + `--shadow-amber-glow`
- **What**: Adopt brand-kit's shadow tokens.
- **Why deferred**: Tailwind `shadow-*` covers dashboard usage. Amber-glow is a landing-CTA construct.
- **When to revisit**: If a marketing-style CTA lands in the dashboard (paid-tier upsell). Adopt `--shadow-amber-glow` as a one-off rather than the full scale.

### 5. Text-color shorthands — `--fg-1`, `--fg-2`, `--fg-3`, `--fg-4`
- **What**: Adopt brand-kit's four-tier text-color shorthand.
- **Why deferred**: new-ui uses two-tier `text-foreground` / `text-muted-foreground`. Four tiers are denser than current needs.
- **When to revisit**: If documentation or marketing surfaces in new-ui need finer-grained text hierarchy.

### 6. Eyebrow tokens — `--eyebrow-color`, `--eyebrow-tracking`, `.t-eyebrow`
- **What**: Adopt brand-kit's eyebrow construct.
- **Why deferred**: Landing-only construct; new-ui has no eyebrow pattern.
- **When to revisit**: Only with a marketing surface in new-ui.

### 7. Extra radii — `--radius-2xl` (1rem), `--radius-full` (9999px)
- **What**: Adopt brand-kit's two extra radius tokens.
- **Why deferred**: `radius-full` is byte-equivalent to Tailwind's `rounded-full`. No new-ui surface needs `radius-2xl` semantically today.
- **When to revisit**: Add ad-hoc when a primitive needs `rounded-2xl` semantically (rather than as a one-off Tailwind utility).

### 8. Raw palette scales — `--amber-{50..900}`, `--zinc-{50..950}`
- **What**: Re-emit raw Tailwind scales as CSS variables.
- **Why deferred**: Brand kit needs them for landing hero compositions; new-ui consumes the palette via Tailwind utility classes (now lint-gated). Tailwind v4 already provides `--color-*` defaults.
- **When to revisit**: Only if cross-surface code references scales by CSS variable rather than Tailwind class. Unlikely.

### 9. Font-fallback alignment
- **What**: Update `--font-sans` fallback to match brand kit (`"Space Grotesk", system-ui, -apple-system, "Segoe UI", sans-serif`).
- **Why deferred**: Functionally equivalent — both load Space Grotesk; brand kit's chain is more conservative for missing-font edge cases. Not visible in practice.
- **When to revisit**: Trivial; fold into any future `globals.css` cleanup.

## Helper classes

### 10. `.gradient-text`
- **What**: Adopt brand kit's gradient-text helper from `colors_and_type.css:261`.
- **Why deferred**: Zero matches in `new-ui/src/`; landing hero construct.
- **When to revisit**: When a marketing-style hero lands in new-ui.

### 11. `.grid-bg`
- **What**: Adopt brand kit's grid-background helper from `colors_and_type.css:282`.
- **Why deferred**: Zero matches in `new-ui/src/`; landing hero construct.
- **When to revisit**: Same as `.gradient-text` — only with a hero surface.

## Architectural

### 12. Multi-surface package extraction
- **What**: Extract a shared `packages/swarm-design-system/` consumed by `new-ui/`, `landing/`, `templates-ui/`, `docs-site/`.
- **Why deferred**: Out of scope; current plan locks `new-ui/` as the canonical implementation.
- **When to revisit**: When the second surface (`landing/` or `templates-ui/`) starts pulling tokens or primitives from `new-ui/` and copy-paste becomes painful.

### 13. Storybook / dedicated `/design-system` route
- **What**: Build a primitive-showcase route or Storybook instance.
- **Why deferred**: 33 existing routes serve as the live catalog; CLAUDE.md primitives table is the doc surface.
- **When to revisit**: If primitive count grows past ~50 and the inline catalog becomes hard to navigate, or if external designers need a non-coding entry point.

### 14. Utility count soft floor
- **What**: Reach 20+ utilities/hooks in `src/lib/` + `src/hooks/`.
- **Why deferred**: Current count is **18**. The plan explicitly says do not invent utilities to hit the number. Phase 10 only extracted on actual duplication (net +11 from baseline).
- **When to revisit**: As real duplication surfaces in future feature work, not as a standalone task.

### 15. Project-root `CLAUDE.md` correction
- **What**: Fix "Dashboard (Next.js, port 5274)" — new-ui is React + Vite, not Next.js.
- **Why deferred**: Out of scope of the design-system plan; needs a separate doc PR.
- **When to revisit**: Next time anyone touches `CLAUDE.md` at project root.

---

## Phase 12 additions (preview/ + ui_kits/dashboard reconciliation)

Source of detail: [`2026-05-06-design-system-audit.md` § Phase 12](./2026-05-06-design-system-audit.md#phase-12--reconcile-preview-33-htmls--ui_kitsdashboard-4-jsx).

### Primitives — missing

#### 16. `<CodeBlock>` primitive (5 modes)
- **What**: Add a `CodeBlock` primitive supporting read / diff / inline / editable / long-collapsed modes (matching `~/Downloads/swarm-design-system/preview/code-block.html`).
- **Why deferred**: Currently no app-side code uses an inline code block; Monaco serves the workflow-detail editing surface and Streamdown handles markdown code fences. A dedicated primitive would surface only when a non-Monaco / non-Streamdown code-display need arises.
- **When to revisit**: When a feature needs a static read-only or diff view of code outside Monaco — e.g. PR diff embed, schema viewer, code-result preview in chat.

#### 17. `<Terminal>` primitive (static mono output card)
- **What**: Static mono-font terminal-output card primitive (matching `~/Downloads/swarm-design-system/preview/terminal.html`).
- **Why deferred**: `SessionLogViewer` covers the streaming case. No surface today needs static terminal output.
- **When to revisit**: When a pre-recorded / non-streaming terminal-output rendering is needed (e.g. recorded-session replay, scheduled-task last-output preview).

#### 18. `<Tabs>` `pill` and `vertical` variants
- **What**: Two new `Tabs` variants beyond `default` and `line`: `pill` (selectable rounded pills) and `vertical` (left side accent rail) — matching `preview/primitives-tabs-modals.html`.
- **Why deferred**: Zero call sites in new-ui need them today.
- **When to revisit**: When a settings-style page wants a vertical-tabs left nav, or a filter-pill UI surface emerges.

### Composed components — missing

#### 19. Per-integration `<StatsBar>` (24h sync stats)
- **What**: Compact horizontal stat strip above integration-detail (last 24h sync count / errors / mean-latency / success-rate) — matching `preview/integration-detail.html`'s "Sync stats · 24h" strip.
- **Why deferred**: Integrations currently surface enough state via `OAuthStatusRow`. Sync metrics are not yet per-integration.
- **When to revisit**: When integration sync becomes metered / SLO-tracked and the per-integration page needs a metrics summary.

#### 20. Detail-page right-rail primitive (`<DetailPageRail>`)
- **What**: Right-rail composed primitive with Quick stats / Relationships / Danger zone sections — adopted across all `pages/*/[id]/page.tsx` per `preview/detail-page-template.html`.
- **Why deferred**: **Major architectural divergence** — every new-ui detail page currently uses flat Tabs without a right rail. Adopting requires a new primitive + per-page restructuring + `qa-use` evidence sweep.
- **When to revisit**: As a dedicated follow-up plan ("detail-page right-rail rollout"). The brand kit is unambiguous that this is canonical detail-page IA — adopting it is a coherence win across the surface.

#### 21. 3-column task-detail layout
- **What**: Restructure `pages/tasks/[id]/page.tsx` to match `preview/task-detail.html`'s 3-column layout (left meta-rail with SCM-PR card + progress bars; center hero + timeline; right quick-stats). Includes a new SCM-PR card primitive.
- **Why deferred**: Significant restructure of a high-density page. Pairs with #20.
- **When to revisit**: As part of the detail-page right-rail rollout plan, or as a standalone task-detail redesign.

#### 22. Approval-request rich detail surface
- **What**: Restructure `pages/approval-requests/[id]?` to match `preview/approval-request.html`'s structure (action banner + countdown + "why agent says it needs this" + decision pills + originating-task card + policy-match + audit-record card).
- **Why deferred**: Approvals page currently exists as a flat list/table; detail surface is minimal.
- **When to revisit**: When approvals become a primary user surface (e.g. approval-budget tracking, scheduled human-loop reviews).

#### 23. Chat surface visual-spec parity
- **What**: Pixel/structure diff between `pages/chat/page.tsx` and `preview/chat-surface.html`. Adopt the brand-kit's chat layout (left rail + center stream + right meta) if better aligned with cross-surface IA.
- **Why deferred**: Chat already implemented; deliberate divergence vs. accidental divergence not yet decided.
- **When to revisit**: Next chat-surface feature ticket — pause to compare against the brand-kit reference before extending.

#### 24. Workflow-canvas run-summary strip
- **What**: Add a horizontal run-summary strip below the workflow-canvas graph (matching `preview/workflow-graph.html`'s `.runmeta`). Shows current run id, elapsed, step counts, latest event.
- **Why deferred**: Run-summary info already surfaces in the workflow-detail page header; canvas-side strip is duplicative.
- **When to revisit**: When the canvas becomes the primary viewport (full-screen workflow-graph mode).

### Sidebar / header polish

#### 25. Sidebar nav-item badge counts
- **What**: Show small mono-font count badges on sidebar nav items (e.g. `Tasks (7)` for pending tasks) — matching `Sidebar.jsx`'s `bg-amber-100 text-amber-800` pill pattern.
- **Why deferred**: Counts not yet wired through; sidebar simplicity is a deliberate choice.
- **When to revisit**: When a dedicated "needs attention" surface is needed (pending approvals, failing workflows, paused budgets).

#### 26. Sidebar footer user-info card
- **What**: Avatar + name + workspace handle in the sidebar footer (currently `<SidebarTrigger>` only) — matching `Sidebar.jsx`'s gradient-fill avatar + name + handle.
- **Why deferred**: User identity surfaces via `<SwarmSwitcher>` in the header; footer card would duplicate.
- **When to revisit**: Multi-tenant / user-management surface lands.

#### 27. Tasks-list "live · /api/tasks" mono indicator
- **What**: Mono-font small indicator showing data source + polling state on the tasks list (matching `TaskList.jsx`'s `/api/tasks · live` display).
- **Why deferred**: react-query auto-polling at 5s already provides freshness without the visual indicator.
- **When to revisit**: When a debug / data-source-transparency feature is requested (e.g. "is this view live or paused?").

#### 28. Agent-avatar gradient-fill variant
- **What**: Add a gradient-fill variant to `<Avatar>` matching `AgentPanel.jsx`'s `bg-gradient-to-br from-violet-400 to-purple-600` agent-identity tile.
- **Why deferred**: Decorative; current `<AvatarFallback>` is functional. Cross-cuts agent vs. user avatars.
- **When to revisit**: When agent identity needs visual distinction from user identity (e.g. mixed user/agent activity feed).

---

## Out of scope (closed, not backlog)

- **Brand-kit overwrite.** `~/Downloads/swarm-design-system/` stays read-only.
- **`new-ui/` style switch away from Tailwind v4 / shadcn.** Foundation stays.
- **`next-themes` re-introduction.** Removed in Phase 6; the custom `useTheme` hook is canonical.
- **Hand-rolled `<Sidebar>` from `Sidebar.jsx` (raw palette literals, gradient avatars).** new-ui's shadcn `<Sidebar>` shell + token-driven variants is canonical. `Sidebar.jsx` is a reference snapshot, not a build artifact — adopting its raw `bg-amber-50 text-amber-800` literals would break the Phase 7 lint gate.
- **Hand-rolled `<TaskList>` `<table>` with inline OKLCH `style={{...}}`.** new-ui's `<DataGrid>` (AG Grid wrapper) is canonical and a CLAUDE.md hard rule.
