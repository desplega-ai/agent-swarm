import type { ScriptContext } from "swarm-sdk";

// pr-review-context: what a reviewer should know beyond the diff.
// Repo rules (swarm repo config + CLAUDE.md), CI on the reviewed commit, code-maat
// hotspots and temporal coupling, recent PRs on the same paths, importers of the
// touched modules. Jev then scores each untouched related file: does this PR
// probably need to change it too?

const RATE_PER_MTOK = 0.042;

export default async function (args: any, ctx: ScriptContext) {
  const repo: string = args?.repo || "desplega-ai/agent-swarm";
  const pr: any = args?.pr || {};
  const sha: string = args?.sha || pr.headSha || "";
  const files: any[] = Array.isArray(args?.files) ? args.files : [];
  const touched = new Set(files.map((f: any) => f.file));
  const maxCandidates: number = args?.maxCandidates ?? 8;
  const sw: any = ctx.swarm as any;

  const tokenRedacted = sw.config.get("GITHUB_TOKEN");
  const tok = tokenRedacted ? (ctx.stdlib as any).Redacted.value(tokenRedacted) : "[REDACTED:GITHUB_TOKEN]";
  const headers: any = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "agent-swarm-script", Authorization: "Bearer " + tok };
  const gh = async (url: string, accept?: string) => {
    const r: any = await (ctx.stdlib as any).fetch(url.startsWith("http") ? url : "https://api.github.com" + url, { headers: accept ? { ...headers, Accept: accept } : headers });
    if (!r.ok) throw new Error("GitHub " + r.status + " on " + url.slice(0, 120));
    return accept && accept.indexOf("raw") >= 0 ? await r.text() : await r.json();
  };
  const safe = async <T>(p: Promise<T>, fallback: T, errs: string[], label: string): Promise<T> => {
    try { return await p; } catch (e: any) { errs.push(label + ": " + String(e?.message || e).slice(0, 160)); return fallback; }
  };
  const errors: string[] = [];
  const srcFiles = files.filter((f: any) => !/(^|\/)(test|tests|__tests__)\/|\.test\.|\.spec\.|\.md$|\.lock|lock\.json$/.test(f.file));

  // 1. Repo rules: swarm repo config (review guidelines + required checks) and CLAUDE.md rule lines.
  const guidelinesP = (async () => {
    const res: any = await sw.db_query({ sql: "SELECT guidelines FROM swarm_repos WHERE url = 'https://github.com/" + repo.replace(/'/g, "") + "' LIMIT 1" });
    const raw = res?.data?.rows?.[0]?.[0];
    const g = raw ? JSON.parse(raw) : {};
    const rules: any[] = [];
    for (const t of g.review || []) rules.push({ from: "swarm repo config", text: String(t) });
    for (const t of g.prChecks || []) rules.push({ from: "required PR check", text: String(t) });
    for (const t of g.mergeChecks || []) rules.push({ from: "merge check", text: String(t) });
    let md = "";
    try { md = await gh("/repos/" + repo + "/contents/CLAUDE.md", "application/vnd.github.raw+json"); } catch { md = ""; }
    const mdRules = String(md).split("\n").map((l) => l.trim())
      .filter((l) => /^[-*] |^\d+\. /.test(l) && /\b(never|always|must|do not|don't|required|only)\b/i.test(l))
      .map((l) => l.replace(/^[-*] |^\d+\. /, "").slice(0, 260)).slice(0, 18);
    for (const t of mdRules) rules.push({ from: "CLAUDE.md", text: t });
    return { rules, prChecks: g.prChecks || [], mergeChecks: g.mergeChecks || [] };
  })();

  // 2. CI on the reviewed commit.
  const ciP = (async () => {
    if (!sha) return { sha: "", state: "unknown", total: 0, passed: 0, failed: [], pending: [], checks: [] };
    const [runs, status]: any[] = await Promise.all([
      gh("/repos/" + repo + "/commits/" + sha + "/check-runs?per_page=100"),
      gh("/repos/" + repo + "/commits/" + sha + "/status").catch(() => ({ statuses: [] })),
    ]);
    const checks: any[] = (runs.check_runs || []).map((c: any) => ({ name: c.name, status: c.status, conclusion: c.conclusion, url: c.html_url, ms: c.completed_at && c.started_at ? new Date(c.completed_at).getTime() - new Date(c.started_at).getTime() : null }));
    for (const s of status.statuses || []) checks.push({ name: s.context, status: s.state === "pending" ? "in_progress" : "completed", conclusion: s.state === "success" ? "success" : s.state === "pending" ? null : "failure", url: s.target_url });
    const failed = checks.filter((c) => c.status === "completed" && ["failure", "timed_out", "cancelled", "action_required"].includes(c.conclusion)).map((c) => c.name);
    const pending = checks.filter((c) => c.status !== "completed").map((c) => c.name);
    const passed = checks.filter((c) => c.status === "completed" && ["success", "neutral", "skipped"].includes(c.conclusion)).length;
    const state = failed.length ? "failing" : pending.length ? "pending" : checks.length ? "passing" : "none";
    return { sha, state, total: checks.length, passed, failed, pending, checks };
  })();

  // 3. code-maat hotspots + temporal coupling.
  const cmP = (async () => {
    const r: any = await sw.kv_get({ namespace: "code-maat", key: repo.split("/")[1] + ":review-index" });
    return r?.data?.value ?? r?.value ?? null;
  })();

  // 4. Recent PRs on the same paths (top 5 source files by churn).
  const recentP = (async () => {
    const pick = srcFiles.slice().sort((a: any, b: any) => (b.additions + b.deletions) - (a.additions + a.deletions)).slice(0, 5);
    const byPr = new Map<number, any>();
    await Promise.all(pick.map(async (f: any) => {
      const commits: any[] = await gh("/repos/" + repo + "/commits?per_page=6&path=" + encodeURIComponent(f.file)).catch(() => []);
      for (const c of commits) {
        const msg = String(c.commit?.message || "").split("\n")[0];
        const m = msg.match(/\(#(\d+)\)\s*$/);
        if (!m || Number(m[1]) === pr.number) continue;
        const n = Number(m[1]);
        const e = byPr.get(n) || { number: n, title: msg.replace(/\s*\(#\d+\)\s*$/, ""), date: c.commit?.author?.date, author: c.author?.login || c.commit?.author?.name, files: [] as string[] };
        if (e.files.indexOf(f.file) < 0) e.files.push(f.file);
        byPr.set(n, e);
      }
    }));
    return Array.from(byPr.values()).sort((a, b) => (b.files.length - a.files.length) || String(b.date).localeCompare(String(a.date))).slice(0, 8);
  })();

  // 5. Importers of the touched modules (GitHub code search, top 3 source files).
  const importersP = (async () => {
    const pick = srcFiles.filter((f: any) => /\.(ts|tsx|js|mjs)$/.test(f.file) && f.status !== "added").slice(0, 3);
    const out: any[] = [];
    for (const f of pick) {
      const parts = f.file.replace(/\.(ts|tsx|js|mjs)$/, "").split("/");
      const base = parts.pop() || "";
      if (base === "index" || base.length < 4) continue;
      const needle = (parts.length ? parts[parts.length - 1] + "/" : "") + base;
      try {
        const q = encodeURIComponent('"' + needle + '" repo:' + repo);
        const r: any = await gh("/search/code?per_page=20&q=" + q);
        const paths = (r.items || []).map((i: any) => i.path).filter((p: string) => p !== f.file && /\.(ts|tsx|js|mjs|cjs)$/.test(p) && !/^(thoughts|docs?)\//.test(p));
        out.push({ file: f.file, needle, total: r.total_count || 0, importers: paths.slice(0, 12), untouched: paths.filter((p: string) => !touched.has(p)).slice(0, 12) });
      } catch (e: any) { errors.push("importers " + f.file + ": " + String(e?.message || e).slice(0, 120)); }
    }
    return out;
  })();

  const [guidelines, ci, cm, recentPrs, importers] = await Promise.all([
    safe(guidelinesP, { rules: [], prChecks: [], mergeChecks: [] } as any, errors, "guidelines"),
    safe(ciP, { sha, state: "unknown", total: 0, passed: 0, failed: [], pending: [], checks: [] } as any, errors, "ci"),
    safe(cmP, null as any, errors, "code-maat"),
    safe(recentP, [] as any[], errors, "recent PRs"),
    safe(importersP, [] as any[], errors, "importers"),
  ]);

  // Hotspots and coupling for touched files.
  const hotspots: any[] = [];
  const coupled: any[] = [];
  if (cm) {
    for (const f of files) {
      const s = cm.files?.[f.file];
      if (s) hotspots.push({ file: f.file, revs: s.r || 0, churn: s.c || 0, mainDev: s.m || null, ownership: s.o ?? null, riskRank: s.k || null, ccn: s.cc || null, loc: s.loc || null, authors: s.a || null });
      for (const [partner, degree, avgRevs] of cm.coupling?.[f.file] || []) {
        coupled.push({ file: f.file, partner, degree, avgRevs, touched: touched.has(partner) });
      }
    }
    hotspots.sort((a, b) => (a.riskRank || 1e9) - (b.riskRank || 1e9) || b.revs - a.revs);
  }

  // Candidates: untouched coupled partners and untouched importers.
  const cand = new Map<string, any>();
  for (const c of coupled.filter((c) => !c.touched).sort((a, b) => b.degree - a.degree)) {
    const e = cand.get(c.partner) || { file: c.partner, reasons: [] as string[], prior: 0 };
    e.reasons.push("changes with " + c.file + " in " + c.degree + "% of commits");
    e.prior = Math.max(e.prior, c.degree / 100);
    cand.set(c.partner, e);
  }
  for (const im of importers) for (const p of im.untouched.slice(0, 4)) {
    const e = cand.get(p) || { file: p, reasons: [] as string[], prior: 0 };
    e.reasons.push("references " + im.file);
    e.prior = Math.max(e.prior, 0.3);
    cand.set(p, e);
  }
  const candidates = Array.from(cand.values()).sort((a, b) => b.prior - a.prior).slice(0, maxCandidates);

  // Jev: does this PR likely need a change in each untouched related file?
  let jevTokens = 0;
  const t0 = Date.now();
  const touchedList = files.map((f: any) => f.file + " (+" + f.additions + " -" + f.deletions + ")").slice(0, 40).join("\n");
  await Promise.all(candidates.map(async (c) => {
    try {
      const res: any = await sw.systemOne_decide({
        state: { pr_title: pr.title || "", pr_description: String(pr.description || "").slice(0, 700), touched_files: touchedList, related_untouched_file: c.file, why_related: c.reasons.join("; ") },
        questions: { needs_change: { type: "noul", instructions: "Given the files this PR changes, is it likely the PR should also change related_untouched_file (and is incomplete without it)?" } },
        timeoutMs: 20000, maxRetries: 1,
      });
      const d = res?.data ?? res;
      c.score = Math.round((d?.answers?.needs_change?.noul ?? 0) * 100) / 100;
      jevTokens += d?.usage?.input_tokens || 0;
    } catch (e: any) { c.score = null; errors.push("jev " + c.file + ": " + String(e?.message || e).slice(0, 100)); }
  }));
  const jevMs = Date.now() - t0;
  const missing = candidates.filter((c) => (c.score ?? 0) >= 0.5).sort((a, b) => (b.score || 0) - (a.score || 0));

  // Prompt block for the agent: short, only what changes a verdict.
  const lines: string[] = [];
  lines.push("CI on " + (sha ? sha.slice(0, 7) : "head") + ": " + ci.state + (ci.failed.length ? " (failing: " + ci.failed.slice(0, 5).join(", ") + ")" : "") + (ci.pending.length ? " (pending: " + ci.pending.length + ")" : ""));
  const keyRules = [
    ...guidelines.rules.filter((r: any) => r.from === "swarm repo config" && /verdict proportionality/i.test(r.text)),
    ...guidelines.rules.filter((r: any) => r.from === "CLAUDE.md").slice(0, 5),
  ];
  if (keyRules.length) lines.push("Repo review rules:\n" + keyRules.map((r: any) => "- " + r.text.slice(0, 420)).join("\n"));
  if (missing.length) lines.push("Related files this PR does not touch but probably should:\n" + missing.slice(0, 4).map((m) => "- " + m.file + " (" + m.reasons[0] + ", Jev " + m.score + ")").join("\n"));
  const hot = hotspots.filter((h) => h.riskRank && h.riskRank <= 25).slice(0, 3);
  if (hot.length) lines.push("Hotspots touched (code-maat risk rank): " + hot.map((h) => h.file + " #" + h.riskRank).join(", "));

  return {
    sha,
    guidelines,
    ci,
    codeMaat: cm ? { runDate: cm.runDate, commit: cm.commit, scope: cm.scope, pageUrl: null } : null,
    hotspots: hotspots.slice(0, 12),
    coupled: coupled.slice(0, 24),
    recentPrs,
    importers,
    candidates,
    missing,
    errors,
    jevCalls: candidates.length,
    jevWallMs: jevMs,
    jevInputTokens: jevTokens,
    jevCostUsd: Math.round(jevTokens * RATE_PER_MTOK) / 1e6,
    promptBlock: lines.join("\n\n"),
  };
}
