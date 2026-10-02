/**
 * Every fact the reel puts on screen, read live from its source right before render.
 *
 *  - workflow races: `test.failing` vs `test` in src/tests/workflow-tla-races.test.ts on origin/main
 *  - workflow fix PRs: open + merged PRs whose diff flips a CX `test.failing` to `test` (gh pr diff)
 *  - heartbeat fixes: merged PRs whose body cites a TLC trace in specs/tla/heartbeat, and the test
 *    file each one added (gh api)
 *  - heartbeat numbers: a model-checking write-up (markdown table + "### Bug N" sections). Set
 *    HEARTBEAT_DOC (agent-fs path) and AGENT_FS_ORG to read it live. Without them the `heartbeat`
 *    block is carried over from FALLBACK_FACTS and marked `carried`, so the run is still honest.
 *
 * Usage (from the repo clone):  bun facts.ts > facts.json
 * Needs: bun, git, an authenticated gh, and agent-fs only when HEARTBEAT_DOC is set.
 */
import { readFileSync } from "node:fs";
import { $ } from "bun";

const R = process.env.REPO ?? "desplega-ai/agent-swarm";
const repo = process.env.REPO_DIR ?? process.cwd();
const FILE = "src/tests/workflow-tla-races.test.ts";
const DOC = process.env.HEARTBEAT_DOC;
const ORG = process.env.AGENT_FS_ORG;
const FALLBACK_FACTS = process.env.FALLBACK_FACTS ?? `${import.meta.dir}/facts.v3.json`;

await $`git -C ${repo} fetch -q origin main`;
const sha = (await $`git -C ${repo} rev-parse --short origin/main`.text()).trim();
const src = await $`git -C ${repo} show origin/main:${FILE}`.text();
const cx = [...src.matchAll(/^\s*test(\.failing)?\("(CX\d+): ([^"]+)"/gm)].map((m) => ({
  id: m[2],
  title: m[3],
  failing: !!m[1],
}));

type Pr = { number: number; state: string; files: { path: string }[] };
const open = JSON.parse(
  await $`gh pr list -R ${R} --state open --limit 10000 --json number,state,files`.text(),
) as Pr[];
const shas = (
  await $`gh api --paginate ${`repos/${R}/commits?path=${FILE}&per_page=100`} --jq ${".[].sha"}`.text()
)
  .split("\n")
  .filter(Boolean);
const merged = new Map<number, Pr>();
for (const c of shas) {
  const ps = JSON.parse(await $`gh api repos/${R}/commits/${c}/pulls`.text()) as {
    number: number;
    merged_at: string | null;
  }[];
  for (const p of ps) {
    if (p.merged_at)
      merged.set(p.number, { number: p.number, state: "MERGED", files: [{ path: FILE }] });
  }
}
const flips: { id: string; pr: number; state: string }[] = [];
for (const p of [...open, ...merged.values()].filter((p) => p.files.some((f) => f.path === FILE))) {
  const diff = await $`gh pr diff ${p.number} -R ${R}`.text();
  for (const m of diff.matchAll(/^\+\s*test\("(CX\d+):/gm)) {
    const id = m[1];
    if (!id) continue;
    const flipped = new RegExp(`^-\\s*test\\.failing\\("${id}:`, "m").test(diff);
    if (flipped && !flips.some((x) => x.id === id && x.pr === p.number)) {
      flips.push({ id, pr: p.number, state: p.state });
    }
  }
}

// Heartbeat numbers: live from the write-up when configured, otherwise carried and labelled.
let heartbeat: Record<string, unknown>;
let bugs: { n: number; title: string; violates: string | null }[] = [];
if (DOC && ORG) {
  const doc = await $`agent-fs --org ${ORG} cat ${DOC}`.text();
  const row = (label: string) => {
    const line = doc.split("\n").find((l) => l.startsWith(`| ${label}`));
    if (!line) throw new Error(`row not found: ${label}`);
    return line
      .split("|")
      .slice(2, 5)
      .map((c) => c.replace(/\*\*/g, "").trim());
  };
  bugs = [...doc.matchAll(/^### Bug (\d+): (.+)\n\n([^\n]+)/gm)].map((m) => ({
    n: Number(m[1]),
    title: m[2] ?? "",
    violates: m[3]?.match(/Violates `(\w+)`/)?.[1] ?? null,
  }));
  heartbeat = {
    bugs,
    states: row("Reachable states"),
    statusViews: row("Task-status views in the graph"),
    rows: row("Rows per unit of work").map((s) => s.replace("up to ", "")),
  };
} else {
  const carried = JSON.parse(readFileSync(FALLBACK_FACTS, "utf8")).heartbeat;
  bugs = carried.bugs;
  heartbeat = { ...carried, carried: true };
}

// Heartbeat fix PRs: merged, body cites a TLC trace in specs/tla/heartbeat. Matched to a bug by title keyword.
const hbPrs = JSON.parse(
  await $`gh pr list -R ${R} --state merged --search ${"TLC trace heartbeat in:body"} --limit 50 --json number,title,state,mergedAt,body`.text(),
) as { number: number; title: string; state: string; mergedAt: string; body: string }[];
const KEY: Record<number, RegExp> = { 1: /stall/i, 2: /resume/i, 3: /reboot/i };
const hbFixes = [];
for (const p of hbPrs.filter((p) => p.body.includes("TLC trace (`specs/tla/heartbeat`"))) {
  const bug = bugs.find((b) => KEY[b.n]?.test(p.title));
  if (!bug) continue;
  const trace = p.body.match(
    /TLC trace \(`specs\/tla\/heartbeat`, `(\w+)`[^)]*\): (?:… )?([^\n]+?)\.?\n/,
  );
  const added = JSON.parse(await $`gh api ${`repos/${R}/pulls/${p.number}/files`}`.text()) as {
    filename: string;
    status: string;
  }[];
  const test =
    added.find((f) => f.status === "added" && f.filename.startsWith("src/tests/"))?.filename ??
    null;
  const onMain = test
    ? (await $`git -C ${repo} cat-file -e origin/main:${test}`.nothrow()).exitCode === 0
    : false;
  hbFixes.push({
    bug: bug.n,
    bugTitle: bug.title,
    pr: p.number,
    state: p.state,
    mergedAt: p.mergedAt,
    invariant: trace?.[1] ?? null,
    trace: trace?.[2]?.split(" → ") ?? null,
    test,
    testOnMain: onMain,
  });
}

console.log(
  JSON.stringify(
    {
      readAt: new Date().toISOString(),
      mainSha: sha,
      cx,
      flips: flips.sort((a, b) => a.id.localeCompare(b.id)),
      hbFixes: hbFixes.sort((a, b) => a.bug - b.bug),
      heartbeat,
    },
    null,
    2,
  ),
);
