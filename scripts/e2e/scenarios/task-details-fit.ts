import { asRecord, expect, expectStatus } from "../http";
import type { McpConnection } from "../mcp";
import type { Scenario, ScenarioContext } from "../run";
import {
  claimTask,
  createAssignedTask,
  expectToolOk,
  registerWorker,
  type ToolOutcome,
  withMcp,
} from "./core-helpers";

// get-task-details fits an agent-facing response under a 9,000-byte payload budget with the
// least loss: log rows drop fields that repeat the task, then the oldest non-lifecycle rows go
// (the newest progress stays), then the longest text is cut. `include` opts out of each step,
// a response under the budget comes back unchanged, and script SDK calls get the full shape.

const BUDGET_BYTES = 9_000;
const LIFECYCLE = new Set(["task_created", "task_status_change"]);

type Data = Record<string, unknown>;
type Log = Record<string, unknown>;

/** The value as a record, or {} when it is not one (absent fields are normal here). */
const obj = (v: unknown): Data =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Data) : {};

const logsOf = (data: Data): Log[] => (Array.isArray(data.logs) ? (data.logs as Log[]) : []);
const taskOf = (data: Data): Data => asRecord(data.task);
const progressValues = (logs: Log[]) =>
  logs.filter((log) => log.eventType === "task_progress").map((log) => log.newValue);
const lifecycleIds = (logs: Log[]) =>
  logs.filter((log) => LIFECYCLE.has(String(log.eventType))).map((log) => log.id);

/** UTF-8 bytes of the payload the fit measures: the tool data, without the registrar envelope. */
function payloadBytes(data: Data): number {
  const { yourAgentId, task, requestedBy, logs, attachments, fitted } = data;
  const payload = { yourAgentId, task, requestedBy, logs, attachments, fitted };
  return Buffer.byteLength(JSON.stringify(payload), "utf8");
}

/** The tool data of a call, read back from overflow KV when the result spilled. */
async function dataOf(conn: McpConnection, outcome: ToolOutcome): Promise<Data> {
  const pointer = obj(outcome.data.truncation).fullValueAt;
  if (typeof pointer !== "string") return outcome.data;
  expect(pointer.startsWith("kv://"), `get-task-details spill pointer is ${pointer}`);
  const rest = pointer.slice("kv://".length);
  const cut = rest.indexOf("/");
  const stored = await expectToolOk(conn, "kv-get", {
    namespace: rest.slice(0, cut),
    key: rest.slice(cut + 1),
  });
  const value = asRecord(stored.data.entry).value;
  const parsed = asRecord(typeof value === "string" ? JSON.parse(value) : value);
  return asRecord(asRecord(parsed.outcome).data);
}

async function details(conn: McpConnection, taskId: string, include?: string[]) {
  const outcome = await expectToolOk(
    conn,
    "get-task-details",
    include ? { taskId, include } : { taskId },
  );
  return { outcome, data: await dataOf(conn, outcome) };
}

/** The full shape, as a script sees it: the MCP bridge marks the call origin script-sdk. */
async function sdkDetails(ctx: ScenarioContext, agentId: string, taskId: string): Promise<Data> {
  const response = await ctx.api("POST", "/api/mcp-bridge", {
    agentId,
    body: { tool: "get-task-details", args: { taskId } },
  });
  expectStatus(response, [200], "bridge get-task-details");
  const data = asRecord(response.json);
  expect(
    data.success === true,
    `bridged get-task-details failed: ${JSON.stringify(data).slice(0, 300)}`,
  );
  expect(data.fitted === undefined, "script SDK call was fitted");
  expect(data.truncation === undefined, "script SDK call spilled");
  return data;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** A default call that the fit reduced in place: under the budget, no spill, a notice. */
function expectFitted(result: { outcome: ToolOutcome; data: Data }, reduced: string[]): void {
  const label = `fitted by ${reduced.join("+")}`;
  expect(result.outcome.data.truncation === undefined, `${label}: response spilled to KV`);
  const bytes = payloadBytes(result.data);
  expect(bytes <= BUDGET_BYTES, `${label}: payload is ${bytes} bytes, over the budget`);
  const fitted = obj(result.data.fitted);
  expect(fitted.budgetBytes === BUDGET_BYTES, `${label}: no fitted notice`);
  expect(
    same(fitted.include, reduced),
    `${label}: fitted.include is ${JSON.stringify(fitted.include)}`,
  );
  expect(
    result.outcome.message.includes(`include ${JSON.stringify(reduced)}`),
    `${label}: message does not name the include values: ${result.outcome.message}`,
  );
  expect(
    (fitted.text !== undefined) === reduced.includes("text"),
    `${label}: fitted.text mismatch`,
  );
}

export const taskDetailsFit: Scenario = {
  name: "task-details-fit",
  order: 269,
  async run(ctx) {
    const worker = await registerWorker(ctx, "details-fit");
    await withMcp(ctx, worker, async (conn) => {
      // Small: one progress line. The response is returned as is.
      const smallId = await createAssignedTask(ctx, worker, `Fit small ${ctx.nonce}`);
      await claimTask(ctx, worker, smallId);
      await expectToolOk(conn, "store-progress", { taskId: smallId, progress: "small step" });
      const small = await details(conn, smallId);
      expect(small.data.fitted === undefined, "small response carries a fitted notice");
      expect(small.data.truncation === undefined, "small response spilled");
      expect(!small.outcome.message.includes("Fitted"), "small response message says fitted");
      const smallFull = await sdkDetails(ctx, worker, smallId);
      expect(
        same(taskOf(small.data), taskOf(smallFull)) && same(logsOf(small.data), logsOf(smallFull)),
        "small response differs from the full shape",
      );
      await expectToolOk(conn, "store-progress", {
        taskId: smallId,
        status: "completed",
        output: "small done",
      });

      // Logs: forty progress lines put the response over the budget; the log steps alone fit it.
      const logsTask = async (pad: number) => {
        const id = await createAssignedTask(ctx, worker, `Fit logs ${ctx.nonce}${"t".repeat(pad)}`);
        await claimTask(ctx, worker, id);
        for (let i = 0; i < 40; i++) {
          await expectToolOk(conn, "store-progress", {
            taskId: id,
            progress: `logs step ${String(i).padStart(2, "0")} ${"p".repeat(150)}`,
          });
        }
        await expectToolOk(conn, "store-progress", {
          taskId: id,
          status: "completed",
          output: "-",
        });
        return id;
      };
      const logsId = await logsTask(0);
      const logsFull = await sdkDetails(ctx, worker, logsId);
      const logsFullRows = logsOf(logsFull);
      expect(payloadBytes(logsFull) > BUDGET_BYTES, "logs task does not pass the budget in full");

      const logsFit = await details(conn, logsId);
      expectFitted(logsFit, ["logs"]);
      const keptLogs = logsOf(logsFit.data);
      expect(
        keptLogs.every((log) => log.taskId === undefined && log.agentId === undefined),
        "fitted log rows still repeat taskId or the task's agentId",
      );
      expect(
        same(lifecycleIds(keptLogs), lifecycleIds(logsFullRows)),
        "fitted logs dropped a lifecycle row",
      );
      const fullProgress = progressValues(logsFullRows);
      const keptProgress = progressValues(keptLogs);
      const omitted = fullProgress.length - keptProgress.length;
      expect(
        omitted > 0 && same(keptProgress, fullProgress.slice(omitted)),
        `fitted logs did not drop the oldest progress first: kept ${keptProgress.length} of ${fullProgress.length}`,
      );
      expect(
        same(obj(logsFit.data.fitted).logs, {
          compacted: obj(obj(logsFit.data.fitted).logs).compacted,
          omitted,
          omittedByEventType: { task_progress: omitted },
        }),
        `fitted.logs does not report the dropped rows: ${JSON.stringify(obj(logsFit.data.fitted).logs)}`,
      );
      expect(
        same(taskOf(logsFit.data), taskOf(logsFull)),
        "a fit that the log steps settle still changed the task",
      );

      const logsVerbatim = await details(conn, logsId, ["logs"]);
      expect(
        same(logsOf(logsVerbatim.data), logsFullRows),
        'include ["logs"] did not return every log row verbatim',
      );
      expect(
        obj(logsVerbatim.data.fitted).logs === undefined,
        'include ["logs"] still reduced logs',
      );

      // The omitted-rows notice counts against the budget too. Each pad shifts the payload by
      // 30 bytes, so across a log row's width one variant ends within a notice of the budget.
      for (let pad = 30; pad <= 300; pad += 30) {
        expectFitted(await details(conn, await logsTask(pad)), ["logs"]);
      }

      // Text: a 20,000-character output passes the budget even with the logs reduced.
      const textId = await createAssignedTask(ctx, worker, `Fit text ${ctx.nonce}`);
      await claimTask(ctx, worker, textId);
      for (let i = 0; i < 5; i++) {
        await expectToolOk(conn, "store-progress", { taskId: textId, progress: `text step ${i}` });
      }
      const output = `Text result ${ctx.nonce}\n${"Measured row. ".repeat(1_430)}`;
      await expectToolOk(conn, "store-progress", {
        taskId: textId,
        status: "completed",
        output,
        attachments: [{ kind: "url", url: `https://example.com/fit/${ctx.nonce}.md`, name: "fit" }],
      });
      const textFull = await sdkDetails(ctx, worker, textId);
      const textFullRows = logsOf(textFull);
      expect(taskOf(textFull).output === output, "script SDK call cut the output");
      expect(
        textFullRows.every((log) => log.taskId === textId),
        "script SDK call compacted the log rows",
      );

      const textFit = await details(conn, textId);
      expectFitted(textFit, ["logs", "text"]);
      const textKept = logsOf(textFit.data);
      expect(
        same(lifecycleIds(textKept), lifecycleIds(textFullRows)),
        "text fit dropped a lifecycle row",
      );
      const textProgress = progressValues(textFullRows);
      expect(
        same(progressValues(textKept), textProgress.slice(-1)),
        "text fit did not drop every older progress row, keeping the newest, before cutting text",
      );
      const cutTask = taskOf(textFit.data);
      const fullTask = taskOf(textFull);
      for (const key of ["id", "status", "agentId", "progress"]) {
        expect(cutTask[key] === fullTask[key], `text fit changed task.${key}`);
      }
      expect(same(textFit.data.attachments, textFull.attachments), "text fit changed attachments");
      const cuts = obj(textFit.data.fitted).text;
      const outputCut = (Array.isArray(cuts) ? cuts : [])
        .map(obj)
        .find((c) => c.field === "task.output");
      const kept = Number(outputCut?.keptChars);
      expect(
        outputCut?.originalChars === output.length && kept >= 280 && kept < output.length,
        `fitted.text does not report the output cut: ${JSON.stringify(cuts)}`,
      );
      expect(
        typeof cutTask.output === "string" &&
          cutTask.output.startsWith(output.slice(0, kept)) &&
          cutTask.output.includes(`[cut, ${output.length} chars in full`),
        "the cut output does not keep its head and a cut marker",
      );

      const textUncut = await details(conn, textId, ["text"]);
      expect(taskOf(textUncut.data).output === output, 'include ["text"] still cut the output');
      expect(
        same(obj(textUncut.data.fitted).include, ["logs"]),
        'include ["text"] skipped the log steps',
      );

      const textWhole = await details(conn, textId, ["logs", "text"]);
      expect(
        same(taskOf(textWhole.data), fullTask) && same(logsOf(textWhole.data), textFullRows),
        'include ["logs", "text"] did not return the full shape',
      );
      expect(!textWhole.outcome.message.includes("Fitted"), "an unreduced response says fitted");
    });
  },
};
