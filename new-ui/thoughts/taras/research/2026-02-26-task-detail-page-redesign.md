---
date: 2026-02-26T12:00:00Z
topic: "Task Detail Page Redesign: Modern Patterns from Linear, GitHub, Vercel, Jira"
---

# Task Detail Page Redesign: Modern Patterns from Linear, GitHub, Vercel, Jira

**Date:** 2026-02-26
**Context:** Redesigning `/tasks/[id]/page.tsx` in the Agent Swarm new-ui dashboard. Current implementation uses stacked Card components in a two-column grid. Goal: Linear-quality information hierarchy.

---

## 1. Layout Architecture: What the Best Tools Do

### Linear's Issue Detail

Linear's issue detail is the gold standard for task/issue pages. Key structural choices:

- **No cards.** The page is a single scrollable pane with semantic sections separated by whitespace and subtle dividers — not wrapped in card containers.
- **Compact metadata bar** at the top: status, priority, assignee, labels, project, cycle — all inline, all editable. Uses icon+text pairs with no labels for obvious fields (the icon IS the label).
- **Title as a large editable heading** — the visual anchor of the page.
- **Description as the primary content** — a rich-text body taking full width beneath the title.
- **Activity/comments at the bottom** — a timeline that includes both human comments and system events (status changes, assignment changes) interleaved chronologically.
- **Right sidebar (properties panel)** — visible on wider screens, contains all metadata fields in a key-value list. On narrow screens, this collapses into the top metadata bar.

### GitHub Issues

- **Title + status badge** as the page header (large).
- **Metadata in a right sidebar**: assignees, labels, projects, milestone, development links. Each is a compact row with label on left, value on right.
- **Tabs below the header**: "Conversation" (default), "Files changed" (for PRs). The conversation tab interleaves comments with timeline events.
- **Error/failure states** for CI: inline status checks with red X icons and expandable detail, not a separate section.

### Jira Issue Detail

- **Breadcrumb > Title** at top.
- **Two-column layout**: wide left (description + activity), narrow right (properties panel — status, assignee, priority, labels, dates, etc.).
- Properties panel uses a definition list: gray label, then value underneath or beside it. No card borders.
- **Activity section** uses tabs: "All", "Comments", "History", "Work log".

### Vercel Deployment Detail

- **Status banner** at the very top — full-width, colored by state (green for success, red for error, yellow for building). This is NOT a card; it's a contextual header background.
- **Metadata row** below banner: commit, branch, time, duration — all inline with monospaced values.
- **Tabs** for content: "Overview", "Logs", "Source", "Functions". This is the primary navigation within the detail page.
- **Logs** are shown in a terminal-like monospaced panel with auto-scroll — very similar to the existing SessionLogViewer.

---

## 2. Concrete Design Patterns to Apply

### Pattern A: Kill the Cards — Use Semantic Sections

**Problem with current approach:** Every piece of content (description, progress, output, failure reason, event history) is wrapped in `<Card><CardHeader><CardTitle>...</CardTitle></CardHeader><CardContent>...</CardContent></Card>`. This creates visual noise — every section has a border, a header, padding. It all looks the same, so nothing stands out.

**What to do instead:**

```
Section title as a small uppercase tracking-wide label
Content directly below with appropriate typography
Generous whitespace between sections (space-y-6)
Optional: a subtle separator line between major sections
```

**Code pattern:**

```tsx
{/* Section — no Card wrapper */}
<div>
  <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
    Description
  </h3>
  <pre className="whitespace-pre-wrap text-sm font-mono leading-relaxed">
    {task.task}
  </pre>
</div>
```

Reserve cards (with borders) ONLY for content that needs visual containment:
- Session logs (because they're a scrollable panel)
- Failure alerts (because they need to call attention)

### Pattern B: Metadata Properties Panel (Right Side or Inline)

Instead of scattering metadata across badges in the header, consolidate into a structured properties panel. Two layouts depending on screen width:

**Wide screen:** Main content (left, ~60-65%) + Properties panel (right, ~35-40%)

```tsx
<div className="flex gap-8">
  {/* Main content */}
  <div className="flex-1 min-w-0 space-y-6">
    {/* title, description, output, tabs, etc. */}
  </div>

  {/* Properties panel */}
  <aside className="w-64 shrink-0 space-y-4">
    <PropertyRow label="Status" value={<StatusBadge status={task.status} />} />
    <PropertyRow label="Priority" value={`P${task.priority}`} />
    <PropertyRow label="Type" value={task.taskType} />
    <PropertyRow label="Agent" value={agentLink} />
    <PropertyRow label="Created" value={formatSmartTime(task.createdAt)} />
    <PropertyRow label="Finished" value={task.finishedAt ? formatSmartTime(task.finishedAt) : "—"} />
    {task.tags?.length > 0 && (
      <PropertyRow label="Tags" value={
        <div className="flex flex-wrap gap-1">
          {task.tags.map(t => <Badge key={t} variant="outline">{t}</Badge>)}
        </div>
      } />
    )}
  </aside>
</div>
```

**PropertyRow component:**

```tsx
function PropertyRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5 text-sm">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="text-right">{value ?? "—"}</span>
    </div>
  );
}
```

This matches Linear/GitHub/Jira where metadata is a right-aligned properties panel, not inline badges.

### Pattern C: Status-Aware Page Header

Instead of a generic header, make the page status immediately scannable:

```tsx
<div className="space-y-1">
  {/* Status indicator — contextual color band */}
  {task.status === "failed" && (
    <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span>Task failed{task.failureReason ? `: ${task.failureReason.slice(0, 100)}` : ""}</span>
    </div>
  )}

  {/* Title area */}
  <div className="flex items-center gap-3">
    <StatusBadge status={task.status} size="md" />
    <h1 className="text-lg font-semibold truncate">
      {task.task.split("\n")[0].slice(0, 80)}
    </h1>
  </div>

  {/* Breadcrumb-style context */}
  <div className="text-xs text-muted-foreground">
    {task.id.slice(0, 8)} · Created {formatSmartTime(task.createdAt)}
    {task.finishedAt && ` · Finished ${formatSmartTime(task.finishedAt)}`}
  </div>
</div>
```

### Pattern D: Tabs for Content Switching (Not Stacked Cards)

The biggest improvement: use tabs to separate description/output from session logs, instead of stacking them vertically.

**Recommended tab structure:**

| Tab | Contents | When shown |
|-----|----------|------------|
| **Overview** | Description + Progress + Output | Always |
| **Session** | SessionLogViewer | When sessionLogs exist |
| **Activity** | LogTimeline (event history) | When task.logs exist |

```tsx
<Tabs defaultValue="overview">
  <TabsList variant="line">
    <TabsTrigger value="overview">Overview</TabsTrigger>
    {hasSessionLogs && (
      <TabsTrigger value="session">
        Session
        <span className="ml-1.5 text-[10px] text-muted-foreground">
          {sessionLogs.length}
        </span>
      </TabsTrigger>
    )}
    {task.logs && task.logs.length > 0 && (
      <TabsTrigger value="activity">Activity</TabsTrigger>
    )}
  </TabsList>

  <TabsContent value="overview" className="space-y-6 mt-4">
    {/* Description section */}
    <div>
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
        Description
      </h3>
      <pre className="whitespace-pre-wrap text-sm font-mono leading-relaxed">
        {task.task}
      </pre>
    </div>

    {/* Progress section */}
    {task.progress && (
      <div>
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
          Progress
        </h3>
        <pre className="whitespace-pre-wrap text-sm font-mono leading-relaxed text-muted-foreground">
          {task.progress}
        </pre>
      </div>
    )}

    {/* Output section */}
    {task.output && (
      <div>
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
          Output
        </h3>
        <pre className="whitespace-pre-wrap text-sm font-mono leading-relaxed bg-muted/30 rounded-md p-3 max-h-64 overflow-auto">
          {task.output}
        </pre>
      </div>
    )}
  </TabsContent>

  {hasSessionLogs && (
    <TabsContent value="session" className="mt-4">
      <SessionLogViewer logs={sessionLogs} className="h-[calc(100vh-280px)]" />
    </TabsContent>
  )}

  {task.logs && task.logs.length > 0 && (
    <TabsContent value="activity" className="mt-4">
      <LogTimeline logs={task.logs} />
    </TabsContent>
  )}
</Tabs>
```

Use `variant="line"` on TabsList for the underline style (like Linear/GitHub) rather than the pill/segmented style.

### Pattern E: Error/Failure States

Modern tools use three levels of error communication:

1. **Page-level alert banner** (Vercel-style): A colored bar at the top of the detail content, before tabs.
2. **Status badge color**: Red dot in StatusBadge (already exists).
3. **Inline failure detail**: Within the Overview tab, failure reason shown with red accent.

**Alert banner for failed tasks:**

```tsx
{task.status === "failed" && (
  <div className="flex items-start gap-3 rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3">
    <AlertTriangle className="h-4 w-4 text-red-400 mt-0.5 shrink-0" />
    <div className="space-y-1 min-w-0">
      <p className="text-sm font-medium text-red-400">Task Failed</p>
      {task.failureReason && (
        <pre className="text-xs text-red-300/80 whitespace-pre-wrap font-mono">
          {task.failureReason}
        </pre>
      )}
    </div>
  </div>
)}
```

**Do NOT use a separate Card for failure.** The alert banner is sufficient and more scannable.

For cancelled tasks, use a similar but muted treatment:

```tsx
{task.status === "cancelled" && (
  <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
    <XCircle className="h-4 w-4 shrink-0" />
    Task was cancelled
    {task.rejectionReason && ` — ${task.rejectionReason}`}
  </div>
)}
```

---

## 3. Information Hierarchy Rules

Based on analysis across Linear, GitHub, Vercel, and Jira:

### Visual Weight (highest to lowest):

1. **Status/Error banner** — full width, colored background, appears first
2. **Title** — largest text on the page (text-lg or text-xl)
3. **Tab content** — the primary reading area, takes most vertical space
4. **Properties panel** — secondary info, smaller text, right-aligned
5. **Breadcrumb/meta** — smallest text, muted color, serves as wayfinding

### Spacing Scale:

- Between major sections (header / alert / tabs): `space-y-4` or `space-y-6`
- Within a tab's content sections: `space-y-6`
- Within a property row: `py-1.5`
- Between label and content within a section: `mb-2`

### Typography Scale:

| Element | Classes |
|---------|---------|
| Page title | `text-lg font-semibold` |
| Section label | `text-xs font-semibold text-muted-foreground uppercase tracking-wider` |
| Body text | `text-sm` |
| Monospaced content | `text-sm font-mono leading-relaxed` |
| Meta/timestamps | `text-xs text-muted-foreground` |
| Property label | `text-sm text-muted-foreground` |
| Property value | `text-sm` |

---

## 4. Full Recommended Page Structure

```
[Back to Tasks]

[Error/Status Banner — only for failed/cancelled]

[StatusBadge]  Task title (first line of task.task)
task-id-short · Created 2h ago · Finished 1h ago

+--------------------------------------+------------------+
|                                      |  Properties      |
|  [Overview] [Session] [Activity]     |  Status    *DONE |
|  ---------------------------------   |  Priority  P1    |
|                                      |  Type      dev   |
|  DESCRIPTION                         |  Agent     alice  |
|  <task body>                         |  Source    api   |
|                                      |  Created   2h ago|
|  PROGRESS                            |  Finished  1h ago|
|  <progress text>                     |  Tags      #ui   |
|                                      |                  |
|  OUTPUT                              |                  |
|  +----------------------------------+|                  |
|  | <monospaced output in muted bg>  ||                  |
|  +----------------------------------+|                  |
|                                      |                  |
+--------------------------------------+------------------+
```

On screens < lg, the properties panel moves above the tabs as a compact horizontal summary or a collapsible section.

---

## 5. Specific Improvements to Current Code

### Remove:
- All `<Card><CardHeader><CardTitle>` wrappers for Description, Progress, Output
- The two-column grid (`grid gap-4 md:grid-cols-[1fr_1.5fr]`) — replace with flex sidebar layout
- Scattered inline badges in the header (move to properties panel)
- Separate Failure Reason card — replace with alert banner

### Add:
- `<Tabs>` with line variant for Overview / Session / Activity
- Properties panel `<aside>` with `PropertyRow` components
- Error/status alert banner at page top (before tabs)
- `<Separator>` between properties panel sections if needed
- Responsive breakpoint: stack properties above content on `< lg`

### Keep:
- `<StatusBadge>` component (it's well-designed)
- `<SessionLogViewer>` (move into Session tab)
- `<LogTimeline>` (move into Activity tab)
- Back button pattern

---

## 6. Component Inventory (What Already Exists)

Available in `@/components/ui/` that are relevant:
- `tabs.tsx` — supports `variant="line"` for underline style
- `badge.tsx` — for tags
- `separator.tsx` — for dividing properties sections
- `alert.tsx` — could use for error banner, or just build custom
- `skeleton.tsx` — for loading states
- `scroll-area.tsx` — for constrained scrolling in output/logs

Components to create:
- `PropertyRow` or `MetadataPanel` — simple, ~15 lines, can be local to the page or shared
- No new shadcn installs needed

---

## 7. Inspiration Reference Links

These are the specific UIs being referenced (for visual reference if needed):
- **Linear**: linear.app — any issue detail page
- **GitHub**: github.com — any issue or PR detail page
- **Vercel**: vercel.com/dashboard — any deployment detail page
- **Jira**: atlassian.com/software/jira — issue detail view
