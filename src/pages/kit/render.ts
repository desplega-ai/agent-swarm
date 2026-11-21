/**
 * Server renderer for the page kit. `renderKitDocument` turns a validated
 * `{ template, slots }` spec into a plain design system v2 HTML document; the
 * `/p/:id` route injects the theme head (`buildPageHeadV2`) and the browser
 * SDK like for any HTML page. Pages are rendered on read, so a fix here
 * restyles every kit page, and share links, print and the org design system
 * keep working because the output is ordinary v2 HTML.
 */
import { type ChartContext, horizontalHeight, renderChart } from "./chart";
import { KIT_CSS } from "./kit-css";
import { blockMarkdown, escapeHtml, inlineMarkdown, slugId } from "./markdown";
import type { KitBlock, KitCell, KitSection, KitSlide, PageKit } from "./schema";

type Ctx = ChartContext & { rail?: boolean };
type Header = Extract<PageKit, { template: "report" }>["slots"]["header"];
type Metrics = NonNullable<Extract<PageKit, { template: "report" }>["slots"]["metrics"]>;
type Fields = Extract<KitBlock, { type: "Fields" }>;
type Table = Extract<KitBlock, { type: "Table" }>;
type Node = KitBlock | KitSection;

const PAGE_W = 1072;
const RAIL_W = 248;
const RAIL_GAP = 56;

// ─── Components ─────────────────────────────────────────────────────────────

function renderMeta(meta: { label: string; value: string }[] | undefined): string {
  if (!meta?.length) return "";
  return `<dl class="kit-meta">${meta
    .map((m) => `<div><dt>${escapeHtml(m.label)}</dt><dd>${inlineMarkdown(m.value)}</dd></div>`)
    .join("")}</dl>`;
}

function renderHeader(node: Header, opts: { compact?: boolean } = {}): string {
  const p = node.props;
  const text = `${p.eyebrow ? `<p class="swarm-eyebrow">${inlineMarkdown(p.eyebrow)}</p>` : ""}<h1>${inlineMarkdown(p.title)}</h1>${p.lede ? `<p class="swarm-lede">${inlineMarkdown(p.lede)}</p>` : ""}`;
  return opts.compact
    ? `<header class="kit-header" data-compact><div>${text}</div>${renderMeta(p.meta)}</header>`
    : `<header class="kit-header">${text}${renderMeta(p.meta)}</header>`;
}

function renderMetrics(node: Metrics | null | undefined): string {
  if (!node) return "";
  const items = node.props.items;
  return `<div class="kit-metrics" style="--kit-cols:${items.length}">${items
    .map(
      (m) => `<div class="kit-metric">
<div class="kit-metric-label">${escapeHtml(m.label)}</div>
<div class="kit-metric-value">${escapeHtml(m.value)}${m.unit ? `<small>${escapeHtml(m.unit)}</small>` : ""}</div>
<div class="kit-metric-compare">${m.delta ? `<span class="kit-delta" data-tone="${m.tone ?? "neutral"}">${escapeHtml(m.delta)}</span> ` : ""}${inlineMarkdown(m.compare)}</div>
</div>`,
    )
    .join("")}</div>`;
}

function renderCell(cell: KitCell): string {
  if (typeof cell === "object") {
    if ("badge" in cell)
      return `<span class="swarm-badge" data-tone="${cell.tone ?? "neutral"}" data-dot>${escapeHtml(cell.badge)}</span>`;
    return `<span class="kit-delta" data-tone="${cell.tone ?? "neutral"}">${inlineMarkdown(cell.text)}</span>`;
  }
  return inlineMarkdown(cell);
}

function renderTable(node: Table): string {
  const p = node.props;
  const align = p.align ?? [];
  const short = (c: KitCell) => typeof c === "object" || String(c).length <= 16;
  const cls = (i: number, c: KitCell) => {
    const names = [
      align[i] === "right" ? "num" : "",
      align[i] !== "right" && short(c) ? "nowrap" : "",
    ].filter(Boolean);
    return names.length ? ` class="${names.join(" ")}"` : "";
  };
  const row = (cells: KitCell[], tag = "td") =>
    `<tr>${cells.map((c, i) => `<${tag}${cls(i, c)}>${renderCell(c)}</${tag}>`).join("")}</tr>`;
  return `<div class="swarm-table-wrap">${p.title ? `<p class="kit-table-title">${inlineMarkdown(p.title)}</p>` : ""}<table class="swarm-table">
${p.caption ? `<caption class="kit-sr">${escapeHtml(p.caption)}</caption>` : ""}
<thead>${row(p.headers, "th")}</thead>
<tbody>${p.rows.map((r) => row(r)).join("")}</tbody>
${p.footer ? `<tfoot>${row(p.footer)}</tfoot>` : ""}
</table></div>`;
}

function renderFields(node: Fields, ctx: Ctx): string {
  const title = node.props?.title
    ? `<p class="swarm-eyebrow">${escapeHtml(node.props.title)}</p>`
    : "";
  const stacked = ctx.rail ? " kit-kv-stacked" : "";
  const body = `${title}<dl class="swarm-kv${stacked}">${node.children
    .map((f) => `<dt>${escapeHtml(f.props.label)}</dt><dd>${inlineMarkdown(f.props.value)}</dd>`)
    .join("")}</dl>`;
  return `<div class="kit-fields${ctx.panel ? " swarm-panel" : ""}">${body}</div>`;
}

function renderNode(node: Node, ctx: Ctx): string {
  switch (node.type) {
    case "Text":
      return `<div class="kit-text${node.props.style === "muted" ? " kit-muted" : ""}">${blockMarkdown(node.props.content)}</div>`;
    case "Fields":
      return renderFields(node, ctx);
    case "Table":
      return renderTable(node);
    case "Chart":
      return renderChart(node.props, ctx);
    case "Callout": {
      const p = node.props;
      return `<div class="swarm-callout" data-tone="${p.tone ?? "info"}">${p.title ? `<p class="kit-callout-title">${inlineMarkdown(p.title)}</p>` : ""}${blockMarkdown(p.content)}</div>`;
    }
    case "Details": {
      const p = node.props;
      const code =
        p.code === undefined
          ? ""
          : `<pre><code>${escapeHtml(typeof p.code === "string" ? p.code : JSON.stringify(p.code, null, 2))}</code></pre>`;
      return `<details class="kit-details"><summary>${inlineMarkdown(p.summary)}</summary>${p.content ? blockMarkdown(p.content) : ""}${code}</details>`;
    }
    case "Section":
      return renderSection(node, ctx);
  }
}

function renderAll(nodes: Node[] | Node | null | undefined, ctx: Ctx): string {
  const list = Array.isArray(nodes) ? nodes : nodes ? [nodes] : [];
  return list.map((n) => renderNode(n, ctx)).join("\n");
}

function renderSplit(children: KitBlock[], layout: "split" | "aside", ctx: Ctx, gap = 40): string {
  const inner = ctx.width - gap;
  const widths = layout === "aside" ? [(inner * 2) / 3, inner / 3] : [inner / 2, inner / 2];
  const [first, ...rest] = children;
  // Two charts side by side: the vertical one takes the height of the horizontal one.
  const second = rest[0];
  if (first?.type === "Chart" && second?.type === "Chart" && rest.length === 1) {
    const horizontal = [first, second].find((c) => c.props.chart.horizontal);
    if (horizontal) ctx = { ...ctx, chartHeight: horizontalHeight(horizontal.props.chart) };
  }
  const column = (nodes: KitBlock[], width: number) => {
    const boxed = ctx.panel && nodes.every((n) => n.type !== "Chart" && n.type !== "Table");
    return boxed
      ? `<div><div class="swarm-panel kit-stack">${renderAll(nodes, { ...ctx, panel: false, width: width - 42 })}</div></div>`
      : `<div>${renderAll(nodes, { ...ctx, width })}</div>`;
  };
  return `<div class="kit-split" data-layout="${layout}">${column(first ? [first] : [], widths[0] ?? inner)}${column(rest, widths[1] ?? inner)}</div>`;
}

function renderSection(node: KitSection, ctx: Ctx): string {
  const title = node.props?.title;
  const layout = node.props?.layout ?? "stack";
  const body =
    layout === "stack" ? renderAll(node.children, ctx) : renderSplit(node.children, layout, ctx);
  return `<section class="swarm-section"${title ? ` id="${slugId(title)}"` : ""}>${title ? `<h2>${inlineMarkdown(title)}</h2>` : ""}${body}</section>`;
}

// ─── Templates ──────────────────────────────────────────────────────────────

function withRail(main: string, rail: string, side: "left" | "right"): string {
  const aside = `<aside class="kit-rail">${rail}</aside>`;
  const body = `<div class="kit-main">${main}</div>`;
  return `<div class="kit-with-rail" data-rail="${side}">${side === "left" ? aside + body : body + aside}</div>`;
}

function renderReport(slots: Extract<PageKit, { template: "report" }>["slots"]): string {
  const railed = Boolean(slots.aside || slots.toc);
  const main = renderAll(slots.sections, { width: railed ? PAGE_W - RAIL_W - RAIL_GAP : PAGE_W });
  const aside = slots.aside ? renderAll(slots.aside, { width: RAIL_W, rail: true }) : "";
  let body = main;
  if (slots.toc) {
    const links = slots.sections
      .map((s) => s.props?.title)
      .filter((t): t is string => Boolean(t))
      .map((t) => `<a href="#${slugId(t)}">${inlineMarkdown(t)}</a>`)
      .join("");
    body = withRail(
      main,
      `<div><p class="swarm-eyebrow">On this page</p><nav class="kit-toc">${links}</nav></div>${aside}`,
      "left",
    );
  } else if (slots.aside) {
    body = withRail(main, aside, "right");
  }
  const appendix = slots.appendix
    ? `<section class="swarm-section kit-appendix"><p class="swarm-eyebrow">Appendix</p>${renderAll(slots.appendix, { width: PAGE_W })}</section>`
    : "";
  return `<main class="swarm-page kit-report">
${renderHeader(slots.header)}
${renderAll(slots.summary, { width: PAGE_W })}
${renderMetrics(slots.metrics)}
${body}
${appendix}
</main>`;
}

function renderOnePager(slots: Extract<PageKit, { template: "one-pager" }>["slots"]): string {
  const narrow = !slots.aside && !slots.metrics;
  const ctx: Ctx = { width: slots.aside ? PAGE_W - RAIL_W - RAIL_GAP : narrow ? 712 : PAGE_W };
  const main = renderAll(slots.sections, ctx);
  const body = slots.aside
    ? withRail(main, renderAll(slots.aside, { width: RAIL_W, rail: true }), "right")
    : main;
  const facts = slots.facts
    ? `<dl class="kit-facts">${slots.facts.children
        .map(
          (f) =>
            `<div><dt>${escapeHtml(f.props.label)}</dt><dd>${inlineMarkdown(f.props.value)}</dd></div>`,
        )
        .join("")}</dl>`
    : "";
  return `<main class="swarm-page kit-onepager"${narrow ? " data-narrow" : ""}>
${renderHeader(slots.header)}
${facts}
${renderMetrics(slots.metrics)}
${body}
${slots.footer ? `<footer class="kit-footer">${renderAll(slots.footer, ctx)}</footer>` : ""}
</main>`;
}

type DashboardSlots = Extract<PageKit, { template: "dashboard" }>["slots"];

function renderDashboard(slots: DashboardSlots): string {
  const ctx: Ctx = { width: 1232, panel: true };
  return `<main class="swarm-page kit-dashboard">
${renderHeader(slots.header, { compact: true })}
${renderAll(slots.notice, ctx)}
${renderMetrics(slots.metrics)}
${renderAll(slots.sections, ctx)}
${slots.footer ? `<footer class="kit-footer">${renderAll(slots.footer, ctx)}</footer>` : ""}
</main>`;
}

function renderSlide(node: KitSlide, index: number, total: number, deckTitle: string): string {
  const p = node.props;
  const layout = p.layout ?? "content";
  const children = node.children ?? [];
  const ctx: Ctx = { width: 1238, deck: true };
  const eyebrow = p.eyebrow ? `<p class="swarm-eyebrow">${inlineMarkdown(p.eyebrow)}</p>` : "";
  let body: string;
  if (layout === "title") {
    body = `${eyebrow}<h1>${inlineMarkdown(p.title)}</h1>${p.lede ? `<p class="swarm-lede">${inlineMarkdown(p.lede)}</p>` : ""}${renderMeta(p.meta)}`;
  } else if (layout === "statement") {
    body = `${eyebrow}<p class="kit-statement">${inlineMarkdown(p.title)}</p>${renderAll(children, ctx)}`;
  } else if (layout === "quote") {
    body = `${eyebrow}<blockquote class="kit-quote"><p>${inlineMarkdown(p.quote)}</p>${p.attribution ? `<footer>${inlineMarkdown(p.attribution)}</footer>` : ""}</blockquote>${renderAll(children, ctx)}`;
  } else if (layout === "split") {
    body = `<div class="kit-slide-head">${eyebrow}<h2>${inlineMarkdown(p.title)}</h2></div><div class="kit-slide-content">${renderSplit(children, "split", ctx, 72)}</div>`;
  } else {
    // Title in the left column, content in the right one.
    body = `<div class="kit-slide-head">${eyebrow}<h2>${inlineMarkdown(p.title)}</h2></div><div class="kit-slide-content">${renderAll(children, { ...ctx, width: 717 })}</div>`;
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return `<section class="kit-slide" data-layout="${layout}" id="s${index + 1}" aria-label="Slide ${index + 1} of ${total}">
<div class="kit-slide-body">${body}</div>
<footer class="kit-slide-foot"><span>${escapeHtml(deckTitle)}</span><span>${pad(index + 1)} / ${pad(total)}</span></footer>
</section>`;
}

/** Arrow keys, Page Up/Down and Space move one slide; print puts one slide per page (kit CSS). */
const DECK_KEYS_SCRIPT = `<script>(function () {
  var slides = Array.prototype.slice.call(document.querySelectorAll(".kit-slide"));
  function current() {
    var best = 0, distance = Infinity;
    slides.forEach(function (s, i) { var d = Math.abs(s.getBoundingClientRect().top); if (d < distance) { distance = d; best = i; } });
    return best;
  }
  document.addEventListener("keydown", function (event) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    var t = event.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    var step = ["ArrowRight", "ArrowDown", "PageDown", " "].indexOf(event.key) >= 0 ? 1 : ["ArrowLeft", "ArrowUp", "PageUp"].indexOf(event.key) >= 0 ? -1 : event.key === "Home" ? -slides.length : event.key === "End" ? slides.length : 0;
    if (!step) return;
    event.preventDefault();
    var next = Math.max(0, Math.min(slides.length - 1, current() + step));
    slides[next].scrollIntoView({ behavior: "smooth" });
  });
})();</script>`;

function renderDeck(slots: Extract<PageKit, { template: "deck" }>["slots"]): string {
  const slides = slots.slides;
  const deckTitle = slides[0]?.props.title ?? "";
  return `<main class="kit-deck">
${slides.map((s, i) => renderSlide(s, i, slides.length, deckTitle)).join("\n")}
</main>
${DECK_KEYS_SCRIPT}`;
}

/** The page title a kit spec carries: the header title, or the first slide's. */
export function kitTitle(kit: PageKit): string {
  return kit.template === "deck"
    ? (kit.slots.slides[0]?.props.title ?? "")
    : kit.slots.header.props.title;
}

export type KitRenderOptions = {
  /** Page title for `<title>`; defaults to the spec's own title. */
  title?: string;
  /** Dashboard only: the `data` KV value, already validated, merged over the spec. */
  dashboardData?: {
    notice?: DashboardSlots["notice"] | null;
    metrics?: DashboardSlots["metrics"] | null;
    sections?: DashboardSlots["sections"];
    footer?: DashboardSlots["footer"] | null;
  };
};

/** Merge a dashboard `data` value over the spec: a key replaces its slot, null clears it. */
function mergeDashboard(
  slots: DashboardSlots,
  data: KitRenderOptions["dashboardData"],
): DashboardSlots {
  if (!data) return slots;
  const pick = <T>(value: T | null | undefined, fallback: T | undefined): T | undefined =>
    value === null ? undefined : (value ?? fallback);
  return {
    ...slots,
    notice: pick(data.notice, slots.notice),
    metrics: pick(data.metrics, slots.metrics),
    sections: data.sections ?? slots.sections,
    footer: pick(data.footer, slots.footer),
  };
}

/** A full HTML document for a kit spec. The `/p/:id` route adds the theme head and the SDK. */
export function renderKitDocument(kit: PageKit, opts: KitRenderOptions = {}): string {
  let body: string;
  let refresh = "";
  switch (kit.template) {
    case "report":
      body = renderReport(kit.slots);
      break;
    case "one-pager":
      body = renderOnePager(kit.slots);
      break;
    case "dashboard": {
      body = renderDashboard(mergeDashboard(kit.slots, opts.dashboardData));
      const seconds = kit.slots.data?.refreshSeconds;
      // Reload while visible, so a hidden tab does not re-render every interval.
      if (seconds)
        refresh = `<script>setInterval(function () { if (document.visibilityState === "visible") location.reload(); }, ${seconds * 1000});</script>`;
      break;
    }
    case "deck":
      body = renderDeck(kit.slots);
      break;
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="swarm-kit" content="${kit.template}">
<title>${escapeHtml(opts.title ?? kitTitle(kit))}</title>
<style id="swarm-kit">${KIT_CSS}</style>
</head>
<body>
${body}
${refresh}
</body>
</html>
`;
}
