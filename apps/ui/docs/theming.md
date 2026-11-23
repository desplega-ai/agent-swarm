# Dashboard theming

Moved from `apps/ui/CLAUDE.md`, which keeps the rule that causes damage when missed and a pointer here. Paths are relative to `apps/ui/` unless a line says repo root.

<!-- Applies when you are writing Tailwind classes, picking colors, or styling components in ui. -->

- **Never hardcode dark-mode colors** (no `bg-zinc-950`, `text-zinc-400`, etc.). Use CSS variable classes: `bg-background`, `bg-muted`, `text-foreground`, `text-muted-foreground`, `border-border`, `bg-accent`.
- **Two-tier lines.** Non-structural lines, `Separator`, `divide-y` row rules, data-grid row borders, sit on the subtle tier: `divide-border-subtle` / `bg-border-subtle` / `border-border-subtle`. Card outlines and inputs keep full `border-border` / `border-input` (the stronger stop is the affordance). See DESIGN.md § Elevation.
- **Amber** is brand `--primary`: use it for interactive / active states only.
- **Status colors come from named semantic tokens**, `bg-status-success`, `text-status-error`, `bg-status-active`, etc., defined in `src/styles/globals.css` (light + dark). Action-type colors (workflow nodes) come from `bg-action-*` tokens. **Do not** use raw Tailwind palette literals (`bg-emerald-500`, `text-amber-400`, `border-red-500/30`, etc.) in app code. Translucent fills use the standard Tailwind opacity syntax: `bg-status-success/10`, `border-action-script/50`.
- **Color literal lint gate.** `bun run check:tokens` (also runs in CI via `merge-gate.yml`'s `ui-lint` job) fails the build on any raw Tailwind color palette literal, `dark:` palette variant, arbitrary color literal (e.g. `bg-[#0d1117]`), or hardcoded hex in `src/`. To use a new color, add a token to `src/styles/globals.css`. Monaco editor themes are exempt and live in `src/lib/monaco-themes.ts`.
- CSS variables defined in `src/styles/globals.css`; AG Grid themed via `src/styles/ag-grid.css`.
- **Theme presets** live in the repo-root `src/themes/presets.ts` (+ `src/themes/classics.ts` for the classic editor themes; `src/lib/themes.ts` re-exports them and injects the CSS; HTML pages with designVersion 2 resolve the same registry through `src/themes/page-theme.ts`): named bundles of token overrides emitted as `[data-theme="<id>"]` rules (light + dark), applied on `<html>` (Settings → Appearance, localStorage) or scoped to one swarm-app canvas (`definition.theme` + the viewer's reserved `$theme` user-config override). Emitted blocks are SELF-CONTAINED (the builder spreads the stock base under each preset's overrides), so a scoped preset fully resets its canvas instead of blending with the dashboard preset; `hive` scoped = explicit reset to stock, NO attribute = inherit the dashboard. Action/destructive tokens are never themed; status tokens are themed ONLY by the classic presets (hue semantics fixed). The preset id list is duplicated in two agent-facing texts, `templates/skills/apps/content.md` and the `app-upsert` tool description, update them when the catalog changes.
- **Clickable = pointer** is enforced globally in `globals.css` (`button:not(:disabled)`, `[role="button"]`, `summary`, …), never add per-component `cursor-pointer` again; disabled controls keep the default cursor. Exception: buttons inside the global sidebar (`[data-slot="sidebar-container"]`) keep the default arrow (Taras's call, nav-rail feel); its nav anchors stay pointer natively.
- **Colorless borders are themed.** A base rule defaults `border-color` to `var(--color-border)` (Tailwind v4 otherwise leaves bare `border`/`border-r` utilities on `currentColor`, near-black in light, and blind to theme presets). Explicit `border-<color>` utilities still win; anything needing a text-colored border must say `border-current`. Dark overrides in `globals.css` MUST stay on `.dark` alone (never `.dark *`) or scoped wrappers break; portalled content inside an app canvas re-stamps `data-theme` via `useJsonRenderThemeAttr()` from `src/lib/json-render/theme-scope.tsx`.
- Use `cn()` from `@/lib/utils` for conditional class merging.

### Semantic token reference

Status tokens (cover the 18 statuses in `status-badge.tsx`'s `statusConfig` map plus a few extras used by integrations and workflow runs).

`-strong` variants exist for text emphasis on neutral surfaces (darker in light mode for contrast). Use `bg-status-X` for fills, `text-status-X-strong` for emphasis text on cards/pages. In dark mode `-strong` collapses to the canonical value. **2026-08-06: the palette migrated to the PALE set** (same hues, ~40% less chroma, lifted lightness; fills take dark `-foreground` text in both modes), the `*-500`/`*-400` source columns below describe the original derivation only; current values live in `src/styles/globals.css`. Classic-theme presets (repo-root `src/themes/classics.ts`) carry their own status palettes, the only sanctioned status theming; hue semantics never change.

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

Each status token has a paired `-foreground` for legible text on the colored fill (e.g. `text-status-success-foreground`). Action tokens do not: workflow nodes pair the colored token with `bg-action-X/10` (translucent fill) and `text-action-X` (text + border).
