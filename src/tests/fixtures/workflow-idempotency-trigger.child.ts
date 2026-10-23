/**
 * One keyed workflow trigger on its own DB connection, for
 * `workflow-idempotency.test.ts`. Runs the HTTP handler's sequence: look the
 * key up, then start the run with the key recorded in the run's transaction,
 * and answer from the record when a concurrent process took the key first.
 *
 * Barrier: after the lookup finds nothing it creates `<dir>/looked-<n>` and
 * waits for `<dir>/go`, so the parent can release every child only once all
 * of them are past the lookup and about to race for the write lock.
 *
 * Prints one JSON line: `{ runId, replayed }`.
 */
import { join } from "node:path";
import { getWorkflow, initDb } from "../../be/db";
import {
  findAcceptedWorkflowOperation,
  IdempotencyKeyTakenError,
  recordAcceptedWorkflowOperation,
  type WorkflowIdempotencyClaim,
  workflowRequestFingerprint,
} from "../../be/db/workflow-idempotency";
import { getExecutorRegistry, startWorkflowExecution } from "../../workflows";

const [dbPath, workflowId, key, barrierDir, n] = process.argv.slice(2);
if (!dbPath || !workflowId || !key || !barrierDir || !n) {
  console.error("usage: workflow-idempotency-trigger.child <db> <workflowId> <key> <dir> <n>");
  process.exit(2);
}

const realLog = console.log;
console.log = () => {};
console.debug = () => {};
console.warn = () => {};

initDb(dbPath);
const workflow = await getWorkflow(workflowId);
if (!workflow) throw new Error(`workflow ${workflowId} not found`);

const body = { n: 1 };
const claim: WorkflowIdempotencyClaim = {
  principal: "agent:concurrency-test",
  operation: "workflow.trigger",
  targetId: workflowId,
  key,
  fingerprint: workflowRequestFingerprint("workflow.trigger", body),
};

if (await findAcceptedWorkflowOperation(claim)) throw new Error("key already accepted");
await Bun.write(join(barrierDir, `looked-${n}`), "");
const go = Bun.file(join(barrierDir, "go"));
while (!(await go.exists())) await Bun.sleep(5);

let result: { runId: string; replayed: boolean };
try {
  const runId = await startWorkflowExecution(workflow, body, getExecutorRegistry(), {
    triggerType: "api",
    accept: (run) =>
      recordAcceptedWorkflowOperation(claim, {
        workflowId,
        runId: run.runId,
        status: 201,
        body: run,
      }),
  });
  result = { runId, replayed: false };
} catch (err) {
  if (!(err instanceof IdempotencyKeyTakenError)) throw err;
  const accepted = await findAcceptedWorkflowOperation(claim);
  result = { runId: (accepted?.body as { runId: string }).runId, replayed: true };
}

realLog(JSON.stringify(result));
process.exit(0);
