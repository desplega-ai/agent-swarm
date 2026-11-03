/**
 * The `<head>` that `/p/:id` injects into an HTML page, one per design
 * version (`page.designVersion`):
 *
 * - 1: `PAGE_HEAD_V1`, the original head. Frozen.
 * - 2: `buildPageHeadV2()`, the swarm design system: theme tokens (see
 *   `src/themes/page-theme.ts`), element defaults and `swarm-*` primitives in
 *   cascade layers, and the pinned Tailwind v4 browser build.
 */
import { type ResolvedPageTheme, renderPageThemeCss } from "../themes/page-theme";
import { PAGE_THEME_TOKENS } from "../themes/tokens";

/** Query param: the viewer's dashboard preset id. Read by design version 2 only. */
export const PAGE_THEME_PARAM = "__swarm-theme";
/** Query param: `dark` renders the dark tokens. Read by design version 2 only. */
export const PAGE_MODE_PARAM = "__swarm-mode";

/**
 * Design version 1, FROZEN: never change it. Pages with designVersion 1 must
 * keep rendering as they did when they were written. Design changes go to
 * `buildPageHeadV2` (or to a new design version).
 *
 * Default `<head>` injection: `<base>` so links escape the iframe, Tailwind
 * Play CDN so agent pages can use utility classes out of the box, Space
 * Grotesk / Space Mono fonts to match the swarm SPA, a small reset that
 * makes pages theme-aware (light by default) so an agent who writes zero CSS
 * still gets a presentable page, and finally the Browser SDK so
 * `window.swarmSdk` works.
 *
 * Agent-provided styles can override these defaults. Tailwind utilities stay
 * available, but its Preflight reset is disabled to preserve browser heading,
 * margin, and list styles.
 */
export const PAGE_HEAD_V1 = `<base target="_blank">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">
<script src="https://cdn.tailwindcss.com"></script>
<script>
  if (window.tailwind) {
    window.tailwind.config = { corePlugins: { preflight: false } };
  }
</script>
<style>
  *, ::before, ::after { box-sizing: border-box; border: 0 solid #e5e7eb; }
  hr { border-top-width: 1px; }
  img, video { display: block; max-width: 100%; height: auto; }
  button, input, optgroup, select, textarea, ::file-selector-button { font: inherit; }
  :root {
    color-scheme: light;
    --swarm-bg: #fbfbfa;
    --swarm-card: #ffffff;
    --swarm-border: #e5e7eb;
    --swarm-text: #111827;
    --swarm-muted: #6b7280;
    --swarm-primary: #3b82f6;
  }
  html, body { background: var(--swarm-bg); color: var(--swarm-text); }
  body {
    font-family: "Space Grotesk", system-ui, sans-serif;
    margin: 0;
    padding: 24px;
    line-height: 1.5;
  }
  code, pre, kbd, samp { font-family: "Space Mono", ui-monospace, monospace; }
  a { color: var(--swarm-primary); }
  ::selection { background: var(--swarm-primary); color: #fff; }
  @media print {
    /* Override theme variables so built-in primitives (swarm-diff, swarm-card)
       that read var(--swarm-card) / var(--swarm-border) etc. inline-styled
       backgrounds also flip to light. Without this, diff cards stay dark navy
       on print. */
    :root {
      --swarm-bg: #ffffff;
      --swarm-card: #ffffff;
      --swarm-border: #cccccc;
      --swarm-text: #000000;
      --swarm-muted: #555555;
    }
    html, body { background: white !important; color: black !important; }
    a { color: black !important; text-decoration: underline; }
    /* Hide any swarm chrome the agent (or built-in primitives) tagged with
       .no-print. Use this class on annotation badges, jump-list nav, anything
       that shouldn't appear in the PDF export. */
    .no-print { display: none !important; }
    /* Avoid page-break inside cards / diff blocks. */
    .swarm-card, swarm-diff { break-inside: avoid; }
  }
</style>`;

// ─── Design version 2 ───────────────────────────────────────────────────────

/** Pinned Tailwind v4 browser build. Bump the version and the hash together. */
const TAILWIND_BROWSER_SRC =
  "https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4.3.3/dist/index.global.js";
const TAILWIND_BROWSER_INTEGRITY =
  "sha384-2ql948lIdLcGEE0/qxNiudyTjgauA3RDJERu5xW75kFCvSl5a9odyQYCb6tEjnmB";

/**
 * `<base target="_blank">` would open an in-page `#id` link in a new tab. On
 * click (capture phase, so before page handlers), this gives such a link
 * `target="_self"` when it has no target. `setAttribute` also works on SVG
 * links.
 */
const IN_PAGE_LINK_SCRIPT = `<script>document.addEventListener("click", function (event) {
  var link = event.target && event.target.closest && event.target.closest('a[href^="#"]:not([target])');
  if (link) link.setAttribute("target", "_self");
}, true);</script>`;

const FONT_LINKS = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet">`;

/**
 * The Tailwind source. Theme and utilities only: Preflight stays off, so the
 * element defaults below survive. `inline reference` maps each token utility
 * (`bg-primary`, `rounded-xl`, `font-mono`) to `var(<token>)` and emits no
 * variable of its own, so the unlayered theme CSS stays the one source.
 */
const TAILWIND_SOURCE = [
  '@import "tailwindcss/theme" layer(theme);',
  '@import "tailwindcss/utilities" layer(utilities);',
  "@custom-variant dark (&:where(.dark, .dark *));",
  "@theme inline reference {",
  ...PAGE_THEME_TOKENS.map((token) => `  ${token}: var(${token});`),
  "}",
].join("\n");

/**
 * Adds the Tailwind source as a `text/tailwindcss` style element at run time
 * (see `buildPageHeadV2`, item 6). The source is a JSON string with `<`
 * escaped, so it cannot close the script.
 */
const TAILWIND_SOURCE_SCRIPT = `<script>(function () {
  var style = document.createElement("style");
  style.type = "text/tailwindcss";
  style.textContent = ${JSON.stringify(TAILWIND_SOURCE).replace(/</g, "\\u003c")};
  document.head.appendChild(style);
})();</script>`;

// One look, two selectors each: the plain element (`@layer base`) and the
// primitive class (`@layer components`). Both are 36px tall, like the
// dashboard controls. Only `background-color` is set, so the select arrow
// (a background image) survives. The base font reset for controls puts its
// elements in `:where()`, so its zero specificity lets these looks win by
// source order (a pseudo-element cannot go inside `:where()`).
const CONTROL_LOOK = `min-width: 0;
    padding: 7px 12px;
    font-size: 14px;
    line-height: 20px;
    color: var(--color-foreground);
    background-color: var(--color-card);
    border: 1px solid var(--color-input);
    border-radius: var(--radius-md);
    transition: border-color 150ms, box-shadow 150ms;`;

const BUTTON_LOOK = `display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 7px 14px;
    font-size: 14px;
    font-weight: 500;
    line-height: 20px;
    color: var(--color-foreground);
    background-color: var(--color-card);
    border: 1px solid var(--color-input);
    border-radius: var(--radius-md);
    text-decoration: none;
    white-space: nowrap;
    cursor: pointer;
    transition: color 150ms, background-color 150ms, border-color 150ms, box-shadow 150ms;`;

const FOCUS_RING = `outline: none;
    border-color: var(--color-ring);
    box-shadow: 0 0 0 2px color-mix(in oklab, var(--color-ring) 60%, transparent);`;

const TEXT_CONTROLS = `:where(input:not([type="checkbox"], [type="radio"], [type="range"], [type="color"], [type="file"], [type="button"], [type="submit"], [type="reset"], [type="image"], [type="hidden"]), select, textarea)`;
const BUTTON_CONTROLS = `:where(button, input[type="button"], input[type="submit"], input[type="reset"])`;

/**
 * The edge shadow of `.swarm-table-wrap`. The wrap paints it at each side with
 * `background-attachment: scroll`, and covers it with card-colored gradients
 * that scroll with the table (`local`). A side shows its shadow only when
 * columns are hidden past it.
 */
const EDGE_SHADOW = "color-mix(in oklab, var(--color-foreground) 14%, transparent)";

/**
 * The status tones of `.swarm-badge`, `.swarm-callout` and `.swarm-metric`
 * (`data-tone`). Each sets a soft color and a text-safe strong color.
 */
const TONES: ReadonlyArray<readonly [tone: string, soft: string, strong: string]> = [
  ["neutral", "--color-status-neutral", "--color-status-neutral-strong"],
  ["primary", "--color-primary", "--color-primary"],
  ...["success", "warning", "error", "info", "pending", "paused", "active"].map(
    (tone) => [tone, `--color-status-${tone}`, `--color-status-${tone}-strong`] as const,
  ),
];

const TONE_RULES = TONES.map(
  ([tone, soft, strong]) =>
    `  :is(.swarm-badge, .swarm-callout, .swarm-metric)[data-tone="${tone}"] {\n    --swarm-tone: var(${soft});\n    --swarm-tone-strong: var(${strong});\n  }`,
).join("\n");

/**
 * Element defaults (`@layer base`), primitives (`@layer components`) and the
 * print rules (unlayered). Every color is a theme token. Taste bar: the Hive
 * dashboard (`apps/ui/DESIGN.md`): quiet chrome, whitespace and uppercase
 * micro-labels for separation, two-tier borders, soft pills, one accent, no
 * shadows.
 */
const PAGE_DESIGN_CSS = `@layer base {
  *, ::before, ::after, ::backdrop, ::file-selector-button {
    box-sizing: border-box;
    border: 0 solid var(--color-border);
  }
  html {
    color: var(--color-foreground);
    -webkit-text-size-adjust: 100%;
    text-size-adjust: 100%;
    tab-size: 4;
  }
  body {
    margin: 0;
    padding: 24px;
    background-color: var(--color-background);
    color: var(--color-foreground);
    font-family: var(--font-sans), ui-sans-serif, system-ui, sans-serif;
    font-size: 15px;
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
  @media (max-width: 640px) {
    body { padding: 16px; }
  }
  :focus-visible {
    outline: 2px solid var(--color-ring);
    outline-offset: 2px;
  }
  h1, h2, h3, h4, h5, h6 {
    margin: 0;
    font-weight: 600;
    text-wrap: balance;
  }
  h1 { margin: 0 0 12px; font-size: 30px; line-height: 1.2; letter-spacing: -0.02em; }
  h2 { margin: 40px 0 12px; font-size: 20px; line-height: 1.3; letter-spacing: -0.015em; }
  h3 { margin: 28px 0 8px; font-size: 16px; line-height: 1.4; letter-spacing: -0.01em; }
  h4 { margin: 24px 0 6px; font-size: 15px; line-height: 1.45; }
  h5, h6 { margin: 20px 0 6px; font-size: 13px; line-height: 1.45; }
  p { margin: 0 0 12px; text-wrap: pretty; }
  ul, ol { margin: 0 0 12px; padding-left: 1.5em; }
  li { margin: 4px 0; }
  li > ul, li > ol { margin: 4px 0 0; }
  li::marker { color: var(--color-muted-foreground); }
  dl, figure, blockquote, pre, table, details, fieldset, form { margin: 0 0 16px; }
  dt { font-weight: 500; }
  dd { margin: 0 0 8px; }
  :where(h1, h2, h3, h4, h5, h6):first-child { margin-top: 0; }
  :where(p, ul, ol, dl, dd, figure, blockquote, pre, table, details, fieldset, form):last-child { margin-bottom: 0; }
  a {
    color: var(--color-primary);
    text-decoration-line: underline;
    text-decoration-thickness: 1px;
    text-decoration-color: color-mix(in oklab, currentColor 35%, transparent);
    text-underline-offset: 3px;
  }
  a:hover { text-decoration-color: currentColor; }
  hr {
    height: 0;
    margin: 32px 0;
    color: inherit;
    border-top: 1px solid var(--color-border-subtle);
  }
  b, strong { font-weight: 600; }
  mark {
    padding: 0 2px;
    color: inherit;
    background-color: color-mix(in oklab, var(--color-status-pending) 35%, transparent);
    border-radius: 2px;
  }
  code, kbd, samp, pre {
    font-family: var(--font-mono), ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.85em;
  }
  code {
    padding: 0.1em 0.35em;
    background-color: var(--color-muted);
    border-radius: var(--radius-sm);
    -webkit-box-decoration-break: clone;
    box-decoration-break: clone;
  }
  kbd {
    padding: 0.05em 0.4em;
    background-color: var(--color-card);
    border: 1px solid var(--color-border);
    border-bottom-width: 2px;
    border-radius: var(--radius-sm);
  }
  pre {
    padding: 12px 14px;
    overflow: auto;
    line-height: 1.6;
    background-color: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
  }
  pre code {
    padding: 0;
    font-size: inherit;
    background-color: transparent;
    border-radius: 0;
  }
  blockquote {
    padding: 2px 0 2px 16px;
    color: var(--color-muted-foreground);
    border-left: 2px solid var(--color-border);
  }
  summary {
    cursor: pointer;
    font-weight: 500;
  }
  summary::marker { color: var(--color-muted-foreground); }
  details[open] > summary { margin-bottom: 8px; }
  img, video {
    display: block;
    max-width: 100%;
    height: auto;
  }
  figcaption {
    margin-top: 8px;
    font-size: 13px;
    color: var(--color-muted-foreground);
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 14px;
    font-variant-numeric: tabular-nums;
  }
  caption {
    padding-bottom: 8px;
    font-size: 13px;
    text-align: left;
    color: var(--color-muted-foreground);
  }
  th, td {
    padding: 8px 12px;
    text-align: left;
    vertical-align: middle;
    border-bottom: 1px solid var(--color-border-subtle);
  }
  th {
    font-size: 11px;
    font-weight: 500;
    line-height: 1.45;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    vertical-align: bottom;
    color: var(--color-muted-foreground);
    border-bottom-color: var(--color-border);
  }
  th[scope="row"] {
    font-size: inherit;
    letter-spacing: normal;
    text-transform: none;
    vertical-align: middle;
    color: inherit;
    border-bottom-color: var(--color-border-subtle);
  }
  tfoot :is(td, th) {
    font-weight: 600;
    border-top: 1px solid var(--color-border);
  }
  tbody:has(+ tfoot) > tr:last-child > :is(td, th) { border-bottom-color: var(--color-border); }
  :where(button, input, optgroup, select, textarea), ::file-selector-button {
    font: inherit;
    font-feature-settings: inherit;
    font-variation-settings: inherit;
    letter-spacing: inherit;
    color: inherit;
  }
  ${TEXT_CONTROLS} {
    ${CONTROL_LOOK}
  }
  ${TEXT_CONTROLS}:focus-visible {
    ${FOCUS_RING}
  }
  :where(input, select, textarea)::placeholder {
    color: var(--color-muted-foreground);
    opacity: 1;
  }
  :where(input, select, textarea, button):disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
  :where(input, select, textarea)[aria-invalid="true"] { border-color: var(--color-destructive); }
  textarea {
    min-height: 80px;
    line-height: 1.5;
    resize: vertical;
  }
  select:not([multiple], [size]) {
    appearance: none;
    padding-right: 32px;
    background-image:
      linear-gradient(45deg, transparent 50%, var(--color-muted-foreground) 50%),
      linear-gradient(135deg, var(--color-muted-foreground) 50%, transparent 50%);
    background-position: calc(100% - 18px) 50%, calc(100% - 13px) 50%;
    background-size: 5px 5px;
    background-repeat: no-repeat;
  }
  ${BUTTON_CONTROLS} {
    ${BUTTON_LOOK}
  }
  ${BUTTON_CONTROLS}:hover:not(:disabled) {
    color: var(--color-accent-foreground);
    background-color: var(--color-accent);
  }
  ${BUTTON_CONTROLS}:focus-visible {
    ${FOCUS_RING}
  }
  ::file-selector-button {
    margin-right: 12px;
    padding: 4px 10px;
    font-size: 13px;
    font-weight: 500;
    color: var(--color-foreground);
    background-color: var(--color-card);
    border: 1px solid var(--color-input);
    border-radius: var(--radius-sm);
    cursor: pointer;
  }
  input[type="checkbox"], input[type="radio"], input[type="range"], progress {
    accent-color: var(--color-primary);
  }
  fieldset {
    min-width: 0;
    padding: 12px 16px 16px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
  }
  legend {
    padding: 0 6px;
    font-size: 13px;
    font-weight: 500;
    color: var(--color-muted-foreground);
  }
  label:has(input, select, textarea), label[for] { cursor: pointer; }
  ::selection {
    color: var(--color-primary-foreground);
    background-color: var(--color-primary);
  }
}

@layer components {
  .swarm-page {
    max-width: 1120px;
    margin-inline: auto;
    padding-block: 8px 24px;
  }
  .swarm-eyebrow {
    margin: 0 0 8px;
    font-size: 11px;
    font-weight: 500;
    line-height: 1.45;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-muted-foreground);
  }
  .swarm-lede {
    max-width: 68ch;
    margin: 0 0 16px;
    font-size: 17px;
    line-height: 1.55;
    color: var(--color-muted-foreground);
    text-wrap: pretty;
  }
  .swarm-section { margin-block: 40px; }
  .swarm-section:last-child { margin-bottom: 0; }
  .swarm-section > :first-child { margin-top: 0; }

  .swarm-metrics {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 148px), 1fr));
    gap: 12px;
    margin: 24px 0;
  }
  .swarm-metric {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
    padding: 14px 16px;
    color: var(--color-card-foreground);
    background-color: var(--color-card);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-xl);
  }
  .swarm-metric-value {
    font-size: 26px;
    font-weight: 600;
    line-height: 1.15;
    letter-spacing: -0.02em;
    font-variant-numeric: tabular-nums;
    overflow-wrap: anywhere;
  }
  .swarm-metric[data-tone] .swarm-metric-value { color: var(--swarm-tone-strong); }
  .swarm-metric-label {
    font-size: 12px;
    line-height: 1.45;
    color: var(--color-muted-foreground);
  }

  .swarm-panel, .swarm-card {
    padding: 20px;
    color: var(--color-card-foreground);
    background-color: var(--color-card);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-xl);
  }
  :is(.swarm-panel, .swarm-card) > :first-child { margin-top: 0; }
  :is(.swarm-panel, .swarm-card) > :last-child { margin-bottom: 0; }

  .swarm-badge {
    --swarm-tone: var(--color-status-neutral);
    --swarm-tone-strong: var(--color-status-neutral-strong);
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 22px;
    padding: 0 8px;
    font-size: 12px;
    font-weight: 500;
    line-height: 1;
    white-space: nowrap;
    vertical-align: middle;
    color: var(--swarm-tone-strong);
    background-color: color-mix(in oklab, var(--swarm-tone) 16%, transparent);
    border: 1px solid color-mix(in oklab, var(--swarm-tone) 28%, transparent);
    border-radius: 999px;
  }
  .swarm-badge[data-dot]::before {
    content: "";
    flex: none;
    width: 6px;
    height: 6px;
    background: var(--swarm-dot, currentColor);
    border-radius: 999px;
  }

  .swarm-table-wrap {
    max-height: min(70vh, 720px);
    margin: 0 0 16px;
    overflow: auto;
    background:
      linear-gradient(to right, var(--color-card) 30%, transparent) left / 40px 100% no-repeat local,
      linear-gradient(to left, var(--color-card) 30%, transparent) right / 40px 100% no-repeat local,
      linear-gradient(to right, ${EDGE_SHADOW}, transparent) left / 14px 100% no-repeat scroll,
      linear-gradient(to left, ${EDGE_SHADOW}, transparent) right / 14px 100% no-repeat scroll,
      var(--color-card);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-xl);
  }
  .swarm-table-wrap:last-child { margin-bottom: 0; }
  .swarm-table-wrap > table { margin: 0; }
  .swarm-table {
    width: 100%;
    border-collapse: separate;
    border-spacing: 0;
    font-size: 13px;
    line-height: 1.45;
    font-variant-numeric: tabular-nums;
  }
  .swarm-table :is(th, td) { padding: 8px 12px; }
  .swarm-table thead th {
    position: sticky;
    top: 0;
    z-index: 1;
    padding-block: 10px 8px;
    white-space: nowrap;
    background-color: var(--color-card);
  }
  .swarm-table tbody tr:hover > :is(td, th) { background-color: color-mix(in oklab, var(--color-accent) 70%, transparent); }
  .swarm-table-wrap > .swarm-table > :last-child > tr:last-child > :is(td, th) { border-bottom: 0; }
  :is(td, th).num {
    text-align: right;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  :is(td, th).nowrap { white-space: nowrap; }
  .swarm-diff-root :is(table, th, td) { margin: 0; border: 0; }

  .swarm-button {
    ${BUTTON_LOOK}
  }
  .swarm-button:hover {
    color: var(--color-accent-foreground);
    background-color: var(--color-accent);
  }
  .swarm-button[data-variant="primary"] {
    color: var(--color-primary-foreground);
    background-color: var(--color-primary);
    border-color: transparent;
  }
  .swarm-button[data-variant="primary"]:hover {
    color: var(--color-primary-foreground);
    background-color: color-mix(in oklab, var(--color-primary) 90%, transparent);
  }
  .swarm-button[data-variant="ghost"] {
    background-color: transparent;
    border-color: transparent;
  }
  .swarm-button[data-variant="ghost"]:hover { background-color: var(--color-accent); }
  .swarm-button:focus-visible {
    ${FOCUS_RING}
  }
  .swarm-button:is(:disabled, [aria-disabled="true"]) {
    opacity: 0.5;
    pointer-events: none;
  }

  .swarm-input {
    ${CONTROL_LOOK}
  }
  .swarm-input:focus-visible {
    ${FOCUS_RING}
  }
  select.swarm-input:not([multiple], [size]) { padding-right: 32px; }

  .swarm-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin: 0 0 12px;
  }
  .swarm-toolbar > :is(input[type="search"], input[type="text"], input:not([type])) { flex: 1 1 260px; }

  .swarm-segmented {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    height: 36px;
    padding: 2px;
    vertical-align: middle;
    background-color: color-mix(in oklab, var(--color-muted) 40%, transparent);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
  }
  .swarm-segmented > :is(button, a) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    height: 100%;
    padding: 0 12px;
    font-size: 12px;
    font-weight: 500;
    line-height: 1;
    white-space: nowrap;
    text-decoration: none;
    color: var(--color-muted-foreground);
    background-color: transparent;
    border: 0;
    border-radius: calc(var(--radius-md) - 3px);
    box-shadow: none;
    cursor: pointer;
    transition: color 150ms, background-color 150ms;
  }
  .swarm-segmented > :is(button, a):hover {
    color: var(--color-foreground);
    background-color: transparent;
  }
  .swarm-segmented > :is([aria-pressed="true"], [data-active]:not([data-active="false"])) {
    color: var(--color-primary-foreground);
    background-color: var(--color-primary);
  }
  .swarm-segmented > :is(button, a):focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px color-mix(in oklab, var(--color-ring) 60%, transparent);
  }

  .swarm-callout {
    --swarm-tone: var(--color-status-info);
    --swarm-tone-strong: var(--color-status-info-strong);
    margin: 0 0 12px;
    padding: 12px 16px;
    color: var(--color-foreground);
    background-color: color-mix(in oklab, var(--swarm-tone) 12%, transparent);
    border: 1px solid color-mix(in oklab, var(--swarm-tone) 40%, transparent);
    border-radius: var(--radius-lg);
  }
  .swarm-callout:last-child { margin-bottom: 0; }
  .swarm-callout > :first-child { margin-top: 0; }
  .swarm-callout > :last-child { margin-bottom: 0; }

  .swarm-kv {
    display: grid;
    grid-template-columns: minmax(96px, max-content) minmax(0, 1fr);
    gap: 8px 20px;
    margin: 0 0 16px;
    font-size: 14px;
  }
  .swarm-kv:last-child { margin-bottom: 0; }
  .swarm-kv > dt {
    font-weight: 400;
    color: var(--color-muted-foreground);
  }
  .swarm-kv > dd {
    min-width: 0;
    margin: 0;
    overflow-wrap: anywhere;
  }

${TONE_RULES}
}

@media print {
  html, body { background: white !important; color: black !important; }
  a:not(.swarm-button) { color: black !important; text-decoration: underline; }
  .no-print { display: none !important; }
  .swarm-panel, .swarm-card, swarm-diff, .swarm-metric { break-inside: avoid; }
  .swarm-table-wrap { max-height: none; overflow: visible; }
  .swarm-table { font-size: 12px; }
  .swarm-table :is(th, td):not(.num) { white-space: normal; }
  .swarm-table thead th { position: static; }
  tfoot { display: table-row-group; }
}`;

/**
 * The design version 2 head. Order matters:
 * 1. `<base>` so links escape the iframe, and the click handler that keeps
 *    in-page `#id` links in the page.
 * 2. The layer order statement, as the FIRST style element: layers rank by
 *    first mention, so base < components < Tailwind utilities, whatever order
 *    the sheets load in. Unlayered CSS (the theme, the page's own styles)
 *    beats every layer.
 * 3. Fonts. 4. Theme tokens (unlayered). 5. Element defaults and primitives.
 * 6. The Tailwind source, before the script, so the first compile already
 *    skips Preflight. A script creates its `text/tailwindcss` style element:
 *    the browser preload scanner reads `@import` in any `<style>` in the
 *    markup, whatever its type, and would fetch `tailwindcss/theme` relative
 *    to the page. 7. The pinned Tailwind script (SRI).
 * 8. In dark mode, the `.dark` class, set before the body renders.
 */
export function buildPageHeadV2({
  theme,
  mode,
}: {
  theme: ResolvedPageTheme;
  mode: "light" | "dark";
}): string {
  return [
    '<base target="_blank">',
    IN_PAGE_LINK_SCRIPT,
    "<style>@layer properties, theme, base, components, utilities;</style>",
    FONT_LINKS,
    `<style id="swarm-theme">\n${renderPageThemeCss(theme)}\n</style>`,
    `<style id="swarm-design">\n${PAGE_DESIGN_CSS}\n</style>`,
    TAILWIND_SOURCE_SCRIPT,
    `<script src="${TAILWIND_BROWSER_SRC}" integrity="${TAILWIND_BROWSER_INTEGRITY}" crossorigin="anonymous"></script>`,
    ...(mode === "dark" ? ['<script>document.documentElement.classList.add("dark")</script>'] : []),
  ].join("\n");
}
