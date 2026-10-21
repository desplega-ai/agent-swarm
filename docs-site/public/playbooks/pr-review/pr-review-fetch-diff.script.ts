import type { ScriptContext } from "swarm-sdk";

// pr-review-fetch-diff: GitHub PR -> numbered change units + Clairic state.
// Units are hunks; a PR with more than maxUnits hunks falls back to one unit per file.
// Re-reviews: pass `sha` to review one commit (its own diff), or `sha` + `base` to
// review only what changed between two commits. Without `sha` it reviews the whole PR.

interface Unit { id: string; file: string; status: string; header: string; additions: number; deletions: number; text: string }

export default async function (args: any, ctx: ScriptContext) {
  const repo: string = args?.repo || "desplega-ai/agent-swarm";
  const pr = Number(args?.pr);
  if (!pr) throw new Error("'pr' (number) is required");
  const maxUnits: number = args?.maxUnits ?? 60;
  const maxStateChars: number = args?.maxStateChars ?? 28000;
  const maxUnitChars: number = args?.maxUnitChars ?? 2500;

  const tokenRedacted = (ctx.swarm as any).config.get("GITHUB_TOKEN");
  const tok = tokenRedacted ? (ctx.stdlib as any).Redacted.value(tokenRedacted) : "[REDACTED:GITHUB_TOKEN]";
  const headers: any = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "agent-swarm-script",
    Authorization: "Bearer " + tok,
  };
  const gh = async (path: string) => {
    const r: any = await (ctx.stdlib as any).fetch("https://api.github.com/repos/" + repo + path, { headers });
    if (!r.ok) throw new Error("GitHub " + r.status + " on " + path);
    return await r.json();
  };

  const meta: any = await gh("/pulls/" + pr);
  const sha: string = String(args?.sha || "").trim();
  let base: string = String(args?.base || "").trim();
  let mode = "full";
  let commit: any = null;
  const files: any[] = [];
  if (sha && !/^\{\{/.test(sha)) {
    const c: any = await gh("/commits/" + sha);
    commit = { sha: c.sha, message: String(c.commit?.message || "").split("\n")[0], author: c.author?.login || c.commit?.author?.name, date: c.commit?.author?.date };
    if (!base || /^\{\{/.test(base)) { base = c.parents?.[0]?.sha || ""; mode = "commit"; } else mode = "range";
    if (mode === "commit") files.push(...(c.files || []));
    else files.push(...(((await gh("/compare/" + base + "..." + c.sha)) as any).files || []));
  } else {
    base = meta.base?.sha || "";
    for (let page = 1; page <= 3; page++) {
      const batch: any[] = await gh("/pulls/" + pr + "/files?per_page=100&page=" + page);
      files.push(...batch);
      if (batch.length < 100) break;
    }
  }
  const reviewedSha: string = commit ? commit.sha : meta.head?.sha;

  const LOCK = /(^|\/)(bun\.lockb?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/;
  const hunks: Omit<Unit, "id">[] = [];
  for (const f of files) {
    const base = { file: f.filename, status: f.status, additions: f.additions, deletions: f.deletions };
    if (!f.patch || LOCK.test(f.filename)) {
      hunks.push({ ...base, header: "", text: f.patch ? "(lockfile diff omitted)" : "(no patch: binary, renamed or too large)" });
      continue;
    }
    const parts = String(f.patch).split(/\n(?=@@ )/);
    for (const p of parts) {
      const nl = p.indexOf("\n");
      const header = nl > 0 ? p.slice(0, nl) : p;
      const body = nl > 0 ? p.slice(nl + 1) : "";
      const adds = (body.match(/^\+/gm) || []).length;
      const dels = (body.match(/^-/gm) || []).length;
      hunks.push({ ...base, header, additions: adds, deletions: dels, text: body });
    }
  }

  let granularity = "hunk";
  let raw: Omit<Unit, "id">[] = hunks;
  if (hunks.length > maxUnits) {
    granularity = "file";
    raw = files.map((f: any) => ({
      file: f.filename, status: f.status, header: "", additions: f.additions, deletions: f.deletions,
      text: LOCK.test(f.filename) ? "(lockfile diff omitted)" : (f.patch || "(no patch: binary, renamed or too large)"),
    }));
  }
  const omittedUnits = Math.max(0, raw.length - maxUnits);
  raw = raw.slice(0, maxUnits);
  const units: Unit[] = raw.map((u, i) => ({
    ...u,
    id: "h" + (i + 1),
    text: u.text.length > maxUnitChars ? u.text.slice(0, maxUnitChars) + "\n…(truncated)" : u.text,
  }));

  const desc = String(meta.body || "").slice(0, 1500);
  const head = "PR #" + pr + ": " + meta.title + "\n\nDescription:\n" + desc + "\n\nChanged units (each has an id like h1):\n";
  const perUnit = Math.max(200, Math.floor((maxStateChars - head.length) / Math.max(1, units.length)) - 120);
  const state = head + units.map((u) =>
    "\n[" + u.id + "] " + u.file + " (" + u.status + ", +" + u.additions + " -" + u.deletions + ") " + u.header + "\n" +
    (u.text.length > perUnit ? u.text.slice(0, perUnit) + "\n…" : u.text)
  ).join("\n");

  return {
    pr: {
      repo, number: pr, title: meta.title, url: meta.html_url, author: meta.user?.login, draft: meta.draft,
      headSha: meta.head?.sha, baseRef: meta.base?.ref, additions: meta.additions, deletions: meta.deletions, changedFiles: meta.changed_files,
      description: desc.slice(0, 800),
    },
    review: { mode, sha: reviewedSha, base, commit, isHead: reviewedSha === meta.head?.sha },
    files: files.map((f: any) => ({ file: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, previous: f.previous_filename || null })),
    granularity,
    unitCount: units.length,
    omittedUnits,
    units,
    state,
    stateChars: state.length,
    claimsState: "Title: " + meta.title + "\n\n" + String(meta.body || "(no description)").slice(0, 4000),
  };
}
