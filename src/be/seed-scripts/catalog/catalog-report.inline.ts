export type CatalogReportFinding = {
  id: string;
  severity?: string;
  summary: string;
  action?: string;
  samples?: unknown[];
};

export type CatalogReportSection = {
  key: string;
  label?: string;
  goal: string;
  findingCount?: number;
  checks?: Record<string, unknown>;
  findings?: CatalogReportFinding[];
};

export type CatalogReport = {
  title: string;
  slug: string;
  description: string;
  generatedAt: string;
  lede: string;
  metrics: Array<[string, unknown]>;
  sections: CatalogReportSection[];
  appendix: unknown;
};

function catalogReportAsText(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : JSON.stringify(value);
}

function catalogReportHtmlEscape(value: unknown): string {
  return catalogReportAsText(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function catalogReportHumanLabel(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_.]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function catalogReportFormatMetric(value: unknown): string {
  if (typeof value === "number") return new Intl.NumberFormat("en-US").format(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return catalogReportAsText(value);
}

function catalogReportSeverityTone(value?: string): string {
  if (value === "critical") return "danger";
  if (value === "high") return "warn";
  if (value === "medium") return "note";
  return "low";
}

function catalogReportIsScalar(value: unknown): boolean {
  return value == null || ["string", "number", "boolean"].includes(typeof value);
}

function catalogReportIsRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function catalogReportValueClass(value: unknown): string {
  if (typeof value === "number") return "numeric";
  if (typeof value === "boolean") return value ? "positive" : "muted-value";
  return "";
}

function catalogReportClassAttr(value: unknown): string {
  const className = catalogReportValueClass(value);
  return className ? ` class="${catalogReportHtmlEscape(className)}"` : "";
}

function catalogReportRenderSampleValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "object" && item !== null ? JSON.stringify(item) : catalogReportAsText(item)))
      .join(", ");
  }
  if (value && typeof value === "object") return JSON.stringify(value);
  return catalogReportAsText(value);
}

function catalogReportRenderSamples(samples?: unknown[]): string {
  if (!Array.isArray(samples) || samples.length === 0) return "";
  const normalized = samples.map((sampleRow) =>
    sampleRow && typeof sampleRow === "object" && !Array.isArray(sampleRow)
      ? (sampleRow as Record<string, unknown>)
      : { value: sampleRow },
  );
  const columns = Array.from(
    new Set(normalized.flatMap((sampleRow) => Object.keys(sampleRow).slice(0, 6))),
  ).slice(0, 6);
  if (columns.length === 0) return "";
  const rows = normalized
    .map(
      (sampleRow) =>
        `<tr>${columns
          .map((column) => `<td>${catalogReportHtmlEscape(catalogReportRenderSampleValue(sampleRow[column]))}</td>`)
          .join("")}</tr>`,
    )
    .join("");
  return `<div class="sample-table" aria-label="Sample rows">
    <table>
      <thead><tr>${columns.map((column) => `<th>${catalogReportHtmlEscape(catalogReportHumanLabel(column))}</th>`).join("")}</tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function catalogReportTableRows(rows: Record<string, unknown>[], limit = 12): string {
  if (rows.length === 0) return '<p class="empty">No rows.</p>';
  const columns = Array.from(new Set(rows.flatMap((row) => Object.keys(row).slice(0, 8)))).slice(0, 8);
  const visible = rows.slice(0, limit);
  const hiddenCount = Math.max(0, rows.length - visible.length);
  return `<div class="data-table" role="region" aria-label="Data table">
    <table>
      <thead><tr>${columns.map((column) => `<th>${catalogReportHtmlEscape(catalogReportHumanLabel(column))}</th>`).join("")}</tr></thead>
      <tbody>
        ${visible
          .map(
            (row) =>
              `<tr>${columns
                .map((column) => {
                  const value = row[column];
                  return `<td${catalogReportClassAttr(value)}>${catalogReportHtmlEscape(
                    catalogReportRenderSampleValue(value),
                  )}</td>`;
                })
                .join("")}</tr>`,
          )
          .join("")}
      </tbody>
    </table>
    ${hiddenCount ? `<p class="table-note">Showing ${visible.length} of ${rows.length} rows. Full payload remains in the appendix.</p>` : ""}
  </div>`;
}

function catalogReportRenderDataValue(value: unknown): string {
  if (catalogReportIsScalar(value)) {
    return `<strong${catalogReportClassAttr(value)}>${catalogReportHtmlEscape(
      catalogReportFormatMetric(value),
    )}</strong>`;
  }
  if (Array.isArray(value)) {
    if (value.every((item) => catalogReportIsRecord(item))) {
      return catalogReportTableRows(value as Record<string, unknown>[]);
    }
    return `<div class="value-list">${value
      .slice(0, 12)
      .map((item) => `<span>${catalogReportHtmlEscape(catalogReportRenderSampleValue(item))}</span>`)
      .join("")}</div>`;
  }
  if (catalogReportIsRecord(value)) {
    const entries = Object.entries(value);
    const scalarEntries = entries.filter(([, entryValue]) => catalogReportIsScalar(entryValue));
    const complexEntries = entries.filter(([, entryValue]) => !catalogReportIsScalar(entryValue));
    return `<div class="data-object">
      ${
        scalarEntries.length
          ? `<div class="object-stats">${scalarEntries
              .map(
                ([label, entryValue]) =>
                  `<div><span>${catalogReportHtmlEscape(catalogReportHumanLabel(label))}</span><strong${catalogReportClassAttr(
                    entryValue,
                  )}>${catalogReportHtmlEscape(catalogReportFormatMetric(entryValue))}</strong></div>`,
              )
              .join("")}</div>`
          : ""
      }
      ${complexEntries
        .map(
          ([label, entryValue]) => `<section class="data-nested">
            <h4>${catalogReportHtmlEscape(catalogReportHumanLabel(label))}</h4>
            ${catalogReportRenderDataValue(entryValue)}
          </section>`,
        )
        .join("")}
    </div>`;
  }
  return `<pre>${catalogReportHtmlEscape(JSON.stringify(value, null, 2))}</pre>`;
}

function catalogReportRenderDataPanels(entries: Array<[string, unknown]>): string {
  if (entries.length === 0) return "";
  return `<div class="data-panels">
    ${entries
      .map(
        ([label, value]) => `<section class="data-panel">
          <div class="data-panel-head">
            <h3>${catalogReportHtmlEscape(catalogReportHumanLabel(label))}</h3>
            <span>${catalogReportHtmlEscape(
              Array.isArray(value)
                ? `${value.length} rows`
                : catalogReportIsRecord(value)
                  ? `${Object.keys(value).length} fields`
                  : "value",
            )}</span>
          </div>
          ${catalogReportRenderDataValue(value)}
        </section>`,
      )
      .join("")}
  </div>`;
}

export function renderCatalogReportPage(report: CatalogReport): string {
  const nav = report.sections
    .map(
      (section) =>
        `<a href="#${catalogReportHtmlEscape(section.key)}"><span>${catalogReportHtmlEscape(
          section.label || catalogReportHumanLabel(section.key),
        )}</span><strong>${catalogReportHtmlEscape(catalogReportFormatMetric(section.findingCount ?? section.findings?.length ?? 0))}</strong></a>`,
    )
    .join("");
  const sections = report.sections
    .map((section) => {
      const checkEntries = Object.entries(section.checks || {});
      const scalarChecks = checkEntries.filter(([, value]) => catalogReportIsScalar(value));
      const dataChecks = checkEntries.filter(([, value]) => !catalogReportIsScalar(value));
      const findings = (section.findings || [])
        .map(
          (finding) => `<article class="finding ${catalogReportHtmlEscape(catalogReportSeverityTone(finding.severity))}">
            <div class="finding-head">
              <div>
                <p class="finding-id">${catalogReportHtmlEscape(finding.id)}</p>
                <h3>${catalogReportHtmlEscape(finding.summary)}</h3>
              </div>
              <span class="pill ${catalogReportHtmlEscape(catalogReportSeverityTone(finding.severity))}">${catalogReportHtmlEscape(
                finding.severity || "low",
              )}</span>
            </div>
            ${finding.action ? `<p class="action">${catalogReportHtmlEscape(finding.action)}</p>` : ""}
            ${catalogReportRenderSamples(finding.samples)}
          </article>`,
        )
        .join("");
      const checks = scalarChecks
        .map(
          ([label, value]) =>
            `<div class="check"><span>${catalogReportHtmlEscape(catalogReportHumanLabel(label))}</span><strong${catalogReportClassAttr(
              value,
            )}>${catalogReportHtmlEscape(catalogReportFormatMetric(value))}</strong></div>`,
        )
        .join("");
      return `<section class="section" id="${catalogReportHtmlEscape(section.key)}">
        <div class="section-grid">
          <aside class="checks">
            <p class="section-kicker">${catalogReportHtmlEscape(section.label || catalogReportHumanLabel(section.key))}</p>
            <div class="check-list">${checks || '<p class="empty">No scalar checks.</p>'}</div>
          </aside>
          <div>
            <div class="section-head">
              <h2>${catalogReportHtmlEscape(section.goal)}</h2>
              <span>${catalogReportHtmlEscape(catalogReportFormatMetric(section.findingCount ?? section.findings?.length ?? 0))} finding(s)</span>
            </div>
            ${catalogReportRenderDataPanels(dataChecks)}
            <div class="findings">
              ${findings || '<p class="empty">No actionable findings in this cluster.</p>'}
            </div>
          </div>
        </div>
      </section>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#f5f2ea">
  <title>${catalogReportHtmlEscape(report.title)}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f5f2ea;
      --panel: #ffffff;
      --panel-soft: #fbfaf6;
      --ink: #18181b;
      --muted: #5f6368;
      --muted-strong: #3f3f46;
      --line: #ded8cb;
      --line-soft: #ebe5d7;
      --accent: #255c99;
      --accent-soft: #edf5ff;
      --danger: #b42318;
      --danger-bg: #fff1f0;
      --warn: #b54708;
      --warn-bg: #fff7ed;
      --note: #175cd3;
      --note-bg: #eff6ff;
      --low: #067647;
      --low-bg: #ecfdf3;
      --radius: 8px;
      --shadow: 0 1px 2px rgba(24, 24, 27, 0.06), 0 14px 36px rgba(24, 24, 27, 0.07);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 16px;
      line-height: 1.55;
    }
    main {
      width: min(1240px, calc(100% - 32px));
      margin: 0 auto;
      padding: 48px 0 72px;
    }
    header {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 24px;
      align-items: end;
      margin-bottom: 24px;
      padding-bottom: 22px;
      border-bottom: 1px solid var(--line);
    }
    .eyebrow {
      margin: 0 0 8px;
      color: var(--muted);
      font-size: 13px;
      font-weight: 750;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    h1 {
      margin: 0;
      max-width: 860px;
      font-size: clamp(2rem, 3.8vw, 3.25rem);
      line-height: 1.05;
      letter-spacing: 0;
    }
    .lede {
      max-width: 840px;
      margin: 16px 0 0;
      color: var(--muted-strong);
      font-size: 18px;
    }
    .description {
      max-width: 340px;
      margin: 0;
      color: var(--muted);
      font-size: 14px;
      text-align: right;
    }
    .metrics {
      display: grid;
      grid-template-columns: repeat(6, minmax(0, 1fr));
      gap: 12px;
      margin: 24px 0 16px;
    }
    .metric, .section, details, .report-nav {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
    }
    .metric {
      min-height: 112px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }
    .metric strong {
      display: block;
      font-size: 30px;
      line-height: 1;
      font-variant-numeric: tabular-nums;
      overflow-wrap: anywhere;
    }
    .metric span {
      display: block;
      margin-top: 8px;
      color: var(--muted);
      font-size: 13px;
      font-weight: 650;
    }
    .report-nav {
      display: grid;
      grid-template-columns: repeat(6, minmax(0, 1fr));
      gap: 1px;
      overflow: hidden;
      margin: 0 0 20px;
      background: var(--line);
    }
    .report-nav a {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      min-height: 48px;
      padding: 11px 13px;
      background: var(--panel);
      color: var(--muted-strong);
      text-decoration: none;
      font-size: 13px;
      font-weight: 700;
    }
    .report-nav a:hover { background: var(--accent-soft); }
    .report-nav strong {
      color: var(--accent);
      font-variant-numeric: tabular-nums;
    }
    .section {
      margin-top: 16px;
      padding: 22px;
    }
    .section-grid {
      display: grid;
      grid-template-columns: 240px minmax(0, 1fr);
      gap: 24px;
    }
    .checks {
      position: sticky;
      top: 18px;
      align-self: start;
    }
    .section-kicker {
      margin: 0 0 12px;
      color: var(--accent);
      font-size: 13px;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .check-list {
      display: grid;
      gap: 8px;
    }
    .check {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 0;
      border-bottom: 1px solid var(--line);
    }
    .check:last-child { border-bottom: 0; }
    .check span {
      color: var(--muted);
      font-size: 13px;
    }
    .check strong {
      font-size: 18px;
      font-variant-numeric: tabular-nums;
      text-align: right;
      overflow-wrap: anywhere;
    }
    .section-head {
      display: flex;
      align-items: start;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 16px;
    }
    .section-head h2 {
      max-width: 680px;
      margin: 0;
      font-size: 24px;
      line-height: 1.2;
      letter-spacing: 0;
    }
    .section-head > span {
      flex: 0 0 auto;
      color: var(--accent);
      background: var(--accent-soft);
      border: 1px solid #cfe5ff;
      border-radius: 999px;
      padding: 5px 10px;
      font-size: 13px;
      font-weight: 700;
      white-space: nowrap;
    }
    .data-panels {
      display: grid;
      gap: 12px;
      margin: 0 0 16px;
    }
    .data-panel {
      border: 1px solid var(--line-soft);
      border-radius: var(--radius);
      background: var(--panel-soft);
      overflow: hidden;
    }
    .data-panel-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 16px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--line-soft);
      background: #fffdf8;
    }
    .data-panel-head h3,
    .data-nested h4 {
      margin: 0;
      color: var(--muted-strong);
      font-size: 14px;
      line-height: 1.25;
      letter-spacing: 0;
    }
    .data-panel-head span,
    .table-note {
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }
    .data-object {
      display: grid;
      gap: 12px;
      padding: 14px;
    }
    .object-stats {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
    }
    .object-stats > div {
      min-height: 76px;
      padding: 12px;
      border: 1px solid var(--line-soft);
      border-radius: var(--radius);
      background: var(--panel);
    }
    .object-stats span,
    .value-list span {
      display: block;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }
    .object-stats strong {
      display: block;
      margin-top: 6px;
      color: var(--ink);
      font-size: 20px;
      line-height: 1.1;
      font-variant-numeric: tabular-nums;
      overflow-wrap: anywhere;
    }
    .data-nested {
      display: grid;
      gap: 8px;
    }
    .data-table {
      overflow-x: auto;
      background: var(--panel);
    }
    .data-table .table-note {
      margin: 0;
      padding: 10px 12px;
      border-top: 1px solid var(--line-soft);
      background: var(--panel-soft);
    }
    .value-list {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      padding: 14px;
    }
    .value-list span {
      padding: 6px 9px;
      border: 1px solid var(--line-soft);
      border-radius: 999px;
      background: var(--panel);
      color: var(--muted-strong);
      overflow-wrap: anywhere;
    }
    .numeric { font-variant-numeric: tabular-nums; }
    .positive { color: var(--low); }
    .muted-value { color: var(--muted); }
    .findings {
      display: grid;
      gap: 12px;
    }
    .finding {
      border: 1px solid var(--line);
      border-left: 4px solid var(--note);
      border-radius: var(--radius);
      padding: 16px;
      background: #fffdf8;
    }
    .finding.danger { border-left-color: var(--danger); }
    .finding.warn { border-left-color: var(--warn); }
    .finding.low { border-left-color: var(--low); }
    .finding-head {
      display: flex;
      align-items: start;
      justify-content: space-between;
      gap: 16px;
    }
    .finding-id {
      margin: 0 0 4px;
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
    }
    h3 {
      margin: 0;
      font-size: 17px;
      line-height: 1.3;
      letter-spacing: 0;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      min-height: 26px;
      padding: 4px 9px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 800;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .pill.danger { background: var(--danger-bg); color: var(--danger); }
    .pill.warn { background: var(--warn-bg); color: var(--warn); }
    .pill.note { background: var(--note-bg); color: var(--note); }
    .pill.low { background: var(--low-bg); color: var(--low); }
    .action {
      margin: 10px 0 0;
      color: var(--muted);
    }
    .sample-table {
      margin-top: 14px;
      overflow-x: auto;
      border: 1px solid var(--line);
      border-radius: var(--radius);
      background: var(--panel);
    }
    table {
      width: 100%;
      min-width: 640px;
      border-collapse: collapse;
    }
    th, td {
      padding: 10px 12px;
      border-bottom: 1px solid var(--line);
      text-align: left;
      vertical-align: top;
    }
    th {
      color: var(--muted);
      font-size: 12px;
      font-weight: 800;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    td {
      max-width: 360px;
      color: #27272a;
      font-size: 13px;
      overflow-wrap: anywhere;
    }
    tr:last-child td { border-bottom: 0; }
    .empty {
      margin: 0;
      color: var(--muted);
    }
    details {
      margin-top: 24px;
      padding: 18px;
    }
    summary {
      cursor: pointer;
      font-weight: 800;
    }
    pre {
      margin: 16px 0 0;
      max-height: 560px;
      overflow: auto;
      padding: 16px;
      border-radius: var(--radius);
      background: #111827;
      color: #f9fafb;
      font-size: 12px;
      line-height: 1.45;
    }
    @media (max-width: 860px) {
      main { width: min(100% - 24px, 1120px); padding-top: 32px; }
      header { grid-template-columns: 1fr; }
      .description { max-width: none; text-align: left; }
      .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .report-nav { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .section-grid { grid-template-columns: 1fr; gap: 18px; }
      .checks { position: static; }
      .section { padding: 18px; }
      .section-head { display: block; }
      .section-head > span { display: block; margin-top: 8px; }
      .object-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 520px) {
      .metrics { grid-template-columns: 1fr; }
      .report-nav { grid-template-columns: 1fr; }
      .lede { font-size: 16px; }
      .finding-head { display: block; }
      .pill { margin-top: 10px; }
      .object-stats { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <p class="eyebrow">Generated ${catalogReportHtmlEscape(report.generatedAt)}</p>
        <h1>${catalogReportHtmlEscape(report.title)}</h1>
        <p class="lede">${catalogReportHtmlEscape(report.lede)}</p>
      </div>
      <p class="description">${catalogReportHtmlEscape(report.description)}</p>
    </header>
    <section class="metrics" aria-label="Audit summary">
      ${report.metrics
        .map(
          ([label, value]) =>
            `<div class="metric"><strong>${catalogReportHtmlEscape(catalogReportFormatMetric(value))}</strong><span>${catalogReportHtmlEscape(
              label,
            )}</span></div>`,
        )
        .join("")}
    </section>
    <nav class="report-nav" aria-label="Report sections">${nav}</nav>
    ${sections}
    <details>
      <summary>Compressed JSON appendix</summary>
      <pre>${catalogReportHtmlEscape(JSON.stringify(report.appendix, null, 2))}</pre>
    </details>
  </main>
</body>
</html>`;
}

export async function publishCatalogReportPage(report: CatalogReport, ctx: any): Promise<any> {
  const response = await ctx.swarm.page_create({
    title: report.title,
    slug: report.slug,
    description: report.description,
    contentType: "text/html",
    authMode: "authed",
    body: renderCatalogReportPage(report),
  });
  const payload = response?.data ?? response;
  if (payload?.success === false) return { error: payload.error || "page_create failed" };
  return {
    id: payload?.id ?? payload?.page?.id ?? null,
    appUrl: payload?.appUrl ?? payload?.app_url ?? null,
    apiUrl: payload?.apiUrl ?? payload?.api_url ?? null,
    version: payload?.version ?? payload?.page?.version ?? null,
  };
}
