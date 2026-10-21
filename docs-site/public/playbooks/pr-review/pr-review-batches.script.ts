import type { ScriptContext } from "swarm-sdk";

// pr-review-batches: tagged units -> N category batches -> Jev per batch (parallel).
// A unit tagged nowhere lands in "other" so nothing is dropped.

const CATS: Record<string, { label: string; q?: { id: string; text: string } }> = {
  tests: { label: "tests", q: { id: "weak_tests", text: "Are these test changes weak: they do not really assert the new behaviour (only mocks, snapshots, skipped tests, or happy path only)?" } },
  db: { label: "database", q: { id: "unsafe_db", text: "Could this database change lose data, lock a large table, or break an older running version (not backward-compatible)?" } },
  api: { label: "API / contract", q: { id: "breaking", text: "Does this change break existing callers of the endpoint, tool or contract (removed or renamed fields, changed types, stricter validation, changed defaults)?" } },
  auth: { label: "auth / security", q: { id: "weakens", text: "Does this change weaken authentication, authorization, secret handling or input validation?" } },
  deps_ci: { label: "deps / CI / build", q: { id: "risky_build", text: "Does this change add a risky dependency, a major-version bump, or weaken CI, build or deploy checks?" } },
  ui: { label: "UI", q: { id: "bug", text: "Is there a likely user-visible bug in this UI change (broken state, missing loading or error handling, wrong condition)?" } },
  logic: { label: "core logic", q: { id: "bug", text: "Is there a likely bug in this logic (wrong condition, missing null or error handling, race, off-by-one, leaked resource)?" } },
  docs: { label: "docs" },
  other: { label: "unclassified", q: { id: "bug", text: "Is there a likely bug in this change (wrong condition, missing error handling, race, off-by-one)?" } },
};

const val = (a: any) => (a && a.value !== undefined && a.value !== null ? a.value : null);

export default async function (args: any, ctx: ScriptContext) {
  const pr = args?.pr || {};
  const units: any[] = Array.isArray(args?.units) ? args.units : [];
  const tags: any = args?.tags || {};
  const c: any = args?.claims && typeof args.claims === "object" ? args.claims : {};
  const claims = {
    intent: val(c.intent), claimed_risk: val(c.claimed_risk), claimed_tests: val(c.claimed_tests),
    breaking: val(c.breaking), touched_areas: val(c.touched_areas),
  };
  // Repo rules from the context step (swarm repo config + CLAUDE.md); code-level ones only.
  const rules: string[] = (Array.isArray(args?.rules) ? args.rules : [])
    .filter((r: any) => r && r.from === "CLAUDE.md").map((r: any) => String(r.text).slice(0, 220)).slice(0, 10);
  const maxBatchChars: number = args?.maxBatchChars ?? 12000;
  const maxAgentBatches: number = args?.maxAgentBatches ?? 2;
  const threshold: number = args?.threshold ?? 0.5;
  const concernThreshold: number = args?.concernThreshold ?? 0.6;
  const driftThreshold: number = args?.driftThreshold ?? 0.6;

  const byId = new Map(units.map((u) => [u.id, u]));
  const norm = (v: any) => {
    const m = String(v).match(/h?\s*(\d+)/i);
    return m ? "h" + m[1] : "";
  };

  // 1. Group units by tag.
  const groups: Record<string, string[]> = {};
  const tagged = new Set<string>();
  for (const cat of Object.keys(CATS)) {
    if (cat === "other") continue;
    const vals: any[] = Array.isArray(val(tags[cat])) ? val(tags[cat]) : [];
    const ids = Array.from(new Set(vals.map(norm).filter((id) => byId.has(id))));
    if (ids.length) { groups[cat] = ids; ids.forEach((id) => tagged.add(id)); }
  }
  const untagged = units.map((u) => u.id).filter((id) => !tagged.has(id));
  if (untagged.length) groups.other = untagged;

  // 2. Split each group into batches that fit one Jev state.
  const render = (u: any) => "[" + u.id + "] " + u.file + " " + (u.header || "") + "\n" + u.text;
  const batches: any[] = [];
  for (const [cat, ids] of Object.entries(groups)) {
    let cur: string[] = [];
    let size = 0;
    const flush = () => { if (cur.length) { batches.push({ category: cat, unitIds: cur }); cur = []; size = 0; } };
    for (const id of ids) {
      const len = render(byId.get(id)).length;
      if (size + len > maxBatchChars && cur.length) flush();
      cur.push(id); size += len;
    }
    flush();
  }
  const perCat: Record<string, number> = {};
  for (const b of batches) {
    perCat[b.category] = (perCat[b.category] || 0) + 1;
    b.key = b.category + "-" + perCat[b.category];
    b.files = Array.from(new Set(b.unitIds.map((id: string) => byId.get(id).file)));
    let diff = b.unitIds.map((id: string) => render(byId.get(id))).join("\n\n");
    if (diff.length > maxBatchChars) diff = diff.slice(0, maxBatchChars) + "\n…(truncated)";
    b.diff = diff;
  }

  // 3. Jev on every batch, in parallel.
  const ask = async (b: any) => {
    const spec = CATS[b.category];
    const questions: any = {
      concern: {
        type: "noul",
        instructions: "Would a careful senior reviewer stop on this " + spec.label + " batch: a likely bug, a breaking change, a security weakness, or a risky behaviour change?",
      },
      drift: {
        type: "noul",
        instructions: "Does this batch change behaviour that the PR's stated intent and claims do not mention (scope drift)?",
      },
      risk: {
        type: "choice",
        instructions: "How risky is this batch of changes to merge?",
        criteria: { low: "Cosmetic, docs, tests or a contained additive change", medium: "A contained behaviour change", high: "Touches data, auth, public contracts or can break production" },
      },
    };
    if (spec.q) questions[spec.q.id] = { type: "noul", instructions: spec.q.text };
    if (rules.length) questions.breaks_rule = { type: "noul", instructions: "Does this batch break one of the repo_rules (the repository's own coding rules)?" };
    const state = {
      pr_title: pr.title || "",
      pr_claims: claims,
      batch_category: spec.label,
      diff: b.diff,
      ...(rules.length ? { repo_rules: rules.map((r, i) => (i + 1) + ". " + r).join("\n") } : {}),
    };
    const t0 = Date.now();
    try {
      const res: any = await (ctx.swarm as any).systemOne_decide({ state, questions, timeoutMs: 30000, maxRetries: 2 });
      const d = res?.data ?? res;
      if (!d?.answers) throw new Error(res?.message || "no answers");
      return { ok: true, ms: Date.now() - t0, model: d.model, answers: d.answers, usage: d.usage };
    } catch (e: any) {
      return { ok: false, ms: Date.now() - t0, error: String(e?.message || e).slice(0, 300) };
    }
  };
  const t0 = Date.now();
  const results = await Promise.all(batches.map(ask));
  const wallMs = Date.now() - t0;

  // 4. Verdicts.
  let inputTokens = 0;
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const out = batches.map((b, i) => {
    const r: any = results[i];
    const spec = CATS[b.category];
    const base = { key: b.key, category: b.category, label: spec.label, unitIds: b.unitIds, files: b.files };
    if (!r.ok) return { ...base, verdict: "error", score: 1, why: ["Jev call failed: " + r.error], jev: null };
    inputTokens += r.usage?.input_tokens || 0;
    const a = r.answers;
    const concern = a.concern?.noul ?? 0;
    const drift = a.drift?.noul ?? 0;
    const specific = spec.q ? (a[spec.q.id]?.noul ?? 0) : 0;
    const risk = a.risk?.choice ?? "low";
    const riskConf = a.risk?.confidence ?? 0;
    const why: string[] = [];
    if (concern >= concernThreshold) why.push("reviewer would stop " + r2(concern));
    if (spec.q && specific >= threshold) why.push(spec.q.id + " " + r2(specific));
    if (drift >= driftThreshold) why.push("scope drift " + r2(drift));
    const rule = rules.length ? (a.breaks_rule?.noul ?? 0) : 0;
    if (rule >= concernThreshold) why.push("breaks a repo rule " + r2(rule));
    const score = Math.max(concern, specific, drift, rule);
    const jev: any = { ms: r.ms, concern: r2(concern), drift: r2(drift), risk, riskConfidence: r2(riskConf) };
    if (spec.q) jev[spec.q.id] = r2(specific);
    if (rules.length) jev.breaks_rule = r2(rule);
    return { ...base, verdict: why.length ? "flag" : "ok", score: r2(score), why, jev };
  });

  const flaggedAll = out.filter((b) => b.verdict !== "ok").sort((x, y) => y.score - x.score);
  const toAgent = flaggedAll.slice(0, maxAgentBatches);
  const diffByKey = new Map(batches.map((b) => [b.key, b.diff]));
  const flagged = toAgent.map((b) => ({
    key: b.key, category: b.category, label: b.label, files: b.files.join(", "), why: b.why.join("; "),
    diff: diffByKey.get(b.key),
  }));

  return {
    claims,
    rulesUsed: rules.length,
    batchCount: out.length,
    flaggedCount: flaggedAll.length,
    sentToAgent: flagged.map((f) => f.key),
    notSentToAgent: flaggedAll.slice(maxAgentBatches).map((b) => b.key),
    untaggedUnits: untagged.length,
    jevWallMs: wallMs,
    jevCalls: out.length,
    jevInputTokens: inputTokens,
    jevCostUsd: Math.round(inputTokens * 0.042) / 1e6,
    batches: out,
    flagged,
  };
}
