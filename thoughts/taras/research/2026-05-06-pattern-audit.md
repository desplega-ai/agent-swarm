---
date: 2026-05-06
phase: 9
plan: thoughts/taras/plans/2026-05-06-new-ui-design-system-migration.md
scope: new-ui/src
last_updated: 2026-05-06
last_updated_by: claude
---

# Pattern audit — new-ui design system (Phase 9)

Auto-discovery scan of `new-ui/src/pages/**/page.tsx` (32 pages) and `new-ui/src/components/{layout,shared,integrations,workflows}/*` (~34 composed components) for recurring layout patterns. Each cluster is named, counted, and either promoted to a primitive (≥2 occurrences, real duplication) or rejected with reason.

Promotions in this phase **add** primitives only. Phase 10 replaces call sites.

---

## Summary

| Cluster | Occurrences | Decision | Primitive | File |
|---|---|---|---|---|
| PageHeader | 37 | Promote | `PageHeader` | `src/components/ui/page-header.tsx` |
| InfoRow / DefinitionList | 32 (across 9 files) | Promote | `InfoRow`, `DefinitionList` | `src/components/ui/info-row.tsx` |
| StatPanel | 5 (api-keys) | Promote | `StatPanel` | `src/components/ui/stat-panel.tsx` |
| AlertCallout (status-toned) | 4+ inline | Promote | `AlertCallout` | `src/components/ui/alert-callout.tsx` |
| SettingsRow / FormField | 14 (config + repos + tasks + ...) | Promote | `SettingsRow` | `src/components/ui/settings-row.tsx` |
| OAuthSection (connection-state row) | 4 (codex / linear / jira / claude-managed) | Promote | `OAuthSection` | `src/components/shared/oauth-section.tsx` |
| WorkflowNodeShell | 3 (action / condition / trigger nodes) | Promote | `WorkflowNodeShell` | `src/components/shared/workflow-node-shell.tsx` |
| EmptyState | already covered | Skip | existing `EmptyState` | `src/components/shared/empty-state.tsx` |
| IntegrationStatusRow | already covered | Skip | existing `IntegrationStatusBadge` | `src/components/integrations/integration-status-badge.tsx` |
| StatsBar | already covered | Skip | existing `StatsBar` | `src/components/shared/stats-bar.tsx` |
| SectionHeader (h2) | 10 — varying scales | Skip-defer | absorbed by `OAuthSection`/`Card` | n/a |

**7 new primitives**, **3 confirmed-coverage skips**, **1 deferred** (SectionHeader has too much scale variance to abstract cleanly without breaking call sites).

---

## Cluster 1 — PageHeader (37 occurrences)

**Pattern**: every route page opens with `<h1 className="text-xl font-semibold">{title}</h1>`, sometimes followed by an action button or paragraph description. Currently hand-rolled as either:

```tsx
<div className="flex items-center justify-between">
  <h1 className="text-xl font-semibold">Title</h1>
  <Button ...>Action</Button>
</div>
```

or

```tsx
<div className="space-y-2">
  <h1 className="text-xl font-semibold">Title</h1>
  <p className="text-sm text-muted-foreground">Description</p>
</div>
```

**Examples**:
- `src/pages/approval-requests/page.tsx:117`
- `src/pages/repos/page.tsx:309,333` (with action button)
- `src/pages/api-keys/page.tsx:316` (bare title)
- `src/pages/integrations/page.tsx:89` (with description below)
- `src/pages/budgets/page.tsx:735` (with leading icon)
- `src/pages/agents/[id]/page.tsx:324` (detail page with editable name + status)
- `src/pages/workflow-runs/[id]/page.tsx:107` (multi-line title)
- 30 more across all 32 pages

**Proposed primitive** — `PageHeader`:

```ts
type PageHeaderProps = {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  icon?: LucideIcon;
  className?: string;
};
```

Renders the canonical `flex items-center justify-between` row with `text-xl font-semibold` title + optional adjacent action; description goes on a second row with `text-sm text-muted-foreground`. Detail pages with bespoke editable titles (e.g. `agents/[id]`) can pass JSX into `title`.

**Edge cases**:
- Detail pages embed status badges or icons next to the title — pass them as ReactNode in `title`
- `agents/[id]` has an editable name with pencil button — passes ReactNode through `title`
- Workflow run detail (`workflow-runs/[id]`) has a multi-line title with metadata — `title` ReactNode covers it

**Placement**: `src/components/ui/page-header.tsx` (brand-agnostic; could ship in any shadcn-style design system).

---

## Cluster 2 — InfoRow / DefinitionList (32 occurrences in 9 files)

**Pattern**: a small uppercase tracking-wide label above a value, used in detail pages, modals, and config sections. Canonical class string: `text-xs text-muted-foreground uppercase tracking-wide`.

```tsx
<div>
  <span className="text-xs text-muted-foreground uppercase tracking-wide">Role</span>
  <p className="text-sm">{agent.role}</p>
</div>
```

**Examples**:
- `src/pages/agents/[id]/page.tsx:347-358` (5+ rows in profile card)
- `src/pages/repos/[id]/page.tsx` (configuration section)
- `src/pages/schedules/[id]/page.tsx`
- `src/pages/workflows/[id]/page.tsx` (multiple)
- `src/pages/config/page.tsx` (connections section)
- `src/pages/usage/page.tsx`
- `src/components/shared/usage-summary.tsx`
- `src/components/shared/name-connection-modal.tsx:58`
- `src/components/workflows/step-card.tsx`

**Proposed primitive** — `InfoRow` + `DefinitionList`:

```ts
type InfoRowProps = {
  label: ReactNode;
  children: ReactNode; // the value
  className?: string;
};

type DefinitionListProps = {
  className?: string;
  children: ReactNode; // expected to be InfoRow | InfoRow[]
};
```

`InfoRow` renders the label-above-value pair with the canonical typography. `DefinitionList` provides a vertical-spaced container so call sites don't repeat `space-y-3`. Both compose freely — call sites can mix `InfoRow` with other components inside a `DefinitionList`.

**Edge cases**:
- Some sites use `<p>` for the value, others use `<div>` — `children: ReactNode` covers both
- Some sites omit the label container's outer `<div>` — `InfoRow` always wraps in a slot div with predictable layout

**Placement**: `src/components/ui/info-row.tsx` (brand-agnostic).

---

## Cluster 3 — StatPanel (5 occurrences in api-keys)

**Pattern**: a `<Card>` with `<CardContent className="p-3 flex items-center gap-3">` containing an icon-tile (`rounded-md bg-{tone}/10 p-2`), a text label, and a numeric value. All 5 instances are in `src/pages/api-keys/page.tsx:319-377` for the summary cards strip.

```tsx
<Card>
  <CardContent className="p-3 flex items-center gap-3">
    <div className="rounded-md bg-status-success/10 p-2">
      <ShieldCheck className="h-4 w-4 text-status-success" />
    </div>
    <div>
      <p className="text-xs text-muted-foreground">Available</p>
      <p className="text-lg font-semibold text-status-success">{stats.available}</p>
    </div>
  </CardContent>
</Card>
```

**Examples**:
- `src/pages/api-keys/page.tsx:320-330` (Total)
- `src/pages/api-keys/page.tsx:331-341` (Available, success tone)
- `src/pages/api-keys/page.tsx:342-352` (Rate limited, error tone)
- `src/pages/api-keys/page.tsx:353-363` (Total Usage)
- `src/pages/api-keys/page.tsx:364-377` (Total Cost)

**Proposed primitive** — `StatPanel`:

```ts
type StatPanelProps = {
  icon: LucideIcon;
  label: string;
  value: ReactNode;
  tone?: "neutral" | "success" | "active" | "error" | "warning" | "info" | "pending";
  className?: string;
};
```

Internally maps `tone` → `bg-status-X/10` icon background + `text-status-X` icon + (optional) `text-status-X` value. `neutral` uses `bg-muted` + `text-muted-foreground`.

**Edge cases**:
- Phase 10 may surface this pattern in `budgets/page.tsx`, `dashboard/page.tsx`, or `usage/page.tsx` if the layout converges. For now, only api-keys uses it.
- Distinct from `StatsBar` (compact horizontal strip) — `StatPanel` is a Card-sized callout. Both stay.

**Placement**: `src/components/ui/stat-panel.tsx` (brand-agnostic).

---

## Cluster 4 — AlertCallout (4+ inline occurrences)

**Pattern**: an inline status-toned alert box, hand-rolled because shadcn's `Alert` only supports `default`/`destructive` variants and these call sites need success/warning/info as well.

```tsx
<div className="flex items-start gap-2 rounded-md border border-status-error/30 bg-status-error/5 p-3 text-status-error">
  <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
  <span>{message}</span>
</div>
```

**Examples**:
- `src/pages/mcp-servers/[id]/mcp-oauth-panel.tsx:279` (error tone)
- `src/pages/mcp-servers/[id]/mcp-oauth-panel.tsx:346` (active/warning tone — "Last error" callout)
- `src/pages/workflows/[id]/page.tsx:1504` (active tone)
- `src/pages/workflows/[id]/page.tsx:1609` (success tone, slimmer p-2 variant)
- `src/pages/config/page.tsx:1048` (success — uses Alert with custom className)

**Proposed primitive** — `AlertCallout`:

```ts
type AlertCalloutProps = {
  tone: "success" | "active" | "error" | "warning" | "info" | "neutral";
  icon?: LucideIcon;
  title?: ReactNode;
  className?: string;
  children: ReactNode;
};
```

Renders the canonical `flex items-start gap-2 rounded-md border border-status-{tone}/30 bg-status-{tone}/5 p-3 text-status-{tone}` shell with optional icon + optional bold title + children.

**Edge cases**:
- Phase 10 may consolidate the shadcn `Alert` + `AlertCallout` API by extending Alert's `variant` enum instead. For Phase 9 we add `AlertCallout` as a sibling primitive — Alert stays for `default`/`destructive` stock cases.
- `text-status-X` may not provide enough contrast on light mode — use `text-status-X-strong` (already added in Phase 1) when the inline-style call site does.

**Placement**: `src/components/ui/alert-callout.tsx` (brand-agnostic).

---

## Cluster 5 — SettingsRow / FormField (14 occurrences)

**Pattern**: a labeled form field wrapper. Canonical structure:

```tsx
<div className="space-y-2">
  <Label htmlFor="repo-url">Repository URL</Label>
  <Input id="repo-url" ... />
</div>
```

Sometimes followed by helper text:

```tsx
<p className="text-xs text-muted-foreground">{helper}</p>
```

**Examples**:
- `src/pages/repos/page.tsx:88-118` (5 fields)
- `src/pages/repos/[id]/page.tsx:88-131` (5 fields)
- `src/pages/config/page.tsx` (welcome card + connection editor: 6+ fields)
- `src/pages/tasks/page.tsx:113-170` (5 fields in CreateTask dialog)

**Proposed primitive** — `SettingsRow`:

```ts
type SettingsRowProps = {
  label: ReactNode;
  htmlFor?: string;
  helper?: ReactNode;
  required?: boolean;
  className?: string;
  children: ReactNode; // the input/select/textarea
};
```

Renders the `space-y-2` container with `<Label>` and the helper paragraph. `htmlFor` wires the label to the control; the consumer is responsible for passing the matching `id` on the input.

**Edge cases**:
- Some forms use `space-y-1` instead of `space-y-2` — Phase 10 will normalize on `space-y-2` since the size diff isn't load-bearing.
- Forms with grouped fields (e.g. `<div className="grid grid-cols-2 gap-4">` of two `SettingsRow`s) are unaffected — `SettingsRow` is one row, the grid is the call site's responsibility.

**Placement**: `src/components/ui/settings-row.tsx` (brand-agnostic).

---

## Cluster 6 — OAuthSection (4 occurrences)

**Pattern**: a connection-state section shared by all OAuth integration components. Section header + bordered status row with bullet dot + label + description, plus action button(s) to connect/disconnect/refresh.

Canonical shell (paraphrased from the four files):

```tsx
<section className="space-y-3">
  <h2 className="text-sm font-semibold uppercase text-muted-foreground tracking-wide">
    Connection
  </h2>
  <div className="border border-border rounded-md bg-muted/10">
    <div className="flex items-start justify-between gap-4 p-4">
      <div className="flex items-start gap-3">
        <div className="mt-1.5 h-2 w-2 rounded-full bg-status-{success|neutral} shrink-0" />
        <div className="space-y-1">
          <div className="text-sm font-medium">{label}</div>
          <div className="text-xs text-muted-foreground">{description}</div>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">{actions}</div>
    </div>
    {/* optional follow-on rows separated by border-t border-border */}
  </div>
</section>
```

**Examples**:
- `src/components/integrations/codex-oauth-section.tsx:113-157` (CLI status)
- `src/components/integrations/linear-oauth-section.tsx:127-289` (full pattern with redirect/webhook rows)
- `src/components/integrations/jira-oauth-section.tsx:113-200+` (full pattern)
- `src/components/integrations/claude-managed-section.tsx:140-180+` (status row + error variant)

**Proposed primitive** — `OAuthSection` + helper sub-components:

```ts
type OAuthSectionProps = {
  title: ReactNode;
  children: ReactNode; // status rows + footer
  className?: string;
};

type OAuthStatusRowProps = {
  connected: boolean;
  label: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
};
```

`OAuthSection` renders the section + uppercase header + bordered card shell. `OAuthStatusRow` renders the status-dot + label + description + actions row, with `connected` toggling `bg-status-success` vs `bg-status-neutral`. Additional rows (Redirect URI, Webhook URL, Footer) compose freely as children.

**Edge cases**:
- The four OAuth sections share the structure but differ in body content (codex shows a CLI snippet, linear shows redirect URI + webhook, jira shows authorization URL + webhook IDs, claude-managed shows a checklist). The primitive captures the shell only — body composition stays in the integration-specific files.
- The "error" state (e.g. `Alert` for `notConfigured` or `isError`) is rendered before the section header is shown. Primitive doesn't need to handle that — call sites short-circuit.

**Placement**: `src/components/shared/oauth-section.tsx` (agent-swarm-specific — encodes our integration-section shape).

---

## Cluster 7 — WorkflowNodeShell (3 occurrences)

**Pattern**: identical bordered card shell shared by `action-node.tsx`, `condition-node.tsx`, `trigger-node.tsx`. The only differences are the icon, label, type chip, and handles.

Canonical shell:

```tsx
<div
  className={cn(
    "bg-card border-2 rounded-lg shadow-sm px-3 py-2 min-w-[240px] max-w-[280px]",
    borderColor,
    selected && "ring-2 ring-status-active ring-offset-1 ring-offset-background",
  )}
>
  <Handle type="target" position={Position.Top} id="input" className={handleClass} />
  <div className="flex items-center gap-2">
    <div className={cn("p-1 rounded", iconBg)}>
      <Icon className={cn("h-4 w-4", iconText)} />
    </div>
    <div className="flex-1 min-w-0">
      <div className="text-xs font-medium truncate">{label}</div>
      <div className="text-[10px] text-muted-foreground uppercase">{nodeType}</div>
    </div>
  </div>
  {/* output handle(s) */}
</div>
```

**Examples**:
- `src/components/workflows/action-node.tsx:86-134` (multi-port + async badge variants)
- `src/components/workflows/condition-node.tsx:63-101` (multi-port variant)
- `src/components/workflows/trigger-node.tsx:22-46` (single source handle, no target)

**Proposed primitive** — `WorkflowNodeShell`:

```ts
type WorkflowNodeShellProps = {
  icon: LucideIcon;
  label: string;
  nodeType: string;
  iconClass: string;       // e.g. "text-action-script"
  iconBgClass: string;     // e.g. "bg-action-script/10"
  borderClass: string;     // already resolved (status override OR action border)
  handleClass: string;     // e.g. "!bg-action-script"
  selected?: boolean;
  showTargetHandle?: boolean; // false for trigger nodes
  outputPorts?: string[];  // ["default"] for single, ["a", "b"] for multi
  badge?: ReactNode;       // e.g. <Badge>async</Badge>
  className?: string;
};
```

Renders the full shell including target handle (conditional) and output handles (single or multi). Each call site reduces to a small variant config — the per-action-type style map stays in the action-node file but the JSX shrinks dramatically.

**Edge cases**:
- Multi-port output handle layout is the trickiest part — the primitive owns the loop and the inline-style left-position computation (already exempt-noted in workflow files via Phase 6).
- `react-flow`'s `Handle` component must remain a direct child of the node root for react-flow to wire connections; the primitive renders them, which is fine.
- Shape currently constrained by react-flow API — if we ever migrate off react-flow, this primitive needs revisiting. Acceptable for now.

**Placement**: `src/components/shared/workflow-node-shell.tsx` (agent-swarm-specific — couples to react-flow's `Handle`).

---

## Skipped clusters

### EmptyState (already covered)

`src/components/shared/empty-state.tsx` already implements the canonical icon-tile + title + description + action layout. Used in `pages/integrations/page.tsx:232`, `pages/integrations/[id]/page.tsx:150,415`. A few inline variants exist (`pages/dashboard/page.tsx:411,449,476` use `flex items-center justify-center py-8 text-sm text-muted-foreground`), but those are simpler "no data" lines without an icon — Phase 10 may consolidate them via an `EmptyState` `compact` variant, deferred.

### IntegrationStatusRow / IntegrationStatusBadge (already covered)

`src/components/integrations/integration-status-badge.tsx` already wraps the badge + tooltip + status-meta map. Used in `integration-card.tsx:80` and `pages/integrations/[id]/page.tsx:346`. No new primitive needed.

### StatsBar (already covered)

`src/components/shared/stats-bar.tsx` is its own primitive composed of `StatItem`. Used in `dashboard/page.tsx`. Distinct intent from `StatPanel` (compact horizontal strip vs Card-sized stat tile).

### SectionHeader (deferred)

The 10 `<h2>` occurrences across pages span 3 different scales (`text-lg font-semibold`, `text-sm font-semibold`, `text-sm font-semibold uppercase text-muted-foreground tracking-wide`). The uppercase-tracking-wide variant is absorbed by `OAuthSection`'s built-in header. The other two scales are rare enough (3 × text-lg, 4 × text-sm bare) that a `SectionHeader` primitive would feel over-abstract. Phase 10 will likely just inline `<h2 className="text-sm font-semibold">` since `Card` + `CardHeader` + `CardTitle` already cover the bordered-section case.

---

## Counter-intuitive observations (for plan review)

None of the clusters split unexpectedly — the 4 OAuth sections all share the same shell (no 3-of-4 outlier), and the 3 workflow nodes all share the same root structure. No abstraction-needs-refinement signal flagged.

One mild observation: `claude-managed-section.tsx` has *two* status variants (success and error states) where the others have one (connected/not-connected). The primitive supports both via the polymorphic `OAuthStatusRow` taking a `connected: boolean` and free-form `description: ReactNode`.

---

## Phase 10 implications

Once Phase 10 starts replacing call sites, it should produce roughly:
- **PageHeader**: 30+ pages × ~6 lines each saved → ~180 lines reduced
- **InfoRow / DefinitionList**: 32 instances × ~4 lines each → ~120 lines reduced
- **StatPanel**: 5 instances × ~10 lines each → ~50 lines reduced
- **AlertCallout**: 4 instances × ~5 lines each → ~20 lines reduced (mostly clarity gain)
- **SettingsRow**: 14 instances × ~5 lines each → ~70 lines reduced
- **OAuthSection**: 4 files × ~30 lines of shell each → ~120 lines reduced + structural normalization
- **WorkflowNodeShell**: 3 files collapse to small variant configs → ~150 lines reduced

Total ballpark: ~700 lines of layout JSX gone, replaced by primitive composition. That's the Phase-10 "compose-from-primitives" target.
