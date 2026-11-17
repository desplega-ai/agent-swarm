import { z } from "zod";

export const argsSchema = z.object({
  url: z.string().optional().describe("Site to read the brand from, for example https://www.agent-swarm.dev"),
  css: z.string().optional().describe("A pasted CSS variable block (shadcn, tweakcn, Tailwind v4)"),
  preset: z.string().optional().describe("A preset id, for example hive or paper"),
  pdfUrl: z.string().optional().describe("A brand PDF. Not supported yet: extract its CSS and pass css"),
  basePreset: z.string().optional().describe("Preset the extracted tokens apply on top of (default hive)"),
  mode: z.enum(["viewer", "light", "dark"]).optional().describe("Mode lock (default viewer)"),
  logo: z.object({ url: z.string(), alt: z.string() }).optional().describe("https logo URL and alt text"),
  fontsHref: z.string().optional().describe("Google Fonts stylesheet URL; a url seed reads it from the site"),
  chartPalette: z.array(z.string()).optional().describe("Ordered chart series colors"),
  save: z.boolean().optional().describe("Save the design system after the preview. Only once the requester approved it"),
});

const LIGHT = new Set([":root", ":host", "html"]);
const DARK = new Set([".dark", ":root.dark", "html.dark", "[data-theme=dark]", '[data-theme="dark"]']);
/** The token contract names in their shadcn, bare and `--color-` spellings. Tailwind palette stops stay out. */
const CONTRACT_NAME =
  /^--(?:color-)?(?:background|foreground|card|surface|popover|primary|secondary|muted|accent|destructive|border|input|ring|chart-\d|status-[a-z]+)(?:-(?:foreground|subtle|strong|solid))?$|^--font-(?:sans|mono)$|^--radius(?:-(?:sm|md|lg|xl))?$/;
const MAX_STYLESHEETS = 8;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c: string) => `&#${c.charCodeAt(0)};`);
}

/** The contract declarations of every light and dark theme block, as one clean CSS block per mode. */
function themeCss(css: string): string {
  const light: string[] = [];
  const dark: string[] = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const parts = (match[1] ?? "").split(",").map((part: string) => part.trim());
    const target = parts.every((p: string) => LIGHT.has(p)) ? light : parts.every((p: string) => DARK.has(p)) ? dark : null;
    if (!target) continue;
    for (const declaration of (match[2] ?? "").split(";")) {
      const colon = declaration.indexOf(":");
      const name = declaration.slice(0, colon).trim();
      if (colon > 0 && CONTRACT_NAME.test(name)) target.push(`${name}: ${declaration.slice(colon + 1).trim()};`);
    }
  }
  return [light.length ? `:root { ${light.join(" ")} }` : "", dark.length ? `.dark { ${dark.join(" ")} }` : ""]
    .filter(Boolean)
    .join("\n");
}

async function readSite(url: string, ctx: any): Promise<{ css: string; fontsHref?: string }> {
  const html = await (await ctx.stdlib.fetch(url, { headers: { Accept: "text/html" } })).text();
  const hrefs: string[] = [];
  let fontsHref: string | undefined;
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const href = tag.match(/href=["']([^"']+)["']/i)?.[1]?.replace(/&amp;/g, "&");
    if (!href || !/rel=["']?stylesheet/i.test(tag)) continue;
    if (href.startsWith("https://fonts.googleapis.com/")) fontsHref ??= href;
    else hrefs.push(new URL(href, url).href);
  }
  const sheets = await Promise.all(
    hrefs.slice(0, MAX_STYLESHEETS).map(async (href) => (await ctx.stdlib.fetch(href)).text()),
  );
  const inline = (html.match(/<style\b[^>]*>[\s\S]*?<\/style>/gi) ?? []).map((s: string) => s.replace(/<\/?style\b[^>]*>/gi, ""));
  return { css: themeCss([...inline, ...sheets].join("\n")), fontsHref };
}

function previewHtml(record: any, ignored: string[]): string {
  const names = [...new Set([...Object.keys(record.tokens.light), ...Object.keys(record.tokens.dark)])].sort();
  const rows = names
    .map((name) => {
      const light = record.tokens.light[name] ?? "";
      const dark = record.tokens.dark[name] ?? "";
      const swatch = name.startsWith("--color-") ? `<span class="swarm-badge" data-dot style="--swarm-dot: var(${name})">${escapeHtml(name)}</span>` : escapeHtml(name);
      return `<tr><td class="nowrap">${swatch}</td><td>${escapeHtml(light)}</td><td>${escapeHtml(dark)}</td></tr>`;
    })
    .join("");
  const palette = (record.chartPalette ?? [])
    .map((color: string) => `<span class="swarm-badge" data-dot style="--swarm-dot: ${escapeHtml(color)}">${escapeHtml(color)}</span>`)
    .join(" ");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Design system preview</title>
${record.fontsHref ? `<link href="${escapeHtml(record.fontsHref)}" rel="stylesheet">` : ""}</head>
<body><main class="swarm-page">
${record.logo ? `<img src="${escapeHtml(record.logo.url)}" alt="${escapeHtml(record.logo.alt)}" style="height:40px;width:auto">` : ""}
<p class="swarm-eyebrow">Design system preview · ${escapeHtml(record.source.kind)}${record.source.ref ? ` · ${escapeHtml(record.source.ref)}` : ""}</p>
<h1>Every page will look like this</h1>
<p class="swarm-lede">Base preset ${escapeHtml(record.basePreset)}, mode ${escapeHtml(record.mode)}. Nothing is saved until the requester approves it.</p>
<div class="swarm-metrics">
<div class="swarm-metric"><div class="swarm-metric-value">${names.length}</div><div class="swarm-metric-label">Tokens set</div></div>
<div class="swarm-metric" data-tone="success"><div class="swarm-metric-value">98.2%</div><div class="swarm-metric-label">Sample success rate</div></div>
<div class="swarm-metric" data-tone="error"><div class="swarm-metric-value">3</div><div class="swarm-metric-label">Sample failures</div></div>
</div>
<section class="swarm-section"><h2>Components</h2>
<p><button class="swarm-button" data-variant="primary" type="button">Primary action</button> <button class="swarm-button" type="button">Secondary</button></p>
<p><span class="swarm-badge" data-tone="success" data-dot>Healthy</span> <span class="swarm-badge" data-tone="warning" data-dot>Degraded</span> <span class="swarm-badge" data-tone="error" data-dot>Down</span></p>
<div class="swarm-callout">A callout reads like this. <a href="#tokens">Links use the primary color.</a></div>
${palette ? `<p>Chart palette: ${palette}</p>` : ""}
</section>
<section class="swarm-section" id="tokens"><h2>Tokens</h2>
<div class="swarm-table-wrap"><table class="swarm-table"><thead><tr><th>Token</th><th>Light</th><th>Dark</th></tr></thead><tbody>${rows || '<tr><td colspan="3">The base preset only.</td></tr>'}</tbody></table></div>
${ignored.length ? `<details><summary>${ignored.length} ignored names</summary><p>${escapeHtml(ignored.join(", "))}</p></details>` : ""}
</section></main></body></html>`;
}

/** Build an org design system from a site URL, a CSS block or a preset, publish a preview page, and save it once approved. */
export default async function designSystemSeed(args: any, ctx: any) {
  const parsed = argsSchema.safeParse(args ?? {});
  if (!parsed.success) return { error: "invalid args: " + parsed.error.message };
  const a = parsed.data;
  const inputs = [a.url, a.css, a.preset, a.pdfUrl].filter((value) => value !== undefined);
  if (inputs.length !== 1) return { error: "pass exactly one of url, css, preset or pdfUrl" };
  // shortcut: no brand-PDF extraction (taste-engine extract_brand_kit is not wired), add it when a requester sends a PDF.
  if (a.pdfUrl) return { error: "brand PDFs are not supported yet: extract the CSS variables and pass css" };

  let css = a.css;
  let fontsHref = a.fontsHref;
  let source: any = { kind: "manual" };
  if (a.url) {
    if (!/^https?:\/\//i.test(a.url)) return { error: "url must be an absolute http(s) URL" };
    const site = await readSite(a.url, ctx);
    if (!site.css) return { error: `no :root or .dark custom properties found on ${a.url}` };
    css = site.css;
    fontsHref ??= site.fontsHref;
    source = { kind: "website", ref: a.url, extractedAt: new Date().toISOString() };
  }
  if (a.preset) source = { kind: "preset", ref: a.preset };

  const input = {
    basePreset: a.preset ?? a.basePreset,
    ...(css ? { themeTokens: { format: "css", css } } : {}),
    ...(fontsHref ? { fontsHref } : {}),
    ...(a.logo ? { logo: a.logo } : {}),
    ...(a.mode ? { mode: a.mode } : {}),
    ...(a.chartPalette ? { chartPalette: a.chartPalette } : {}),
    source,
  };
  const checked: any = await ctx.swarm.designSystem_set({ ...input, dryRun: true });
  const draft = checked?.data ?? checked;
  if (draft?.success === false || !draft?.designSystem) return { error: draft?.message ?? "design system validation failed" };
  const record = draft.designSystem;
  const ignored: string[] = draft.ignoredTokens ?? [];

  const page: any = await ctx.swarm.page_create({
    title: "Design system preview",
    slug: "design-system-preview",
    contentType: "text/html",
    body: previewHtml(record, ignored),
    theme: record.basePreset,
    themeTokens: { light: record.tokens.light, dark: record.tokens.dark },
    designVersion: 2,
  });
  const pageData = page?.data ?? page;
  if (a.save) await ctx.swarm.designSystem_set(input);
  return {
    saved: a.save === true,
    previewUrl: pageData?.app_url ?? null,
    previewApiUrl: pageData?.api_url ?? null,
    designSystem: record,
    ignoredTokens: ignored,
    // Pass this to design-system-set (or rerun with save: true) once the requester approves.
    saveInput: input,
  };
}
