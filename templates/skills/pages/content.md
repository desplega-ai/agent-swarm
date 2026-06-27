# Pages

Pages are persistent, shareable HTML documents created via the swarm's page tooling. Use them when the output benefits from layout, tables, headers, and persistent sharing. A page should be a clean human-facing artifact, not a raw dump with a URL.

This skill covers how to publish pages and the default taste baseline every page should follow. The baseline is `taste-minimalist-skill`: warm monochrome palette, strong typography hierarchy, macro-whitespace, crisp borders, near-zero shadows, restrained motion, and an anti-slop ban list. Apply it to every page, including reports, dashboards, tables, audits, public explainers, and data-heavy summaries.

For reports, dashboards, and other dense pages, add the report-density layer below on top of the minimalist baseline. Density is an information-architecture layer, not a separate aesthetic.

## Universal Baseline

Before creating a page, write a one-line design read for yourself:

> Reading this as: `<page kind>` for `<audience>`, using minimalist taste plus `<density needs>`.

Always apply the minimalist baseline:

- Use a warm monochrome canvas (`#FFFFFF`, `#FBFBFA`, `#F7F6F3`) with charcoal text and scarce muted accents.
- Build a clear type hierarchy with premium/system typography; use monospace for code, metadata, and `<kbd>`.
- Use macro-whitespace and strong alignment. Give summaries room to breathe and keep tables compact enough to scan.
- Prefer flat surfaces: crisp `1px` borders, `8px` or `12px` radii, and practically no shadows.
- Use restrained motion only where it clarifies hierarchy or interaction state.
- Keep visual language quiet and precise: no AI-purple gradient mesh, centered hero plus three equal cards, decorative glassmorphism, emojis as UI decoration, fake screenshots made from rectangles, oversized decorative art, nested cards, or low-contrast text.
- Make responsive behavior explicit: readable type, stable grids, horizontal table scroll where needed, and no overlapping content.

If the full minimalist source is available, use `taste-minimalist-skill` for the deeper primitives: bento grids, status badges, `<kbd>` keys, flat tables, code blocks, and the detailed anti-slop checks.


## When to Create a Page

- A report, dashboard, or summary that benefits from structured layout
- Analysis that should be linkable and bookmarkable
- Results that need to be reviewed asynchronously
- A public-facing explainer, reference page, or polished deliverable that should be shared as HTML
- Content that is too long or rich for a `store-progress.output` string

Do NOT use pages for:

- In-flight progress notes; use `store-progress.progress`
- Secrets, private credentials, or unapproved personal data
- Large binary files; use agent-fs for PNG/MP4
- Raw verbose logs; summarize them and link to artifacts

## Report Density Layer

Use this layer for reports, dashboards, data tables, and internal summaries. Keep the minimalist style floor, then compress the information architecture enough that busy readers can scan evidence quickly.

These defaults also distill the current external design guidance from Anthropic's `frontend-design`, Vercel's `composition-patterns`, and Vercel's `web-design-guidelines`: start from content hierarchy, use a small spacing system, keep typography readable, prefer restraint over decoration, and make responsive behavior intentional.

Every dense page should be useful at a glance.

- Put the page's point in the first viewport: title, one-sentence summary, and 3-6 key numbers or statuses.
- Use a single-column reading spine with `max-width: 1120px`; keep prose measure around 65-75 characters and reserve denser grids for metrics/evidence.
- Use premium/system typography unless there is a clear brand reason not to: `"SF Pro Display", "Geist Sans", "Helvetica Neue", ui-sans-serif, system-ui, sans-serif`.
- Use the minimalist palette: warm off-white background, charcoal text, white or near-white panels, light borders, one scarce accent, and semantic colors for statuses only.
- Use a consistent spacing scale: `8, 12, 16, 24, 32, 48, 72`.
- Use clear type hierarchy: page title 36-48px desktop / 30-36px mobile, section titles 22-28px, body 15-16px, supporting text 13-14px.
- Keep tables readable: sticky/scannable headers where useful, padded cells, zebra-free or very subtle row borders, `tabular-nums` for numbers, horizontal scroll on narrow screens.
- Prefer flat bordered cards only for repeated records or metrics. Do not nest cards inside cards.
- Use shadows only when they solve a hierarchy problem; keep them ultra-diffuse and below `0.05` opacity.
- Hide raw JSON behind a collapsed `<details>` block at the bottom.
- Make mobile explicit with media queries: single-column grids, reduced padding, no overflow except intentional table scroll.

## Content Structure

Use this order unless the task gives a better domain-specific structure:

1. Header: title, short summary, timestamp/source context
2. Key metrics: 3-6 tiles that answer "how big / how bad / what changed?"
3. Findings or sections grouped by theme, owner, severity, or stage
4. Evidence tables or samples under each finding
5. Next actions or recommendations
6. Raw evidence links / collapsed JSON appendix

Write section headings as labels, not slogans. Favor "Critical Routing Gaps" over "Things We Found".

## Creating a Page

Use the page tool with an HTML body. Prefer `contentType: "text/html"` and an explicit `authMode` for internal reports.

```javascript
const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Q2 SEO Performance</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f4f0;
      --panel: #ffffff;
      --ink: #18181b;
      --muted: #62646a;
      --line: #dedbd2;
      --accent: #2563eb;
      --danger: #b42318;
      --warn: #b54708;
      --ok: #067647;
      --radius: 8px;
      --shadow: 0 1px 2px rgba(24, 24, 27, 0.04);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font-family: "SF Pro Display", "Geist Sans", "Helvetica Neue", ui-sans-serif, system-ui, sans-serif;
      font-size: 16px;
      line-height: 1.55;
    }
    main {
      width: min(1120px, calc(100% - 32px));
      margin: 0 auto;
      padding: 48px 0 72px;
    }
    header { margin-bottom: 32px; }
    .eyebrow {
      margin: 0 0 8px;
      color: var(--muted);
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    h1 {
      margin: 0;
      max-width: 780px;
      font-size: clamp(2rem, 4vw, 3rem);
      line-height: 1.05;
      letter-spacing: 0;
    }
    .lede {
      max-width: 760px;
      margin: 16px 0 0;
      color: var(--muted);
      font-size: 18px;
    }
    .metrics {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      margin: 32px 0;
    }
    .metric, .section {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
    }
    .metric { padding: 18px; }
    .metric strong {
      display: block;
      font-size: 32px;
      line-height: 1;
      font-variant-numeric: tabular-nums;
    }
    .metric span {
      display: block;
      margin-top: 8px;
      color: var(--muted);
      font-size: 13px;
      font-weight: 650;
    }
    .section {
      margin-top: 18px;
      padding: 24px;
    }
    h2 { margin: 0 0 12px; font-size: 24px; line-height: 1.2; }
    h3 { margin: 0 0 8px; font-size: 17px; line-height: 1.3; }
    p { margin: 0 0 12px; }
    .table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: var(--radius); }
    table { width: 100%; border-collapse: collapse; min-width: 640px; }
    th, td { padding: 10px 12px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
    th { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; }
    td { font-size: 14px; }
    code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    details { margin-top: 24px; }
    summary { cursor: pointer; font-weight: 700; }
    pre { overflow: auto; padding: 16px; background: #111827; color: #f9fafb; border-radius: var(--radius); }
    @media (max-width: 760px) {
      main { width: min(100% - 24px, 1120px); padding-top: 32px; }
      .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .section { padding: 18px; }
    }
    @media (max-width: 520px) {
      .metrics { grid-template-columns: 1fr; }
      .lede { font-size: 16px; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <p class="eyebrow">Generated 2026-06-04</p>
      <h1>Q2 SEO Performance</h1>
      <p class="lede">Organic traffic grew sharply, but the next gains depend on fixing thin page metadata and publishing three high-intent pillar pages.</p>
    </header>

    <section class="metrics" aria-label="Key metrics">
      <div class="metric"><strong>18.6k</strong><span>Organic clicks</span></div>
      <div class="metric"><strong>+50%</strong><span>Quarter over quarter</span></div>
      <div class="metric"><strong>23</strong><span>Metadata fixes</span></div>
      <div class="metric"><strong>3</strong><span>Priority pages</span></div>
    </section>

    <section class="section">
      <h2>Summary</h2>
      <p>Start with the conclusion. Add tables only after the reader understands what changed and what to do next.</p>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Metric</th><th>Q1</th><th>Q2</th><th>Change</th></tr></thead>
          <tbody><tr><td>Organic clicks</td><td>12,400</td><td>18,600</td><td>+50%</td></tr></tbody>
        </table>
      </div>
    </section>
  </main>
</body>
</html>`;

await create_page({
  title: "Q2 SEO Performance",
  slug: "q2-seo-performance",
  description: "Human-readable SEO performance report with summary metrics and next actions.",
  contentType: "text/html",
  authMode: "authed",
  body: html,
});
```

Returns a page ID. Build share URLs from environment:

```text
${APP_URL}/pages/<pageId>           # opens in SPA with chrome
${APP_URL}/pages/<pageId>?mode=full # slim header, full viewport
${MCP_BASE_URL}/p/<pageId>          # direct HTML
```

Read `APP_URL` and `MCP_BASE_URL` from environment. Never hardcode localhost or example hosts in shared output.

## Design Checklist

Before publishing:

- The first viewport states what the page is, why it matters, and the key numbers.
- The page has a clear hierarchy: `h1`, short lede, metrics, sections, evidence.
- Body text is readable on mobile and desktop.
- Tables scroll horizontally on mobile instead of crushing columns.
- Status colors are semantic and not the whole visual identity.
- Raw JSON/logs are collapsed or linked, not the primary experience.
- No nested cards, decorative gradients, oversized art, or cramped default browser styles.
- No text overlaps, clipped buttons, or unreadable low-contrast text.

## Page vs Agent-fs

| Use pages for | Use agent-fs for |
|---|---|
| Reports, dashboards, human-readable summaries | Markdown research notes, code files, recordings |
| Content that benefits from HTML layout | Searchable knowledge base entries |
| Quick share links to non-technical stakeholders | Binary artifacts such as PNG or MP4 |
| Time-bounded deliverables | Long-lived reference documentation |

For a research memo, write the source to agent-fs and create a page for the human-facing summary.
