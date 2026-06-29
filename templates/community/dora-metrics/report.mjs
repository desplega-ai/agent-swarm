import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const [outDir, repoDir, repoName, runDate, branch = "main", windowDaysArg = "90", hotfixWindowArg = "24", tagPattern = "v*"] = process.argv.slice(2);
if (!outDir || !repoDir || !repoName || !runDate) {
  console.error("Usage: node report.mjs <outDir> <repoDir> <repoName> <runDate> [branch] [windowDays] [hotfixWindowHours] [tagPattern]");
  process.exit(1);
}

const windowDays = Number(windowDaysArg);
const hotfixWindowHours = Number(hotfixWindowArg);
const now = new Date(`${runDate}T23:59:59Z`);
const start = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

const CONFIG = {
  deploymentFrequency: {
    elitePerDay: 1,
    highPerDay: 1 / 7,
    mediumPerDay: 1 / 30,
  },
  leadTimeHours: {
    eliteMax: 24,
    highMax: 24 * 7,
    mediumMax: 24 * 30,
  },
  changeFailureRate: {
    eliteMax: 0.05,
    highMax: 0.2,
    mediumMax: 0.1,
  },
  failedDeploymentRecoveryHours: {
    eliteMax: 1,
    highMax: 24,
    mediumMax: 24,
  },
};

const read = (file) => fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
const esc = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");
const hoursBetween = (a, b) => Math.max(0, (b.getTime() - a.getTime()) / 36e5);
const fmtHours = (hours) => {
  if (!Number.isFinite(hours)) return "n/a";
  if (hours < 48) return `${Math.round(hours * 10) / 10}h`;
  return `${Math.round((hours / 24) * 10) / 10}d`;
};
const fmtPct = (value) => `${Math.round(value * 1000) / 10}%`;
const median = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const git = (args) => execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf8" }).trim();

function parseTsv(text, fields) {
  return text.trim().split("\n").filter(Boolean).map((line) => {
    const parts = line.split("\t");
    return Object.fromEntries(fields.map((field, i) => [field, parts[i] ?? ""]));
  });
}

function classifyDeploymentFrequency(perDay) {
  if (perDay >= CONFIG.deploymentFrequency.elitePerDay) return "Elite";
  if (perDay >= CONFIG.deploymentFrequency.highPerDay) return "High";
  if (perDay >= CONFIG.deploymentFrequency.mediumPerDay) return "Medium";
  return "Low";
}

function classifyLeadTime(hours) {
  if (!Number.isFinite(hours)) return "Unknown";
  if (hours < CONFIG.leadTimeHours.eliteMax) return "Elite";
  if (hours <= CONFIG.leadTimeHours.highMax) return "High";
  if (hours <= CONFIG.leadTimeHours.mediumMax) return "Medium";
  return "Low";
}

function classifyChangeFailureRate(rate) {
  if (!Number.isFinite(rate)) return "Unknown";
  if (rate <= CONFIG.changeFailureRate.eliteMax) return "Elite";
  if (rate <= CONFIG.changeFailureRate.mediumMax) return "Medium";
  if (rate <= CONFIG.changeFailureRate.highMax) return "High";
  return "Low";
}

function classifyRecovery(hours) {
  if (!Number.isFinite(hours)) return "Unknown";
  if (hours < CONFIG.failedDeploymentRecoveryHours.eliteMax) return "Elite";
  if (hours <= CONFIG.failedDeploymentRecoveryHours.highMax) return "High";
  if (hours <= CONFIG.failedDeploymentRecoveryHours.mediumMax) return "Medium";
  return "Low";
}

function commitsBetween(fromRef, toRef) {
  const range = fromRef ? `${fromRef}..${toRef}` : toRef;
  const text = git(["log", range, "--format=%H%x09%ct%x09%s", "--no-merges"]);
  return parseTsv(text, ["sha", "unix", "subject"]).map((row) => ({
    ...row,
    date: new Date(Number(row.unix) * 1000),
  }));
}

const allTags = parseTsv(read(path.join(outDir, "tags.tsv")), ["name", "sha", "date", "unix"])
  .map((tag) => ({ ...tag, at: new Date(tag.date), unix: Number(tag.unix) }))
  .filter((tag) => tag.name && Number.isFinite(tag.unix))
  .sort((a, b) => a.unix - b.unix);

const deployments = allTags.filter((tag) => tag.at >= start && tag.at <= now);
const leadSamples = [];
const deploymentRows = [];

for (const tag of deployments) {
  const idx = allTags.findIndex((candidate) => candidate.name === tag.name);
  const previous = idx > 0 ? allTags[idx - 1] : null;
  const commits = commitsBetween(previous?.name, tag.name);
  const samples = commits
    .map((commit) => hoursBetween(commit.date, tag.at))
    .filter((hours) => Number.isFinite(hours) && hours >= 0);
  leadSamples.push(...samples);
  deploymentRows.push({
    tag: tag.name,
    date: tag.date,
    commitCount: commits.length,
    medianLeadTimeHours: median(samples),
    previousTag: previous?.name ?? null,
  });
}

const remediationCommits = parseTsv(read(path.join(outDir, "remediation-commits.tsv")), ["sha", "unix", "author", "subject"])
  .map((row) => ({ ...row, at: new Date(Number(row.unix) * 1000), source: "commit" }));

const prs = JSON.parse(read(path.join(outDir, "prs.json")) || "[]");
const hotfixPrs = prs
  .filter((pr) => pr?.mergedAt && /(revert|rollback|hotfix|fix-forward)/i.test(pr.title ?? ""))
  .map((pr) => ({
    sha: `PR #${pr.number}`,
    at: new Date(pr.mergedAt),
    author: pr.author?.login ?? "",
    subject: pr.title,
    url: pr.url,
    source: "pull-request",
  }))
  .filter((signal) => signal.at >= start && signal.at <= now);

const remediationSignals = [...remediationCommits, ...hotfixPrs]
  .filter((signal) => signal.at >= start && signal.at <= now)
  .sort((a, b) => a.at - b.at);

const failureSignals = [];
const failedDeploymentNames = new Set();
for (const signal of remediationSignals) {
  const fixing = deployments.find((tag) => tag.at >= signal.at) ?? deployments[deployments.length - 1];
  const failing = [...deployments].reverse().find((tag) => {
    const diff = (signal.at.getTime() - tag.at.getTime()) / 36e5;
    return diff >= 0 && diff <= hotfixWindowHours;
  });
  if (!failing || !fixing) continue;
  if (fixing.at < signal.at) continue;
  if (fixing.name === failing.name) continue;
  failedDeploymentNames.add(failing.name);
  failureSignals.push({
    source: signal.source,
    subject: signal.subject,
    sha: signal.sha,
    url: signal.url,
    signalAt: signal.at.toISOString(),
    failingTag: failing.name,
    failingAt: failing.at.toISOString(),
    fixingTag: fixing.name,
    fixingAt: fixing.at.toISOString(),
    recoveryHours: hoursBetween(failing.at, fixing.at),
  });
}

const deploymentCount = deployments.length;
const deploymentFrequencyPerDay = deploymentCount / windowDays;
const leadTimeMedianHours = median(leadSamples);
const changeFailureRate = deploymentCount ? failedDeploymentNames.size / deploymentCount : 0;
const recoveryMedianHours = median(failureSignals.map((signal) => signal.recoveryHours));

const metrics = {
  deploymentFrequency: {
    label: "Deployment Frequency",
    quality: "EXACT",
    value: deploymentFrequencyPerDay,
    display: `${Math.round(deploymentFrequencyPerDay * 100) / 100}/day`,
    band: classifyDeploymentFrequency(deploymentFrequencyPerDay),
    detail: `${deploymentCount} ${tagPattern} deployments over ${windowDays} days`,
    source: `${tagPattern} git tags mapped to production releases`,
  },
  leadTimeForChanges: {
    label: "Lead Time for Changes",
    quality: "EXACT",
    valueHours: leadTimeMedianHours,
    display: fmtHours(leadTimeMedianHours),
    band: classifyLeadTime(leadTimeMedianHours),
    detail: `Median across ${leadSamples.length} non-merge commits included in release tags`,
    source: "Commit timestamp to containing release tag timestamp",
  },
  changeFailureRate: {
    label: "Change Failure Rate",
    quality: "PROXY",
    value: changeFailureRate,
    display: fmtPct(changeFailureRate),
    band: classifyChangeFailureRate(changeFailureRate),
    detail: `${failedDeploymentNames.size} failed-release proxies / ${deploymentCount} deployments`,
    source: `Revert, rollback, hotfix, and fix-forward signals within ${hotfixWindowHours}h of a release`,
  },
  failedDeploymentRecoveryTime: {
    label: "Failed Deployment Recovery Time",
    quality: "PROXY",
    valueHours: recoveryMedianHours,
    display: fmtHours(recoveryMedianHours),
    band: classifyRecovery(recoveryMedianHours),
    detail: `${failureSignals.length} remediation signal(s) paired to release tags`,
    source: "Time from failed-release proxy tag to fixing tag",
  },
};

const summary = {
  repoName,
  runDate,
  generatedAt: new Date().toISOString(),
  branch,
  window: {
    days: windowDays,
    start: start.toISOString(),
    end: now.toISOString(),
  },
  tagPattern,
  hotfixWindowHours,
  commit: read(path.join(outDir, "revision.txt")).trim(),
  commitSummary: read(path.join(outDir, "revision-summary.txt")).trim(),
  metrics,
  deployments: deploymentRows,
  failureSignals,
  notes: [
    "Deployment Frequency and Lead Time for Changes are exact only when the configured tag pattern maps 1:1 to production releases.",
    "Change Failure Rate and Failed Deployment Recovery Time are proxy estimates. They can miss manual incidents and can include non-incident remediation work.",
    "Use a formal incident tracker or production deployment event stream before treating CFR/MTTR as precise operational truth.",
  ],
  references: {
    doraMetrics: "https://dora.dev/guides/dora-metrics/",
    dora2024Report: "https://dora.dev/research/2024/dora-report/",
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
const bandClass = (band) => String(band ?? "Unknown").toLowerCase();
const metricCards = Object.values(metrics).map((metric) => `
    <div class="metric ${esc(bandClass(metric.band))} ${esc(String(metric.quality).toLowerCase())}">
      <span>${esc(metric.label)} <em>${esc(metric.quality)}</em></span>
      <strong>${esc(metric.display)}</strong>
      <b>${esc(metric.band)}</b>
      <p>${esc(metric.detail)}</p>
    </div>`).join("");

const deploymentRowsHtml = deploymentRows.slice(-30).reverse().map((row) => `
      <tr>
        <td>${esc(row.tag)}</td>
        <td>${esc(row.date)}</td>
        <td>${esc(row.commitCount)}</td>
        <td>${esc(fmtHours(row.medianLeadTimeHours))}</td>
      </tr>`).join("");

const failureRowsHtml = failureSignals.map((signal) => `
      <tr>
        <td>${esc(signal.failingTag)}</td>
        <td>${esc(signal.fixingTag)}</td>
        <td>${esc(fmtHours(signal.recoveryHours))}</td>
        <td>${esc(signal.source)}</td>
        <td>${signal.url ? `<a href="${esc(signal.url)}">${esc(signal.subject)}</a>` : esc(signal.subject)}</td>
      </tr>`).join("") || `<tr><td colspan="5">No proxy remediation signals detected in this window.</td></tr>`;

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>DORA Metrics - ${esc(repoName)}</title>
  <style>
    body { margin: 0; background: #f7f6f3; color: #181817; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.5; }
    main { width: min(1180px, calc(100% - 32px)); margin: 0 auto; padding: 48px 0 80px; }
    h1 { font-size: clamp(2rem, 5vw, 4rem); line-height: 1; margin: 0 0 12px; }
    h2 { margin-top: 40px; }
    p, .muted { color: #686660; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 28px 0; }
    .metric, .card, .callout { background: #fff; border: 1px solid #e4ded3; border-radius: 8px; padding: 18px; }
    .metric span { display: flex; justify-content: space-between; gap: 8px; color: #686660; font-size: 12px; font-weight: 700; text-transform: uppercase; }
    .metric em { color: #181817; font-style: normal; }
    .metric strong { display: block; margin-top: 8px; font-size: 30px; }
    .metric b { display: inline-block; margin-top: 8px; padding: 2px 8px; border-radius: 999px; background: #f0ece5; font-size: 12px; text-transform: uppercase; }
    .metric.proxy { border-color: #d4a84f; }
    .charts { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .chart { height: 320px; }
    svg { width: 100%; height: 100%; display: block; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; background: #fff; border: 1px solid #e4ded3; border-radius: 8px; overflow: hidden; }
    th, td { padding: 8px 10px; border-bottom: 1px solid #eee8dc; text-align: left; vertical-align: top; }
    th { color: #686660; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
    td { max-width: 520px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    code { background: #fff; border: 1px solid #e4ded3; padding: 1px 5px; border-radius: 4px; }
    a { color: #8b5a00; }
    @media (max-width: 920px) { .grid, .charts { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
<main>
  <p class="muted">Generated ${esc(summary.generatedAt)}</p>
  <h1>DORA Metrics</h1>
  <p><strong>${esc(repoName)}</strong> at <code>${esc(summary.commit.slice(0, 12))}</code>. Window: ${esc(summary.window.start.slice(0, 10))} to ${esc(summary.window.end.slice(0, 10))}. Release signal: <code>${esc(tagPattern)}</code> tags.</p>

  <section class="grid">
${metricCards}
  </section>

  <section class="callout">
    <h2>Data-source reality check</h2>
    <p>Deployment Frequency and Lead Time for Changes are <strong>exact</strong> for this configuration because release tags are treated as production deployments. Change Failure Rate and Failed Deployment Recovery Time are <strong>proxy estimates</strong> from remediation signals. They are useful for trend watching, not a substitute for incident tracking.</p>
  </section>

  <section class="charts">
    <div class="card">
      <h2>Deployments by week</h2>
      <div id="deployments" class="chart"></div>
    </div>
    <div class="card">
      <h2>Lead time by release</h2>
      <div id="leadtime" class="chart"></div>
    </div>
  </section>

  <h2>Recent deployments</h2>
  <table>
    <thead><tr><th>Tag</th><th>Date</th><th>Commits</th><th>Median lead time</th></tr></thead>
    <tbody>${deploymentRowsHtml}</tbody>
  </table>

  <h2>Proxy failure signals</h2>
  <table>
    <thead><tr><th>Failing tag</th><th>Fixing tag</th><th>Recovery</th><th>Source</th><th>Signal</th></tr></thead>
    <tbody>${failureRowsHtml}</tbody>
  </table>

  <h2>References</h2>
  <ul>
    <li><a href="https://dora.dev/guides/dora-metrics/">DORA metrics guide</a></li>
    <li><a href="https://dora.dev/research/2024/dora-report/">2024 Accelerate State of DevOps Report</a></li>
  </ul>
</main>
<script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"></script>
<script id="report-data" type="application/json">${dataJson}</script>
<script>
const data = JSON.parse(document.getElementById("report-data").textContent);
const deployments = data.deployments.map((d) => ({ ...d, dateObj: new Date(d.date), lead: d.medianLeadTimeHours || 0 }));
function drawBars(id, values, getX, getY) {
  const el = document.getElementById(id);
  const width = el.clientWidth || 520;
  const height = el.clientHeight || 320;
  const margin = { top: 16, right: 16, bottom: 42, left: 46 };
  const svg = d3.select(el).append("svg").attr("viewBox", [0, 0, width, height]);
  const x = d3.scaleBand().domain(values.map(getX)).range([margin.left, width - margin.right]).padding(0.2);
  const y = d3.scaleLinear().domain([0, d3.max(values, getY) || 1]).nice().range([height - margin.bottom, margin.top]);
  svg.append("g").attr("transform", "translate(0," + (height - margin.bottom) + ")").call(d3.axisBottom(x).tickValues(x.domain().filter((_, i) => i % Math.ceil(x.domain().length / 6) === 0))).selectAll("text").attr("transform", "rotate(-35)").style("text-anchor", "end");
  svg.append("g").attr("transform", "translate(" + margin.left + ",0)").call(d3.axisLeft(y).ticks(5));
  svg.append("g").selectAll("rect").data(values).join("rect")
    .attr("x", (d) => x(getX(d)))
    .attr("y", (d) => y(getY(d)))
    .attr("width", x.bandwidth())
    .attr("height", (d) => y(0) - y(getY(d)))
    .attr("fill", "#b58118");
}
const byWeek = Array.from(d3.rollup(deployments, (v) => v.length, (d) => d3.utcFormat("%Y-W%U")(d.dateObj)), ([week, count]) => ({ week, count }));
drawBars("deployments", byWeek, (d) => d.week, (d) => d.count);
drawBars("leadtime", deployments.slice(-20), (d) => d.tag, (d) => d.lead);
</script>
</body>
</html>`;

fs.writeFileSync(path.join(outDir, "report.html"), html);
