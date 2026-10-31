---
date: 2026-10-31T00:00:00Z
topic: "Pages design system v2: frozen implementation spec"
status: in-progress
---

# Spec: pages design system v2 (frozen for implementation)

Worktree: `/Users/taras/worktrees/agent-swarm/2026-10-31-pages-design-system` (branch `pages-design-system`).
Maps of the current code: `thoughts/taras/research/2026-10-31-pages-ds-maps/*.md`. Read the map for your area before you edit.
Yolo plan (orchestrator owns it, do not edit): `thoughts/taras/plans-yolo/2026-10-31-pages-design-system.md`.

## 0. Rules for every implementing agent

- Edit only the files your section owns. Another agent edits the other files at the same time.
- Never `git commit`, `git add -A`, `git stash`, or `git checkout` other paths. The orchestrator commits.
- Format only your files: `bunx biome check --write <your files>`. Never run `bun run lint:fix` on the repo.
- Run `bun test` only when your section says so. Two `bun test` runs at the same time break each other.
- If a typecheck error is in a file you do not own, ignore it and mention it in your report.
- No em dash characters anywhere (code, comments, docs). Use a colon, a comma, or parentheses.
- Smallest diff that meets the spec. No speculative abstractions beyond what this spec names.
- Report at the end: status (completed / blocked), files changed, verification output (short), open questions.

## 1. Concepts and names (shared vocabulary)

- **Design version**: integer on each page. `1` = the current head, frozen forever (Tailwind v3 Play CDN, `--swarm-*` hex tokens). `2` = the new design system. Existing rows read `1`. New pages default to `2`.
- **Token contract** (`PAGE_THEME_TOKENS`): the dashboard names that pages expose.
  - Colors (52): `--color-background`, `--color-foreground`, `--color-card`, `--color-card-foreground`, `--color-surface`, `--color-popover`, `--color-popover-foreground`, `--color-primary`, `--color-primary-foreground`, `--color-secondary`, `--color-secondary-foreground`, `--color-muted`, `--color-muted-foreground`, `--color-accent`, `--color-accent-foreground`, `--color-destructive`, `--color-destructive-foreground`, `--color-border`, `--color-border-subtle`, `--color-input`, `--color-ring`, `--color-chart-1` .. `--color-chart-5`, `--color-status-{success,active,error,info,pending,warning,paused,neutral}` each with base, `-strong`, `-foreground`, plus `--color-status-success-solid`, `--color-status-active-solid`.
  - Non-color (6): `--font-sans`, `--font-mono`, `--radius-sm`, `--radius-md`, `--radius-lg`, `--radius-xl`. They have one value for both modes.
  - Not in the contract: `--color-sidebar-*`, `--color-action-*`, `--color-peer-*`, `--text-*`, `--ease-*`.
- **Preset**: an entry of the existing dashboard registry (`hive` default, plus the others, plus new `paper`). A page uses only the contract keys of a preset.
- **Theme tokens** (`themeTokens`): per-page overrides `{ light: {...}, dark: {...} }` keyed by contract names. Stored normalized.
- **Theme importer**: a function that turns an outside format into theme tokens. Formats today: `tokens` (a JSON map) and `css` (a CSS custom-property block, as shadcn, tweakcn and Tailwind v4 `@theme` produce). Figma / DTCG later = one new importer. Nothing downstream changes.
- **Viewer theme and mode**: the dashboard passes `__swarm-theme=<preset id>` and `__swarm-mode=dark` on the page URL. Direct links pass nothing: Hive, light.
- **Resolution** (design version 2 only): preset = page `theme` if set, else the viewer `__swarm-theme` if it names a known preset, else `hive`. Then the page `themeTokens` overrides apply on top. Mode = `dark` only when `__swarm-mode=dark`. Print is always light.

## 2. Section F: shared theme engine (owner: Foundation agent)

Owns: `src/themes/**`, `apps/ui/src/lib/themes.ts`, `apps/ui/src/lib/theme-classics.ts` (delete), `apps/ui/vercel.json`, `src/apps/definition.ts` (comment only), `src/tests/themes-*.test.ts`, `src/tests/theme-import.test.ts`.

1. Move the pure parts of `apps/ui/src/lib/themes.ts` to `src/themes/presets.ts` (keep the header comment, keep every behavior): `ThemePreset`, `DEFAULT_THEME_ID`, `BASE_SCOPE_VARS` (now exported), `accentPreset`, `NEAR_WHITE`, `ZINC_900`, `THEME_PRESETS`, `getThemePreset`, `resolveThemeId`, `declarations`, `buildThemePresetCss`. Add `isThemePresetId(id: string): boolean` and `THEME_PRESET_IDS: readonly string[]`.
2. Move `apps/ui/src/lib/theme-classics.ts` to `src/themes/classics.ts` unchanged except the type import path. Delete the old file.
3. `apps/ui/src/lib/themes.ts` keeps `STYLE_ELEMENT_ID` and `injectThemePresetStyles()` (DOM) and re-exports the rest from `../../../../src/themes/presets` so the 4 importers stay unchanged. Check `apps/ui/src/components/shared/session-log-viewer.test.tsx:61` (alias list) still works.
4. Add the `paper` preset (full-field, after `carbon`, before the classics): the warm editorial look of today's pages skill. Light: canvas about `#F7F6F3`, white cards, warm borders about `#DEDBD2` and a lighter subtle tier, charcoal text about `#18181B`, muted text about `#62646A`, blue primary about `#2563EB`. Dark: warm charcoal canvas, slightly lighter cards, warm translucent borders, warm off-white text, a lighter blue primary. All values in `oklch(...)` (convert precisely; `check:tokens` bans hex in UI TS and the presets use oklch). Light and dark key sets identical (the INVARIANT). Do not set status tokens. Fill `accent` and `field` swatches.
5. `src/themes/tokens.ts`: `PAGE_THEME_COLOR_TOKENS`, `PAGE_THEME_SHARED_TOKENS` (fonts, radius), `PAGE_THEME_TOKENS` (both), types `PageThemeToken`, `PageThemeTokenValues = Partial<Record<PageThemeToken, string>>`, `PageThemeTokens = { light: PageThemeTokenValues; dark: PageThemeTokenValues }`, and `HIVE_PAGE_TOKENS` = full Hive values copied from `apps/ui/src/styles/globals.css` (light `@theme`, `.dark`). Shared tokens come from the light block and apply to both modes.
6. `src/themes/page-theme.ts`:
   - `resolvePageTheme({ pageTheme, viewerTheme, overrides }): ResolvedPageTheme` with `ResolvedPageTheme = { presetId: string; light: Record<PageThemeToken, string>; dark: Record<PageThemeToken, string> }`. Rules in section 1. Pick only contract keys from preset vars. A shared token set in `overrides.light` and absent from `overrides.dark` applies to dark too.
   - `renderPageThemeCss(theme: ResolvedPageTheme): string` returns unlayered CSS: `:root { color-scheme: light; <light tokens>; <aliases> }`, `:root.dark { color-scheme: dark; <dark tokens> }`, and `@media print { :root.dark { color-scheme: light; <light tokens> } }`. Aliases (in `:root` only): `--swarm-bg: var(--color-background); --swarm-card: var(--color-card); --swarm-border: var(--color-border); --swarm-text: var(--color-foreground); --swarm-muted: var(--color-muted-foreground); --swarm-primary: var(--color-primary);`.
7. `src/themes/import.ts` (the Figma-ready boundary). Header comment explains: an importer turns an outside format into `PageThemeTokens`; to add Figma / DTCG, write `importDtcg`, add `"dtcg"` to `THEME_IMPORT_FORMATS` and to `THEME_IMPORTERS`; storage and rendering stay the same.
   - `THEME_IMPORT_FORMATS = ["tokens", "css"] as const`, `ThemeImportFormat`.
   - `ThemeImportInput = { format?: "tokens"; light?: Record<string, string>; dark?: Record<string, string> } | { format: "css"; css: string }` (format defaults to `tokens`).
   - `importThemeTokens(input): { tokens: PageThemeTokens; ignored: string[] }`. Throws `ThemeImportError` (exported class, message names the bad key or value) on a bad shape or an unsafe value.
   - Name normalization (both formats): `--color-primary`, `--primary`, `primary`, `color-primary` all map to `--color-primary`. Font and radius names map the same way (`--font-sans`, `font-sans`). shadcn `--radius` expands to `--radius-sm: calc(<v> - 4px)`, `--radius-md: calc(<v> - 2px)`, `--radius-lg: <v>`, `--radius-xl: calc(<v> + 4px)`. Bare HSL triplets (`222.2 47.4% 11.2%`) wrap as `hsl(...)`. Names outside the contract (for example `--sidebar`, `--shadow-2xs`, `--tracking-normal`, `--spacing`, `--font-serif`) go to `ignored`; they never throw.
   - Value safety: 1 to 200 chars, none of `; { } < > \` or a newline, and no `url(`, `expression(`, `@import`, `javascript:`. Violations throw.
   - `css` format: read declarations from `:root { }` (light), `.dark { }` (dark), and `@theme { }` / `@theme inline { }` (light). Ignore other blocks and comments.
8. Tests (you may run `bun test` on your own new test files only):
   - `src/tests/themes-presets.test.ts`: every preset has identical light and dark key sets; `paper` exists; `BASE_SCOPE_VARS` and `HIVE_PAGE_TOKENS` equal the values parsed from `apps/ui/src/styles/globals.css` (sync guard); `buildThemePresetCss` still emits a block per preset.
   - `src/tests/themes-page-theme.test.ts`: resolution precedence, unknown viewer id falls back, overrides apply, shared overrides reach dark, rendered CSS contains `:root {`, `:root.dark {`, the aliases, and the print block.
   - `src/tests/theme-import.test.ts`: all normalization rules, `css` format with `:root`, `.dark`, `@theme`, ignored names, unsafe values throw, unknown format throws.
9. `apps/ui/vercel.json`: add `src/themes` to the ignoreCommand input list. `src/apps/definition.ts:448-453`: update the comment to point at `src/themes/presets.ts`.
10. Verify: `bun test src/tests/themes-presets.test.ts src/tests/themes-page-theme.test.ts src/tests/theme-import.test.ts`, `bun run tsc:check`, `cd apps/ui && bun run lint && bunx tsc -b && bun run check:tokens`, `bun run check:dep-graph`.

## 3. Section D: page data (owner: Data agent; starts after F)

Owns: `src/be/migrations/267_pages_design_system.sql`, `src/types.ts` (page schemas only), `src/be/db.ts` (page functions only), `src/http/pages.ts`, `src/tools/create-page.ts`, `src/tools/utils.ts` (one NUDGES entry), `src/pages/version.ts`, `src/tests/pages-storage.test.ts`, `src/tests/pages-http.test.ts`, `src/tests/create-page-tool.test.ts`, `src/tests/pages-versioning.test.ts`, `openapi.json`, `docs-site/content/docs/api-reference/**` (generated).

1. Migration 267: `ALTER TABLE pages ADD COLUMN theme TEXT;` `ALTER TABLE pages ADD COLUMN theme_tokens TEXT;` `ALTER TABLE pages ADD COLUMN design_version INTEGER NOT NULL DEFAULT 1;` (existing rows read 1). Header comment explains the three columns. Run `bash scripts/check-migration-conflicts.sh`.
2. `PageSchema`: `theme: string | null`, `themeTokens: PageThemeTokensSchema | null`, `designVersion: number`. `PageSnapshotSchema`: the same three, optional. Add `PageThemeTokensSchema` (zod, `{ light: record, dark: record }` of string to string) next to the page schemas and reuse it.
3. DB layer: `PageRow` + `rowToPage` map the 3 columns (JSON parse `theme_tokens`, tolerate bad JSON as null). `createPage` takes `theme?`, `themeTokens?`, `designVersion?` (default `2`) and inserts them. `updatePage`: undefined keeps, null clears (`theme`, `themeTokens`), a number sets `designVersion`. Leave `rowToPageSummary` unchanged.
4. Inputs (POST and PUT `/api/pages`, and `create_page`): `theme?: string | null` must pass `isThemePresetId` (400 / toolErr listing `THEME_PRESET_IDS`); `themeTokens?: ThemeImportInput | null` goes through `importThemeTokens` (400 / toolErr with the `ThemeImportError` message) and the NORMALIZED tokens are stored; `designVersion?: 1 | 2`. Create default `designVersion` = 2. The `create_page` upsert branch: an omitted theme field keeps the stored value (do not clear on upsert). Responses report `ignoredTokens` when the importer ignored names (HTTP: field in the 201/200 body; tool: in the message and details).
5. `create_page` description: add one paragraph: "HTML pages use the swarm design system (designVersion 2): theme tokens such as var(--color-primary), the swarm-* primitives, and Tailwind v4 utilities such as bg-card and text-muted-foreground. Set `theme` to a preset id or pass `themeTokens` (a token map, or a CSS variable block with format \"css\") to restyle the whole page. Do not hardcode colors: inside the dashboard the page follows the viewer's theme and dark mode. Pages created before designVersion 2 keep the old look; pass designVersion: 2 when you rewrite one." Describe each new input field in its zod `.describe()`.
6. Nudge: in `create_page`, for `text/html` with `designVersion >= 2`, count color literals inside `<style>` blocks and `style="..."` attributes (`#rgb`/`#rrggbb`/`#rrggbbaa`, `rgb(`, `rgba(`, `hsl(`, `hsla(`, `oklch(`). Put `colorLiteralCount` in the result data. Add `NUDGES["create_page"]`: when ok and the count is 8 or more, return "This page hardcodes N color values. Use theme tokens (var(--color-primary), bg-primary, text-muted-foreground) so theme and dark-mode switches restyle it."
7. `snapshotPage` copies the three fields.
8. Tests (run `bun test` on the four page test files you own, after the code is in): create defaults to designVersion 2; a row inserted without the column reads 1; theme validation; themeTokens normalization stored (shadcn names), `css` format works, ignored names reported; update null clears; upsert keeps omitted theme; snapshot carries the fields; nudge fires at 8 literals and not at 7.
9. Run `bun run docs:openapi` and keep the regenerated files. Verify: the four test files, `bun run tsc:check`, `bash scripts/check-migration-conflicts.sh`, `bash scripts/check-db-boundary.sh`, `bash scripts/check-audit-columns.sh`, `bun run check:rbac-coverage`, `bun run check:openapi-response-coverage`.

## 4. Section S: page serving and the v2 head (owner: Serving agent; starts after D)

Owns: `src/pages/page-head.ts` (new), `src/http/pages-public.ts`, `src/pages/browser-sdk.ts` (color and font fallbacks only), `src/tests/pages-public-html.test.ts`, `src/tests/pages-head-v2.test.ts` (new).

1. Move `PAGE_HEAD_DEFAULTS` verbatim to `src/pages/page-head.ts` as `PAGE_HEAD_V1` with a comment: design version 1, frozen, never change it. Add `PAGE_THEME_PARAM = "__swarm-theme"`, `PAGE_MODE_PARAM = "__swarm-mode"`, and `buildPageHeadV2({ theme: ResolvedPageTheme, mode: "light" | "dark" }): string`.
2. v2 head, in this order:
   1. `<base target="_blank">`
   2. `<style>@layer properties, theme, base, components, utilities;</style>` (must be the first style element).
   3. Google Fonts preconnects and the Space Grotesk + Space Mono link (same as v1).
   4. `<style id="swarm-theme">` = `renderPageThemeCss(theme)` (unlayered).
   5. `<style id="swarm-design">` = `@layer base { element defaults }`, `@layer components { primitives }`, plus an unlayered `@media print` block (white background, black text, underlined links, `.no-print` hidden, `break-inside: avoid` on `.swarm-panel`, `.swarm-card`, `swarm-diff`, `.swarm-metric`).
   6. `<style type="text/tailwindcss">` with, in order: `@import "tailwindcss/theme" layer(theme);`, `@import "tailwindcss/utilities" layer(utilities);`, `@custom-variant dark (&:where(.dark, .dark *));`, and `@theme inline reference { <every contract token>: var(<same token>); }`.
   7. `<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4.3.3/dist/index.global.js" integrity="sha384-..." crossorigin="anonymous"></script>`. Compute the integrity yourself: `curl -sL <url> | openssl dgst -sha384 -binary | openssl base64 -A`. The research run got `sha384-2ql948lIdLcGEE0/qxNiudyTjgauA3RDJERu5xW75kFCvSl5a9odyQYCb6tEjnmB`; use your computed value if it differs and say so.
   8. When mode is dark: `<script>document.documentElement.classList.add("dark")</script>`.
   (The SDK and SWARM_UI_JS scripts follow, as today.)
3. Element defaults (`@layer base`): the Hive identity. Body: `--color-background` field, `--color-foreground` text, `var(--font-sans)`, 15px, line-height 1.55, margin 0, padding 24px (zero-CSS pages must look finished), antialiased. Headings h1 to h4 with a tight scale (h1 about 30px / 600 / -0.02em), paragraphs, lists, links (primary, underline offset), `hr` on `--color-border-subtle`, `code` / `pre` / `kbd` / `samp` on `var(--font-mono)` with muted surfaces, `blockquote`, `details` / `summary`, `img` / `video` max-width, plain `table` (collapsed borders, padded cells, uppercase 11px tracked muted headers, subtle row rules, tabular numbers), form controls (`input`, `select`, `textarea`, `button`) on `--color-input` / `--color-ring`, `:focus-visible` ring 2px, `::selection`. Keep Preflight off (only theme and utilities are imported).
4. Primitives (`@layer components`), exact class names, all from tokens only (no color literals):
   - `.swarm-page`: centered reading spine, max-width 1120px. Must not double the body padding awkwardly.
   - `.swarm-eyebrow`: 11px uppercase tracked micro-label, muted.
   - `.swarm-lede`: larger muted paragraph, max about 68ch.
   - `.swarm-section`: vertical rhythm block for a titled section.
   - `.swarm-metrics` (responsive auto-fit grid) and `.swarm-metric` with `.swarm-metric-value` (large, tabular) and `.swarm-metric-label` (muted); optional `data-tone` on the metric colors the value.
   - `.swarm-panel` and its alias `.swarm-card`: flat surface, 1px border, `--radius-xl`, padding.
   - `.swarm-badge` with `data-tone` = `neutral` (default), `primary`, `success`, `warning`, `error`, `info`, `pending`, `paused`, `active`: soft pill on the status tokens, NEVER wraps (`white-space: nowrap`), optional leading dot via `.swarm-badge[data-dot]`.
   - `.swarm-table-wrap` (scroll container: `overflow: auto` plus a max height, so the sticky header works) and `.swarm-table` (sticky header, compact rows, subtle rules, row hover); `.num` on `th` / `td` = right aligned, tabular, nowrap; `.nowrap` keeps any cell on one line.
   - `.swarm-button` with `data-variant` = `outline` (default), `primary`, `ghost`; works on `button` and `a`.
   - `.swarm-input`: text input / select look (also the base look for plain form controls).
   - `.swarm-toolbar`: wrapping flex row for search, filters and actions.
   - `.swarm-segmented`: segmented control; the active item is `[aria-pressed="true"]` or `[data-active]`.
   - `.swarm-callout` with `data-tone` (info default, success, warning, error): a finding or note box.
   - `.swarm-kv`: key / value grid for `dl` (`dt` muted, `dd` value).
   Taste bar: the Hive dashboard (see `apps/ui/DESIGN.md`, `apps/ui/src/styles/globals.css`). Quiet chrome, separation by whitespace and uppercase micro-labels, two-tier borders (`--color-border` for structure, `--color-border-subtle` for row rules), soft pill states, one sparse accent, no shadows except a barely visible one where hierarchy needs it. Every primitive must look right in light and dark mode and under every preset.
5. `pages-public.ts`: read `page.designVersion`. Version 1: inject `PAGE_HEAD_V1` exactly as today (ignore theme params). Version 2: `resolvePageTheme({ pageTheme: page.theme, viewerTheme: <__swarm-theme param>, overrides: page.themeTokens })`, mode from `__swarm-mode` (`dark` or light), inject `buildPageHeadV2`. Keep CSP unchanged unless the v2 head needs more (it should not: jsdelivr and inline styles are allowed). Print (`?print=1`) works for both versions.
6. `browser-sdk.ts` (`SWARM_UI_JS`): make the diff and jump-list colors and fonts theme-aware with fallbacks that equal today's literals, so v1 renders identically: for example `var(--color-status-error-strong, #ef4444)`, `var(--color-muted-foreground, #7c8aa6)`, `var(--font-mono, 'Space Mono', ui-monospace, monospace)`. Keep the existing `--swarm-*` reads. Do not touch the feedback overlay.
7. Tests (run `bun test` on the page-serving test files after D is done): v1 page keeps the exact old head (`--swarm-bg: #fbfbfa`, `cdn.tailwindcss.com`, no `@tailwindcss/browser`); v2 page has the layer statement before any other style, the pinned v4 script with integrity, the contract tokens, the aliases, the primitives; `__swarm-theme=github` changes token values when the page has no theme; the page theme wins over the param; an unknown param is ignored; `__swarm-mode=dark` adds the class script; themeTokens overrides appear; print still works. Also run the existing `swarm-diff`, `pages-feedback`, `pages-authed-mode`, `pages-browser-sdk` tests.
8. Verify: those tests, `bun run tsc:check`, `bun run lint:slop`.

## 5. Section U: dashboard viewer (owner: Dashboard agent; starts after F)

Owns: `apps/ui/src/pages/pages/[id]/page.tsx` (and a small helper beside it if useful).

1. Use `useTheme()` (`apps/ui/src/hooks/use-theme.ts`): `preset` and the resolved `theme` (light/dark).
2. Add `__swarm-theme=<preset>` (omit for `hive`) and `__swarm-mode=dark` (omit for light) to: the public iframe src, the authed iframe src (keep the relaunch flow working), the password iframe src (at submit), and the Open link. Not the Export PDF link (print is always light). Not the Full link (the full route renders the iframe itself). The params must not collide with page params; use the exact names above.
3. A theme or mode switch in the dashboard updates the frame (a reload is acceptable).
4. Verify: `cd apps/ui && bun run lint && bunx tsc -b && bun run check:tokens`. No `bun test`.

## 6. Section G: agent guidance and docs (owner: Guidance agent; starts at once, text only)

Owns: `templates/skills/pages/content.md`, `templates/skills/pages/config.json` (description only), `templates/skills/pages/files/examples/*.html`, `src/be/seed-skills/bundled-files.generated.json` (generated), `templates/skills/apps/content.md` (preset list line), `templates/skills/apps/SKILL.md` (generated), `src/tools/app-upsert.ts` (preset list in the description only), `docs-site/content/docs/(documentation)/reference/mcp-tools.mdx` (create_page styling paragraph).

1. Replace the "Design baseline" part of the pages skill with a "Design system" part: what designVersion 2 gives, the token table (CSS variable, Tailwind class, meaning), the primitive catalog (section 4.4 names, one short HTML snippet each), theming (`theme` preset ids incl. `paper`, `themeTokens` with both formats and a shadcn paste example), dark mode (inside the dashboard the page follows the viewer, so use tokens only), designVersion (old pages keep v1, pass 2 when rewriting, the v3 to v4 class changes: shadow-sm, rounded-sm, ring, outline-none, bg-opacity), and the rule "no hardcoded colors". Keep the content-structure guidance, the density guidance (minus palette and font lines), and the design checklist (add "no color literals"). Remove the warm-palette hex list and the SF Pro font stack. Update the Tailwind line in "Built-in primitives" and the print section (print is light). Keep the strings `create_page` and `swarm-diff` (a test needs them). Write new text in short, direct sentences, no em dashes.
2. Rewrite `examples/report-page.html` with the primitives and tokens only (zero color literals). Swap the hex literals in `examples/multiplayer-board.html` for tokens. Keep `annotated-pr.html` working.
3. Update `config.json` description to name the design system instead of the taste baseline. Do not change other fields.
4. Preset lists: add `paper` (after `carbon`, described as the warm editorial paper look) in `src/tools/app-upsert.ts:27` and `templates/skills/apps/content.md:131`, then `bun run build:skill-md`.
5. `mcp-tools.mdx` create_page paragraph (L813): describe designVersion 2, tokens, primitives, Tailwind v4, `theme` / `themeTokens`.
6. Run `bun run build:seed-skill-files`, then verify `bun run check:skill-sources && bun run check:seed-skill-files && bun run check:skill-md`. No `bun test`.
