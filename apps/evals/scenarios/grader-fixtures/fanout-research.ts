import { fanoutResearch, fanoutResearchSolo } from "../fanout-research.ts";
import {
  type GraderFixture,
  makeContext,
  nullTasks,
  toolCallRows,
} from "../grader-validation-support.ts";

/**
 * Reference: a lead that fans out. It sends one region to each researcher in
 * three back-to-back send-task calls (all created before the first finishes),
 * never queries the incident records itself, reads the three shard reports and
 * merges them into /workspace/research/incident-review.md on its own sandbox
 * (roster index 3). Answer key (fixtures/fanout-research-history.sql): emea 17
 * incidents / 682 min, amer 15 / 641, apac 13 / 709; 45 incidents, 2032 min;
 * most common root cause overall dependency-failure (13); longest incident
 * INC-3301 tokyo-edge-cache (184 min).
 *
 * The solo reference is one worker doing the same research and writing the same
 * review on its own sandbox (index 0). Runtime-spawned ids avoid the `task-`
 * prefix: only `task-0` is an upfront task.
 */

const LEAD = "lead";
const REPORT_FILE = "/workspace/research/incident-review.md";

const REVIEW = [
  "# Incident review",
  "",
  "emea: 17 incidents, 682 downtime minutes",
  "  cert-expiry 6, dependency-failure 4, config-drift 3, capacity 2, bad-deploy 2",
  "amer: 15 incidents, 641 downtime minutes",
  "  config-drift 6, dependency-failure 5, bad-deploy 2, cert-expiry 1, capacity 1",
  "apac: 13 incidents, 709 downtime minutes",
  "  capacity 5, dependency-failure 4, bad-deploy 2, config-drift 1, cert-expiry 1",
  "",
  "## Summary",
  "Total incidents: 45",
  "Total downtime minutes: 2032",
  "Most common root cause overall: dependency-failure",
  "Longest incident: INC-3301: tokyo-edge-cache capacity exhaustion",
].join("\n");

const SHARD_RESULTS = {
  emea: "emea: 17 incidents, 682 downtime minutes. cert-expiry 6, dependency-failure 4, config-drift 3, capacity 2, bad-deploy 2. Longest: INC-2105 dublin-cdn (64 min).",
  amer: "amer: 15 incidents, 641 downtime minutes. config-drift 6, dependency-failure 5, bad-deploy 2, cert-expiry 1, capacity 1. Longest: INC-2415 reporting-etl (71 min).",
  apac: "apac: 13 incidents, 709 downtime minutes. capacity 5, dependency-failure 4, bad-deploy 2, config-drift 1, cert-expiry 1. Longest: INC-3301 tokyo-edge-cache (184 min).",
} as const;

const T0 = Date.UTC(2026, 8, 30, 10, 0, 0);
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

function child(region: keyof typeof SHARD_RESULTS, worker: number) {
  return {
    id: `child-${region}`,
    title: `Research the ${region} incidents`,
    description: `Report the ${region} incident count, downtime, per-cause counts and longest incident.`,
    status: "completed",
    agentId: `worker-${worker}`,
    creatorAgentId: LEAD,
    parentTaskId: "task-0",
    result: SHARD_RESULTS[region],
    createdAt: at(10 + worker),
    finishedAt: at(200 + worker * 20),
    origin: "run" as const,
  };
}

const [leadSeed] = nullTasks(fanoutResearch);
const [soloSeed] = nullTasks(fanoutResearchSolo);

export const fixture: GraderFixture = {
  reference: () =>
    makeContext(fanoutResearch, {
      tasks: [
        {
          ...(leadSeed as NonNullable<typeof leadSeed>),
          agentId: LEAD,
          result: `Fanned out to three researchers and merged their reports into ${REPORT_FILE}.`,
        },
        child("emea", 0),
        child("amer", 1),
        child("apac", 2),
      ],
      files: { [`w3:${REPORT_FILE}`]: REVIEW },
      logs: {
        "task-0": [
          ...(["emea", "amer", "apac"] as const).flatMap((region, i) =>
            toolCallRows(
              "task-0",
              "mcp__agent-swarm__send-task",
              { task: `Research the ${region} incidents only.`, agentId: `worker-${i}` },
              { success: true, task: { id: `child-${region}` } },
              `toolu_send_${region}`,
            ),
          ),
          ...toolCallRows(
            "task-0",
            "mcp__agent-swarm__get-tasks",
            { mineOnly: false, includeFull: true },
            { tasks: [] },
            "toolu_read_children",
          ),
          ...toolCallRows(
            "task-0",
            "Write",
            { file_path: REPORT_FILE, content: REVIEW },
            "File created successfully",
            "toolu_write_review",
          ),
        ],
      },
    }),
};

export const soloFixture: GraderFixture = {
  reference: () =>
    makeContext(fanoutResearchSolo, {
      tasks: [
        {
          ...(soloSeed as NonNullable<typeof soloSeed>),
          agentId: "worker-0",
          result: `Wrote the incident review to ${REPORT_FILE}.`,
        },
      ],
      files: { [`w0:${REPORT_FILE}`]: REVIEW },
    }),
};

export const __test__ = { REVIEW, SHARD_RESULTS, child, LEAD, REPORT_FILE };
