# Agent Swarm Dashboard (ui)

React + Vite + shadcn/ui + Tailwind + AG Grid + react-query dashboard for the Agent Swarm API.

## Design Context

Strategic design context lives in [PRODUCT.md](./PRODUCT.md) (register, users, positioning, brand personality, design principles) and the visual system in [DESIGN.md](./DESIGN.md) (tokens, typography, elevation, component doctrine). Read them before designing or restyling any UI surface.

<important if="you are running the ui dev server, building it, or setting up ui locally">

## Quick start

| Command | What it does |
|---|---|
| `bun install` | Install dependencies (run from repo root — `ui` is a Bun workspace member) |
| `bun run dev` | Dev server on http://localhost:5274 |
| `bun run build` | Production build |
| `bun run preview` | Preview production build |
| `bun run lint` / `bun run lint:fix` | Biome check / auto-fix |
| `bunx tsc --noEmit` | Type check |

Dev server proxies `/api/*` and `/health` to `http://localhost:3013`.

</important>

<important if="you are creating a new file in ui/src/ and need to decide where it lives">

## Project structure

- Pages use **default exports** (required for `React.lazy` in the router).
- Import via `@/` path alias.

</important>

<important if="you are adding or modifying react-query hooks, api calls, or fetch intervals in ui">

## Data fetching

- react-query with a **5s auto-polling** default on most list/detail hooks.
- Hooks live under `src/api/hooks/` — one file per domain (e.g. `use-agents.ts`, `use-tasks.ts`).
- API client singleton: `src/api/client.ts`.

</important>

<important if="you are adding or modifying a data table, list, or grid view in ui">

## Data tables (AG Grid)

- **Always use `DataGrid`** from `@/components/shared/data-grid`. **Never** use HTML `<Table>` components for data lists — this is a hard rule.
- Page wrapper for grid pages in the main layout: `flex flex-col flex-1 min-h-0 gap-4` (DataGrid fills remaining height).
- For config-style pages that scroll, set `domLayout="autoHeight"` on the DataGrid.
- Sizing: `width` for fixed columns, `flex: 1 + minWidth` for stretch. `DataGrid` calls `sizeColumnsToFit()` on grid ready.
- Interactive elements in cell renderers (buttons, links) MUST call `e.stopPropagation()` to prevent row-click.
- Delete actions use `AlertDialog` confirmation (not click-again patterns).

</important>

<important if="you are rendering a tag, status chip, pill, or small badge in ui">

## Tags / status chips

Use the `tag` size on `Badge` — the small-uppercase chip styling (`text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase`) is baked into the component:

```tsx
<Badge variant="outline" size="tag">PENDING</Badge>
<Badge variant="outline" size="tag" className="border-status-info/30 text-status-info-strong">QUEUED</Badge>
```

The `variant` controls color/background (outline, default, secondary, destructive, ghost, link). `size="tag"` controls the chip sizing/casing. Combine them — do not re-inline the className. For semantic-toned chips, use status tokens (`status-info`, `status-success`, etc.) — never raw Tailwind palette literals (the lint gate fails the build on `border-sky-500/30`).

</important>

<important if="you are rendering a destructive-outline icon or button in ui (delete, remove, disconnect)">

## Destructive-outline buttons

Use `variant="destructive-outline"` on `Button` for red-outlined destructive actions (delete, remove, disconnect). The red border/text/hover colors are baked in:

```tsx
<Button variant="destructive-outline" size="icon"><Trash2 /></Button>
<Button variant="destructive-outline" size="sm">Delete</Button>
```

Do not re-inline the underlying classes (`border-status-error/30 text-status-error-strong hover:bg-status-error/10`) or — worse — raw palette literals (`border-red-500/30 text-red-400 hover:bg-red-500/10`); the lint gate fails the build on the latter. Pair with `AlertDialog` for confirmation.

</important>

<important if="you are copying a primitive from ~/Downloads/swarm-design-system or comparing ui's components/ui to the brand kit">

## Primitive parity with brand kit

ui's primitives in `src/components/ui/` are the **canonical implementation**. The brand kit at `~/Downloads/swarm-design-system/new-ui/src/components/ui/` is a snapshot of an earlier version of the ui — it is a brand reference, not a build artifact.

Brand-kit divergences are tracked in [`thoughts/taras/research/2026-05-06-design-system-audit.md`](../thoughts/taras/research/2026-05-06-design-system-audit.md) (see "Phase 8 — Primitive parity") and reconciled deliberately. **Do not blindly copy from `~/Downloads/swarm-design-system`** — consult the audit first, especially for the `Button` `destructive-outline` variant where the ui's status-token form (Phase 4) is canonical and adopting the brand kit's raw `red-*` literals would break the Phase 7 `check:tokens` lint gate.

</important>

<important if="you are writing Tailwind classes, picking colors, or styling components in ui">

## Theming

- **Never hardcode dark-mode colors** (no `bg-zinc-950`, `text-zinc-400`, etc.). Use CSS variable classes: `bg-background`, `bg-muted`, `text-foreground`, `text-muted-foreground`, `border-border`, `bg-accent`.
- **Two-tier lines.** Non-structural lines — `Separator`, `divide-y` row rules, data-grid row borders — sit on the subtle tier: `divide-border-subtle` / `bg-border-subtle` / `border-border-subtle`. Card outlines and inputs keep full `border-border` / `border-input` (the stronger stop is the affordance). See DESIGN.md § Elevation.
- **Amber** is brand `--primary` — use it for interactive / active states only.
- **Status colors come from named semantic tokens** — `bg-status-success`, `text-status-error`, `bg-status-active`, etc. — defined in `src/styles/globals.css` (light + dark). Action-type colors (workflow nodes) come from `bg-action-*` tokens. **Do not** use raw Tailwind palette literals (`bg-emerald-500`, `text-amber-400`, `border-red-500/30`, etc.) in app code. Translucent fills use the standard Tailwind opacity syntax: `bg-status-success/10`, `border-action-script/50`.
- **Color literal lint gate.** `bun run check:tokens` (also runs in CI via `merge-gate.yml`'s `ui-lint` job) fails the build on any raw Tailwind color palette literal, `dark:` palette variant, arbitrary color literal (e.g. `bg-[#0d1117]`), or hardcoded hex in `src/`. To use a new color, add a token to `src/styles/globals.css`. Monaco editor themes are exempt and live in `src/lib/monaco-themes.ts`.
- CSS variables defined in `src/styles/globals.css`; AG Grid themed via `src/styles/ag-grid.css`.
- **Theme presets** live in `src/lib/themes.ts` (+ `src/lib/theme-classics.ts` for the classic editor themes): named bundles of token overrides emitted as `[data-theme="<id>"]` rules (light + dark), applied on `<html>` (Settings → Appearance, localStorage) or scoped to one swarm-app canvas (`definition.theme` + the viewer's reserved `$theme` user-config override). Emitted blocks are SELF-CONTAINED (the builder spreads the stock base under each preset's overrides), so a scoped preset fully resets its canvas instead of blending with the dashboard preset; `hive` scoped = explicit reset to stock, NO attribute = inherit the dashboard. Action/destructive tokens are never themed; status tokens are themed ONLY by the classic presets (hue semantics fixed). The preset id list is duplicated in two agent-facing texts — `templates/skills/apps/content.md` and the `app-upsert` tool description — update them when the catalog changes.
- **Clickable = pointer** is enforced globally in `globals.css` (`button:not(:disabled)`, `[role="button"]`, `summary`, …) — never add per-component `cursor-pointer` again; disabled controls keep the default cursor. Exception: buttons inside the global sidebar (`[data-slot="sidebar-container"]`) keep the default arrow (Taras's call — nav-rail feel); its nav anchors stay pointer natively.
- **Colorless borders are themed.** A base rule defaults `border-color` to `var(--color-border)` (Tailwind v4 otherwise leaves bare `border`/`border-r` utilities on `currentColor` — near-black in light, and blind to theme presets). Explicit `border-<color>` utilities still win; anything needing a text-colored border must say `border-current`. Dark overrides in `globals.css` MUST stay on `.dark` alone (never `.dark *`) or scoped wrappers break; portalled content inside an app canvas re-stamps `data-theme` via `useJsonRenderThemeAttr()` from `src/lib/json-render/theme-scope.tsx`.
- Use `cn()` from `@/lib/utils` for conditional class merging.

### Semantic token reference

Status tokens (cover the 18 statuses in `status-badge.tsx`'s `statusConfig` map plus a few extras used by integrations and workflow runs).

`-strong` variants exist for text emphasis on neutral surfaces (darker in light mode for contrast). Use `bg-status-X` for fills, `text-status-X-strong` for emphasis text on cards/pages. In dark mode `-strong` collapses to the canonical value. **2026-08-06: the palette migrated to the PALE set** (same hues, ~40% less chroma, lifted lightness; fills take dark `-foreground` text in both modes) — the `*-500`/`*-400` source columns below describe the original derivation only; current values live in `src/styles/globals.css`. Classic-theme presets (`src/lib/theme-classics.ts`) carry their own status palettes — the only sanctioned status theming; hue semantics never change.

| Token | Usage | Light source | Dark source |
|---|---|---|---|
| `status-success` | idle, completed, healthy, approved (fill) | emerald-500 | emerald-400 |
| `status-success-strong` | success-state text emphasis | emerald-600 | emerald-400 |
| `status-active` | busy, offered, in_progress, running (fill) | amber-500 | amber-400 |
| `status-active-strong` | active-state text emphasis | amber-600 | amber-400 |
| `status-error` | failed, unhealthy, rejected (fill) | red-500 | red-400 |
| `status-error-strong` | error-state text emphasis | red-600 | red-400 |
| `status-info` | informational chips (fill) | sky-500 | sky-400 |
| `status-info-strong` | info-state text emphasis | sky-600 | sky-400 |
| `status-pending` | pending, waiting, starting (fill) | yellow-500 | yellow-400 |
| `status-pending-strong` | pending-state text emphasis | yellow-600 | yellow-400 |
| `status-warning` | timeout, threshold-warning (fill) | orange-500 | orange-400 |
| `status-warning-strong` | warning-state text emphasis | orange-600 | orange-400 |
| `status-paused` | paused, reviewing (fill) | blue-500 | blue-400 |
| `status-paused-strong` | paused-state text emphasis | blue-600 | blue-400 |
| `status-neutral` | offline, backlog, unassigned, cancelled, stopped, skipped (fill) | zinc-500 | zinc-400 |
| `status-neutral-strong` | neutral-state text emphasis | zinc-600 | zinc-400 |

Action-type tokens (workflow node types from `components/workflows/action-node.tsx` and `condition-node.tsx`):

| Token | Workflow node type | Light source | Dark source |
|---|---|---|---|
| `action-agent-task` | `agent-task` | violet-500 | violet-400 |
| `action-script` | `script` | cyan-500 | cyan-400 |
| `action-notify` | `notify` | teal-500 | teal-400 |
| `action-human-in-the-loop` | `human-in-the-loop` | orange-500 | orange-400 |
| `action-create-task` | `create-task` | indigo-500 | indigo-400 |
| `action-send-message` | `send-message` | pink-500 | pink-400 |
| `action-delegate-to-agent` | `delegate-to-agent` | purple-500 | purple-400 |
| `action-default` | unknown action fallback | blue-500 | blue-400 |
| `action-property-match` | `property-match` (condition) | amber-500 | amber-400 |
| `action-code-match` | `code-match` (condition) | yellow-500 | yellow-400 |
| `action-raw-llm` | `raw-llm` (condition) | sky-500 | sky-400 |

Each status token has a paired `-foreground` for legible text on the colored fill (e.g. `text-status-success-foreground`). Action tokens do not — workflow nodes pair the colored token with `bg-action-X/10` (translucent fill) and `text-action-X` (text + border).

</important>

<important if="you are adding animation, transitions, easing, or an animated icon in ui">

## Motion

Doctrine lives in [DESIGN.md § Motion](./DESIGN.md) — read it first. Hard points: <300ms budget, exits faster than enters, `ease-swift`/`ease-snappy` tokens (never `ease-in`), transform/opacity only, no animation on keyboard-driven or high-frequency interactions, `MotionConfig reducedMotion="user"` is already mounted in `app/providers.tsx`.

Standard timings (all `ease-snappy` unless noted): Dialog/AlertDialog 200ms in / 150ms out; Popover/DropdownMenu/Select/Tooltip 150ms in / 100ms out; Sheet/Drawer 400/250 on `ease-swift` (the large-surface exception); collapse/reveal via the shared `AnimatedReveal` (`components/shared/animated-reveal.tsx`) — 200/150 default (`CollapsibleSection`, settings rail), 150/120 `speed="fast"` for frequently-toggled surfaces like session-log expanders (click-driven toggles animate; data CHANGES never do); global sidebar rail width/left 200ms on `ease-swift` (the stock shadcn `ease-linear` is banned — no linear easing anywhere except shimmer loops). Keep Radix overlays on the shadcn CSS `animate-in/out` classes — do not rebase them onto motion/react.

`Button` transitions live in the un-layered `[data-slot="button"]` block in `globals.css`, NOT in Tailwind classes: colors follow linger timing while transform presses at 100ms and releases at 200ms. Don't re-add `transition-*` utilities to `button.tsx`; press scale is 0.98 (0.97 on sm/icon sizes, via the size variants). Sidebar nav rows don't press-scale (frequency rule).

Animated icons are vendored into `src/components/icons/` — sources in preference order: lucide-animated (`bunx shadcn@latest add "https://lucide-animated.com/r/<icon>.json"`, then move the file out of the literal `@/` directory the CLI creates), animateicons (`https://animateicons.in/r/lu-<icon>.json`) for gaps, hand-written on the same pattern (exact lucide path data) when neither ships one. Interactive-control and nav-row affordance only — never decorative, never in data rows (tables, logs, per-record lists). When the icon sits in a larger click target, drive it from the container via the `startAnimation`/`stopAnimation` handle ref (see `NavIconLink`). Icon variants must be transform-based — never animate `pathLength`/`opacity` from 0 (draw-ins blank the glyph on quick pass-overs; retune registry icons that ship one — see DESIGN.md § Motion "Animated icons").

Hover timing is asymmetric: pointer-hover surfaces enter instantly and release softly via the `.hover-linger` utility (timing-only; composes with the element's `transition-property`; never on keyboard-driven highlights or transform transitions — `Button` gets the same color timing through its own per-property block instead) — see DESIGN.md § Motion "linger rule".

</important>

<important if="you are rendering any markdown content in ui (LLM output, task descriptions, comments, task prompts, etc.)">

## Markdown rendering

Use `<Streamdown>{text}</Streamdown>` from `streamdown` for **all** markdown rendering — LLM output, user-supplied descriptions, anything that may contain markdown. Do not use `react-markdown`.

</important>

<important if="you are modifying session log parsing, task-detail logs, SessionLogViewer, or files under src/logs-parser">

## Session Log Parser Runbook

- Parser ownership lives in `src/logs-parser/`. Keep harness-specific logic inside adapters; `components/shared/session-log-viewer.tsx` should render normalized messages, not parse raw provider protocols.
- Preserve the shared spine: parse `record.content` → order by `(createdAt, lineNumber, fileIndex)` → dispatch by `record.cli` → normalize to IR → pair tool calls/results → render. OpenCode delta reassembly depends on ordering before the adapter.
- Adapter boundaries:
  - `claude` / `pi`: Anthropic-style `message.content[]`; pair tool results by `tool_use_id`.
  - `claude-managed`: Anthropic Managed Agents raw SSE (`agent.message`, `agent.tool_use`, `agent.tool_result`, `session.status_*`); pair by managed tool ids and render non-message runtime events low-key.
  - `codex`: `item.started` is the call and `item.completed` is the result; pair by `item.id`.
  - `opencode`: concatenate `message.part.delta` by ordered `partID`; use `message.part.updated` only to learn part kind; pair `tool_start` / `tool_end` by `toolCallId`; drop `server.*` transport noise.
  - `devin`: provider-meta status / structured-output rows plus generic transcript messages; keep it on the generic path unless real fixtures prove a new adapter is needed.
- Internal/helper rows should use the compact low-key system presentation. Do not render provider-prefixed labels like `Claude helper` / `Opencode unknown`; show the event name or useful content only.
- Group Claude hook rows by `hook_event`, then by `hook_id`. Group continuous thinking-token rows into one helper line: live shimmer while running, otherwise `Thought for ...` with estimated thinking tokens.
- Validate with `bun test src/tests/ui-logs-parser.test.ts`, `cd ui && bunx tsc -b`, and `cd ui && bun run lint`. When touching OpenCode or Pi behavior, also run the parser against a real exported fixture and confirm zero unexpected `unknown` rows, no rendered `server.*` events, and no orphaned tool pairs.

</important>

<important if="you are debugging API calls from ui, changing the dev proxy, or configuring production apiUrl/apiKey">

## API connection

- **Dev:** Vite proxies `/api/*` and `/health` to `http://localhost:3013`.
- **Prod:** configure `apiUrl` in the in-app config panel, or pass `?apiUrl=...&apiKey=...` in the URL.

</important>

<important if="you are building a page, modifying a page's layout, or composing UI in ui">

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
| `InfoRow`, `DefinitionList` | uppercase-label + value pair, used in detail pages | `<DefinitionList><InfoRow label="Role">Engineer</InfoRow></DefinitionList>` |
| `Input` | text input | `<Input id="name" value={v} onChange={...} />` |
| `Label` | form-control label (use inside `SettingsRow`) | `<Label htmlFor="name">Name</Label>` |
| `PageHeader` | route-page description + action row. Plain-string `title`s are NOT rendered (the breadcrumb owns page identity) — keep passing them anyway; only ReactNode titles render (badges, back buttons, editable names). On LIST pages with a filter/toolbar row, don't park a lone action here — render it as an icon Button + Tooltip at the toolbar's right end (see tasks/skills/mcp-servers/connections) | `<PageHeader title="Pages" description="…" />` |
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
| `Table`, `TableHeader`, `TableRow`, `TableCell` | NEVER use for data lists — use `DataGrid` instead. Reserved for static layout tables (e.g. pricing). |
| `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent` | tabbed sections | `<Tabs value={tab} onValueChange={setTab}><TabsList>...</TabsList>...` |
| `Textarea` | multi-line text input | `<Textarea value={v} onChange={...} />` |
| `Tooltip`, `TooltipTrigger`, `TooltipContent` | hover/focus tooltip | `<Tooltip><TooltipTrigger>...</TooltipTrigger><TooltipContent>...</TooltipContent></Tooltip>` |

### Agent-swarm-specific primitives (`src/components/shared/`)

| Primitive | Usage | Example |
|---|---|---|
| `AgentLink` | linked agent name with avatar | `<AgentLink agentId={id} agentName={name} />` |
| `CollapsibleDescription` | truncated text with show-more toggle | `<CollapsibleDescription text={long} />` |
| `CollapsibleSection` | folding section header | `<CollapsibleSection title="Details">...</CollapsibleSection>` |
| `CommandMenu` | global ⌘K palette | mounted at root |
| `DataGrid` | AG Grid wrapper — REQUIRED for all data lists | `<DataGrid rowData={rows} columnDefs={cols} />` |
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
- Header: `<PageHeader />` (badges, primary actions — the entity NAME belongs to the breadcrumb, so don't re-render it in an h1 when the breadcrumb resolves it). Single destructive actions (Delete) go in the header alongside other primary actions — they are first-class operations, not buried below the fold.
- Body: `<DetailPageBody main={...} rail={<DetailPageRail>…</DetailPageRail>} />`. Right rail is fixed 280px; below `lg` the rail stacks below main.
- Rail sections, in order: `<QuickStats>` (k/v at-a-glance) → `<Relationships>` (linked entities, arrow link) → `<DangerZone>` (full-width destructive button — use only when a page has multiple destructive actions or the action is genuinely supplementary, e.g. an irreversible reset paired with a primary save).

A handful of detail pages are exempt because their identity is an editor or split-view (Monaco-dominated, react-flow graph): `templates/[id]`, `templates/[id]/history/[version]`, `workflow-runs/[id]`, `workflows/[id]`. Don't shoehorn the primitive in there. For tabs-driven pages where a single tab carries the primary content (agents `Profile`, mcp-servers `Configuration`), apply the primitive INSIDE that tab body so the rail rides alongside.

</important>

<important if="you are preparing a PR that touches ui/, or running automated UI tests against ui">

## qa-use & PR screenshot requirement

Use `qa-use` for browser automation: `/qa-use:test-run`, `/qa-use:verify`, `/qa-use:explore`. Any PR touching `ui/` MUST include a `qa-use` session with screenshots of the changes running locally — enforced by the merge gate. Port-conflict handling: [../LOCAL_TESTING.md § Dashboard UI](../LOCAL_TESTING.md#dashboard-ui).

</important>
