import fs from "node:fs";
import path from "node:path";

const [outDir, repoDir, repoName, runDate, scopePath = "src"] = process.argv.slice(2);
if (!outDir || !repoDir || !repoName || !runDate) {
  console.error("Usage: node report.mjs <outDir> <repoDir> <repoName> <runDate> [scopePath]");
  process.exit(1);
}

const read = (file) => fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
const csvPath = (name) => path.join(outDir, `${name}.csv`);
const esc = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (quoted) {
      if (ch === '"' && next === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(cur);
      cur = "";
    } else if (ch === "\n") {
      row.push(cur);
      rows.push(row);
      row = [];
      cur = "";
    } else if (ch !== "\r") {
      cur += ch;
    }
  }
  if (cur.length || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows.filter((r) => r.some(Boolean));
}

function parseCsv(text) {
  const rows = parseCsvRows(text);
  if (!rows.length) return [];
  const headers = rows.shift().map((h) => h.trim());
  return rows.map((row) => Object.fromEntries(headers.map((h, i) => [h, row[i] ?? ""])));
}

const num = (value) => {
  const n = Number(String(value ?? "").replace(/[%\s,]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

const pick = (row, names, fallback = "") => {
  for (const name of names) {
    if (row?.[name] !== undefined && row[name] !== "") return row[name];
  }
  return fallback;
};

const normalize = (file) => String(file ?? "")
  .replace(`${repoDir}/`, "")
  .replace(/^\.?\//, "");

function currentLocByFile() {
  const files = read(path.join(outDir, "src-files.txt")).trim().split("\n").filter(Boolean);
  const loc = new Map();
  for (const file of files) {
    const full = path.join(repoDir, file);
    if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) continue;
    const text = fs.readFileSync(full, "utf8");
    loc.set(normalize(file), text.split("\n").filter((line) => line.trim()).length);
  }
  return loc;
}

function complexityByFile() {
  const rows = parseCsvRows(read(path.join(outDir, "lizard-functions.csv")));
  const byFile = new Map();
  for (const row of rows) {
    const file = normalize(row[6]);
    if (!file || !file.startsWith(`${scopePath}/`)) continue;
    const entry = byFile.get(file) ?? { file, functions: 0, totalCcn: 0, maxCcn: 0 };
    const ccn = num(row[1]);
    entry.functions += 1;
    entry.totalCcn += ccn;
    entry.maxCcn = Math.max(entry.maxCcn, ccn);
    byFile.set(file, entry);
  }
  return byFile;
}

const loc = currentLocByFile();
const complexity = complexityByFile();
const revisionsRows = parseCsv(read(csvPath("revisions")));
const couplingRows = parseCsv(read(csvPath("coupling")));
const ageRows = parseCsv(read(csvPath("age")));
const authorsRows = parseCsv(read(csvPath("authors")));
const ownershipRows = parseCsv(read(csvPath("main-dev")));
const summaryRows = parseCsv(read(csvPath("summary")));

const summaryStats = Object.fromEntries(summaryRows.map((row) => [pick(row, ["statistic", "name"]), num(pick(row, ["value", "n"]))]));
const authorCountByFile = new Map();
for (const row of authorsRows) {
  authorCountByFile.set(normalize(pick(row, ["entity", "module", "file"])), num(pick(row, ["n-authors", "authors", "author-count", "count"])));
}

const ageByFile = new Map();
for (const row of ageRows) {
  ageByFile.set(normalize(pick(row, ["entity", "module", "file"])), {
    ageMonths: num(pick(row, ["age-months", "age", "months"])),
    lastChange: pick(row, ["last-revision", "last-modified", "date"], ""),
  });
}

const ownershipByFile = new Map();
for (const row of ownershipRows) {
  const file = normalize(pick(row, ["entity", "module", "file"]));
  ownershipByFile.set(file, {
    mainDeveloper: pick(row, ["main-dev", "author", "developer"], "Unknown"),
    ownershipPercent: (() => {
      const value = num(pick(row, ["ownership", "ownership%", "contribution"]));
      return value <= 1 && value > 0 ? Math.round(value * 1000) / 10 : Math.round(value * 10) / 10;
    })(),
  });
}

const files = revisionsRows.map((row) => {
  const file = normalize(pick(row, ["entity", "module", "file"]));
  const revs = num(pick(row, ["n-revs", "revisions", "revs"]));
  const cx = complexity.get(file) ?? { functions: 0, totalCcn: 0, maxCcn: 0 };
  const owned = ownershipByFile.get(file) ?? { mainDeveloper: "Unknown", ownershipPercent: 0 };
  const age = ageByFile.get(file) ?? { ageMonths: 0, lastChange: "" };
  const totalCcn = cx.totalCcn || cx.maxCcn || 0;
  return {
    file,
    revs,
    loc: loc.get(file) ?? 0,
    functions: cx.functions,
    totalCcn,
    maxCcn: cx.maxCcn,
    riskScore: Math.round(revs * Math.log2(totalCcn + 1) * 10) / 10,
    mainDeveloper: owned.mainDeveloper,
    ownershipPercent: owned.ownershipPercent,
    authorCount: authorCountByFile.get(file) || 0,
    ageMonths: age.ageMonths,
    lastChange: age.lastChange,
  };
}).filter((row) => row.file.startsWith(`${scopePath}/`));

files.sort((a, b) => b.riskScore - a.riskScore);
const topRisk = files.slice(0, 25);
const chartFiles = files.slice(0, 100);

const coupling = couplingRows.map((row) => ({
  a: normalize(pick(row, ["entity", "entity-1", "module", "file"])),
  b: normalize(pick(row, ["coupled", "entity-2", "coupled-entity"])),
  degree: num(pick(row, ["degree", "coupling", "coupling%"])),
  sharedRevs: num(pick(row, ["average-revs", "shared-revisions", "shared-revs", "n-revs"])),
})).filter((row) => row.a.startsWith(`${scopePath}/`) && row.b.startsWith(`${scopePath}/`))
  .sort((a, b) => (b.degree - a.degree) || (b.sharedRevs - a.sharedRevs))
  .slice(0, 30);

const ageBuckets = [
  { label: "0-1m", min: 0, max: 1, files: 0, loc: 0 },
  { label: "1-3m", min: 1, max: 3, files: 0, loc: 0 },
  { label: "3-6m", min: 3, max: 6, files: 0, loc: 0 },
  { label: "6-12m", min: 6, max: 12, files: 0, loc: 0 },
  { label: "12m+", min: 12, max: Infinity, files: 0, loc: 0 },
];
for (const file of files) {
  const bucket = ageBuckets.find((b) => file.ageMonths >= b.min && file.ageMonths < b.max);
  if (bucket) {
    bucket.files += 1;
    bucket.loc += file.loc;
  }
}

const summary = {
  repoName,
  runDate,
  scopePath,
  generatedAt: new Date().toISOString(),
  commit: read(path.join(outDir, "revision.txt")).trim(),
  commitSummary: read(path.join(outDir, "revision-summary.txt")).trim(),
  totals: {
    commitsInScopedLog: summaryStats["number-of-commits"] || 0,
    entities: summaryStats["number-of-entities"] || files.length,
    trackedFiles: read(path.join(outDir, "src-files.txt")).trim().split("\n").filter(Boolean).length,
    authors: summaryStats["number-of-authors"] || 0,
    totalLoc: files.reduce((sum, file) => sum + file.loc, 0),
  },
  topRisk,
  topCoupling: coupling,
  ageBuckets,
  charts: {
    files: chartFiles,
    ageBuckets,
  },
  references: {
    d3: "https://d3js.org",
    codeMaat: "https://github.com/adamtornhill/code-maat",
    lizard: "https://github.com/terryyin/lizard",
  },
};

fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
fs.writeFileSync(path.join(outDir, "latest-pointer.json"), JSON.stringify({
  repoName,
  runDate,
  path: outDir,
  latestJson: path.join(path.dirname(outDir), "latest.json"),
  latestHtml: path.join(path.dirname(outDir), "latest.html"),
  generatedAt: summary.generatedAt,
}, null, 2));

const dataJson = JSON.stringify(summary).replaceAll("</script", "<\\/script");
const rows = (items, columns) => items.map((item) => `<tr>${columns.map((col) => `<td>${esc(typeof col === "function" ? col(item) : item[col])}</td>`).join("")}</tr>`).join("\n");

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Code Health Report - ${esc(repoName)}</title>
  <style>
    body { margin: 0; background: #f7f6f3; color: #181817; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.5; }
    main { width: min(1180px, calc(100% - 32px)); margin: 0 auto; padding: 48px 0 80px; }
    h1 { font-size: clamp(2rem, 5vw, 4rem); line-height: 1; margin: 0 0 12px; }
    h2 { margin-top: 40px; }
    p, .muted { color: #686660; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 28px 0; }
    .metric, .card { background: #fff; border: 1px solid #e4ded3; border-radius: 8px; padding: 18px; }
    .metric span { display: block; color: #686660; font-size: 12px; font-weight: 700; text-transform: uppercase; }
    .metric strong { display: block; margin-top: 8px; font-size: 30px; }
    .charts { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .chart { height: 360px; }
    svg { width: 100%; height: 100%; display: block; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; background: #fff; border: 1px solid #e4ded3; border-radius: 8px; overflow: hidden; }
    th, td { padding: 8px 10px; border-bottom: 1px solid #eee8dc; text-align: left; vertical-align: top; }
    th { color: #686660; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
    td { max-width: 380px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    code { background: #fff; border: 1px solid #e4ded3; padding: 1px 5px; border-radius: 4px; }
    @media (max-width: 860px) { .grid, .charts { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
<main>
  <p class="muted">Generated ${esc(summary.generatedAt)}</p>
  <h1>Code Health Report</h1>
  <p><strong>${esc(repoName)}</strong> at <code>${esc(summary.commit.slice(0, 12))}</code>. Scope: <code>${esc(scopePath)}/**</code>.</p>

  <section class="grid">
    <div class="metric"><span>Scoped commits</span><strong>${esc(summary.totals.commitsInScopedLog || "n/a")}</strong></div>
    <div class="metric"><span>Entities</span><strong>${esc(summary.totals.entities)}</strong></div>
    <div class="metric"><span>Tracked files</span><strong>${esc(summary.totals.trackedFiles)}</strong></div>
    <div class="metric"><span>Current LOC</span><strong>${esc(summary.totals.totalLoc)}</strong></div>
  </section>

  <section class="charts">
    <div class="card">
      <h2>Hotspots</h2>
      <p>Bubble size is current LOC. Color is churn x complexity score.</p>
      <div id="bubble" class="chart"></div>
    </div>
    <div class="card">
      <h2>Change Frequency x Complexity</h2>
      <p>X is revisions. Y is total cyclomatic complexity.</p>
      <div id="scatter" class="chart"></div>
    </div>
  </section>

  <h2>Top Hotspots</h2>
  <table>
    <thead><tr><th>File</th><th>Revs</th><th>LOC</th><th>Total CCN</th><th>Max CCN</th><th>Risk Score</th><th>Main Dev</th><th>Authors</th><th>Own %</th></tr></thead>
    <tbody>${rows(topRisk, [
      "file",
      "revs",
      "loc",
      "totalCcn",
      "maxCcn",
      "riskScore",
      "mainDeveloper",
      "authorCount",
      "ownershipPercent",
    ])}</tbody>
  </table>

  <h2>Temporal Coupling</h2>
  <table>
    <thead><tr><th>Entity A</th><th>Entity B</th><th>Degree %</th><th>Shared Revs</th></tr></thead>
    <tbody>${rows(coupling, ["a", "b", "degree", "sharedRevs"])}</tbody>
  </table>

  <h2>Code Age</h2>
  <div id="age" class="chart card"></div>

  <h2>References</h2>
  <ul>
    <li><a href="https://github.com/adamtornhill/code-maat">Code Maat</a></li>
    <li><a href="https://d3js.org">D3.js</a></li>
    <li><a href="https://github.com/terryyin/lizard">Lizard</a></li>
  </ul>
</main>
<script>window.__CODE_MAAT_DATA__ = ${dataJson};</script>
<script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"></script>
<script>
const data = window.__CODE_MAAT_DATA__;
const colors = d3.scaleSequential(d3.interpolateYlOrRd).domain([0, d3.max(data.charts.files, d => d.riskScore) || 1]);

function drawBubble() {
  const el = document.querySelector("#bubble");
  const width = el.clientWidth;
  const height = el.clientHeight;
  const root = d3.hierarchy({ children: data.charts.files }).sum(d => d.loc || 1);
  d3.pack().size([width, height]).padding(3)(root);
  const svg = d3.select(el).append("svg");
  const node = svg.selectAll("g").data(root.leaves()).join("g").attr("transform", d => \`translate(\${d.x},\${d.y})\`);
  node.append("circle").attr("r", d => d.r).attr("fill", d => colors(d.data.riskScore)).attr("stroke", "#fff");
  node.append("title").text(d => \`\${d.data.file}\\nrevs: \${d.data.revs}\\nccn: \${d.data.totalCcn}\\nrisk: \${d.data.riskScore}\`);
}

function drawScatter() {
  const el = document.querySelector("#scatter");
  const width = el.clientWidth;
  const height = el.clientHeight;
  const margin = { top: 20, right: 20, bottom: 38, left: 48 };
  const svg = d3.select(el).append("svg");
  const x = d3.scaleLinear().domain([0, d3.max(data.charts.files, d => d.revs) || 1]).nice().range([margin.left, width - margin.right]);
  const y = d3.scaleLinear().domain([0, d3.max(data.charts.files, d => d.totalCcn) || 1]).nice().range([height - margin.bottom, margin.top]);
  const r = d3.scaleSqrt().domain([0, d3.max(data.charts.files, d => d.loc) || 1]).range([3, 18]);
  svg.append("g").attr("transform", \`translate(0,\${height - margin.bottom})\`).call(d3.axisBottom(x));
  svg.append("g").attr("transform", \`translate(\${margin.left},0)\`).call(d3.axisLeft(y));
  svg.selectAll("circle").data(data.charts.files).join("circle")
    .attr("cx", d => x(d.revs)).attr("cy", d => y(d.totalCcn)).attr("r", d => r(d.loc))
    .attr("fill", d => colors(d.riskScore)).attr("opacity", 0.82).append("title")
    .text(d => \`\${d.file}\\nrevs: \${d.revs}\\nccn: \${d.totalCcn}\\nrisk: \${d.riskScore}\`);
}

function drawAge() {
  const el = document.querySelector("#age");
  const width = el.clientWidth;
  const height = el.clientHeight;
  const margin = { top: 20, right: 20, bottom: 38, left: 56 };
  const svg = d3.select(el).append("svg");
  const x = d3.scaleBand().domain(data.ageBuckets.map(d => d.label)).range([margin.left, width - margin.right]).padding(0.2);
  const y = d3.scaleLinear().domain([0, d3.max(data.ageBuckets, d => d.loc) || 1]).nice().range([height - margin.bottom, margin.top]);
  svg.append("g").attr("transform", \`translate(0,\${height - margin.bottom})\`).call(d3.axisBottom(x));
  svg.append("g").attr("transform", \`translate(\${margin.left},0)\`).call(d3.axisLeft(y));
  svg.selectAll("rect").data(data.ageBuckets).join("rect")
    .attr("x", d => x(d.label)).attr("y", d => y(d.loc)).attr("width", x.bandwidth()).attr("height", d => y(0) - y(d.loc))
    .attr("fill", "#8a5a12").append("title").text(d => \`\${d.label}: \${d.loc} LOC, \${d.files} files\`);
}

if (window.d3) {
  drawBubble();
  drawScatter();
  drawAge();
}
</script>
</body>
</html>`;

fs.writeFileSync(path.join(outDir, "report.html"), html);
