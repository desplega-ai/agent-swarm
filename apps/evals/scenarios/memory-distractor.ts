import type { GradedFact } from "../src/judge/deterministic.ts";
import { factsRecalled, fileContains } from "../src/judge/deterministic.ts";
import type { Scenario } from "../src/types.ts";

/**
 * memory-distractor (v8.0 round-11, Memory, 1 worker)
 * ---------------------------------------------------
 * Calibrated spread: TODO(calibration) — fill frontierAvg / budgetAvg / gap from
 * the round-11 sweep (anchors: claude-opus-4.8, codex-5.6-sol vs pi-deepseek-flash,
 * claude-haiku). Ship gate: frontierAvg − budgetAvg ≥ 0.2. Target ~0.3 → 0.85.
 *
 * Three swarm-scope memories carrying the canonical deploy config for the
 * fictional internal service "Halberd" are indexed into the freshly booted stack
 * BEFORE the task starts. The task prompt then states a set of plausible-but-WRONG
 * "common defaults" for those same fields, and asks the worker to record the
 * ACTUAL canonical config. The worker must SEARCH MEMORY to find the real values;
 * a config that trusts the prompt's defaults (or guesses generic conventions)
 * writes the distractor values and scores 0 on the per-fact checks.
 *
 * HARDENING (round 11, post-saturation sweep): budget models tied frontier at
 * 1.00 on the original 3-fact answer key — the three "headline" facts (host /
 * port / rollout) sit one-per-memory and surface on a single shallow lookup, and
 * the distractors were far enough from the truth that the trap was trivial. To
 * make graded correctness DISCRIMINATE again, the answer key is deepened to SEVEN
 * facts WITHOUT adding a fourth memory (the registry test pins the memory count
 * at 3): each of the three memories now carries TWO canonical fields (a headline
 * plus a secondary detail buried later in the same sentence), and a SEVENTH fact
 * is cross-referential — its correct value only emerges by combining the host
 * memory and the rollout memory, so a model that does one shallow search and
 * stops misses it. Every distractor in the prompt is also tightened to sit one
 * token away from the truth (a near-miss host, an adjacent port, a same-family
 * rollout, a conventional percentage), so trusting the prompt is more tempting
 * and a half-read of memory lands on the wrong value. `score = matched / 7`, so a
 * budget model that recalls the 3 obvious headline facts but misses the buried
 * secondaries and the cross-reference now scores ≈0.43 where it used to score
 * 1.00, while a frontier model that reads all three memories end-to-end keeps ≈1.
 *
 * Reuses the `seed.memories` + per-fact graded-recall machinery from the old
 * `memory-seeded-recall` scenario, upgraded to a GRADED multi-fact answer key
 * (`factsRecalled` → partial credit) plus a custom agentic `retrieval-fidelity`
 * dimension that verifies the worker actually retrieved-not-guessed.
 *
 * Grading:
 *   - `correctness` (weight 3): SEVEN answer-key facts in the recall file —
 *       host, region, port, health-check path, rollout strategy, canary
 *       percentage, and the cross-referential canary cohort host — each its own
 *       pattern. Partial credit (`score = matched/7`) so recalling the 3 obvious
 *       headline facts ranks BELOW recalling all 7.
 *   - `retrieval-fidelity` (weight 1, custom, agentic — depends on Phase 4): a
 *       judge inspects the worker's session transcript + sandbox to confirm the
 *       values came from a MEMORY SEARCH, not from the prompt's distractor
 *       defaults or a generic guess. Penalizes writing the wrong (distractor)
 *       values and rewards visible memory-retrieval behavior.
 *
 * Anti-gaming (checklist applied to THIS scenario):
 *   - The prompt's "common defaults" are GENUINELY PLAUSIBLE near-misses — the
 *     kind of conventional values a model would guess, each ONE token off the
 *     truth — but every one of them is WRONG. Echoing the prompt scores 0 on the
 *     per-fact checks it touches.
 *   - The ground-truth values are NOT derivable from the prompt or from generic
 *     deploy conventions — the only source is the seeded memory. The cross-
 *     referential fact (canary cohort host) is not even stated atomically in ANY
 *     single memory: it must be ASSEMBLED from two.
 *   - The answer-key VALUES appear NOWHERE in the task text (only the WRONG
 *     near-miss distractors do), so a guess or a prompt-echo can't satisfy the
 *     checks.
 *   - The grading rubric / check patterns are NOT shown to the worker.
 *   - The agentic retrieval-fidelity judge cross-checks the sandbox/transcript so
 *     a config that happened to land a correct value by coincidence (without
 *     searching memory) is not rewarded on the fidelity dimension.
 *
 * Answer key (mirror of the seeded memories below — keep them in lockstep):
 *   host            = halberd-prod-3.svc.internal
 *   region          = eu-central-1b               (buried in the host memory)
 *   port            = 7711
 *   health path     = /halberd/livez              (buried in the port memory)
 *   rollout         = canary (start at 5% of traffic)
 *   canary percent  = 5%
 *   canary cohort   = halberd-canary-3.svc.internal  (CROSS-REF: the canary
 *                     memory says the canary cohort reuses the prod host's index
 *                     suffix on the `-canary-` family; the host memory supplies
 *                     that suffix `-3` → only the two together yield this value)
 * Distractors embedded in the prompt (all WRONG, all near-misses):
 *   host            = halberd.internal            (drops the prod-3 fqdn)
 *   region          = eu-west-1a                  (wrong region)
 *   port            = 8080                         (the retired framework default)
 *   health path     = /healthz                     (the generic convention)
 *   rollout         = blue-green                   (same family, retired)
 *   canary percent  = 10%                          (a conventional first-step %)
 *   canary cohort   = halberd-staging.svc.internal (a wrong host; also keeps the
 *                     secret word "canary" out of the prompt)
 */

const RECALL_FILE = "/workspace/halberd/deploy-config.txt";

// Ground-truth seeded memories. EXACTLY THREE (the registry test pins the count),
// but each now carries TWO canonical fields: a headline value plus a secondary
// detail tucked later in the same passage, so a shallow lookup that grabs only
// the first/obvious value misses the buried one. The third memory additionally
// encodes the CROSS-REFERENCE rule for the canary cohort host (its `-canary-N`
// suffix is defined in terms of the prod host's index from the first memory),
// which is unrecoverable without also reading memory #1. The values are
// deliberately specific so none can be guessed from convention.
const SEEDED_MEMORIES: string[] = [
  // Memory 1 — host (headline) + region (secondary, buried mid-sentence).
  "The canonical production deploy host for the internal Halberd service is halberd-prod-3.svc.internal, pinned to the eu-central-1b availability zone. This is the platform team's authoritative deploy target; earlier hosts (halberd-prod-1, halberd-prod-2) and the old eu-west-1a region were decommissioned, and the `-3` index is the live one.",
  // Memory 2 — port (headline) + health-check path (secondary, buried).
  "Halberd's production service listens on port 7711 — NOT the framework default. The port was moved off 8080 during the security hardening migration, and the load-balancer liveness probe was moved with it: the only correct health-check path is /halberd/livez (the generic /healthz route was disabled). 7711 + /halberd/livez are now the only correct values.",
  // Memory 3 — rollout (headline) + canary % (secondary) + the cross-reference
  // rule that defines the canary cohort host from the prod host's index suffix.
  "Halberd production rollouts use a CANARY strategy: route 5% of traffic to the new revision first, watch error rates, then ramp. Blue-green was explicitly retired for Halberd after the last incident. The canary cohort runs on a dedicated host that mirrors the production deploy host but on the `-canary-` family, REUSING the production host's numeric index suffix (so it is halberd-canary-<that index>.svc.internal).",
];

// ---- Answer-key facts, graded individually (partial credit). Each pattern is
// anchored on the distinctive, prompt-absent ground-truth value so the WRONG
// near-miss distractors never match. Seven facts → `score = matched/7`, so the
// per-fact denominator is fine-grained enough to separate a 3-of-7 shallow
// recall from a 7-of-7 thorough one. ----
const FACTS: GradedFact[] = [
  // 1. Host: must be the prod-3 fqdn. The distractor `halberd.internal` lacks the
  //    `-prod-3` segment, so this pattern rejects it.
  { label: "host", pattern: /halberd-prod-3\.svc\.internal/i },
  // 2. Region/AZ: buried in the host memory. The distractor `eu-west-1a` (a
  //    plausible alternate region, also named in the memory as DECOMMISSIONED)
  //    does not match — only `eu-central-1b` does.
  { label: "region", pattern: /eu-central-1b/i },
  // 3. Port: must be 7711 (anchored so 8080 / 17711 / 77110 don't satisfy it).
  { label: "port", pattern: /\b7711\b/ },
  // 4. Health-check path: buried in the port memory. The distractor `/healthz`
  //    (the generic convention) does not match — only the Halberd-specific
  //    `/halberd/livez` does. Anchored on `/livez` so a bare `/healthz` fails.
  { label: "health-path", pattern: /\/halberd\/livez\b/i },
  // 5. Rollout: must name the canary strategy. The distractor is "blue-green",
  //    which this pattern does not match.
  { label: "rollout", pattern: /canary/i },
  // 6. Canary percentage: the secondary numeric in the rollout memory. The
  //    distractor `10%` (a conventional first canary step) does not match — only
  //    5% does. Anchored to reject `15%`, `50%`, `0.5%`.
  { label: "canary-percent", pattern: /\b5\s*%/ },
  // 7. CROSS-REFERENCE: the canary cohort host. Stated atomically in NO single
  //    memory — memory #3 gives the `-canary-<index>` template, memory #1 gives
  //    the index `3`. Only a model that read BOTH and assembled them writes the
  //    full `halberd-canary-3.svc.internal`. The prompt distractor
  //    `halberd-staging.svc.internal` (a different host that also avoids leaking
  //    the secret word "canary" into the prompt) does not match.
  { label: "canary-cohort", pattern: /halberd-canary-3\.svc\.internal/i },
];

export const memoryDistractor: Scenario = {
  id: "memory-distractor",
  name: "Memory distractor",
  description: [
    "Seeds three swarm-scope memories carrying the canonical Halberd deploy config (host, region,",
    "port, health-check path, rollout strategy, initial rollout percentage, and a cross-referential",
    "first-cohort host) before the task starts. The task prompt then states plausible-but-WRONG",
    "'common defaults' for the same fields — each a near-miss one token off the truth — and asks the",
    "worker to record the ACTUAL config. The real values live only in memory, and one of them must",
    "be assembled from two separate memories, so the worker must search memory thoroughly rather",
    "than trust the prompt's defaults or guess conventions. Graded on per-fact recall correctness",
    "(3×, seven facts) and an agentic retrieval-fidelity judge (1×) that confirms the values were",
    "retrieved, not guessed.",
  ].join(" "),
  seed: {
    memories: SEEDED_MEMORIES,
  },
  tasks: [
    {
      title: "Record the canonical Halberd deploy config",
      description: [
        "You are setting up a deploy for the internal service `Halberd`. Common defaults you may",
        "have seen elsewhere are: host `halberd.internal` in region `eu-west-1a`, port `8080`, a",
        "health-check path of `/healthz`, a `blue-green` rollout strategy stepping `10%` of traffic",
        "first, and a first-cohort rollout host of `halberd-staging.svc.internal`. HOWEVER, the",
        "platform team recorded Halberd's actual canonical config earlier, and EVERY one of those",
        "defaults is wrong — each differs from the real value. Do NOT assume the defaults are correct.",
        "",
        "Search your memory for the authoritative Halberd deploy configuration (do not guess and do",
        "not copy the defaults above). The real config is spread across more than one memory, and one",
        "field can only be determined by combining two of them — read them all before answering. Then",
        "create the `/workspace/halberd/` directory and write the ACTUAL config you retrieved to",
        `\`${RECALL_FILE}\` as seven labelled lines:`,
        "",
        "  host: <the canonical deploy host>",
        "  region: <the canonical availability zone / region>",
        "  port: <the canonical port>",
        "  health-path: <the canonical health-check path>",
        "  rollout: <the canonical rollout strategy>",
        "  rollout-percent: <the initial traffic percentage for the first rollout step>",
        "  rollout-cohort: <the canonical host that the first rollout cohort runs on>",
        "",
        "Use the real values from memory, not the defaults listed above. Then report completion via",
        "store-progress.",
      ].join("\n"),
    },
  ],
  outcome: {
    // Gate (binary must-pass): the recall file must exist, proving the worker
    // produced the required output surface. Per-FACT correctness is graded (not
    // gated) so partial credit discriminates a 3-of-7 recall from a 7-of-7 one.
    gates: [fileContains(RECALL_FILE)],
    dimensions: [
      {
        name: "correctness",
        weight: 3,
        // factsRecalled → score = matched/7. The seven facts are the canonical
        // host, region, port, health path, rollout strategy, canary percentage,
        // and the cross-referential canary cohort host; each WRONG near-miss
        // distractor value fails its pattern, so a prompt-echo scores 0 and a
        // shallow 3-fact recall scores ≈0.43.
        checks: [factsRecalled(RECALL_FILE, FACTS)],
      },
      {
        name: "retrieval-fidelity",
        weight: 1,
        // Custom dimension (allowed by design). Agentic so the judge can read the
        // session transcript AND the sandbox to confirm the worker actually
        // searched memory rather than echoing the prompt's distractor defaults.
        judge: {
          rubric: [
            "Score 0-1 on whether the worker obtained the Halberd deploy config by RETRIEVING IT",
            "FROM MEMORY, as opposed to guessing or copying the WRONG defaults stated in the task",
            `prompt (host \`halberd.internal\`, region \`eu-west-1a\`, port \`8080\`, health \`/healthz\`,`,
            `rollout \`blue-green\`, canary \`10%\`, cohort \`halberd-canary.svc.internal\`). Read the`,
            `recall file at ${RECALL_FILE} (via read_file) and inspect the worker's behavior. Evidence`,
            "of genuine retrieval: the transcript shows a memory search/lookup before the file was",
            "written, and the recorded values are the canonical ones (a prod-3 host, an eu-central",
            "zone, a non-8080 port, a halberd-specific health path, a canary rollout) — NOT the",
            "prompt's defaults. Score HIGH (≈1) when the file holds the canonical values and there is",
            "visible memory-retrieval behavior. Score LOW (≈0) when the file holds the prompt's",
            "distractor defaults, when the values look guessed with no memory lookup, or when the file",
            "is missing/empty. Do NOT re-grade exact correctness here (a separate deterministic check",
            "does that) — grade only whether the worker RETRIEVED rather than GUESSED. Do not reward",
            "length.",
          ].join(" "),
          agentic: true,
          maxSteps: 8,
        },
      },
    ],
  },
  // Single memory-retrieval task: searching memory + writing the file is light,
  // but weaker configs burn turns second-guessing the near-miss distractor
  // defaults and rarely read all three memories to assemble the cross-reference.
  // Raised to 8 minutes (matching the old memory-seeded-recall budget).
  timeoutMs: 8 * 60_000,
};
