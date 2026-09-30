/**
 * Scenario cards: what each scenario claims to test, in plain English.
 *
 * The Scenarios page renders these. They live here, apart from each scenario
 * module, on purpose: `src/scenario-hash.ts` hashes a scenario's source file, so
 * a sentence added to `sql-audit.ts` would demand a `version` bump, move the
 * scenario out of the frozen suite manifest, and orphan every recorded attempt.
 * A card describes the scenario to humans; it never reaches an agent or a grader.
 *
 * Rules (`src/registry.test.ts` enforces them):
 *   - every registered scenario has exactly one card, and no card is orphaned;
 *   - `topology` matches the roster (a lead or more than one worker is `swarm`);
 *   - `changelog` has one entry per pinned version in `scenario-hashes.ts`, so a
 *     version bump that skips the card fails. The long-form record stays in
 *     `CHANGELOG.md`; the card carries a single line per version.
 *
 * Write for someone who has not read the code: name what the agent is asked to
 * do, what earns points, and what does not.
 */

/** How many agents the scenario needs. `swarm` = a lead, or more than one worker. */
export type ScenarioTopology = "single-agent" | "swarm";

/**
 * How the work is arranged. `parallel`: several agents work at the same time.
 * `sequential`: one step feeds the next, or one agent works through the task.
 */
export type ScenarioFlow = "parallel" | "sequential";

/**
 * Why it is in the suite. `regression`: an agent that works should pass it every
 * time, so a drop means something broke. `capability`: hard enough to separate
 * setups, so failures are expected and the score has headroom.
 */
export type ScenarioKind = "regression" | "capability";

export interface ScenarioTags {
  topology: ScenarioTopology;
  flow: ScenarioFlow;
  kind: ScenarioKind;
}

export interface ScenarioChangelogEntry {
  /** The scenario `version` this line describes. */
  version: number;
  note: string;
}

export interface ScenarioCard {
  /** What the scenario claims to test, in one sentence. */
  summary: string;
  /** What the agent is asked to do. */
  agentDoes: string;
  /** What earns points and what gates a pass, in plain words. */
  scoredBy: string;
  tags: ScenarioTags;
  /** Oldest first. */
  changelog: ScenarioChangelogEntry[];
}

export const SCENARIO_CARDS: Readonly<Record<string, ScenarioCard>> = {
  "sql-audit": {
    summary:
      "Can one agent read a messy task history through the swarm API and report three correct facts from it?",
    agentDoes:
      "Reads 20 seeded historical tasks (completed, failed and cancelled, with near-miss decoys). Answers three questions: how many tasks completed, which completed task had the highest priority, and which task's output claims success although its status says otherwise. Writes each answer to its own file and adds a short report.",
    scoredBy:
      "The report file must exist. Correctness (weight 3): each of the three answer files is compared with the answer key, so partial credit is possible. Communication (weight 1): a judge reads the report and asks whether it states the answers and justifies them from the data. Pass at 0.75.",
    tags: { topology: "single-agent", flow: "sequential", kind: "regression" },
    changelog: [
      {
        version: 1,
        note: "First frozen version. The fixture holds 20 rows so the whole history fits one API page (Phase 2).",
      },
    ],
  },
  "delegation-probe": {
    summary: "Does a lead hand the work to its workers when told to, instead of doing it itself?",
    agentDoes:
      "The lead gets one audit job over a seeded 20-task history and is told to delegate it to its two researcher workers and not to query the tasks API itself. The workers query the data and report back. The lead merges both reports into one.",
    scoredBy:
      "No judge. Delegation (weight 5): child tasks were created, the workers completed them, the report's facts trace back to worker output, and the lead did not run the queries itself. A lead that audits alone scores zero here even with a correct report. Correctness (weight 2): the merged answers match the answer key. The merged report must exist. Pass at 0.75.",
    tags: { topology: "swarm", flow: "parallel", kind: "regression" },
    changelog: [{ version: 1, note: "First frozen version." }],
  },
  "workflow-authoring": {
    summary:
      "Can an agent build a working multi-step workflow with the swarm's workflow tool, reusing a catalog script?",
    agentDoes:
      "Creates one deterministic pull-request review workflow: it takes a webhook payload, runs a reusable swarm script from the catalog for the lint step, passes that result into an agent step through an explicit input mapping with a structured JSON output, and ends with a summary step. It must declare a trigger schema using only supported keywords.",
    scoredBy:
      "No judge. The saved workflow is read back and checked. Exactly one workflow must exist. Graph shape (weight 4): at least three connected nodes, a reusable swarm-script node instead of inline code, an agent node with a structured-output schema, and every value read from an earlier node mapped in its inputs. Trigger schema (weight 2): present, only supported keywords, and it covers the repository and pull-request fields. Correctness (weight 1): the rest of the authoring contract. Pass at 0.9, so a missing reusable script node cannot hide behind the other points.",
    tags: { topology: "single-agent", flow: "sequential", kind: "regression" },
    changelog: [
      {
        version: 1,
        note: "First frozen version. A seeded pr-checks script and a 0.9 pass line (Phase 2).",
      },
    ],
  },
  "script-authoring": {
    summary:
      "Can an agent write, save and run a reusable typed swarm script through the swarm tools?",
    agentDoes:
      "Saves one agent-scoped TypeScript script that fetches task details through the swarm SDK and returns the total count, the completion rate and the title of the highest-priority completed task. It then runs the script at least once on real task ids and reports the output. Raw fetch, curl and API keys are off limits.",
    scoredBy:
      "No judge. Exactly one script must be saved and type-check. Script behavior (weight 4): it reads tasks through the SDK, takes arguments, avoids raw fetch, curl and API keys, and was actually run. Correctness (weight 2): a successful run returned a total, a completion rate and a top-priority title. Reusability (weight 1): it was run by name more than once, with no raw API workarounds. Pass at 0.75.",
    tags: { topology: "single-agent", flow: "sequential", kind: "regression" },
    changelog: [
      {
        version: 1,
        note: "First frozen version. The script-created and script-run-output checks were fixed (Phase 1).",
      },
    ],
  },
  "delegation-chain": {
    summary:
      "Can a lead run a three-step chain where each worker task waits for the one before it?",
    agentDoes:
      "The lead must not read the task history itself. It creates three worker tasks linked with dependsOn: the first counts completed tasks, the second finds the highest-priority completed task, the third looks for the planted anomaly. It merges the three outputs into one final report.",
    scoredBy:
      "No judge. The final report must exist. Chain (weight 5): three child tasks in one strict line, each depending on the last, with real work done. Dispatch (weight 3): each hop went to the right worker with the right topic. Correctness (weight 2): the final answers match the answer key. Pass at 0.75.",
    tags: { topology: "swarm", flow: "sequential", kind: "regression" },
    changelog: [
      {
        version: 1,
        note: "First frozen version. The chain check ordered a correct chain wrongly for 3 of the 6 orders the API can list tasks in.",
      },
      {
        version: 2,
        note: "Children are ordered by dependency depth, not by listing order. A correct run now scores 1.000 where it scored 0.743.",
      },
    ],
  },
  "tool-routing": {
    summary:
      "Does an agent find the handoff rules in swarm memory and carry the right facts through the swarm's own tools?",
    agentDoes:
      "Reads two seeded memory notes that describe a project handoff, reads the seeded task history through swarm tools, stores a checkpoint in KV under the exact key the notes name, and creates one follow-up task that names the top completed task. It ends with a JSON summary. Raw API calls and db-query are off limits.",
    scoredBy:
      "The final output must be present and valid JSON with the requested fields (both are gates). Tool selection (weight 5): it used the swarm MCP tools for memory, KV, tasks and progress. Dispatch order (weight 2): the steps happened in a sensible order, and partial order earns partial credit. Correctness (weight 4): the checkpoint and the follow-up task hold the right facts. Pass at 0.75.",
    tags: { topology: "single-agent", flow: "sequential", kind: "capability" },
    changelog: [
      {
        version: 1,
        note: "First frozen version. Structured-output gate and partial hop order (Phase 2).",
      },
    ],
  },
  "fanout-research": {
    summary:
      "Can a lead split one analysis across three workers in parallel and merge their answers without redoing the work?",
    agentDoes:
      "The API holds 45 incident postmortems in three region shards (emea 17, amer 15, apac 13). The lead fans the review out to three researchers, one region each, in parallel, then merges the shard reports into one incident review.",
    scoredBy:
      "The report must exist. Delegation (weight 5), from the task tree: one shard per worker, no shard done twice, shard tasks created before the first one finished, and report facts that trace back to worker output. A lead that queries the records itself scores zero here. Correctness (weight 3): the merged answers match the answer key. Communication (weight 1): a judge grades the report. Efficiency (weight 1): cost and time against the budget. Pass at 0.75.",
    tags: { topology: "swarm", flow: "parallel", kind: "capability" },
    changelog: [{ version: 1, note: "Added in Phase 7 with a single-agent baseline." }],
  },
  "fanout-research-solo": {
    summary:
      "What does one agent score on the fan-out brief? The baseline that shows what the swarm adds.",
    agentDoes:
      "The same incident review and answer key as fanout-research, with one worker and no lead, under the same timeout and budgets.",
    scoredBy:
      "The swarm scenario's outcome dimensions only: correctness (weight 3), communication (weight 1, judge) and efficiency (weight 1). There is no delegation dimension, because there is nobody to delegate to. Pass at 0.75.",
    tags: { topology: "single-agent", flow: "sequential", kind: "capability" },
    changelog: [{ version: 1, note: "Baseline of fanout-research (Phase 7, plan Q6)." }],
  },
  "worker-recovery": {
    summary: "When one worker's data is bad, does the lead notice and route around it?",
    agentDoes:
      "The lead splits a 24-row ledger across two clerks, one batch each. Clerk 2's copy is poisoned at seed time: every amount is multiplied by 7 under a healthy-looking header. The lead has to notice the failed or wrong batch, hand it to the healthy clerk, and keep the poisoned numbers out of its summary.",
    scoredBy:
      "The summary must exist. Recovery (weight 5), from the task tree: both batches were computed by the healthy clerk, the re-dispatch came after the failure, and no poisoned number appears on an answer line. Correctness (weight 3): the totals match the answer key. Communication (weight 1): a judge grades the summary. Efficiency (weight 1): cost and time against the budget. Pass at 0.75.",
    tags: { topology: "swarm", flow: "parallel", kind: "capability" },
    changelog: [{ version: 1, note: "Added in Phase 7 with a single-agent baseline." }],
  },
  "worker-recovery-solo": {
    summary:
      "What does one agent score on the ledger brief? The baseline that shows what the swarm adds.",
    agentDoes:
      "The same ledger summary and answer key as worker-recovery, with one worker and no lead, under the same timeout and budgets.",
    scoredBy:
      "The swarm scenario's outcome dimensions only: correctness (weight 3), communication (weight 1, judge) and efficiency (weight 1). There is no recovery dimension, because there is no second worker to recover from. Pass at 0.75.",
    tags: { topology: "single-agent", flow: "sequential", kind: "capability" },
    changelog: [{ version: 1, note: "Baseline of worker-recovery (Phase 7, plan Q6)." }],
  },
};

/** The card for a scenario id, or null for one that was never registered (historical runs). */
export function scenarioCard(id: string): ScenarioCard | null {
  return SCENARIO_CARDS[id] ?? null;
}
