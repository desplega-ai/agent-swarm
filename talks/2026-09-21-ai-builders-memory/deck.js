// Zero-dependency slide engine + the three data-driven visuals.
// Keys: arrows / space / PageUp / PageDown (clicker), Home, End,
//       f = fullscreen, n = notes overlay, p = presenter window,
//       c = review mode (comments, see debug.js).

const slides = [...document.querySelectorAll(".slide")];
const stage = document.getElementById("stage");
const isPresenter = new URLSearchParams(location.search).has("presenter");
let current = 0;
let peer = isPresenter ? window.opener : null;
let startedAt = null;

function fit() {
  const s = Math.min(innerWidth / 1920, innerHeight / 1080);
  stage.style.transform = `translate(-50%, -50%) scale(${s})`;
}

function titleOf(slide) {
  return slide?.querySelector("h1, h2")?.textContent.trim() ?? "";
}

function show(i, fromPeer = false) {
  current = Math.max(0, Math.min(slides.length - 1, i));
  slides.forEach((s, n) => s.classList.toggle("active", n === current));
  document.getElementById("progress").style.width = `${((current + 1) / slides.length) * 100}%`;
  document.getElementById("counter").textContent = `${current + 1} / ${slides.length}`;
  const notes = slides[current].querySelector("aside.notes")?.innerHTML ?? "<p>(no notes)</p>";
  document.getElementById("notes-overlay").innerHTML = notes;
  document.getElementById("p-title").textContent = `${current + 1}. ${titleOf(slides[current])}`;
  document.getElementById("p-body").innerHTML = notes;
  document.getElementById("p-next").textContent = `next: ${titleOf(slides[current + 1]) || "(end)"}`;
  history.replaceState(null, "", `${location.search}#${current + 1}`);
  if (current > 0 && startedAt === null) startedAt = Date.now();
  // postMessage works on file:// URLs, BroadcastChannel does not.
  if (!fromPeer && peer && !peer.closed) peer.postMessage({ deck: current }, "*");
}

addEventListener("message", (e) => {
  if (typeof e.data?.deck !== "number") return;
  if (!peer) peer = e.source;
  show(e.data.deck, true);
});

addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest?.("textarea, input")) return;
  const k = e.key;
  if (["ArrowRight", "ArrowDown", "PageDown", " ", "Enter"].includes(k)) show(current + 1);
  else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace"].includes(k)) show(current - 1);
  else if (k === "Home") show(0);
  else if (k === "End") show(slides.length - 1);
  else if (k === "f") document.documentElement.requestFullscreen?.();
  else if (k === "n") document.getElementById("notes-overlay").classList.toggle("on");
  else if (k === "p" && !isPresenter) {
    peer = window.open(`${location.pathname}?presenter=1#${current + 1}`, "deck-presenter", "width=900,height=700");
  } else return;
  e.preventDefault();
});

addEventListener("resize", fit);
addEventListener("hashchange", () => {
  const i = (Number.parseInt(location.hash.slice(1), 10) || 1) - 1;
  if (i !== current) show(i);
});

setInterval(() => {
  const el = document.getElementById("p-timer");
  if (!el || startedAt === null) return;
  const s = Math.floor((Date.now() - startedAt) / 1000);
  el.textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}, 500);

// ---------------------------------------------------------------------------
// Visuals
// ---------------------------------------------------------------------------

const NS = "http://www.w3.org/2000/svg";
const C = { fg: "#09090b", muted: "#71717a", grid: "#e4e4e7", amber: "#d97706", amberDark: "#b45309", gold: "#f59e0b", sky: "#0ea5e9", red: "#dc2626" };

function el(parent, tag, attrs = {}, text) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text !== undefined) n.textContent = text;
  parent.appendChild(n);
  return n;
}

// Generic line plot. series: [{ name, color, fn, dash?, width? }]
function linePlot(svg, { w, h, xMax, yMax, xTicks, xLabel, series, samples = 200 }) {
  const m = { l: 110, r: 330, t: 40, b: 100 };
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  const px = (x) => m.l + (x / xMax) * (w - m.l - m.r);
  const py = (y) => h - m.b - (y / yMax) * (h - m.t - m.b);
  for (const t of xTicks) {
    el(svg, "line", { x1: px(t), x2: px(t), y1: py(0), y2: py(yMax), stroke: C.grid, "stroke-width": 2 });
    el(svg, "text", { x: px(t), y: h - m.b + 40, "text-anchor": "middle", "font-size": 24 }, String(t));
  }
  el(svg, "line", { x1: px(0), x2: px(xMax), y1: py(0), y2: py(0), stroke: C.fg, "stroke-width": 3 });
  el(svg, "line", { x1: px(0), x2: px(0), y1: py(0), y2: py(yMax), stroke: C.fg, "stroke-width": 3 });
  el(svg, "text", { x: px(xMax / 2), y: h - 18, "text-anchor": "middle", "font-size": 26 }, xLabel);
  for (const s of series) {
    let d = "";
    for (let i = 0; i <= samples; i++) {
      const x = (i / samples) * xMax;
      d += `${i ? "L" : "M"}${px(x).toFixed(1)},${py(Math.min(yMax, s.fn(x))).toFixed(1)}`;
    }
    el(svg, "path", { d, fill: "none", stroke: s.color, "stroke-width": s.width ?? 7, "stroke-dasharray": s.dash ?? "", "stroke-linecap": "round" });
    const yEnd = s.labelY ?? Math.min(yMax, s.fn(xMax));
    el(svg, "text", { x: px(xMax) + 18, y: py(yEnd) + 9, "font-size": 26, fill: s.color, "font-weight": 700 }, s.name).setAttribute("style", `fill:${s.color}`);
  }
  return { px, py };
}

// Slide: recency decay per source. Values from src/be/memory/constants.ts.
function decayChart() {
  const svg = document.getElementById("decay-chart");
  if (!svg) return;
  const hl = (d) => (x) => 2 ** (-x / d);
  const { px, py } = linePlot(svg, {
    w: 1660, h: 640, xMax: 180, yMax: 1.05, xTicks: [0, 30, 60, 90, 120, 150, 180], xLabel: "memory age (days)",
    series: [
      { name: "manual  ∞", color: C.fg, fn: () => 1 },
      { name: "file_index  180d", color: C.amberDark, fn: hl(180) },
      { name: "task_completion  14d", color: C.gold, fn: hl(14), labelY: 0.1 },
      { name: "session_summary  7d", color: C.sky, fn: hl(7), labelY: 0.02 },
    ],
  });
  // The day-76 incident: flat 14d half-life scored a canonical memory at x0.02.
  el(svg, "line", { x1: px(76), x2: px(76), y1: py(0), y2: py(1.05), stroke: C.red, "stroke-width": 3, "stroke-dasharray": "10 8" });
  el(svg, "circle", { cx: px(76), cy: py(2 ** (-76 / 14)), r: 12, fill: C.red });
  el(svg, "circle", { cx: px(76), cy: py(2 ** (-76 / 180)), r: 12, fill: C.amberDark });
  el(svg, "text", { x: px(76) + 18, y: py(0.4), "font-size": 26 }, "day 76").setAttribute("style", `fill:${C.red};font-weight:700`);
  el(svg, "text", { x: px(76) + 18, y: py(0.4) + 34, "font-size": 24 }, "x0.02 → x0.75").setAttribute("style", `fill:${C.red}`);
}

// Slide: Beta(alpha, beta) posteriors. Unnormalised pdf scaled to its own peak.
function betaChart() {
  const svg = document.getElementById("beta-chart");
  if (!svg) return;
  const pdf = (a, b) => {
    const raw = (x) => (x <= 0 || x >= 1 ? 0 : x ** (a - 1) * (1 - x) ** (b - 1));
    let peak = 0;
    for (let i = 1; i < 200; i++) peak = Math.max(peak, raw(i / 200));
    return (x) => (a === 1 && b === 1 ? 0.35 : raw(x) / peak);
  };
  linePlot(svg, {
    w: 900, h: 560, xMax: 1, yMax: 1.1, xTicks: [0, 0.25, 0.5, 0.75, 1], xLabel: "P(this memory is useful)",
    series: [
      { name: "fresh (1, 1)", color: C.muted, fn: pdf(1, 1), dash: "12 10", labelY: 0.35 },
      { name: "proven (6, 2)", color: C.amberDark, fn: pdf(6, 2), labelY: 0.75 },
      { name: "misleading (2, 5)", color: C.red, fn: pdf(2, 5), labelY: 0.12 },
    ],
  });
}

// Slide: landscape grid. Edit positions here. x, y are 0..1.
// x: where the intelligence lives (0 = write time, 1 = read time)
// y: what the ranking adapts to. Three bands: static (0-0.33), time (0.33-0.66), usage (0.66-1)
const LANDSCAPE = [
  { name: "vanilla RAG", x: 0.62, y: 0.12, note: "chunk, embed, top-k" },
  { name: "gbrain", x: 0.1, y: 0.24, note: "librarian: nightly dream cycle, graph" },
  { name: "Supermemory", x: 0.04, y: 0.42, note: "auto extraction, graph, forgetAfter" },
  { name: "Zep / Mem0", x: 0.14, y: 0.6, note: "facts + contradiction handling" },
  { name: "OpenClaw", x: 0.6, y: 0.5, note: "markdown + hybrid index + age decay" },
  // x2: we also run one write-time job (the daily compounding reflection), so we span the divider.
  { name: "agent-swarm", x: 0.6, y: 0.86, note: "hybrid search + learned ranking", us: true, x2: 0.3, note2: ["+ daily reflection job", "1 AI task per night"] },
];

function landscape() {
  const svg = document.getElementById("landscape");
  if (!svg) return;
  const w = 1660, h = 760, m = { l: 250, r: 40, t: 30, b: 120 };
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  const px = (x) => m.l + x * (w - m.l - m.r);
  const py = (y) => h - m.b - y * (h - m.t - m.b);
  const label = (x, y, text, size, style, anchor = "start") =>
    el(svg, "text", { x, y, "font-size": size, "text-anchor": anchor }, text).setAttribute("style", style);
  el(svg, "rect", { x: px(0), y: py(1), width: px(1) - px(0), height: py(2 / 3) - py(1), fill: "#fffbeb" });
  for (const y of [1 / 3, 2 / 3]) el(svg, "line", { x1: px(0), x2: px(1), y1: py(y), y2: py(y), stroke: C.grid, "stroke-width": 3 });
  el(svg, "line", { x1: px(0.5), x2: px(0.5), y1: py(0), y2: py(1), stroke: C.grid, "stroke-width": 3 });
  el(svg, "rect", { x: px(0), y: py(1), width: px(1) - px(0), height: py(0) - py(1), fill: "none", stroke: C.fg, "stroke-width": 3 });
  [["static", 1 / 6], ["time-aware", 0.5], ["usage-aware", 5 / 6]].forEach(([t, y]) =>
    label(px(0) - 24, py(y) + 10, t, 28, `fill:${C.amberDark};font-weight:700`, "end"));
  label(px(0.25), h - 62, "← WRITE time: a librarian organises", 26, `fill:${C.fg};font-weight:700`, "middle");
  label(px(0.25), h - 26, "cost: AI tasks per write, per night", 24, `fill:${C.muted}`, "middle");
  label(px(0.75), h - 62, "READ time: rank at query →", 26, `fill:${C.fg};font-weight:700`, "middle");
  label(px(0.75), h - 26, "cost: arithmetic", 24, `fill:${C.muted}`, "middle");
  for (const p of LANDSCAPE) {
    if (p.x2 !== undefined) {
      // Arrow from our dot into write time: the daily reflection job.
      el(svg, "line", { x1: px(p.x2) + 22, x2: px(p.x), y1: py(p.y), y2: py(p.y), stroke: C.amberDark, "stroke-width": 6, "stroke-dasharray": "4 14", "stroke-linecap": "round" });
      el(svg, "path", { d: `M${px(p.x2)},${py(p.y)} l30,-17 v34 z`, fill: C.amberDark });
      p.note2.forEach((t, i) => label(px(p.x2), py(p.y) + 46 + i * 28, t, 22, `fill:${i ? C.muted : C.amberDark};font-weight:${i ? 400 : 700}`, "middle"));
    }
    el(svg, "circle", { cx: px(p.x), cy: py(p.y), r: p.us ? 22 : 15, fill: p.us ? C.amberDark : C.fg });
    label(px(p.x) + 32, py(p.y) + 4, p.name, p.us ? 38 : 32, `fill:${p.us ? C.amberDark : C.fg};font-weight:700;font-family:"Space Grotesk",sans-serif`);
    label(px(p.x) + 32, py(p.y) + 38, p.note, 22, `fill:${C.muted}`);
  }
}

if (isPresenter) document.body.classList.add("presenter");
decayChart();
betaChart();
landscape();
fit();
show((Number.parseInt(location.hash.slice(1), 10) || 1) - 1, true);
