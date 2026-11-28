/**
 * `<swarm-chart>`: the page kit's chart, rendered on the server to inline SVG.
 * It follows the branding rules for charts: real axes with nice ticks, the unit
 * on the values, a legend when there is more than one series, a tooltip on
 * every mark (SVG `<title>`), and a grey `baseline` series so a comparison
 * costs no second color. Colors are theme tokens only (`--color-chart-N`).
 */
import { escapeHtml, inlineMarkdown } from "./markdown";
import type { KitChartSpec } from "./schema";

type Series = KitChartSpec["series"][number];

export type ChartContext = {
  /** Width in viewBox units the chart may use. */
  width: number;
  /** Inside a dashboard panel: the chart gets the panel frame. */
  panel?: boolean;
  /** Inside a slide: a smaller viewBox, so labels scale up with the slide. */
  deck?: boolean;
  /** Fixed height, used to match a horizontal chart beside it. */
  chartHeight?: number;
};

export function formatValue(value: number, unit = ""): string {
  const small = !Number.isInteger(value) && Math.abs(value) < 10;
  const n = value.toLocaleString("en-US", { maximumFractionDigits: small ? 2 : 1 });
  if (!unit) return n;
  const currency = unit.match(/^([$€£])(.*)$/);
  if (currency) return `${currency[1]}${n}${currency[2]}`;
  return unit === "%" ? `${n}%` : `${n} ${unit}`;
}

function niceTicks(min: number, max: number, target = 5) {
  const rough = (max - min || 1) / target;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= rough) ?? rough;
  const lo = Number((Math.floor(min / step + 1e-9) * step).toFixed(8));
  const hi = Number((Math.ceil(max / step - 1e-9) * step).toFixed(8));
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 1e6 && ticks.length < 50; v += step) {
    ticks.push(Number(v.toFixed(8)));
  }
  const decimals = Math.max(0, ...ticks.map((t) => (String(t).split(".")[1] ?? "").length));
  return { lo, hi: hi === lo ? lo + step : hi, ticks, decimals };
}

function seriesColors(series: Series[]): string[] {
  let next = 1;
  return series.map((s) =>
    s.role === "baseline"
      ? "var(--kit-chart-baseline)"
      : `var(--color-chart-${((next++ - 1) % 5) + 1})`,
  );
}

const f1 = (n: number) => n.toFixed(1);

/** Height of a horizontal bar chart; a vertical chart beside it takes the same height. */
export function horizontalHeight(chart: KitChartSpec): number {
  const k = chart.stacked ? 1 : chart.series.length;
  const rowH = k === 1 ? (chart.stacked ? 40 : 34) : k * 11 + (k - 1) * 3 + 18;
  return 4 + chart.categories.length * rowH + 2;
}

function categoryGutter(chart: KitChartSpec, width: number): number {
  const longest = Math.max(...chart.categories.map((c) => c.length));
  return Math.min(Math.round(width * 0.42), Math.round(longest * 6.4) + 14);
}

function horizontalBars(chart: KitChartSpec, width: number): string {
  const colors = seriesColors(chart.series);
  const left = categoryGutter(chart, width);
  const height = horizontalHeight(chart);
  const parts = [`<line class="axis" x1="${left}" x2="${left}" y1="4" y2="${height - 2}" />`];
  if (chart.stacked) {
    const innerW = width - left - 72;
    const totals = chart.categories.map((_, i) =>
      chart.series.reduce((sum, s) => sum + Math.max(0, s.values[i] ?? 0), 0),
    );
    const max = Math.max(...totals) || 1;
    const rowH = 40;
    const barH = 22;
    chart.categories.forEach((category, i) => {
      const y = 4 + i * rowH + (rowH - barH) / 2;
      parts.push(
        `<text class="cat" x="${left - 10}" y="${y + barH / 2}" text-anchor="end" dominant-baseline="central">${escapeHtml(category)}</text>`,
      );
      let x = left;
      chart.series.forEach((s, j) => {
        const v = Math.max(0, s.values[i] ?? 0);
        const w = (v / max) * innerW;
        parts.push(
          `<rect x="${f1(x)}" y="${y}" width="${f1(Math.max(0, w - 1))}" height="${barH}" fill="${colors[j]}"><title>${escapeHtml(category)}, ${escapeHtml(s.name)}: ${escapeHtml(formatValue(v, chart.unit))}</title></rect>`,
        );
        if (w > 44)
          parts.push(
            `<text class="inbar" x="${f1(x + w / 2)}" y="${y + barH / 2}" text-anchor="middle" dominant-baseline="central">${formatValue(v)}</text>`,
          );
        x += w;
      });
      parts.push(
        `<text class="val" x="${f1(x + 7)}" y="${y + barH / 2}" dominant-baseline="central">${escapeHtml(formatValue(totals[i] ?? 0, chart.unit))}</text>`,
      );
    });
    return parts.join("");
  }
  const k = chart.series.length;
  const barH = k === 1 ? 18 : 11;
  const rowH = k === 1 ? 34 : k * barH + (k - 1) * 3 + 18;
  const max = Math.max(...chart.series.flatMap((s) => s.values), 0) || 1;
  const innerW = width - left - 64;
  chart.categories.forEach((category, i) => {
    const groupH = k * barH + (k - 1) * 3;
    const y0 = 4 + i * rowH + (rowH - groupH) / 2;
    parts.push(
      `<text class="cat" x="${left - 10}" y="${y0 + groupH / 2}" text-anchor="end" dominant-baseline="central">${escapeHtml(category)}</text>`,
    );
    chart.series.forEach((s, j) => {
      const v = s.values[i] ?? 0;
      const w = Math.max(1, (Math.max(0, v) / max) * innerW);
      const y = y0 + j * (barH + 3);
      parts.push(
        `<rect x="${left}" y="${y}" width="${f1(w)}" height="${barH}" rx="2" fill="${colors[j]}"><title>${escapeHtml(category)}, ${escapeHtml(s.name)}: ${escapeHtml(formatValue(v, chart.unit))}</title></rect>`,
        `<text class="${s.role === "baseline" ? "" : "val"}" x="${f1(left + w + 7)}" y="${y + barH / 2}" dominant-baseline="central">${escapeHtml(formatValue(v, chart.unit))}</text>`,
      );
    });
  });
  return parts.join("");
}

function verticalChart(chart: KitChartSpec, width: number, height: number): string {
  const colors = seriesColors(chart.series);
  const n = chart.categories.length;
  const k = chart.series.length;
  const isBar = chart.type === "bar";
  const stacked = isBar && chart.stacked === true;
  const totals = chart.categories.map((_, i) =>
    chart.series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0),
  );
  const values = stacked ? totals : chart.series.flatMap((s) => s.values);
  const dataMax = Math.max(...values, chart.reference?.value ?? Number.NEGATIVE_INFINITY);
  const dataMin = chart.yMin ?? Math.min(0, ...values);
  const { lo, hi, ticks, decimals } = niceTicks(dataMin, dataMax);
  const tick = (v: number) =>
    v.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  const topTick = formatValue(hi, chart.unit).replace(formatValue(hi), tick(hi));
  const left = Math.max(34, Math.round(topTick.length * 6.2) + 12);
  const right = isBar ? 8 : 58;
  const top = 14;
  const bottom = chart.xLabel ? 44 : 26;
  const innerW = width - left - right;
  const innerH = height - top - bottom;
  const y = (v: number) =>
    top + innerH - ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * innerH;
  const parts: string[] = [];

  ticks.forEach((t, i) => {
    const last = i === ticks.length - 1;
    parts.push(
      `<line class="${t === lo ? "axis" : "grid"}" x1="${left}" x2="${left + innerW}" y1="${f1(y(t))}" y2="${f1(y(t))}" />`,
      `<text x="${left - 8}" y="${f1(y(t))}" text-anchor="end" dominant-baseline="central">${escapeHtml(last ? topTick : tick(t))}</text>`,
    );
  });

  const every = n > 14 ? Math.ceil(n / 7) : 1;
  if (isBar) {
    const band = innerW / n;
    const groupW = Math.min(band * 0.64, (stacked ? 1 : k) * 44 + (k - 1) * 2);
    const barW = stacked ? groupW : (groupW - (k - 1) * 2) / k;
    chart.categories.forEach((category, i) => {
      const cx = left + band * i + band / 2;
      if (i % every === 0)
        parts.push(
          `<text x="${f1(cx)}" y="${top + innerH + 17}" text-anchor="middle">${escapeHtml(category)}</text>`,
        );
      let acc = lo;
      chart.series.forEach((s, j) => {
        const v = s.values[i] ?? 0;
        const x = stacked ? cx - groupW / 2 : cx - groupW / 2 + j * (barW + 2);
        const yTop = stacked ? y(acc + v) : y(v);
        const yBase = stacked ? y(acc) : y(lo);
        acc += v;
        parts.push(
          `<rect x="${f1(x)}" y="${f1(yTop)}" width="${f1(barW)}" height="${f1(Math.max(0, yBase - yTop))}" rx="${stacked ? 0 : 2}" fill="${colors[j]}"><title>${escapeHtml(category)}, ${escapeHtml(s.name)}: ${escapeHtml(formatValue(v, chart.unit))}</title></rect>`,
        );
        if (!stacked && n * k <= 14 && barW >= 22)
          parts.push(
            `<text class="${s.role === "baseline" ? "" : "val"}" x="${f1(x + barW / 2)}" y="${f1(yTop - 6)}" text-anchor="middle">${formatValue(v)}</text>`,
          );
      });
      if (stacked)
        parts.push(
          `<text class="val" x="${f1(cx)}" y="${f1(y(lo + (totals[i] ?? 0)) - 6)}" text-anchor="middle">${escapeHtml(formatValue(totals[i] ?? 0, chart.unit))}</text>`,
        );
    });
  } else {
    const xAt = (i: number) => left + (n === 1 ? innerW / 2 : (innerW * i) / (n - 1));
    chart.categories.forEach((category, i) => {
      if (i % every === 0 || i === n - 1)
        parts.push(
          `<text x="${f1(xAt(i))}" y="${top + innerH + 17}" text-anchor="middle">${escapeHtml(category)}</text>`,
        );
    });
    const ends = chart.series.map((s) => y(s.values[n - 1] ?? 0));
    // Nudge end labels apart when two series finish close together.
    for (let a = 0; a < ends.length; a++)
      for (let b = a + 1; b < ends.length; b++) {
        const ea = ends[a] ?? 0;
        const eb = ends[b] ?? 0;
        if (Math.abs(ea - eb) < 14) {
          const upper = ea <= eb ? a : b;
          const lower = upper === a ? b : a;
          const mid = (ea + eb) / 2;
          ends[upper] = mid - 7;
          ends[lower] = mid + 7;
        }
      }
    chart.series.forEach((s, j) => {
      const pts = s.values.map((v, i) => `${f1(xAt(i))},${f1(y(v))}`);
      const base = s.role === "baseline";
      if (chart.type === "area" && !base)
        parts.push(
          `<path d="M${pts.join("L")}L${f1(xAt(n - 1))},${f1(y(lo))}L${f1(xAt(0))},${f1(y(lo))}Z" fill="${colors[j]}" opacity="0.12" />`,
        );
      parts.push(
        `<path d="M${pts.join("L")}" fill="none" stroke="${colors[j]}" stroke-width="${base ? 1.5 : 2}" stroke-linejoin="round" stroke-linecap="round"${base ? ' stroke-dasharray="4 4"' : ""}><title>${escapeHtml(s.name)}</title></path>`,
      );
      s.values.forEach((v, i) => {
        parts.push(
          `<circle class="pt" cx="${f1(xAt(i))}" cy="${f1(y(v))}" r="${i === n - 1 ? 3 : 2}" fill="${colors[j]}"><title>${escapeHtml(chart.categories[i] ?? "")}, ${escapeHtml(s.name)}: ${escapeHtml(formatValue(v, chart.unit))}</title></circle>`,
        );
      });
      const lastV = s.values[n - 1] ?? 0;
      parts.push(
        `<text class="${base ? "" : "val"}" x="${f1(xAt(n - 1) + 8)}" y="${f1(ends[j] ?? 0)}" dominant-baseline="central">${escapeHtml(formatValue(lastV, chart.unit))}</text>`,
      );
    });
  }
  if (chart.reference) {
    const ry = y(chart.reference.value);
    parts.push(
      `<line class="ref" x1="${left}" x2="${left + innerW}" y1="${f1(ry)}" y2="${f1(ry)}" />`,
      `<text class="reflabel" x="${left + 6}" y="${f1(ry - 7)}">${escapeHtml(chart.reference.label)}</text>`,
    );
  }
  if (chart.xLabel)
    parts.push(
      `<text x="${left + innerW / 2}" y="${height - 6}" text-anchor="middle">${escapeHtml(chart.xLabel)}</text>`,
    );
  return parts.join("");
}

/** A `<figure>` with the title, legend and the `<swarm-chart>` SVG. */
export function renderChart(
  props: { title: string; chart: KitChartSpec; note?: string },
  ctx: ChartContext,
): string {
  const { title, chart, note } = props;
  // shortcut: one fixed viewBox per layout, so labels shrink on a phone; upgrade to a client-measured width when mobile readers complain.
  const width = Math.max(
    240,
    Math.round((ctx.panel ? ctx.width - 42 : ctx.width) / (ctx.deck ? 1.45 : 1)),
  );
  let height: number;
  let body: string;
  if (chart.type === "bar" && chart.horizontal) {
    height = horizontalHeight(chart);
    body = horizontalBars(chart, width);
  } else {
    height =
      ctx.chartHeight ??
      (ctx.deck
        ? Math.round(Math.min(330, width * 0.6))
        : Math.round(Math.min(280, Math.max(200, width * 0.42))));
    body = verticalChart(chart, width, height);
  }
  const colors = seriesColors(chart.series);
  const legend =
    chart.series.length > 1
      ? `<div class="kit-legend">${chart.series
          .map(
            (s, i) =>
              `<span><i style="background:${colors[i]}"${s.role === "baseline" && chart.type !== "bar" ? ' data-line="dashed"' : ""}></i>${escapeHtml(s.name)}</span>`,
          )
          .join("")}</div>`
      : "";
  const sub = chart.yLabel ? `<p class="kit-chart-sub">${escapeHtml(chart.yLabel)}</p>` : "";
  return `<figure class="kit-chart${ctx.panel ? " swarm-panel" : ""}">
<figcaption class="kit-chart-title">${inlineMarkdown(title)}</figcaption>${sub}${legend}
<swarm-chart data-type="${chart.type}"${chart.horizontal ? " data-horizontal" : ""}><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(title)}">${body}</svg></swarm-chart>
${note ? `<p class="kit-chart-note">${inlineMarkdown(note)}</p>` : ""}</figure>`;
}
