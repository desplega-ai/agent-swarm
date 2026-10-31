---
date: 2026-10-31T00:00:00Z
topic: "Pages design system v2: review and QA fix list"
status: in-progress
---

# Fix list after review and QA authoring

Sources: `thoughts/taras/research/2026-10-31-pages-ds-maps/review-standards.md`, `review-spec.md`, `review-author.md`, and the full test run. The spec (`2026-10-31-pages-design-system-spec.md`) still applies. Section 0 rules of the spec apply to every agent (own files only, no commits, no em dashes, format only your files).

## Agent A: import, data, tool (runs first, may run bun test)

Owns: `src/themes/import.ts`, `src/themes/page-fields.ts` (new), `src/types.ts` (page schemas), `src/http/pages.ts`, `src/tools/create-page.ts`, `src/tools/utils.ts` (NUDGES.create_page), `src/be/db.ts`, `src/be/db/page-theme-tokens.ts` (new), `src/be/migrations/267_pages_design_system.sql` (rename), `.text-columns.json`, `src/tests/script-connections.test.ts` (one line), `src/tests/theme-import.test.ts`, `src/tests/pages-storage.test.ts`, `src/tests/pages-http.test.ts`, `src/tests/create-page-tool.test.ts`, `src/tests/pages-versioning.test.ts`, `openapi.json`, `docs-site/public/openapi.d.ts`, `docs-site/content/docs/api-reference/**`, `MCP.md` (generated).

- A1 (Critical) `src/themes/import.ts:264`: `rawValue.trim().replace(/\s*!\s*important$/i, "")` is O(n^2) on long space runs (100k spaces = 2.2 s, blocks the API). Reject over-long raw values before any regex, and strip `!important` in linear time. Add a timing guard test (100k-space value fails fast, well under 100 ms).
- A2 Rename the migration to `269_pages_design_system.sql` (open PRs now hold 267 and 268). In `src/tests/script-connections.test.ts`, the migration-112 replay test marks every later migration as applied (`markMigrationApplied(database, "266_script_runs_source_task.sql")` is the last line); add the 269 line after it. Grep tests for any `267_pages` reference.
- A3 `.text-columns.json`: classify `pages.theme` and `pages.theme_tokens` (read `scripts/check-text-columns.ts` for the categories; `theme_tokens` is JSON). `src/tests/check-text-columns.test.ts` must pass.
- A4 `src/tests/db-task-write-contract.test.ts` fails: `parsePageThemeTokens` is a new top-level body in `src/be/db.ts`. Move it to `src/be/db/page-theme-tokens.ts` (flat, like `page-versions.ts`) and import it.
- A5 `readThemeFields` exists twice (`src/http/pages.ts`, `src/tools/create-page.ts`). Move it to `src/themes/page-fields.ts` (imports only `src/themes/*` and types, registers no OpenAPI component). Re-run `bun run docs:openapi` and confirm `openapi.json` has no component reordering (only intended diffs).
- A6 `PageThemeTokensInputSchema`: build the `format` enum from `THEME_IMPORT_FORMATS` and add a test that they match. Update the `import.ts` header: a new format = an importer + a `THEME_IMPORT_FORMATS` entry + (only if it needs a new payload field, for example a DTCG `document`) one field in `PageThemeTokensInputSchema`.
- A7 CSS importer selectors: split selector lists on commas and classify each part. Light: `:root`, `:host`, `html`. Dark: `.dark`, `:root.dark`, `html.dark`, `[data-theme=dark]`, `[data-theme="dark"]`, and `:root` inside `@media (prefers-color-scheme: dark)`. `@theme` / `@theme inline` stay light. A block under any other selector that holds custom properties reports its property names in `ignored` (never silently dropped). Throw only when no recognized block exists. Tests: Tailwind v4 compiled `:root, :host`, shadcn `.dark, [data-theme=dark]`, the media query form.
- A8 Wording: a contract token whose value references a variable outside the contract is dropped. Report it in `ignored` with a clear reason, for example `--font-sans (references --font-geist-sans)`, and make the tool message say "ignored (outside the page token contract or referencing a variable outside it)".
- A9 `create_page` result: put `designVersion` in data and in the message. `NUDGES.create_page` returns one combined string from these sentences (each only when it applies):
  - v1 trap: the saved page is `text/html` with designVersion 1 and its body uses `swarm-` classes or `var(--color-`, or the call set `theme` / `themeTokens`: "This page is on designVersion 1 (the original look), so design system classes, tokens and themes have no effect. Pass designVersion: 2."
  - Light-only colors: the stored themeTokens have light color tokens and no dark color tokens: "Your themeTokens set colors for light mode only. Dark mode keeps the preset's dark colors; add a dark map (or a .dark block) to restyle it too."
  - The existing color-literal sentence (count >= 8).
  The tool computes the flags into data (`designVersion`, `colorLiteralCount`, `usesDesignSystem`, `lightOnlyColors`). POST and PUT responses also return `designVersion`.
- A10 Color counting also counts: named `white` / `black` as CSS values inside style regions, and color classes inside `class` attributes: Tailwind palette classes (`(bg|text|border|ring|outline|divide|fill|stroke|from|via|to|decoration|accent|caret|placeholder|shadow)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-<digits>`), `bg-white`, `bg-black`, `text-white`, `text-black`, and arbitrary color classes (`-[#`, `-[rgb`, `-[hsl`, `-[oklch`). Bounded, linear regexes; extend the guard test.
- Verify: your tests, `bun test src/tests/check-text-columns.test.ts src/tests/db-task-write-contract.test.ts src/tests/script-connections.test.ts`, `bun run tsc:check`, `bash scripts/check-migration-conflicts.sh`, `bun run check:openapi-response-coverage`, `bun run docs:openapi`, `bun run docs:mcp`, `bun scripts/check-floating-promises.ts`, `bun scripts/check-promise-sinks.ts`.

## Agent B: serving, CSS, SDK, dashboard (runs after A, may run bun test)

Owns: `src/pages/page-head.ts`, `src/http/pages-public.ts`, `src/pages/browser-sdk.ts`, `src/tests/pages-head-v2.test.ts`, `src/tests/pages-public-html.test.ts`, `src/tests/swarm-diff.test.ts`, `apps/ui/src/pages/pages/[id]/page.tsx`.

- B1 (Important) `src/pages/page-head.ts:335`: the base reset `button, input, optgroup, select, textarea, ::file-selector-button { font: inherit; ... color: inherit }` (specificity 0,0,1) beats the later zero-specificity `:where(...)` control and button looks, so plain controls get 15px / 23.25px / 39px instead of the 14px / 36px look. Use `:where(button, input, optgroup, select, textarea), ::file-selector-button`. Confirm with computed styles in a browser that a plain input, select and button match `.swarm-input` / `.swarm-button`.
- B2 Base `table` / `th` / `td` rules leak into `<swarm-diff>` tables (a rule on every code line, a 16px gap under each hunk). Add `.swarm-diff-root :is(table, th, td) { margin: 0; border: 0; }` in `@layer components`.
- B3 Standards mode on v2: if the body has no doctype, prepend `<!doctype html>`; when there is no `<head>`, insert the head after `<html ...>` when present, else after the doctype. v1 behavior stays byte-identical. Tests.
- B4 Category dots: `.swarm-badge[data-dot]::before` uses `background: var(--swarm-dot, currentColor)`, so an author can write `style="--swarm-dot: var(--color-chart-2)"`. Keep the badge's internal gap at 6px.
- B5 `.swarm-toolbar`: text and search inputs grow (`flex: 1 1 260px`) instead of a fixed basis.
- B6 Base: `@media (max-width: 640px) { body { padding: 16px; } }`.
- B7 `<swarm-diff>` annotation repeat bug (`browser-sdk.ts` renderHunk): a context row whose old-side number equals an annotated line shows that annotation again. Fall back to the old-side number only on deleted rows. Add a test in `src/tests/swarm-diff.test.ts`.
- B8 `apps/ui/src/pages/pages/[id]/page.tsx`: Export PDF passes `__swarm-theme` (never the mode). Verify `cd apps/ui && bun run lint && bunx tsc -b && bun run check:tokens`.
- Verify: `bun test src/tests/pages-head-v2.test.ts src/tests/pages-public-html.test.ts src/tests/swarm-diff.test.ts src/tests/pages-feedback.test.ts src/tests/pages-authed-mode.test.ts src/tests/pages-browser-sdk.test.ts`, `bun run tsc:check`, `bun run lint:slop`.

## Agent C: agent guidance (runs in parallel with A and B, text only, no bun test)

Owns: `templates/skills/pages/content.md`, `templates/skills/pages/files/examples/*.html`, `src/be/seed-skills/bundled-files.generated.json` (generated).

Frozen names from Agent B: badge dot color variable `--swarm-dot`; badge internal gap 6px; table wrap max height `min(70vh, 720px)` and the wrap is a bordered card surface; toolbar text inputs grow; the body pads 16px at 640px and below. Read `src/pages/page-head.ts` for everything else (it is the truth).

- C1 Taste skill conflict: keep the strings `taste-minimalist-skill` and `Report density layer` (a test needs them), but say the design system overrides every color, font, spacing and motion value from the taste skill; use the taste skill only for restraint in layout and copy. Remove "Apply it to every page".
- C2 `<swarm-diff>` example: `text` is the line WITHOUT its `+`, `-` or space marker; fix the `old_lines` / `new_lines` counts; same fixes in `examples/annotated-pr.html`. Say to write `<` as `<` inside the diff JSON. Document the anchor id rule from the code.
- C3 List every element the head styles (read `page-head.ts`), including that a plain `<button>` gets the outline look.
- C4 One tone table shared by badge, callout and metric: neutral, primary, success, warning, error, info, pending, paused, active.
- C5 Category labels: a neutral badge with `data-dot` and `style="--swarm-dot: var(--color-chart-N)"`. Do not add margins inside badges (6px gap built in).
- C6 Table wrap: the max height, that it is already a bordered surface (do not put it inside a panel), and how to remove the cap (`max-h-none`).
- C7 Replace the spacing-scale line with the scale the primitives use, or drop it.
- C8 Dark mode rule: a color set only in `light` does not reach dark mode; set both maps (or a `.dark` block in the css format). Fonts and radius apply to both modes.
- C9 `themeTokens` replaces the stored map on every write (no merge); send the full map; `null` clears.
- C10 A value that references a variable outside the contract is dropped and listed in `ignoredTokens`.
- C11 Upsert keeps the stored `designVersion`; the tool result reports it; pass `designVersion: 2` when an old page should use the design system.
- C12 Remove any advice to add a mobile padding media query or a fixed-width search input (both built in now).
- Verify: `bun run build:seed-skill-files && bun run check:skill-sources && bun run check:seed-skill-files && bun run check:skill-md`; keep the strings `src/tests/system-default-skills.test.ts` needs (`create_page`, `swarm-diff`, `taste-minimalist-skill`, `Report density layer`, and the config description matching /taste/i).

## Agent Q: QA render fixes (one agent, may run bun test)

Evidence: `thoughts/taras/research/2026-10-31-pages-ds-maps/qa-render-report.md` and the shots in `/tmp/pds-qa/shots` (crops in `/tmp/pds-qa/qa/crops`).

Owns: `src/pages/page-head.ts`, `src/http/pages-public.ts`, `src/pages/color-literals.ts` (new), `src/tools/create-page.ts` (move only), `src/pages/browser-sdk.ts` (jump labels only), `src/tests/pages-head-v2.test.ts`, `src/tests/create-page-tool.test.ts`, `src/tests/swarm-diff.test.ts`, `templates/skills/pages/content.md`.

- Q1 (High) Hardcoded-color pages stay light. A v2 page whose body counts 8 or more color literals (the existing counter: style regions, named white/black, palette and arbitrary color classes) ignores `__swarm-mode=dark` and renders light. Move `countColorLiterals` and the threshold (8, one constant shared with the nudge) to `src/pages/color-literals.ts`; the tool and `pages-public.ts` both import it. Extend the nudge sentence: "...so theme and dark-mode switches restyle it. Until then the page stays light in a dark dashboard." Tests: 8 literals + dark param = no dark script; 7 = dark script.
- Q2 (Medium-high) Remove the `html { background-color: ... }` base rule, so a body background (old-style pages) propagates to the canvas and short pages show no band. `body` keeps `background-color: var(--color-background)`, so token pages look the same.
- Q3 (Medium) `.swarm-table-wrap` gets CSS-only horizontal scroll shadows from tokens (cover gradients in `var(--color-card)` with `background-attachment: local`, shadow gradients from `color-mix(in oklab, var(--color-foreground) 14%, transparent)` with `scroll`, plus the card fill), so hidden columns show an edge hint. No color literals.
- Q4 (Low-medium) Table footers: `tfoot` cells get a `--color-border` top rule and weight 600. Keep the last tbody row rule when a tfoot follows. In print, `tfoot { display: table-row-group; }` so Chrome does not repeat it on every page.
- Q5 Print: inside `.swarm-table`, cells may wrap (`white-space: normal`) except `.num`, and the print font is 12px, so wide tables fit the page.
- Q6 In-page anchors: a small inline v2 head script sets `target="_self"` on click (capture phase) for `a[href^="#"]` with no target, so `<base target="_blank">` no longer opens them in a new tab.
- Q7 `code` gets `box-decoration-break: clone` (with the `-webkit-` form), so a wrapped inline chip keeps its padding and radius on both lines.
- Q8 `<swarm-diff-jumps>`: when a file name repeats, add the hunk's new-side start line to the label (`src/x.ts:58`).
- Q9 Skill (`content.md`): one line each for Q1 (8+ hardcoded colors keep the page light in dark mode), Q3 (the wrap shows edge shadows when it scrolls sideways), Q4 (footer rows), Q6 (in-page `#` links stay in the page; external links still open a new tab).
- Verify: `bun test src/tests/pages-head-v2.test.ts src/tests/pages-public-html.test.ts src/tests/create-page-tool.test.ts src/tests/swarm-diff.test.ts src/tests/pages-feedback.test.ts`, `bun run tsc:check`, `bun run lint:slop`, `bun run build:seed-skill-files && bun run check:seed-skill-files`, Biome on your files. Visual check with agent-browser (`AGENT_BROWSER_SESSION=pds-fix-q`) on a temp API (`DATABASE_PATH` under /tmp, `AGENT_SWARM_API_KEY=123123`, free PORT): re-seed with `API=... bun /tmp/pds-qa/seed.ts`, then screenshot `demo-leads-v2` light (scroll shadow), `demo-leads-asis-v2` with `?__swarm-mode=dark` (must stay light, no band), and `report-ops` light (tfoot). Save to `/tmp/pds-qa/shots-r2/`. Stop the server, close the session.
