import type { ScriptContext } from "swarm-sdk";

const CRITERIA: Record<string, string> = {
  tests: "Adds or changes tests, test fixtures or test helpers",
  db: "Changes database schema, migrations, SQL queries or the shape of stored data",
  api: "Adds or changes an HTTP endpoint, MCP tool, CLI command, exported type or other public contract",
  auth: "Touches authentication, permissions, roles, secrets, tokens or input validation",
  deps_ci: "Changes dependencies, lockfiles, CI workflows, Docker, build or deploy config",
  ui: "Changes frontend UI components, pages or styles",
  docs: "Only documentation, markdown, comments or generated API docs",
  logic: "Other backend or runtime logic",
};

export default async function (args: any, ctx: ScriptContext) {
  const units: any[] = Array.isArray(args?.units) ? args.units : [];
  const concurrency: number = args?.concurrency ?? 12;
  const question = { category: { type: "choice", instructions: "Which category best describes this single change unit?", criteria: CRITERIA } };

  const tagOne = async (u: any) => {
    const state = { file: u.file, status: u.status, hunk_header: u.header || "", diff: String(u.text || "").slice(0, 3000) };
    try {
      const res: any = await (ctx.swarm as any).systemOne_decide({ state, questions: question, timeoutMs: 20000, maxRetries: 2 });
      const d = res?.data ?? res;
      const a = d?.answers?.category;
      if (!a?.choice) throw new Error(res?.message || "no answer");
      return { id: u.id, category: a.choice, confidence: a.confidence, tokens: d.usage?.input_tokens || 0 };
    } catch (e: any) {
      return { id: u.id, category: null, error: String(e?.message || e).slice(0, 200), tokens: 0 };
    }
  };

  const t0 = Date.now();
  const out: any[] = new Array(units.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, units.length) }, async () => {
    while (next < units.length) { const i = next++; out[i] = await tagOne(units[i]); }
  }));
  const wallMs = Date.now() - t0;

  const answers: Record<string, any> = {};
  for (const cat of Object.keys(CRITERIA)) answers[cat] = { type: "list", value: [] as string[] };
  for (const r of out) if (r.category && answers[r.category]) answers[r.category].value.push(r.id);
  const tokens = out.reduce((s, r) => s + (r.tokens || 0), 0);

  return {
    answers,
    perUnit: out.map((r) => ({ id: r.id, category: r.category, confidence: r.confidence, error: r.error })),
    errors: out.filter((r) => !r.category).length,
    jevCalls: out.length,
    jevWallMs: wallMs,
    jevInputTokens: tokens,
    jevCostUsd: Math.round(tokens * 0.042) / 1e6,
  };
}
