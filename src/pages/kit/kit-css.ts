/**
 * Page kit CSS. Theme tokens only, no color literals: a design system or a
 * preset restyles every kit page. Sits in `@layer components`, so the head's
 * element defaults stay below it and Tailwind utilities stay above it.
 */
export const KIT_CSS = `
@layer components {
  :root {
    --kit-chart-baseline: color-mix(in oklab, var(--color-muted-foreground) 42%, transparent);
  }

  /* Header */
  .kit-header { margin: 8px 0 32px; }
  .kit-header h1 { max-width: 24ch; margin-bottom: 14px; font-size: 38px; line-height: 1.12; letter-spacing: -0.025em; }
  .kit-header .swarm-lede { margin-bottom: 0; font-size: 18px; }
  .kit-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 32px;
    margin: 22px 0 0;
    font-size: 13px;
  }
  .kit-meta > div { display: flex; align-items: baseline; gap: 8px; }
  .kit-meta dt { font-weight: 400; color: var(--color-muted-foreground); }
  .kit-meta dd { margin: 0; font-weight: 500; }
  .kit-header[data-compact] {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    justify-content: space-between;
    gap: 12px 32px;
    margin-bottom: 20px;
  }
  .kit-header[data-compact] h1 { margin-bottom: 0; font-size: 26px; max-width: none; }
  .kit-header[data-compact] .swarm-eyebrow { margin-bottom: 4px; }
  .kit-header[data-compact] .kit-meta { margin: 0 0 4px; }

  /* Metrics: one ruled strip, not a grid of cards. Every item carries a comparison. */
  .kit-metrics {
    display: grid;
    grid-template-columns: repeat(var(--kit-cols, 4), minmax(0, 1fr));
    margin: 28px 0 36px;
    border-block: 1px solid var(--color-border);
  }
  .kit-metric {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
    padding: 18px 24px 18px;
    border-left: 1px solid var(--color-border-subtle);
  }
  .kit-metric:first-child { padding-left: 0; border-left: 0; }
  .kit-metric-label {
    font-size: 11px;
    font-weight: 500;
    line-height: 1.45;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--color-muted-foreground);
  }
  .kit-metric-value {
    font-size: 30px;
    font-weight: 600;
    line-height: 1.1;
    letter-spacing: -0.02em;
    font-variant-numeric: tabular-nums;
  }
  .kit-metric-value small {
    margin-left: 4px;
    font-size: 15px;
    font-weight: 500;
    letter-spacing: 0;
    color: var(--color-muted-foreground);
  }
  .kit-metric-compare { font-size: 12.5px; line-height: 1.4; color: var(--color-muted-foreground); text-wrap: balance; }
  .kit-delta { font-weight: 600; font-variant-numeric: tabular-nums; color: var(--color-status-neutral-strong); }
  .kit-delta[data-tone="success"] { color: var(--color-status-success-strong); }
  .kit-delta[data-tone="error"] { color: var(--color-status-error-strong); }
  .kit-delta[data-tone="warning"] { color: var(--color-status-warning-strong); }
  .kit-delta[data-tone="info"] { color: var(--color-status-info-strong); }
  td .kit-delta { font-weight: 500; }
  tfoot .kit-delta { font-weight: 600; }

  /* Text */
  .kit-text { max-width: 70ch; }
  .kit-text + .kit-text { margin-top: 12px; }
  .kit-text + :is(.swarm-callout, .swarm-table-wrap, .kit-chart, .swarm-kv) { margin-top: 16px; }
  .kit-muted { font-size: 13px; color: var(--color-muted-foreground); }
  .swarm-table-wrap + .kit-muted, .kit-chart + .kit-muted { margin-top: -6px; }
  .kit-text blockquote { margin: 0 0 12px; padding: 2px 0 2px 18px; font-size: 19px; line-height: 1.4; color: var(--color-foreground); border-left: 2px solid var(--color-primary); }
  .kit-callout-title {
    margin: 0 0 4px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--swarm-tone-strong);
  }
  .swarm-callout { max-width: none; padding: 14px 18px; }
  .kit-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }

  /* Rail layouts */
  .kit-with-rail {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 248px;
    gap: 56px;
    align-items: start;
  }
  .kit-with-rail[data-rail="left"] { grid-template-columns: 248px minmax(0, 1fr); }
  .kit-main > .swarm-section:first-child { margin-top: 0; }
  .swarm-callout + .kit-with-rail { margin-top: 40px; }
  .kit-rail { position: sticky; top: 24px; font-size: 13.5px; }
  .kit-with-rail[data-rail="right"] > .kit-rail { padding-left: 28px; border-left: 1px solid var(--color-border-subtle); }
  .kit-rail > * + * { margin-top: 20px; }
  .kit-with-rail[data-rail="left"] > .kit-rail > * + * { margin-top: 32px; }
  .kit-rail > .swarm-eyebrow + * { margin-top: 0; }
  .kit-kv-stacked { display: block; font-size: 13.5px; }
  .kit-kv-stacked > dt { font-size: 12px; }
  .kit-kv-stacked > dd { margin: 0 0 12px; font-weight: 500; }
  .kit-kv-stacked > dd:last-child { margin-bottom: 0; }
  .kit-toc { display: flex; flex-direction: column; gap: 2px; border-left: 1px solid var(--color-border); }
  .kit-toc a {
    margin-left: -1px;
    padding: 5px 0 5px 14px;
    color: var(--color-muted-foreground);
    text-decoration: none;
    border-left: 1px solid transparent;
  }
  .kit-toc a:hover { color: var(--color-foreground); }
  .kit-toc a:first-child { color: var(--color-foreground); font-weight: 500; border-left-color: var(--color-primary); }

  /* Section splits */
  .kit-split { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 40px; align-items: start; }
  .kit-split[data-layout="aside"] { grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); }
  .kit-split > div > :last-child { margin-bottom: 0; }
  .kit-split > div > * + * { margin-top: 20px; }
  .kit-text blockquote + p { font-size: 13px; color: var(--color-muted-foreground); }

  /* Table */
  .swarm-table :is(th, td).num { width: 1%; padding-left: 28px; }
  .kit-table-title { margin: 0; padding: 14px 12px 4px; font-size: 14px; font-weight: 600; }

  /* Chart */
  .kit-chart { margin: 0 0 16px; }
  .kit-chart-title { margin: 0 0 2px; font-size: 14px; font-weight: 600; color: var(--color-foreground); }
  .kit-chart-sub { margin: 0; font-size: 12.5px; color: var(--color-muted-foreground); }
  .kit-legend { display: flex; flex-wrap: wrap; gap: 4px 18px; margin: 6px 0 0; font-size: 12px; color: var(--color-muted-foreground); }
  .kit-legend span { display: inline-flex; align-items: center; gap: 6px; }
  .kit-legend i { width: 10px; height: 10px; border-radius: 2px; }
  .kit-legend i[data-line="dashed"] { height: 2px; width: 14px; border-radius: 0; }
  swarm-chart { display: block; }
  .kit-chart svg circle.pt:hover { r: 5; }
  .kit-chart svg { display: block; width: 100%; height: auto; margin-top: 12px; overflow: visible; }
  .kit-chart svg text { font-size: 11px; fill: var(--color-muted-foreground); font-variant-numeric: tabular-nums; }
  .kit-chart svg text.cat { font-size: 12px; fill: var(--color-foreground); }
  .kit-chart svg text.val { fill: var(--color-foreground); font-weight: 500; }
  .kit-chart svg text.inbar { fill: var(--color-primary-foreground); font-weight: 500; }
  .kit-chart svg .grid { stroke: var(--color-border-subtle); }
  .kit-chart svg .axis { stroke: var(--color-border); }
  .kit-chart svg .ref { stroke: var(--color-foreground); stroke-width: 1; stroke-dasharray: 3 4; opacity: 0.55; }
  .kit-chart svg text.reflabel { fill: var(--color-foreground); font-weight: 500; }
  .kit-chart-note { margin: 10px 0 0; font-size: 12px; color: var(--color-muted-foreground); }

  /* One-pager */
  .kit-onepager[data-narrow] { max-width: 760px; }
  .kit-facts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 0;
    margin: 0 0 36px;
    border-block: 1px solid var(--color-border);
    font-size: 14px;
  }
  .kit-facts > div { padding: 14px 18px; border-left: 1px solid var(--color-border-subtle); }
  .kit-facts > div:first-child { padding-left: 0; border-left: 0; }
  .kit-facts dt { margin-bottom: 2px; font-size: 11px; font-weight: 500; letter-spacing: 0.06em; text-transform: uppercase; color: var(--color-muted-foreground); }
  .kit-facts dd { margin: 0; font-weight: 500; }
  .kit-footer { margin-top: 40px; padding-top: 16px; font-size: 13px; color: var(--color-muted-foreground); border-top: 1px solid var(--color-border-subtle); }
  .kit-footer .kit-text { max-width: none; }

  /* Report */
  .kit-appendix { padding-top: 24px; border-top: 1px solid var(--color-border-subtle); }
  .kit-details > summary { font-size: 14px; }

  /* Dashboard */
  .kit-dashboard { max-width: 1280px; }
  .kit-dashboard .kit-metrics { margin: 20px 0 24px; }
  .kit-dashboard .swarm-section { margin-block: 24px; }
  .kit-dashboard h2 { margin: 0 0 10px; font-size: 15px; letter-spacing: -0.005em; }
  .kit-dashboard .kit-split { gap: 24px; }
  .kit-dashboard .kit-chart { margin-bottom: 0; }
  .kit-dashboard > .swarm-callout { margin-bottom: 0; }
  .kit-dashboard .kit-split { align-items: stretch; }
  .kit-dashboard .kit-split > div { display: flex; flex-direction: column; }
  .kit-dashboard .kit-split > div > :only-child { flex: 1; margin-bottom: 0; }
  .kit-dashboard .kit-fields .swarm-eyebrow { margin-bottom: 14px; }
  .kit-stack > * + * { margin-top: 20px; padding-top: 18px; border-top: 1px solid var(--color-border-subtle); }
  .kit-stack h3 { margin-bottom: 10px; font-size: 11px; font-weight: 500; letter-spacing: 0.08em; text-transform: uppercase; color: var(--color-muted-foreground); }
  .kit-stack .kit-text { font-size: 14px; }

  /* Deck: one slide per viewport and per printed page. Sizes follow --u. */
  html:has(.kit-deck) { scroll-snap-type: y mandatory; }
  body:has(.kit-deck) { padding: 0; }
  .kit-deck { --u: min(1vw, 1.6vh); }
  .kit-slide {
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100vh;
    padding: calc(var(--u) * 5) calc(var(--u) * 7) calc(var(--u) * 6);
    overflow: hidden;
    font-size: calc(var(--u) * 1.55);
    line-height: 1.45;
    scroll-snap-align: start;
    border-bottom: 1px solid var(--color-border-subtle);
  }
  .kit-slide-body { display: flex; flex: 1; flex-direction: column; justify-content: center; min-height: 0; }
  .kit-slide:is([data-layout="content"], [data-layout="split"]) .kit-slide-body { justify-content: flex-start; padding-top: calc(var(--u) * 6.5); }
  .kit-slide[data-layout="content"] .kit-slide-body {
    display: grid;
    grid-template-columns: minmax(0, 5fr) minmax(0, 8fr);
    column-gap: calc(var(--u) * 5);
    align-content: start;
    align-items: start;
  }
  .kit-slide[data-layout="content"] h2 { font-size: calc(var(--u) * 2.6); }
  .kit-slide[data-layout="content"] .kit-slide-content { padding-top: calc(var(--u) * 0.3); }
  .kit-slide[data-layout="title"] .kit-slide-body { justify-content: flex-end; padding-bottom: calc(var(--u) * 3); }
  .kit-slide[data-layout="title"] .swarm-eyebrow::before { content: ""; display: block; width: calc(var(--u) * 3.4); height: calc(var(--u) * 0.3); margin-bottom: calc(var(--u) * 1.8); background: var(--color-primary); }
  .kit-slide-content { min-width: 0; }
  .kit-slide .swarm-eyebrow { margin-bottom: calc(var(--u) * 1.1); font-size: calc(var(--u) * 0.95); letter-spacing: 0.1em; }
  .kit-slide h1 { max-width: 16ch; margin: 0 0 calc(var(--u) * 1.6); font-size: calc(var(--u) * 5.4); line-height: 1.04; letter-spacing: -0.035em; }
  .kit-slide h2 { max-width: 28ch; margin: 0 0 calc(var(--u) * 2.4); font-size: calc(var(--u) * 2.9); line-height: 1.12; letter-spacing: -0.025em; }
  .kit-slide h3 { margin: 0 0 calc(var(--u) * 0.9); font-size: calc(var(--u) * 1.05); font-weight: 500; letter-spacing: 0.08em; text-transform: uppercase; color: var(--color-muted-foreground); }
  .kit-slide .swarm-lede { max-width: 40ch; font-size: calc(var(--u) * 1.9); }
  .kit-slide .kit-meta { gap: calc(var(--u) * 0.4) calc(var(--u) * 2.6); margin-top: calc(var(--u) * 3.2); font-size: calc(var(--u) * 1.1); }
  .kit-statement { max-width: 21ch; margin: 0 0 calc(var(--u) * 2.2); font-size: calc(var(--u) * 4.4); font-weight: 600; line-height: 1.08; letter-spacing: -0.03em; text-wrap: balance; }
  .kit-slide[data-layout="statement"] .kit-text { max-width: 52ch; font-size: calc(var(--u) * 1.75); color: var(--color-muted-foreground); }
  .kit-quote { margin: 0 0 calc(var(--u) * 2.4); padding: 0 0 0 calc(var(--u) * 2.2); color: var(--color-foreground); border-left: calc(var(--u) * 0.25) solid var(--color-primary); }
  .kit-quote p { max-width: 24ch; margin: 0 0 calc(var(--u) * 1.4); font-size: calc(var(--u) * 3.6); font-weight: 500; line-height: 1.15; letter-spacing: -0.025em; text-wrap: balance; }
  .kit-quote footer { font-size: calc(var(--u) * 1.2); color: var(--color-muted-foreground); }
  .kit-slide[data-layout="quote"] .kit-text { max-width: 52ch; padding-left: calc(var(--u) * 2.45); font-size: calc(var(--u) * 1.6); color: var(--color-muted-foreground); }
  .kit-slide .kit-text { max-width: 60ch; font-size: calc(var(--u) * 1.85); }
  .kit-slide .kit-split .kit-text { font-size: calc(var(--u) * 1.7); }
  .kit-slide .kit-text :is(ul, ol) { padding-left: 1.2em; }
  .kit-slide .kit-text li { margin: calc(var(--u) * 0.9) 0; padding-left: 0.3em; }
  .kit-slide .kit-split { gap: calc(var(--u) * 5); }
  .kit-slide .swarm-table-wrap { max-height: none; background: transparent; border-width: 1px 0 0; border-radius: 0; }
  .kit-slide .swarm-table { font-size: calc(var(--u) * 1.4); }
  .kit-slide .kit-split .swarm-table { font-size: calc(var(--u) * 1.3); }
  .kit-slide .swarm-table :is(th, td) { padding: calc(var(--u) * 1) calc(var(--u) * 1.1); vertical-align: top; background: transparent; }
  .kit-slide .swarm-table :is(th, td):first-child { padding-left: 0; }
  .kit-slide .swarm-table thead th { padding-block: calc(var(--u) * 0.9) calc(var(--u) * 0.7); font-size: calc(var(--u) * 0.82); }
  .kit-slide .swarm-table tfoot :is(td, th) { border-bottom: 0; }
  .kit-slide .swarm-badge { height: calc(var(--u) * 1.9); padding: 0 calc(var(--u) * 0.75); font-size: calc(var(--u) * 1); }
  .kit-slide .swarm-kv { grid-template-columns: minmax(calc(var(--u) * 11), max-content) minmax(0, 1fr); gap: 0; font-size: calc(var(--u) * 1.6); }
  .kit-slide .swarm-kv > :is(dt, dd) { padding: calc(var(--u) * 0.95) 0; border-top: 1px solid var(--color-border-subtle); }
  .kit-slide .swarm-kv > dt { padding-right: calc(var(--u) * 3); }
  .kit-slide .swarm-kv > :is(dt, dd):nth-child(-n + 2) { border-top-color: var(--color-border); }
  .kit-slide .kit-chart-title { font-size: calc(var(--u) * 1.2); }
  .kit-slide .kit-legend { font-size: calc(var(--u) * 1); }
  .kit-slide .kit-chart-note { font-size: calc(var(--u) * 0.95); }
  .kit-slide-foot {
    position: absolute;
    right: calc(var(--u) * 7);
    bottom: calc(var(--u) * 2.4);
    left: calc(var(--u) * 7);
    display: flex;
    justify-content: space-between;
    font-size: calc(var(--u) * 0.82);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--color-muted-foreground);
    font-variant-numeric: tabular-nums;
  }

  @media (max-width: 800px) {
    .kit-with-rail, .kit-with-rail[data-rail="left"], .kit-split, .kit-split[data-layout="aside"] { grid-template-columns: minmax(0, 1fr); }
    .kit-rail { position: static; padding-left: 0 !important; border-left: 0 !important; }
    .kit-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .kit-metric, .kit-metric:first-child { padding: 14px 16px 14px 0; border-left: 0; border-top: 1px solid var(--color-border-subtle); }
    .kit-header h1 { font-size: 30px; }
    .swarm-table td:first-child:not(.nowrap, .num) { min-width: 16ch; }
  }
}

@media print {
  html:has(.kit-deck) { scroll-snap-type: none; }
  .kit-slide { height: 100vh; break-after: page; break-inside: avoid; border-bottom: 0; }
  .kit-rail { position: static; }
}
`;
