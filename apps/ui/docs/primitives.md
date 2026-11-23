# Dashboard primitives

Moved from `apps/ui/CLAUDE.md`, which keeps the rule that causes damage when missed and a pointer here. Paths are relative to `apps/ui/` unless a line says repo root.

<!-- Applies when you are building a page, modifying a page's layout, or composing UI in ui. -->

## Primitives catalog

**Compose from primitives. Do not hand-roll a `<div>` layout if a primitive already exists. Add a new primitive when you'd otherwise repeat the pattern.**

### Compose-only rule

Pages and composed components are built from primitives. Raw `<div>` layouts that re-implement a primitive's responsibility are forbidden. If you find yourself writing a `<div className="flex items-center gap-...">` to recreate a header/section/row pattern, use or create the relevant primitive. Recurring inline logic (status formatters, time/token formatters, percent-threshold class pickers) belongs in `src/lib/<name>.ts` or `src/hooks/<name>.ts` once it appears in 2+ call sites.

### shadcn primitives (`src/components/ui/`)

| Primitive | Usage | Example |
|---|---|---|
| `Alert`, `AlertTitle`, `AlertDescription` | default + destructive informational alert | `<Alert variant="destructive"><AlertCircle /><AlertDescription>Failed</AlertDescription></Alert>` |
| `AlertCallout` | status-toned inline alert (success/active/error/warning/info/pending/paused/neutral) | `<AlertCallout tone="error" icon={AlertCircle}>Last error: ...</AlertCallout>` |
| `AlertDialog` | confirmation dialog for destructive actions | `<AlertDialog><AlertDialogTrigger>...<AlertDialogContent>...` |
| `Avatar`, `AvatarImage`, `AvatarFallback` | user/agent avatar with fallback | `<Avatar><AvatarImage src={url} /><AvatarFallback>TY</AvatarFallback></Avatar>` |
| `Badge` | tags, chips, status pills (use `size="tag"` for small uppercase) | `<Badge variant="outline" size="tag">PENDING</Badge>` |
| `Button` | actions (variants: default, outline, ghost, destructive, destructive-outline, secondary, link) | `<Button size="sm" variant="outline">Save</Button>` |
| `Card`, `CardHeader`, `CardTitle`, `CardAction`, `CardContent`, `CardFooter` | bordered section container | `<Card><CardHeader><CardTitle>...</CardTitle></CardHeader><CardContent>...</CardContent></Card>` |
| `Command`, `CommandInput`, `CommandList`, `CommandItem` | command palette / fuzzy-search list | `<Command><CommandInput /><CommandList>...</CommandList></Command>` |
| `DetailPageBody`, `DetailPageRail`, `DetailPageSection`, `QuickStats`, `QuickStat`, `Relationships`, `Relationship`, `DangerZone` | canonical detail-page body layout (1fr / 280px rail) per brand-kit `preview/detail-page-template.html`. Compose pages with `<PageHeader />` above + `<DetailPageBody main={...} rail={<DetailPageRail>…</DetailPageRail>} />`. Pages dominated by editors / split-views / Monaco (templates, workflow-runs, workflows) are exempt. | `<DetailPageBody main={<Form />} rail={<DetailPageRail><QuickStats><QuickStat label="Created" value="…" /></QuickStats><Relationships><Relationship label="Owner" to="/agents/abc" /></Relationships><DangerZone><Button variant="destructive-outline" className="w-full">Delete</Button></DangerZone></DetailPageRail>} />` |
| `Dialog`, `DialogTrigger`, `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogFooter` | modal dialog | `<Dialog open={open}><DialogContent>...</DialogContent></Dialog>` |
| `DropdownMenu`, `DropdownMenuTrigger`, `DropdownMenuContent`, `DropdownMenuItem` | dropdown actions menu | `<DropdownMenu><DropdownMenuTrigger>...</DropdownMenuTrigger><DropdownMenuContent>...` |
| `ContextMenu`, `ContextMenuTrigger`, `ContextMenuContent`, `ContextMenuItem`, `ContextMenuSeparator` | right-click (long press) actions menu, same look as `DropdownMenu` | `<ContextMenu><ContextMenuTrigger asChild>{row}</ContextMenuTrigger><ContextMenuContent>...` |
| `InfoRow`, `DefinitionList` | uppercase-label + value pair, used in detail pages | `<DefinitionList><InfoRow label="Role">Engineer</InfoRow></DefinitionList>` |
| `Input` | text input | `<Input id="name" value={v} onChange={...} />` |
| `Label` | form-control label (use inside `SettingsRow`) | `<Label htmlFor="name">Name</Label>` |
| `PageHeader` | route-page description + action row. Plain-string `title`s are NOT rendered (the breadcrumb owns page identity), keep passing them anyway; only ReactNode titles render (badges, back buttons, editable names). On LIST pages with a filter/toolbar row, don't park a lone action here, render it as an icon Button + Tooltip at the toolbar's right end (see tasks/skills/mcp-servers/connections) | `<PageHeader title="Pages" description="…" />` |
| `Progress` | linear progress bar | `<Progress value={75} />` |
| `ScrollArea`, `ScrollBar` | scrollable container with custom scrollbar | `<ScrollArea className="h-72">...</ScrollArea>` |
| `Select`, `SelectTrigger`, `SelectValue`, `SelectContent`, `SelectItem` | dropdown select | `<Select value={v} onValueChange={...}><SelectTrigger>...</SelectTrigger>...` |
| `Separator` | horizontal/vertical divider | `<Separator />` |
| `SettingsRow` | labeled form-field wrapper (label + control + optional helper) | `<SettingsRow label="URL" htmlFor="url" helper="..."><Input id="url" /></SettingsRow>` |
| `Sheet`, `SheetTrigger`, `SheetContent` | slide-in side drawer | `<Sheet><SheetContent side="right">...</SheetContent></Sheet>` |
| `Sidebar`, `SidebarHeader`, `SidebarContent`, `SidebarMenu` | shadcn sidebar shell (used by `app-sidebar.tsx`) | `<Sidebar><SidebarContent>...</SidebarContent></Sidebar>` |
| `Skeleton` | loading-state placeholder | `<Skeleton className="h-4 w-32" />` |
| `Sonner` (`Toaster`) | toast notifications | mounted at root, call `toast.success("...")` |
| `StatPanel` | Card-sized stat tile (icon-bg + label + numeric value, status-toned) | `<StatPanel icon={Key} label="Total Keys" value={42} tone="success" />` |
| `Switch` | toggle | `<Switch checked={v} onCheckedChange={...} />` |
| `Table`, `TableHeader`, `TableRow`, `TableCell` | NEVER use for data lists: use `DataGrid` instead. Reserved for static layout tables (e.g. pricing). |
| `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent` | tabbed sections | `<Tabs value={tab} onValueChange={setTab}><TabsList>...</TabsList>...` |
| `Textarea` | multi-line text input | `<Textarea value={v} onChange={...} />` |
| `Tooltip`, `TooltipTrigger`, `TooltipContent` | hover/focus tooltip | `<Tooltip><TooltipTrigger>...</TooltipTrigger><TooltipContent>...</TooltipContent></Tooltip>` |

### Agent-swarm-specific primitives (`src/components/shared/`)

| Primitive | Usage | Example |
|---|---|---|
| `AgentLink` | linked agent name with avatar | `<AgentLink agentId={id} agentName={name} />` |
| `CollapsibleDescription` | truncated text with show-more toggle | `<CollapsibleDescription text={long} />` |
| `CollapsibleSection` | folding section header | `<CollapsibleSection title="Details">...</CollapsibleSection>` |
| `CommandMenu` | global ⌘K palette. A new route needs a `handle` in `app/routes.tsx`: `nav({...})` lists it in "Go to", `unlisted(reason)` opts out; an entity list (`/x` + `/x/:id`) also names `search` providers (`components/command-palette/providers.tsx`) or a `searchOptOut`. `app/routes.test.tsx` fails otherwise. Page-specific commands: `useCommandMenuGroup` | mounted at root |
| `DataGrid` | AG Grid wrapper: REQUIRED for all data lists | `<DataGrid rowData={rows} columnDefs={cols} />` |
| `EmptyState` | icon + title + description + optional action. First-run page empties add `entity` (renders an "Ask the swarm" CTA that seeds a new session) + `fullPage` (vertical centering) | `<EmptyState icon={Inbox} title="No tasks yet" description="..." entity="task" fullPage />` |
| `ErrorBoundary` | top-level error fallback | wrap routes |
| `JsonViewer` | collapsible JSON tree with copy | `<JsonViewer data={obj} />` |
| `NameConnectionModal` | first-time connection naming | mounted on first connect |
| `OAuthSection`, `OAuthStatusRow`, `OAuthSectionRow` | shared OAuth integration shell (codex/linear/jira/claude-managed) | `<OAuthSection title="Connection"><OAuthStatusRow connected={ok} label="..." actions={...} /></OAuthSection>` |
| `PageSkeleton` | route-page loading placeholder | `<PageSkeleton />` |
| `SessionId` | short clickable session/agent ID chip | `<SessionId id={id} />` |
| `SessionLogViewer` | streaming agent-session log viewer | `<SessionLogViewer sessionId={id} />` |
| `StatsBar` | compact horizontal stats strip (used on dashboard) | `<StatsBar agents={...} tasks={...} />` |
| `StatusBadge` | semantic status chip (18 statuses, uses status tokens) | `<StatusBadge status="in_progress" />` |
| `UsageSummary` | per-agent token/cost summary panel | `<UsageSummary agentId={id} />` |
| `WorkflowNodeShell` | shared shell for action / condition / trigger nodes (react-flow) | `<WorkflowNodeShell icon={Bot} label={name} nodeType="agent-task" borderClass="..." iconBgClass="..." iconClass="..." handleClass="..." />` |

If you find yourself writing `<div className="flex items-center gap-2">` or `<div className="space-y-2"><h1>...</h1>...</div>` to recreate one of the patterns above, stop and use the primitive. If the pattern doesn't fit any primitive yet but appears 2+ times, add a new primitive to `src/components/{ui,shared}/` rather than copying the JSX a third time.

### Detail-page layout convention

Detail pages (`pages/*/[id]/page.tsx`) follow the brand-kit's `preview/detail-page-template.html` contract:
- Header: `<PageHeader />` (badges, primary actions, the entity NAME belongs to the breadcrumb, so don't re-render it in an h1 when the breadcrumb resolves it). Single destructive actions (Delete) go in the header alongside other primary actions, they are first-class operations, not buried below the fold.
- Body: `<DetailPageBody main={...} rail={<DetailPageRail>…</DetailPageRail>} />`. Right rail is fixed 280px; below `lg` the rail stacks below main.
- Rail sections, in order: `<QuickStats>` (k/v at-a-glance) → `<Relationships>` (linked entities, arrow link) → `<DangerZone>` (full-width destructive button, use only when a page has multiple destructive actions or the action is genuinely supplementary, e.g. an irreversible reset paired with a primary save).

A handful of detail pages are exempt because their identity is an editor or split-view (Monaco-dominated, react-flow graph): `templates/[id]`, `templates/[id]/history/[version]`, `workflow-runs/[id]`, `workflows/[id]`. Don't shoehorn the primitive in there. For tabs-driven pages where a single tab carries the primary content (agents `Profile`, mcp-servers `Configuration`), apply the primitive INSIDE that tab body so the rail rides alongside.

<!-- Applies when you are rendering a tag, status chip, pill, or small badge in ui. -->

## Tags / status chips

Use the `tag` size on `Badge`: the small-uppercase chip styling (`text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase`) is baked into the component:

```tsx
<Badge variant="outline" size="tag">PENDING</Badge>
<Badge variant="outline" size="tag" className="border-status-info/30 text-status-info-strong">QUEUED</Badge>
```

The `variant` controls color/background (outline, default, secondary, destructive, ghost, link). `size="tag"` controls the chip sizing/casing. Combine them: do not re-inline the className. For semantic-toned chips, use status tokens (`status-info`, `status-success`, etc.), never raw Tailwind palette literals (the lint gate fails the build on `border-sky-500/30`).

<!-- Applies when you are rendering a destructive-outline icon or button in ui (delete, remove, disconnect). -->

## Destructive-outline buttons

Use `variant="destructive-outline"` on `Button` for red-outlined destructive actions (delete, remove, disconnect). The red border/text/hover colors are baked in:

```tsx
<Button variant="destructive-outline" size="icon"><Trash2 /></Button>
<Button variant="destructive-outline" size="sm">Delete</Button>
```

Do not re-inline the underlying classes (`border-status-error/30 text-status-error-strong hover:bg-status-error/10`) or, worse, raw palette literals (`border-red-500/30 text-red-400 hover:bg-red-500/10`); the lint gate fails the build on the latter. Pair with `AlertDialog` for confirmation.

<!-- Applies when you are copying a primitive from ~/Downloads/swarm-design-system or comparing ui's components/ui to the brand kit. -->

## Primitive parity with brand kit

ui's primitives in `src/components/ui/` are the **canonical implementation**. The brand kit at `~/Downloads/swarm-design-system/new-ui/src/components/ui/` is a snapshot of an earlier version of the ui, it is a brand reference, not a build artifact.

Brand-kit divergences are tracked in [`thoughts/taras/research/2026-05-06-design-system-audit.md`](../../../thoughts/taras/research/2026-05-06-design-system-audit.md) (see "Phase 8, Primitive parity") and reconciled deliberately. **Do not blindly copy from `~/Downloads/swarm-design-system`**, consult the audit first, especially for the `Button` `destructive-outline` variant where the ui's status-token form (Phase 4) is canonical and adopting the brand kit's raw `red-*` literals would break the Phase 7 `check:tokens` lint gate.
