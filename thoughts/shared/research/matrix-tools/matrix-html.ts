// Emit self-contained HTML report from /tmp/matrix/metrics.json (+ /tmp/matrix/analysis.html fragment).
// Usage: bun /tmp/matrix-html.ts [outPath]
import { readFileSync, existsSync, writeFileSync } from "node:fs";

const data = JSON.parse(readFileSync("/tmp/matrix/metrics.json", "utf8"));
const analysis = existsSync("/tmp/matrix/analysis.html") ? readFileSync("/tmp/matrix/analysis.html", "utf8") : "<p><em>Analysis pending.</em></p>";
const OUT = process.argv[2] ?? "/tmp/matrix/mcp-surface-matrix-report.html";

const ORDER = ["claude/full", "claude/scripts-only", "claude/scripts-only+seeds", "pi/full", "pi/scripts-only+seeds", "opencode/full", "opencode/scripts-only+seeds"];
const agg = [...data.agg].sort((a: any, b: any) => ORDER.indexOf(a.group) - ORDER.indexOf(b.group));
const runs = data.runs;
const COLORS: Record<string, string> = {
  "claude/full": "#f59e0b", "claude/scripts-only": "#818cf8", "claude/scripts-only+seeds": "#6366f1",
  "pi/full": "#fbbf24", "pi/scripts-only+seeds": "#4f46e5",
  "opencode/full": "#fcd34d", "opencode/scripts-only+seeds": "#4338ca",
};

const aggRows = agg.map((a: any) => `
  <tr>
    <td><i class="dot" style="background:${COLORS[a.group] ?? "#888"}"></i>${a.group}</td>
    <td>${a.completed}/${a.attempts}</td><td>${a.delegatedOk}/${a.completed}</td>
    <td>$${a.meanCost.toFixed(2)}</td><td>${a.meanWallMin}</td><td>${a.meanToolCalls}</td>
    <td>${a.meanSeedCalls}</td><td>${a.meanErrors}</td>
    <td>${a.meanLeadCtx ? Math.round(a.meanLeadCtx / 1000) + "K" : "n/a"}</td>
    <td>${a.meanWorkerCtx ? Math.round(a.meanWorkerCtx / 1000) + "K" : "n/a"}</td>
    <td>${Math.round(a.meanOutputTokens / 1000)}K</td>
  </tr>`).join("");

const runRows = runs.map((r: any) => `
  <tr class="${r.result !== "completed" ? "bad" : ""}">
    <td>${r.group} #${r.runId}</td><td>${r.result}</td><td>${r.wallMin ?? "—"}</td>
    <td>$${r.costUsd.toFixed(2)}</td><td>${r.totalToolCalls}</td><td>${r.seedCalls}</td><td>${r.errors}</td>
    <td>${Object.entries(r.toolCalls).map(([k, v]) => `${k}:${v}`).join(" · ") || "—"}</td>
  </tr>`).join("");

const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>Swarm MCP surface matrix — scripts-only vs full × claude/pi/opencode</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
  :root { --bg:#0f1117; --card:#181b25; --txt:#e5e7eb; --mut:#9ca3af; }
  * { box-sizing:border-box; }
  body { margin:0; font:15px/1.55 -apple-system,'Segoe UI',Roboto,sans-serif; background:var(--bg); color:var(--txt); padding:32px 16px; }
  .wrap { max-width:1160px; margin:0 auto; }
  h1 { font-size:25px; margin:0 0 4px; } h2 { font-size:19px; margin:36px 0 12px; border-bottom:1px solid #2a2e3d; padding-bottom:6px; }
  .sub { color:var(--mut); margin-bottom:20px; }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:20px; } @media(max-width:900px){ .grid{grid-template-columns:1fr;} }
  .card { background:var(--card); border:1px solid #262a38; border-radius:12px; padding:18px; }
  .card h3 { margin:0 0 10px; font-size:13.5px; color:var(--mut); font-weight:600; text-transform:uppercase; letter-spacing:.04em; }
  .hero { display:grid; grid-template-columns:repeat(3,1fr); gap:14px; margin:18px 0; } @media(max-width:900px){ .hero{grid-template-columns:1fr;} }
  .hero .card { text-align:center; } .hero .n { font-size:21px; font-weight:700; } .hero .l { font-size:12.5px; color:var(--mut); margin-top:4px; }
  table { width:100%; border-collapse:collapse; font-size:13.5px; }
  th,td { text-align:left; padding:7px 9px; border-bottom:1px solid #262a38; }
  th { color:var(--mut); font-weight:600; font-size:12px; text-transform:uppercase; letter-spacing:.03em; }
  tr.bad td { opacity:.45; }
  .dot { display:inline-block; width:10px; height:10px; border-radius:3px; margin-right:7px; vertical-align:baseline; }
  .analysis p { margin:10px 0; } .analysis li { margin:6px 0; } .analysis h4 { margin:18px 0 6px; }
  code { background:#232736; padding:1px 5px; border-radius:4px; font-size:12.5px; }
  canvas { max-height:270px; }
  .note { font-size:12.5px; color:var(--mut); margin-top:8px; }
</style></head><body><div class="wrap">
<h1>Swarm MCP surface matrix</h1>
<div class="sub">scripts-only ("code-mode", 8 tools) vs full surface (118 tools) × claude / pi / opencode — same collaborative task, fresh stack per run, same images.<br>
pi + opencode run <code>deepseek-v4-flash</code> via OpenRouter (all 3 agents). "+seeds" = 6 default scripts (delegate, wait-for-task, get-child-outputs, complete-task, report-progress, swarm-overview) + code-mode prompt. Generated ${data.generatedAt}.</div>

<div class="hero">
  <div class="card"><div class="n">Claude: seeds close the gap</div><div class="l">$1.85 vs $1.83 · faster (3.3 vs 3.9 min) · lead context −37%</div></div>
  <div class="card"><div class="n">opencode/full ctx ≈ 80K</div><div class="l">the 118-tool schema really enters context without tool-search; scripts-only cuts lead ctx to ~38K</div></div>
  <div class="card"><div class="n">Weak models break in code-mode</div><div class="l">deepseek delegation fidelity: full 5/5 · scripts-only 1/3 (leads skip collaboration)</div></div>
</div>

<div class="grid">
  <div class="card"><h3>Completion & correct delegation (of attempts)</h3><canvas id="cDone"></canvas></div>
  <div class="card"><h3>Mean cost per run (USD, log scale)</h3><canvas id="cCost"></canvas><div class="note">Claude = subscription-estimated; deepseek = OpenRouter metered. Compare within provider, not across.</div></div>
  <div class="card"><h3>Mean parent wall time (min)</h3><canvas id="cWall"></canvas></div>
  <div class="card"><h3>Peak context — lead session (tokens)</h3><canvas id="cCtx"></canvas><div class="note">pi does not report context usage (adapter gap — worth fixing). </div></div>
  <div class="card"><h3>Mean tool calls per run, by category</h3><canvas id="cTools"></canvas></div>
  <div class="card"><h3>Seed-script adoption (calls/run) & tool errors</h3><canvas id="cSeed"></canvas></div>
</div>

<h2>Aggregate (means over completed runs)</h2>
<div class="card"><table>
  <tr><th>Group</th><th>Done</th><th>Delegated</th><th>Cost</th><th>Wall min</th><th>Calls</th><th>Seed calls</th><th>Errors</th><th>Lead ctx</th><th>Worker ctx</th><th>Out tok</th></tr>
  ${aggRows}
</table></div>

<h2>All runs</h2>
<div class="card"><table>
  <tr><th>Run</th><th>Result</th><th>Wall</th><th>Cost</th><th>Calls</th><th>Seeds</th><th>Errs</th><th>Call breakdown</th></tr>
  ${runRows}
</table></div>

<h2>Analysis & recommendations</h2>
<div class="card analysis">${analysis}</div>

<script>
const agg = ${JSON.stringify(agg)};
const COLORS = ${JSON.stringify(COLORS)};
Chart.defaults.color='#9ca3af'; Chart.defaults.borderColor='#262a38';
const labels = agg.map(a=>a.group);
const colors = agg.map(a=>COLORS[a.group] ?? '#888');
const opts = { plugins:{legend:{display:false}}, scales:{x:{ticks:{autoSkip:false,maxRotation:45,minRotation:30}}} };
new Chart(cDone,{type:'bar',data:{labels,datasets:[
  {label:'completed %',data:agg.map(a=>100*a.completed/a.attempts),backgroundColor:colors},
  {label:'delegated %',data:agg.map(a=>100*(a.delegatedOk??0)/a.attempts),backgroundColor:colors.map(c=>c+'66')}]},
  options:{...opts, plugins:{legend:{display:true}}, scales:{...opts.scales, y:{max:100}}}});
new Chart(cCost,{type:'bar',data:{labels,datasets:[{data:agg.map(a=>a.meanCost),backgroundColor:colors}]},options:{...opts, scales:{...opts.scales, y:{type:'logarithmic'}}}});
new Chart(cWall,{type:'bar',data:{labels,datasets:[{data:agg.map(a=>a.meanWallMin),backgroundColor:colors}]},options:opts});
new Chart(cCtx,{type:'bar',data:{labels,datasets:[{data:agg.map(a=>a.meanLeadCtx||null),backgroundColor:colors}]},options:opts});
const cats=[...new Set(agg.flatMap(a=>Object.keys((${JSON.stringify(runs)}).filter(r=>r.group===a.group&&r.result==='completed').reduce((acc,r)=>Object.assign(acc,r.toolCalls),{}))))];
const runsAll=${JSON.stringify(runs)};
const catMean=(g,c)=>{const rs=runsAll.filter(r=>r.group===g&&r.result==='completed');return rs.length?rs.reduce((s,r)=>s+(r.toolCalls[c]||0),0)/rs.length:0;};
new Chart(cTools,{type:'bar',data:{labels,datasets:cats.map((c,i)=>({label:c,data:agg.map(a=>catMean(a.group,c)),backgroundColor:['#6366f1','#f59e0b','#10b981','#ef4444','#8b5cf6'][i%5],stack:'s'}))},
  options:{...opts, plugins:{legend:{display:true}}, scales:{x:{stacked:true,ticks:{autoSkip:false,maxRotation:45,minRotation:30}},y:{stacked:true}}}});
new Chart(cSeed,{type:'bar',data:{labels,datasets:[
  {label:'seed calls/run',data:agg.map(a=>a.meanSeedCalls),backgroundColor:'#10b981'},
  {label:'tool errors/run',data:agg.map(a=>a.meanErrors),backgroundColor:'#ef4444'}]},
  options:{...opts, plugins:{legend:{display:true}}}});
</script>
</div></body></html>`;

writeFileSync(OUT, html);
console.log("report written:", OUT);
