/** Batch 3: workflow step stall + retry poller (#1678), multi-runtime off leg */
import {
  check,
  createTask,
  makeApi,
  mcpConnect,
  openDb,
  poll,
  registerWorker,
  results,
  row,
  rows,
  scenario,
  stall,
  startSut,
  stopSut,
  waitFor,
} from "./hb-lib";

const sut = await startSut(
  true,
  {},
  { MULTI_RUNTIME_ENABLED: "true", HEARTBEAT_INTERVAL_MS: "1000", HEARTBEAT_MAX_AUTO_ASSIGN: "0" },
);
console.log(`SUT ${sut.baseUrl}`);
const api = makeApi(sut);
const db = openDb(sut);

await scenario(
  "W1 workflow-step task stalls → failed superseded_workflow_task → retry poller re-runs step, no double run",
  async () => {
    const w = await registerWorker(api, "w1");
    const wf = await api("POST", "/api/workflows", {
      body: {
        name: "qa-wf",
        definition: {
          nodes: [
            {
              id: "t",
              type: "agent-task",
              config: { template: "qa step", agentId: w.id },
              retry: { maxRetries: 2, strategy: "static", baseDelayMs: 1000, maxDelayMs: 2000 },
            },
          ],
        },
      },
    });
    check(wf.status === 201, `wf ${wf.status} ${wf.text.slice(0, 200)}`);
    const tr = await api("POST", `/api/workflows/${wf.json.id}/trigger`, { body: {} });
    check(tr.status === 201, `trigger ${tr.status} ${tr.text.slice(0, 200)}`);
    const runId = tr.json.runId;
    let p: any;
    check(
      await waitFor(async () => {
        p = await poll(api, w);
        return !!p.json?.trigger?.taskId;
      }, 15000),
      "no task handed out",
    );
    const t1 = p.json.trigger.taskId;
    stall(db, t1, 10);
    check(await waitFor(() => row(db, t1).status === "failed", 15000), `t1 ${row(db, t1).status}`);
    const reason = row(db, t1).failureReason;
    // retry poller should create a new task for the step
    let t2: string | undefined;
    await waitFor(async () => {
      const q = await poll(api, w);
      t2 = q.json?.trigger?.taskId;
      return !!t2;
    }, 20000);
    const run = (await api("GET", `/api/workflow-runs/${runId}`)).json;
    const steps = (run.steps ?? []).map(
      (s: any) => `${s.nodeId}:${s.status}/r${s.retryCount ?? "?"}`,
    );
    return `t1 failed(${reason}); retry task=${t2 ? t2.slice(0, 6) : "NONE"} same-row=${t2 === t1}; run=${run.run?.status}; steps=${steps}`;
  },
);

console.log("\n=== RESULTS ===");
for (const r of results) console.log(`${r.status}\t${r.name}\t${r.detail.slice(0, 500)}`);
db.close();
await stopSut(sut, false);
