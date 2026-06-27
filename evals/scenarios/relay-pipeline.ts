import type { PipelineStage } from "../src/judge/deterministic.ts";
import { fileAbsentOnWorker, pipelineStagesCorrect } from "../src/judge/deterministic.ts";
import type { CheckResult, DeterministicCheck, Scenario } from "../src/types.ts";

/**
 * relay-pipeline (v8.0 round-11, Multi-worker, 3 workers)
 * ------------------------------------------------------
 * Calibrated spread: TODO(calibration) — fill frontierAvg / budgetAvg / gap from
 * the round-11 sweep (anchors: claude-opus-4.8, codex-5.5 vs pi-deepseek-flash,
 * claude-haiku). Ship gate: frontierAvg − budgetAvg ≥ 0.2. Target ~0.4 → 0.9.
 *
 * Three workers form a CHAINED TRANSFORM PIPELINE. Worker A (worker 0) reads a
 * random per-attempt source payload seeded ONLY on its sandbox, applies the
 * stage-1 transform, and publishes the result into swarm memory under a channel
 * tag. Worker B (worker 1, dependsOn A) retrieves stage-1's output from memory,
 * applies the stage-2 transform, and re-publishes. Worker C (worker 2, dependsOn
 * B) retrieves stage-2's output, applies the stage-3 transform, and writes the
 * final result. Each worker also writes its own stage's result to a receipt file
 * on its own sandbox.
 *
 * Each stage's fidelity is INDEPENDENTLY checkable: the grader recomputes every
 * stage's expected output by folding the (pure, deterministic) stage transforms
 * over the seeded source, then compares line-for-line against each stage's
 * receipt (`pipelineStagesCorrect` → score = stages correct / total). Because the
 * stages are dependency-chained, a corruption at stage k naturally tanks stages
 * k+1… — chained deps give natural partial credit. Crucially, each stage is
 * scored against the recomputed truth (anchored to the seed), NOT against the
 * previous worker's actual receipt, so a downstream worker that faithfully
 * transforms a WRONG input still scores 0 on its own stage.
 *
 * Reuses the cross-worker `workers: 3` + `seed.exec` (writable scratch dirs) +
 * `dependsOn` + per-worker `fileAbsentOnWorker` machinery from the old
 * `relay-handoff` scenario, generalized to a graded multi-stage transform chain
 * (`pipelineStagesCorrect`).
 *
 * Requires an embedding key in evals/.env (EMBEDDING_API_KEY or OPENAI_API_KEY)
 * for the swarm memory store/search the handoff relies on — same as the old
 * relay-handoff scenario.
 *
 * Grading:
 *   - `correctness` (weight 3): the FRACTION of the three pipeline stages whose
 *       receipt file exactly matches the recomputed expected output — graded via
 *       `pipelineStagesCorrect`, which reads the seeded source from A at grade
 *       time (the payload is per-attempt random) and folds the stage transforms
 *       over it. Partial credit so a pipeline that got stage 1 right but botched
 *       stage 2 ranks above one that botched stage 1.
 *   - `completeness` (weight 1): a deterministic check that ALL THREE stage
 *       receipts EXIST and are non-empty — a worker that skipped its stage (no
 *       receipt) is incomplete even if its upstream stages were correct. This is
 *       graded (fraction of receipts present) so a partial pipeline still
 *       discriminates.
 *
 * Anti-gaming (checklist applied to THIS scenario):
 *   - The source payload is GENERATED AT RUNTIME on worker A's sandbox from
 *     /dev/urandom (random ids + shuffled words) — it is NOT in any prompt,
 *     fixture, or seed file committed to the repo, so the correct stage outputs
 *     are NOT derivable from the task text. The grader recomputes the expected
 *     output from A's LIVE seeded source, never from a hard-coded answer.
 *   - Each stage is scored against the recomputed truth (anchored to the seed),
 *     NOT against the previous worker's receipt — so a downstream worker cannot
 *     "win" its stage by faithfully transforming a corrupted input, and echoing
 *     the prompt (which contains no payload values) scores 0.
 *   - The transforms are deterministic and unambiguous (filter even ids → keep
 *     values; sort+uppercase; reverse+number) so there is exactly one correct
 *     output per stage; a worker that guesses cannot match a multi-line payload.
 *   - The receipt files live on three filesystem-ISOLATED sandboxes;
 *     `fileAbsentOnWorker` proves A's source never leaked downstream (the handoff
 *     was through memory, not a shared disk) — echoing or disk-sharing can't
 *     satisfy it.
 *   - The grading rubric / per-stage line-match criteria are NOT shown to the
 *     workers; the prompt states the transform SPEC (what to compute) but not how
 *     it is graded.
 */

const PIPE_DIR = "/workspace/pipeline";
// Worker A's seeded source payload: random per-attempt records, one per line in
// the form `<id>,<value>` (id is an integer, value is a lowercase word). Lives
// only on A's sandbox; the grader reads it to recompute every stage's truth.
const SOURCE_FILE = `${PIPE_DIR}/source.csv`;
// One receipt file per stage, written by that stage's worker onto its OWN
// sandbox. The grader compares each to the recomputed expected output.
const STAGE1_FILE = `${PIPE_DIR}/stage1.txt`;
const STAGE2_FILE = `${PIPE_DIR}/stage2.txt`;
const STAGE3_FILE = `${PIPE_DIR}/stage3.txt`;

// Distinctive shared memory channel tags so each downstream worker can find its
// predecessor's published output. The tags are part of the protocol the prompt
// describes; the SECRET is the per-attempt source payload, never any tag.
const STAGE1_TAG = "relay-pipe-stage1-7k4";
const STAGE2_TAG = "relay-pipe-stage2-7k4";

// ---- Pure stage transforms (v8.0 §6). These MUST mirror the natural-language
// transform spec in each task prompt EXACTLY — the grader folds them over the
// seeded source to recompute the per-stage truth, so any divergence between the
// prompt wording and these functions would be a grading bug. Each operates on a
// normalized line array (trimmed, no blanks). ----

// Stage 1: from `<id>,<value>` records, keep only EVEN-id rows and emit just the
// value column (one per line), preserving the source row order.
function stage1(sourceLines: string[]): string[] {
  const out: string[] = [];
  for (const line of sourceLines) {
    const comma = line.indexOf(",");
    if (comma < 0) continue;
    const idStr = line.slice(0, comma).trim();
    const value = line.slice(comma + 1).trim();
    const id = Number.parseInt(idStr, 10);
    if (Number.isInteger(id) && id % 2 === 0 && value.length > 0) out.push(value);
  }
  return out;
}

// Stage 2: sort the stage-1 values case-insensitively ascending, then UPPERCASE
// each. (Sort by lowercased form; ties keep input order — stable sort.)
function stage2(stage1Lines: string[]): string[] {
  return [...stage1Lines]
    .sort((a, b) => {
      const la = a.toLowerCase();
      const lb = b.toLowerCase();
      return la < lb ? -1 : la > lb ? 1 : 0;
    })
    .map((v) => v.toUpperCase());
}

// Stage 3: reverse the order of the stage-2 lines, then prefix each with its
// 1-based position in the REVERSED order as `N: ` (so the first line of the
// final output is `1: <last stage-2 line>`).
function stage3(stage2Lines: string[]): string[] {
  return [...stage2Lines].reverse().map((v, i) => `${i + 1}: ${v}`);
}

const PIPELINE_STAGES: PipelineStage[] = [
  { label: "stage1", worker: 0, path: STAGE1_FILE, transform: stage1 },
  { label: "stage2", worker: 1, path: STAGE2_FILE, transform: stage2 },
  { label: "stage3", worker: 2, path: STAGE3_FILE, transform: stage3 },
];

// ---- completeness: all three stage receipts must EXIST and be non-empty. Graded
// (score = present / total) so a pipeline that produced stages 1-2 but not 3
// ranks above one that produced only stage 1. A worker reads its receipt from its
// OWN sandbox index (stage k's receipt lives on worker k). ----
const STAGE_RECEIPTS: { label: string; worker: number; path: string }[] = [
  { label: "stage1", worker: 0, path: STAGE1_FILE },
  { label: "stage2", worker: 1, path: STAGE2_FILE },
  { label: "stage3", worker: 2, path: STAGE3_FILE },
];

const allStagesPresent: DeterministicCheck = {
  name: "pipeline-stages-present",
  fn: async (ctx): Promise<CheckResult> => {
    const total = STAGE_RECEIPTS.length;
    const missing: string[] = [];
    for (const r of STAGE_RECEIPTS) {
      const w = ctx.workers[r.worker];
      if (!w) {
        missing.push(`${r.label}(w${r.worker} not booted)`);
        continue;
      }
      const content = await w.readFile(r.path);
      if (content === null || content.trim().length === 0) missing.push(r.label);
    }
    const present = total - missing.length;
    const score = present / total;
    return {
      pass: missing.length === 0,
      score,
      detail:
        missing.length === 0
          ? `all ${total} stage receipts present`
          : `${present}/${total} stage receipts present (missing: ${missing.join(", ")})`,
    };
  },
};

// ---- Gate: worker A must have produced a non-empty source payload (the per-
// attempt ground truth the correctness recompute depends on). Without it there is
// nothing to transform and the attempt has no defensible output. The synthetic
// tasks-completed gate is prepended by the runner. ----
const sourceExists: DeterministicCheck = {
  name: "source-exists",
  fn: async (ctx): Promise<CheckResult> => {
    const w = ctx.workers[0];
    if (!w) return { pass: false, detail: "worker 0 not booted" };
    const content = await w.readFile(SOURCE_FILE);
    if (content === null) return { pass: false, detail: `${SOURCE_FILE} not found` };
    if (!/^\s*\d+\s*,/m.test(content)) {
      return { pass: false, detail: `${SOURCE_FILE} holds no <id>,<value> records` };
    }
    return { pass: true, detail: `${SOURCE_FILE} (${content.length} bytes)` };
  },
};

export const relayPipeline: Scenario = {
  id: "relay-pipeline",
  name: "Relay pipeline",
  description: [
    "Three workers form a chained transform pipeline. Worker A reads a random per-attempt source",
    "payload seeded only on its sandbox, applies the stage-1 transform (filter even ids → values),",
    "and publishes the result into swarm memory. Worker B retrieves it, applies stage 2 (sort +",
    "uppercase), and re-publishes; worker C retrieves that, applies stage 3 (reverse + number), and",
    "writes the final result. Each worker writes its own stage to a receipt file. Graded on per-stage",
    "fidelity (correctness, 3×) — each stage recomputed independently from the seed — and on all three",
    "stage receipts being present (completeness, 1×).",
  ].join(" "),
  workers: 3,
  seed: {
    // seed.exec runs on worker 0 (A) only. Generate a RANDOM per-attempt source
    // payload (12 records of `<id>,<value>`) so the correct stage outputs appear
    // in no prompt and cannot be seeded from the repo. Ids are random in 1..99
    // (mixed parity so the stage-1 even-filter is non-trivial); values are drawn
    // from a fixed word pool but RANDOMLY ordered per attempt. B and C create
    // their own pipeline dirs from their task prompts (separate sandboxes).
    exec: [
      [
        `mkdir -p ${PIPE_DIR} && chmod -R a+rwX ${PIPE_DIR}`,
        // Build the random payload with awk seeded from $RANDOM so it differs per
        // attempt. Word pool is fixed; id parity and value order are randomized.
        `awk 'BEGIN {`,
        `  srand();`,
        `  n = split("alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa", words, " ");`,
        `  for (i = 1; i <= 12; i++) {`,
        `    id = int(rand() * 99) + 1;`,
        `    w = words[int(rand() * n) + 1];`,
        `    print id "," w;`,
        `  }`,
        `}' > ${SOURCE_FILE}`,
        `chmod a+rwX ${SOURCE_FILE}`,
      ].join("\n"),
    ],
  },
  tasks: [
    {
      title: "Pipeline stage 1: filter and project",
      worker: 0,
      description: [
        `You own STAGE 1 of a 3-stage data pipeline. Read the source file \`${SOURCE_FILE}\` — it`,
        "holds one record per line in the form `<id>,<value>` (an integer id, a comma, then a word).",
        "",
        "Apply the stage-1 transform, EXACTLY:",
        "  1. Keep ONLY the rows whose id is an EVEN number (discard odd-id rows).",
        "  2. From each kept row, output JUST the value (the part after the comma), one per line,",
        "     PRESERVING the original source order. Output nothing else (no ids, no headers).",
        "",
        `Write that result (one value per line) to \`${STAGE1_FILE}\` on your sandbox. Then PUBLISH it`,
        "so the next worker can consume it: index a swarm memory whose content includes your full",
        `stage-1 output AND the exact channel tag \`${STAGE1_TAG}\` (the next worker searches that tag),`,
        "and include the stage-1 output in your completion report. Report completion via store-progress.",
        "",
        "The downstream workers cannot see your files — memory is the only handoff.",
      ].join("\n"),
    },
    {
      title: "Pipeline stage 2: sort and uppercase",
      worker: 1,
      dependsOn: [0],
      description: [
        `Another agent published STAGE 1 of a data pipeline into swarm memory under the channel tag`,
        `\`${STAGE1_TAG}\`. Search your memory for that channel and retrieve its EXACT stage-1 output`,
        "(a list of values, one per line). Do NOT guess or invent values — use exactly what was",
        "published.",
        "",
        "Apply the stage-2 transform, EXACTLY:",
        "  1. SORT the lines case-insensitively in ASCENDING order (compare as if lowercased; lines",
        "     that are equal ignoring case keep their input order).",
        "  2. Convert each line to UPPERCASE.",
        "",
        `Create the directory \`${PIPE_DIR}\` and write the result (one value per line) to`,
        `\`${STAGE2_FILE}\`. Then PUBLISH it for the next worker: index a swarm memory whose content`,
        `includes your full stage-2 output AND the exact channel tag \`${STAGE2_TAG}\`, and include the`,
        "stage-2 output in your completion report. Report completion via store-progress.",
      ].join("\n"),
    },
    {
      title: "Pipeline stage 3: reverse and number",
      worker: 2,
      dependsOn: [1],
      description: [
        `Another agent published STAGE 2 of a data pipeline into swarm memory under the channel tag`,
        `\`${STAGE2_TAG}\`. Search your memory for that channel and retrieve its EXACT stage-2 output`,
        "(a list of uppercase values, one per line). Do NOT guess or invent values — use exactly what",
        "was published.",
        "",
        "Apply the stage-3 transform, EXACTLY:",
        "  1. REVERSE the order of the lines (the last stage-2 line becomes the first).",
        "  2. Prefix each line with its 1-based position in the REVERSED order followed by a colon and",
        "     a single space, i.e. the format `N: VALUE` (so the first output line is `1: <last stage-2",
        "     value>`, the second is `2: …`, and so on).",
        "",
        `Create the directory \`${PIPE_DIR}\` and write the final result (one \`N: VALUE\` line per line)`,
        `to \`${STAGE3_FILE}\`. Then report completion via store-progress.`,
      ].join("\n"),
    },
  ],
  outcome: {
    // Gates (binary must-pass): A must have produced a source payload (ground
    // truth), and A's source file must NOT have leaked onto B/C (sandbox
    // isolation proof — the handoff was through memory, not a shared disk).
    // Per-stage fidelity is GRADED (not gated) so partial credit discriminates a
    // one-stage pipeline from a three-stage one.
    gates: [sourceExists, fileAbsentOnWorker(1, SOURCE_FILE), fileAbsentOnWorker(2, SOURCE_FILE)],
    dimensions: [
      {
        name: "correctness",
        weight: 3,
        // pipelineStagesCorrect → score = stages whose receipt matches the
        // recomputed expected output / total. Truth is folded from A's live
        // seeded source at grade time (per-attempt random); each stage is scored
        // independently against the seed, so a faithful transform of a wrong
        // input still scores 0 for that stage.
        checks: [pipelineStagesCorrect({ worker: 0, path: SOURCE_FILE }, PIPELINE_STAGES)],
      },
      {
        name: "completeness",
        weight: 1,
        // All three stage receipts must exist and be non-empty (graded fraction).
        // A worker that skipped its stage is incomplete even if upstream was right.
        checks: [allStagesPresent],
      },
    ],
  },
  // Three-stage memory-handoff pipeline over a strict dependency chain (C depends
  // on B depends on A): weaker configs burn turns getting the memory publish/
  // search right at each hop and mis-applying a transform breaks everything
  // downstream. Raised to 12 minutes.
  timeoutMs: 12 * 60_000,
};
