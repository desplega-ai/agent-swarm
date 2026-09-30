import {
  type GraderFixture,
  makeContext,
  nullTasks,
  toolCallRows,
} from "../grader-validation-support.ts";
import { __test__ as key, workerRecovery, workerRecoverySolo } from "../worker-recovery.ts";

/**
 * Reference: a lead that recovers. It sends `north` to clerk-1 (healthy) and
 * `south` to clerk-2 (poisoned) at the same time, telling both to run the
 * integrity check first. clerk-2's check fails and it fails its task with no
 * numbers; the lead re-dispatches `south` to clerk-1 and merges the two verified
 * batch reports into /workspace/ledger/summary.md on its own sandbox (index 2).
 * Answer key is derived from the scenario's ROWS (see worker-recovery.ts).
 *
 * The solo reference is one clerk with the healthy copy doing both batches.
 */

const LEAD = "lead";
const { TRUE_TOTALS, GRAND_TOTAL, TOP_ACCOUNT, REPORT_FILE } = key;

const SUMMARY = [
  "# Ledger summary",
  "",
  `north: 12 rows, total amount ${TRUE_TOTALS.north}`,
  `south: 12 rows, total amount ${TRUE_TOTALS.south}`,
  `Grand total amount: ${GRAND_TOTAL}`,
  `Top account: ${TOP_ACCOUNT}`,
  "",
  "clerk-2's copy failed the integrity check, so south was recomputed by clerk-1, whose copy passed.",
].join("\n");

const T0 = Date.UTC(2026, 8, 30, 10, 0, 0);
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

function child(
  id: string,
  worker: number,
  status: string,
  result: string,
  createdAt: number,
  finishedAt: number,
) {
  return {
    id,
    title: `Ledger batch (${id})`,
    description:
      "Verify your ledger copy, then report the batch's rows, total and per-account totals.",
    status,
    agentId: `worker-${worker}`,
    creatorAgentId: LEAD,
    parentTaskId: "task-0",
    result,
    createdAt: at(createdAt),
    finishedAt: at(finishedAt),
    origin: "run" as const,
  };
}

const [leadSeed] = nullTasks(workerRecovery);
const [soloSeed] = nullTasks(workerRecoverySolo);

export const fixture: GraderFixture = {
  reference: () =>
    makeContext(workerRecovery, {
      tasks: [
        {
          ...(leadSeed as NonNullable<typeof leadSeed>),
          agentId: LEAD,
          result: `clerk-2's copy was corrupt; south re-dispatched to clerk-1. Summary in ${REPORT_FILE}.`,
        },
        child(
          "child-north",
          0,
          "completed",
          `Integrity OK. north: 12 rows, total amount ${TRUE_TOTALS.north}.`,
          10,
          120,
        ),
        child("child-south-1", 1, "failed", "", 11, 90),
        child(
          "child-south-2",
          0,
          "completed",
          `Integrity OK. south: 12 rows, total amount ${TRUE_TOTALS.south}.`,
          95,
          210,
        ),
      ],
      files: { [`w2:${REPORT_FILE}`]: SUMMARY },
      logs: {
        "task-0": toolCallRows(
          "task-0",
          "Write",
          { file_path: REPORT_FILE, content: SUMMARY },
          "File created successfully",
          "toolu_write_summary",
        ),
      },
    }),
};

export const soloFixture: GraderFixture = {
  reference: () =>
    makeContext(workerRecoverySolo, {
      tasks: [
        {
          ...(soloSeed as NonNullable<typeof soloSeed>),
          agentId: "worker-0",
          result: `Copy verified. Summary in ${REPORT_FILE}.`,
        },
      ],
      files: { [`w0:${REPORT_FILE}`]: SUMMARY.split("\n").slice(0, 6).join("\n") },
    }),
};

export const __test__ = { SUMMARY, child, LEAD };
