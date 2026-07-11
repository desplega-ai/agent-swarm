// Emit self-contained HTML report from /tmp/matrix/metrics.json (+ optional /tmp/matrix/analysis.html fragment).
// Usage: bun /tmp/matrix-html.ts [outPath]
import { readFileSync, existsSync, writeFileSync } from "node:fs";

const data = JSON.parse(readFileSync("/tmp/matrix/metrics.json", "utf8"));
const analysis = existsSync("/tmp/matrix/analysis.html") ? readFileSync("/tmp/matrix/analysis.html", "utf8") : "<p><em>Analysis pending.</em></p>";
const OUT = process.argv[2] ?? "/tmp/matrix/scripts-only-vs-full-report.html";

const so = data.agg.find((a: any) => a.mode === "scripts-only");
const fu = data.agg.find((a: any) => a.mode === "full");
const runs = data.runs;

const catSet = new Set<string>();
for (const r of runs) Object.keys(r.toolCalls).forEach((k) => catSet.add(k));
const cats = [...catSet];
const modes = ["scripts-only", "full"];
const okRuns = (m: string) => runs.filter((r: any) => r.mode === m && r.result === "completed");
const meanCat = (m: string, c: string) => {
  const rs = okRuns(m);
  return rs.length ? +(rs.reduce((s: number, r: any) => s + (r.toolCalls[c] ?? 0), 0) / rs.length).toFixed(1) : 0;
};

const kpi = (label: string, a: any, b: any, fmt = (x: any) => x) => `
  <tr><td>${label}</td><td class="so">${fmt(a)}</td><td class="fu">${fmt(b)}</td></tr>`;

const runRows = runs.map((r: any) => `
  <tr class="${r.result !== "completed" ? "bad" : ""}">
    <td>${r.mode}-${r.runId}</td><td>${r.result}</td><td>${r.wallMin ?? "—"}</td>
    <td>$${r.costUsd.toFixed(2)}</td><td>${r.sessions}</td><td>${r.totalToolCalls}</td>
    <td>${r.probes}</td><td>${r.errors}</td>
    <td>${r.perTask.filter((t: any) => t.kind === "work").map((t: any) => `${t.agent}:${t.ctxTokens ? Math.round(t.ctxTokens / 1000) + "K" : "?"}`).join(" ")}</td>
  </tr>`).join("");

const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>Swarm MCP surface: scripts-only vs full — comparison</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
  :root { --so:#6366f1; --fu:#f59e0b; --bg:#0f1117; --card:#181b25; --txt:#e5e7eb; --mut:#9ca3af; }
  * { box-sizing:border-box; }
  body { margin:0; font:15px/1.55 -apple-system,'Segoe UI',Roboto,sans-serif; background:var(--bg); color:var(--txt); padding:32px 16px; }
  .wrap { max-width:1080px; margin:0 auto; }
  h1 { font-size:26px; margin:0 0 4px; } h2 { font-size:19px; margin:36px 0 12px; border-bottom:1px solid #2a2e3d; padding-bottom:6px; }
  .sub { color:var(--mut); margin-bottom:24px; }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:20px; } @media(max-width:860px){ .grid{grid-template-columns:1fr;} }
  .card { background:var(--card); border:1px solid #262a38; border-radius:12px; padding:18px; }
  .card h3 { margin:0 0 10px; font-size:14px; color:var(--mut); font-weight:600; text-transform:uppercase; letter-spacing:.04em; }
  .hero { display:grid; grid-template-columns:repeat(4,1fr); gap:14px; margin:20px 0; } @media(max-width:860px){ .hero{grid-template-columns:repeat(2,1fr);} }
  .hero .card { text-align:center; } .hero .n { font-size:26px; font-weight:700; } .hero .l { font-size:12px; color:var(--mut); }
  table { width:100%; border-collapse:collapse; font-size:14px; }
  th,td { text-align:left; padding:7px 10px; border-bottom:1px solid #262a38; }
  th { color:var(--mut); font-weight:600; font-size:12.5px; text-transform:uppercase; letter-spacing:.03em; }
  td.so { color:var(--so); font-weight:600; } td.fu { color:var(--fu); font-weight:600; }
  tr.bad td { opacity:.45; }
  .legend span { display:inline-block; margin-right:16px; font-size:13px; color:var(--mut); }
  .dot { display:inline-block; width:10px; height:10px; border-radius:3px; margin-right:6px; vertical-align:middle; }
  .analysis p { margin:10px 0; } .analysis li { margin:6px 0; }
  code { background:#232736; padding:1px 5px; border-radius:4px; font-size:13px; }
  canvas { max-height:280px; }
</style></head><body><div class="wrap">
<h1>Swarm MCP surface: <span style="color:var(--so)">scripts-only</span> vs <span style="color:var(--fu)">full</span></h1>
<div class="sub">Same task ("collaborative marketing blurb": lead → analyst → marketer), same images, fresh DB per run · Claude harness · generated ${data.generatedAt}</div>
<div class="legend"><span><i class="dot" style="background:var(--so)"></i>scripts-only (8 MCP tools, everything via script-run)</span><span><i class="dot" style="background:var(--fu)"></i>full (118 MCP tools)</span></div>

<div class="hero">
  <div class="card"><div class="n">8 vs 118</div><div class="l">MCP tools exposed</div></div>
  <div class="card"><div class="n">~2.2K vs ~80K</div><div class="l">tool-schema tokens (35x)</div></div>
  <div class="card"><div class="n">${so.completed}/${so.attempts} · ${fu.completed}/${fu.attempts}</div><div class="l">runs completed (so · full)</div></div>
  <div class="card"><div class="n">$${so.meanCost.toFixed(2)} vs $${fu.meanCost.toFixed(2)}</div><div class="l">mean cost / run</div></div>
</div>

<div class="grid">
  <div class="card"><h3>Cost per run (USD)</h3><canvas id="cCost"></canvas></div>
  <div class="card"><h3>Parent wall time (min)</h3><canvas id="cWall"></canvas></div>
  <div class="card"><h3>Mean tool calls per run, by category</h3><canvas id="cTools"></canvas></div>
  <div class="card"><h3>End-of-session context (tokens)</h3><canvas id="cCtx"></canvas></div>
</div>

<h2>Mode comparison (means over completed runs)</h2>
<div class="card"><table>
  <tr><th>Metric</th><th style="color:var(--so)">scripts-only</th><th style="color:var(--fu)">full</th></tr>
  ${kpi("Completed / attempts", `${so.completed}/${so.attempts}`, `${fu.completed}/${fu.attempts}`)}
  ${kpi("Cost per run (USD)", so.meanCost, fu.meanCost, (x: number) => "$" + Number(x).toFixed(2))}
  ${kpi("Parent wall time (min)", so.meanWallMin, fu.meanWallMin)}
  ${kpi("Tool calls per run", so.meanToolCalls, fu.meanToolCalls)}
  ${kpi("SDK-probing script runs", so.meanProbes, fu.meanProbes)}
  ${kpi("Tool errors per run", so.meanErrors, fu.meanErrors)}
  ${kpi("Worker context @ end (mean)", so.meanWorkerCtx, fu.meanWorkerCtx, (x: number) => Math.round(x / 1000) + "K")}
  ${kpi("Lead context @ end (mean)", so.meanLeadCtx, fu.meanLeadCtx, (x: number) => Math.round(x / 1000) + "K")}
  ${kpi("Output tokens per run", so.meanOutputTokens, fu.meanOutputTokens, (x: number) => Math.round(x))}
</table></div>

<h2>All runs</h2>
<div class="card"><table>
  <tr><th>Run</th><th>Result</th><th>Wall (min)</th><th>Cost</th><th>Sessions</th><th>Tool calls</th><th>Probes</th><th>Errors</th><th>Worker ctx</th></tr>
  ${runRows}
</table></div>

<h2>Analysis</h2>
<div class="card analysis">${analysis}</div>

<script>
const runs = ${JSON.stringify(runs)};
const cats = ${JSON.stringify(cats)};
const SO='#6366f1', FU='#f59e0b';
Chart.defaults.color='#9ca3af'; Chart.defaults.borderColor='#262a38';
const byMode = m => runs.filter(r=>r.mode===m);
const labels = [...new Set(runs.map(r=>'run '+r.runId))].sort();
function series(m, f){ return labels.map(l=>{ const r=byMode(m).find(r=>'run '+r.runId===l); return r&&r.result==='completed'?f(r):null; }); }
new Chart(cCost,{type:'bar',data:{labels,datasets:[
  {label:'scripts-only',data:series('scripts-only',r=>r.costUsd),backgroundColor:SO},
  {label:'full',data:series('full',r=>r.costUsd),backgroundColor:FU}]},options:{plugins:{legend:{display:false}}}});
new Chart(cWall,{type:'bar',data:{labels,datasets:[
  {label:'scripts-only',data:series('scripts-only',r=>r.wallMin),backgroundColor:SO},
  {label:'full',data:series('full',r=>r.wallMin),backgroundColor:FU}]},options:{plugins:{legend:{display:false}}}});
const meanCat=(m,c)=>{const rs=byMode(m).filter(r=>r.result==='completed');return rs.length?rs.reduce((s,r)=>s+(r.toolCalls[c]||0),0)/rs.length:0;};
new Chart(cTools,{type:'bar',data:{labels:cats,datasets:[
  {label:'scripts-only',data:cats.map(c=>meanCat('scripts-only',c)),backgroundColor:SO},
  {label:'full',data:cats.map(c=>meanCat('full',c)),backgroundColor:FU}]},options:{plugins:{legend:{display:false}}}});
const agg=${JSON.stringify(data.agg)};
new Chart(cCtx,{type:'bar',data:{labels:['worker (mean)','lead (mean)'],datasets:[
  {label:'scripts-only',data:[agg[0].meanWorkerCtx,agg[0].meanLeadCtx],backgroundColor:SO},
  {label:'full',data:[agg[1].meanWorkerCtx,agg[1].meanLeadCtx],backgroundColor:FU}]},options:{plugins:{legend:{display:false}}}});
</script>
</div></body></html>`;

writeFileSync(OUT, html);
console.log("report written:", OUT);
