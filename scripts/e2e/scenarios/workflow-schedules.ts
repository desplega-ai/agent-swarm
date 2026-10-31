// Schedules over HTTP and MCP: create (workflow, agent-task and one-time targets),
// read, list filters, full and partial update, run-now, delete, and every validation
// each surface enforces. Far-future timings keep the real scheduler from firing them.
import { asRecord, asRecords, asString, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import {
  callToolErr,
  callToolOk,
  createWorkflow,
  getRunDetail,
  registerWorker,
  waitForRun,
} from "./workflow-helpers";

// 03:00 on 1 January: never due while the suite runs.
const YEARLY = "0 3 1 1 *";
const HOUR_MS = 3_600_000;

export const workflowSchedules: Scenario = {
  name: "workflow-schedules",
  order: 350,
  async run(ctx) {
    const marker = `sched-${ctx.nonce}`;
    const workerId = await registerWorker(ctx, "wf-sched");
    // Registered, never polling: tasks the schedules create for it stay pending.
    const idleId = await registerWorker(ctx, "wf-sched-idle");
    const connection = await ctx.connectMcp(workerId);
    const schedules: string[] = [];
    const name = (suffix: string) => `e2e-${suffix}-${ctx.nonce}`;

    try {
      const targetWorkflow = await createWorkflow(
        ctx,
        "sched-target",
        {
          nodes: [{ id: "tick", type: "script", config: { runtime: "bash", script: "echo tick" } }],
        },
        {},
        workerId,
      );

      // ── create: validation ──────────────────────────────────────────────────
      const base = { name: name("bad"), cronExpression: YEARLY, taskTemplate: "x" };
      expectStatus(
        await ctx.api("POST", "/api/schedules", { apiKey: null, body: base }),
        [401],
        "create without credentials",
      );
      const invalid: Array<[string, Record<string, unknown>, number, string]> = [
        ["no name", { cronExpression: YEARLY, taskTemplate: "x" }, 400, ""],
        ["a malformed cron expression", { ...base, cronExpression: "not a cron" }, 400, "cron"],
        [
          "an agent-task without a template",
          { name: name("bad"), cronExpression: YEARLY },
          400,
          "taskTemplate",
        ],
        [
          "a workflow target without a workflow",
          { name: name("bad"), cronExpression: YEARLY, targetType: "workflow" },
          400,
          "workflowId",
        ],
        [
          "a workflow target that does not exist",
          { ...base, targetType: "workflow", workflowId: crypto.randomUUID() },
          400,
          "Workflow not found",
        ],
        [
          "a script target without a script",
          { name: name("bad"), cronExpression: YEARLY, targetType: "script" },
          400,
          "scriptName",
        ],
        [
          "a script target that does not exist",
          {
            name: name("bad"),
            cronExpression: YEARLY,
            targetType: "script",
            scriptName: `ghost-${ctx.nonce}`,
          },
          400,
          "Script not found",
        ],
        [
          "a target agent that does not exist",
          { ...base, targetAgentId: crypto.randomUUID() },
          400,
          "agent",
        ],
        [
          "a one-time schedule without a time",
          { ...base, cronExpression: undefined, scheduleType: "one_time" },
          400,
          "delayMs",
        ],
        [
          "a one-time schedule with a cron",
          { ...base, scheduleType: "one_time", delayMs: HOUR_MS },
          400,
          "One-time",
        ],
        [
          "a one-time schedule with both delay and runAt",
          {
            name: name("bad"),
            taskTemplate: "x",
            scheduleType: "one_time",
            delayMs: HOUR_MS,
            runAt: new Date(Date.now() + HOUR_MS).toISOString(),
          },
          400,
          "not both",
        ],
        [
          "a one-time schedule in the past",
          {
            name: name("bad"),
            taskTemplate: "x",
            scheduleType: "one_time",
            runAt: "2020-01-01T00:00:00Z",
          },
          400,
          "future",
        ],
        ["a delay on a recurring schedule", { ...base, delayMs: HOUR_MS }, 400, "one-time"],
        ["a priority out of range", { ...base, priority: 101 }, 400, ""],
      ];
      for (const [label, body, status, needle] of invalid) {
        const response = await ctx.api("POST", "/api/schedules", { body });
        expectStatus(response, [status], `create with ${label}`);
        if (needle) {
          expect(
            JSON.stringify(response.json).toLowerCase().includes(needle.toLowerCase()),
            `create with ${label}: expected "${needle}", got ${response.text.slice(0, 300)}`,
          );
        }
      }

      // ── create: workflow, agent-task and one-time targets ────────────────────
      const createdFlow = await ctx.api("POST", "/api/schedules", {
        body: {
          name: name("flow"),
          description: `fires the workflow ${marker}`,
          cronExpression: YEARLY,
          timezone: "Europe/Madrid",
          targetType: "workflow",
          workflowId: targetWorkflow,
          tags: ["e2e"],
        },
      });
      expectStatus(createdFlow, [201], "create a workflow schedule");
      const flow = asRecord(createdFlow.json);
      const flowId = asString(flow.id, "workflow schedule id");
      schedules.push(flowId);
      expect(
        flow.name === name("flow") &&
          flow.enabled === true &&
          flow.scheduleType === "recurring" &&
          flow.targetType === "workflow" &&
          flow.workflowId === targetWorkflow &&
          flow.cronExpression === YEARLY &&
          flow.timezone === "Europe/Madrid" &&
          flow.consecutiveErrors === 0,
        `workflow schedule shape: ${JSON.stringify(flow)}`,
      );
      expect(
        typeof flow.nextRunAt === "string" && Date.parse(flow.nextRunAt) > Date.now(),
        "the next run is in the future",
      );
      expect(flow.lastRunAt === undefined, "a new schedule has never run");
      expectStatus(
        await ctx.api("POST", "/api/schedules", { body: { ...base, name: name("flow") } }),
        [409],
        "create with a name that is taken",
      );

      const createdTask = await ctx.api("POST", "/api/schedules", {
        body: {
          name: name("task"),
          intervalMs: HOUR_MS,
          taskTemplate: `scheduled work ${marker}`,
          taskType: "e2e-scheduled",
          tags: ["e2e", "scheduled"],
          priority: 61,
          targetAgentId: idleId,
        },
      });
      expectStatus(createdTask, [201], "create an agent-task schedule");
      const taskSchedule = asRecord(createdTask.json);
      const taskScheduleId = asString(taskSchedule.id, "agent-task schedule id");
      schedules.push(taskScheduleId);
      expect(
        taskSchedule.targetType === "agent-task" &&
          taskSchedule.intervalMs === HOUR_MS &&
          taskSchedule.priority === 61 &&
          taskSchedule.targetAgentId === idleId &&
          taskSchedule.taskTemplate === `scheduled work ${marker}`,
        "agent-task schedule shape",
      );

      const createdOnce = await ctx.api("POST", "/api/schedules", {
        body: {
          name: name("once"),
          scheduleType: "one_time",
          delayMs: HOUR_MS,
          taskTemplate: `one shot ${marker}`,
          targetAgentId: idleId,
        },
      });
      expectStatus(createdOnce, [201], "create a one-time schedule");
      const once = asRecord(createdOnce.json);
      const onceId = asString(once.id, "one-time schedule id");
      schedules.push(onceId);
      expect(
        once.scheduleType === "one_time" &&
          typeof once.nextRunAt === "string" &&
          Math.abs(Date.parse(once.nextRunAt) - (Date.now() + HOUR_MS)) < 60_000,
        "a one-time schedule is due after its delay",
      );

      const disabled = await ctx.api("POST", "/api/schedules", {
        body: { name: name("off"), cronExpression: YEARLY, taskTemplate: "x", enabled: false },
      });
      expectStatus(disabled, [201], "create a disabled schedule");
      const offId = asString(asRecord(disabled.json).id, "disabled schedule id");
      schedules.push(offId);
      expect(
        asRecord(disabled.json).enabled === false &&
          asRecord(disabled.json).nextRunAt === undefined,
        "a disabled schedule has no next run",
      );

      // FINDING: a recurring schedule needs a cron or an interval, and the create-schedule
      // tool answers that with a clear error. The REST create route has no such check, so the
      // insert fails and the route answers 500 "Failed to create schedule" instead of 400.
      const noTiming = await ctx.api("POST", "/api/schedules", {
        body: { name: name("notiming"), taskTemplate: "x" },
      });
      expectStatus(noTiming, [500], "a recurring schedule with no timing");
      const noTimingRows = ctx.db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM scheduled_tasks WHERE name = ?",
        [name("notiming")],
      );
      expect(noTimingRows?.n === 0, "the failed create left no row behind");
      const row = ctx.db.get<{ name: string; enabled: number; targetType: string }>(
        "SELECT name, enabled, targetType FROM scheduled_tasks WHERE id = ?",
        [flowId],
      );
      expect(
        row?.name === name("flow") && row.enabled === 1 && row.targetType === "workflow",
        "row persisted",
      );

      // ── read and list ───────────────────────────────────────────────────────
      const got = await ctx.api("GET", `/api/schedules/${taskScheduleId}`);
      expectStatus(got, [200], "get a schedule");
      expect(
        asRecord(got.json).id === taskScheduleId &&
          typeof asRecord(got.json).favorite === "boolean" &&
          asRecord(got.json).taskTemplate === `scheduled work ${marker}`,
        "get returns the full schedule with its template",
      );
      expectStatus(
        await ctx.api("GET", `/api/schedules/${crypto.randomUUID()}`),
        [404],
        "get an unknown schedule",
      );
      const slim = await ctx.api("GET", `/api/schedules?name=${encodeURIComponent(name("task"))}`);
      expectStatus(slim, [200], "list schedules by name");
      const slimRows = asRecords(slim.json, "schedules");
      expect(
        slimRows.length === 1 &&
          asRecord(slim.json).count === 1 &&
          slimRows[0]?.id === taskScheduleId &&
          typeof slimRows[0]?.taskTemplatePreview === "string" &&
          !("taskTemplate" in (slimRows[0] ?? {})),
        `slim list rows carry a template preview: ${JSON.stringify(slimRows[0])}`,
      );
      const full = await ctx.api(
        "GET",
        `/api/schedules?fields=full&name=${encodeURIComponent(name("task"))}`,
      );
      expect(
        asRecords(full.json, "schedules")[0]?.taskTemplate === `scheduled work ${marker}`,
        "fields=full restores the template",
      );
      const byTarget = await ctx.api(
        "GET",
        `/api/schedules?targetType=workflow&workflowId=${targetWorkflow}`,
      );
      expect(
        asRecords(byTarget.json, "schedules")
          .map((s) => s.id)
          .join(",") === flowId,
        "targetType and workflowId filter the list",
      );
      const byType = asRecords(
        (
          await ctx.api(
            "GET",
            `/api/schedules?scheduleType=one_time&name=${encodeURIComponent(ctx.nonce)}`,
          )
        ).json,
        "schedules",
      );
      expect(byType.map((s) => s.id).join(",") === onceId, "scheduleType filters the list");
      const byEnabled = asRecords(
        (await ctx.api("GET", `/api/schedules?enabled=false&name=${encodeURIComponent(ctx.nonce)}`))
          .json,
        "schedules",
      );
      expect(byEnabled.map((s) => s.id).join(",") === offId, "enabled=false filters the list");
      const byKey = await ctx.api(
        "GET",
        `/api/schedules?key=${encodeURIComponent(String(flow.key))}`,
      );
      expect(
        asRecords(byKey.json, "schedules").some((s) => s.id === flowId),
        "key filters the list",
      );
      const byPrefix = await ctx.api("GET", "/api/schedules?keyPrefix=shared/");
      expect(
        asRecords(byPrefix.json, "schedules").some((s) => s.id === flowId),
        "keyPrefix filters the list",
      );
      expectStatus(
        await ctx.api("GET", "/api/schedules?scheduleType=weekly"),
        [400],
        "list with a bad scheduleType",
      );
      const neverFailed = await ctx.api(
        "GET",
        `/api/schedules?lastRunStatus=failed&name=${ctx.nonce}`,
      );
      expect(asRecords(neverFailed.json, "schedules").length === 0, "no schedule has failed yet");

      // ── update (PUT) and patch (PATCH) ──────────────────────────────────────
      const beforeNext = String(flow.nextRunAt);
      const put = await ctx.api("PUT", `/api/schedules/${flowId}`, {
        body: { cronExpression: "0 4 1 1 *", description: "moved to four", tags: ["e2e", "moved"] },
      });
      expectStatus(put, [200], "update a schedule");
      const putJson = asRecord(put.json);
      expect(
        putJson.cronExpression === "0 4 1 1 *" &&
          putJson.description === "moved to four" &&
          (putJson.tags as string[]).join(",") === "e2e,moved" &&
          putJson.workflowId === targetWorkflow &&
          putJson.nextRunAt !== beforeNext,
        `update changes the cron and recomputes the next run: ${JSON.stringify([putJson.cronExpression, putJson.nextRunAt, beforeNext])}`,
      );
      const patch = await ctx.api("PATCH", `/api/schedules/${flowId}`, {
        body: { description: "patched", priority: 70 },
      });
      expectStatus(patch, [200], "patch a schedule");
      expect(
        asRecord(patch.json).description === "patched" &&
          asRecord(patch.json).priority === 70 &&
          asRecord(patch.json).cronExpression === "0 4 1 1 *",
        "patch merges over the stored schedule",
      );
      const renamed = await ctx.api("PATCH", `/api/schedules/${flowId}`, {
        body: { name: name("flow-renamed") },
      });
      expectStatus(renamed, [200], "rename a schedule");
      expect(asRecord(renamed.json).name === name("flow-renamed"), "rename applied");
      const toggled = asRecord(
        (await ctx.api("PUT", `/api/schedules/${flowId}`, { body: { enabled: false } })).json,
      );
      expect(
        toggled.enabled === false &&
          (toggled.nextRunAt === undefined || toggled.nextRunAt === null),
        "disabling clears the next run",
      );
      const reenabled = asRecord(
        (await ctx.api("PATCH", `/api/schedules/${flowId}`, { body: { enabled: true } })).json,
      );
      expect(
        reenabled.enabled === true &&
          typeof reenabled.nextRunAt === "string" &&
          Date.parse(reenabled.nextRunAt) > Date.now(),
        "enabling schedules the next run",
      );
      for (const method of ["PUT", "PATCH"] as const) {
        expectStatus(
          await ctx.api(method, `/api/schedules/${crypto.randomUUID()}`, {
            body: { description: "x" },
          }),
          [404],
          `${method} an unknown schedule`,
        );
        expectStatus(
          await ctx.api(method, `/api/schedules/${flowId}`, { body: { cronExpression: "nope" } }),
          [400],
          `${method} with a bad cron`,
        );
        expectStatus(
          await ctx.api(method, `/api/schedules/${flowId}`, { body: { name: name("task") } }),
          [409],
          `${method} to a name that is taken`,
        );
        expectStatus(
          await ctx.api(method, `/api/schedules/${flowId}`, {
            body: { workflowId: crypto.randomUUID() },
          }),
          [400],
          `${method} to a workflow that does not exist`,
        );
        expectStatus(
          await ctx.api(method, `/api/schedules/${taskScheduleId}`, {
            body: { intervalMs: null, cronExpression: null },
          }),
          [400],
          `${method} that removes all timing`,
        );
        expectStatus(
          await ctx.api(method, `/api/schedules/${taskScheduleId}`, { body: { taskTemplate: "" } }),
          [400],
          `${method} to an empty template`,
        );
      }
      expectStatus(
        await ctx.api("PUT", `/api/schedules/${taskScheduleId}`, {
          body: { targetType: "workflow" },
        }),
        [400],
        "retarget to a workflow without one",
      );

      // ── run now ─────────────────────────────────────────────────────────────
      const ran = await ctx.api("POST", `/api/schedules/${flowId}/run`);
      expectStatus(ran, [200], "run a workflow schedule now");
      const ranJson = asRecord(ran.json);
      const runIds = ranJson.workflowRunIds as string[];
      expect(Array.isArray(runIds) && runIds.length === 1, "run-now starts one workflow run");
      expect(
        typeof asRecord(ranJson.schedule).lastRunAt === "string" &&
          asRecord(ranJson.schedule).nextRunAt === reenabled.nextRunAt,
        "run-now stamps lastRunAt and leaves the regular timing alone",
      );
      const scheduledRun = await waitForRun(
        ctx,
        runIds[0] as string,
        "completed",
        20_000,
        "scheduled run",
      );
      expect(
        asRecord(scheduledRun.run.triggerData).scheduleId === flowId &&
          asRecord(scheduledRun.run.triggerData).scheduleName === name("flow-renamed"),
        "the run's trigger data names the schedule",
      );
      const provenance = ctx.db.get<{ triggerType: string }>(
        "SELECT triggerType FROM workflow_runs WHERE id = ?",
        [runIds[0] as string],
      );
      expect(provenance?.triggerType === "schedule", "the run is recorded as schedule-triggered");

      const ranTask = await ctx.api("POST", `/api/schedules/${taskScheduleId}/run`);
      expectStatus(ranTask, [200], "run an agent-task schedule now");
      const created = asRecord(asRecord(ranTask.json).task);
      expect(
        created.agentId === idleId &&
          created.priority === 61 &&
          String(created.task).includes(marker) &&
          (created.tags as string[]).includes("manual-run"),
        `run-now creates the task for the target agent: ${JSON.stringify(created)}`,
      );
      const taskRow = ctx.db.get<{ scheduleId: string | null; status: string }>(
        "SELECT scheduleId, status FROM agent_tasks WHERE id = ?",
        [String(created.id)],
      );
      expect(taskRow?.scheduleId === taskScheduleId, "the task links back to its schedule");

      const ranOnce = await ctx.api("POST", `/api/schedules/${onceId}/run`);
      expectStatus(ranOnce, [200], "run a one-time schedule now");
      const onceAfter = asRecord(asRecord(ranOnce.json).schedule);
      expect(
        onceAfter.enabled === false && typeof onceAfter.lastRunAt === "string",
        "a one-time schedule disables itself after it runs",
      );
      expectStatus(
        await ctx.api("POST", `/api/schedules/${onceId}/run`),
        [400],
        "run a disabled schedule",
      );
      const finished = await ctx.api("PATCH", `/api/schedules/${onceId}`, {
        body: { description: "late" },
      });
      expectStatus(finished, [400], "edit a one-time schedule that already ran");
      expect(String(asRecord(finished.json).error).includes("already executed"), "says why");
      expectStatus(
        await ctx.api("POST", `/api/schedules/${offId}/run`),
        [400],
        "run a disabled schedule",
      );
      expectStatus(
        await ctx.api("POST", `/api/schedules/${crypto.randomUUID()}/run`),
        [404],
        "run an unknown schedule",
      );
      const hidden = asRecords(
        (await ctx.api("GET", `/api/schedules?hideCompleted=true&name=${ctx.nonce}`)).json,
        "schedules",
      );
      expect(
        !hidden.some((s) => s.id === onceId),
        "hideCompleted hides the finished one-time schedule",
      );
      const shown = asRecords(
        (await ctx.api("GET", `/api/schedules?hideCompleted=false&name=${ctx.nonce}`)).json,
        "schedules",
      );
      expect(
        shown.some((s) => s.id === onceId),
        "hideCompleted=false shows it",
      );

      // The dashboard's list of the same rows lives under /api/scheduled-tasks.
      const stats = await ctx.api(
        "GET",
        `/api/scheduled-tasks?name=${encodeURIComponent(ctx.nonce)}&limit=500`,
      );
      expectStatus(stats, [200], "list scheduled tasks");
      const statRows = asRecords(stats.json, "scheduledTasks");
      expect(
        statRows.some(
          (row) => row.id === taskScheduleId && row.taskTemplate === `scheduled work ${marker}`,
        ),
        "scheduled-tasks returns full rows by default",
      );
      const statSlim = asRecords(
        (
          await ctx.api(
            "GET",
            `/api/scheduled-tasks?fields=slim&targetType=workflow&name=${ctx.nonce}`,
          )
        ).json,
        "scheduledTasks",
      );
      expect(
        statSlim.length >= 1 &&
          statSlim.every((row) => row.targetType === "workflow" && !("taskTemplate" in row)),
        "scheduled-tasks slim rows carry no template and honor targetType",
      );
      const statLimit = asRecords(
        (await ctx.api("GET", `/api/scheduled-tasks?limit=1&name=${ctx.nonce}`)).json,
        "scheduledTasks",
      );
      expect(statLimit.length === 1, "scheduled-tasks limit caps the list");
      expectStatus(
        await ctx.api("GET", "/api/scheduled-tasks?limit=0"),
        [400],
        "scheduled-tasks limit must be positive",
      );

      // ── delete ──────────────────────────────────────────────────────────────
      const doomed = await ctx.api("POST", "/api/schedules", {
        body: { name: name("doomed"), cronExpression: YEARLY, taskTemplate: "x" },
      });
      const doomedId = asString(asRecord(doomed.json).id, "doomed id");
      const deleted = await ctx.api("DELETE", `/api/schedules/${doomedId}`);
      expectStatus(deleted, [200], "delete a schedule");
      expect(asRecord(deleted.json).success === true, "delete answers success");
      expectStatus(await ctx.api("GET", `/api/schedules/${doomedId}`), [404], "get after delete");
      expectStatus(await ctx.api("DELETE", `/api/schedules/${doomedId}`), [404], "delete twice");

      // ── MCP ─────────────────────────────────────────────────────────────────
      const tool = {
        flow: name("tool-flow"),
        once: name("tool-once"),
      };
      await callToolErr(
        connection,
        "create-schedule",
        { name: tool.flow, taskTemplate: "x" },
        "cronExpression or intervalMs",
      );
      await callToolErr(
        connection,
        "create-schedule",
        { name: tool.flow, cronExpression: "bad", taskTemplate: "x" },
        "cron",
      );
      await callToolErr(
        connection,
        "create-schedule",
        { name: tool.flow, cronExpression: YEARLY },
        "taskTemplate",
      );
      await callToolErr(
        connection,
        "create-schedule",
        {
          name: tool.flow,
          cronExpression: YEARLY,
          targetType: "workflow",
          workflowId: crypto.randomUUID(),
        },
        "Workflow not found",
      );
      await callToolErr(
        connection,
        "create-schedule",
        { name: tool.flow, scheduleType: "one_time", taskTemplate: "x" },
        "delayMs or runAt",
      );
      await callToolErr(
        connection,
        "create-schedule",
        { name: name("flow-renamed"), cronExpression: YEARLY, taskTemplate: "x" },
        "already exists",
      );
      const madeFlow = await callToolOk(connection, "create-schedule", {
        name: tool.flow,
        cronExpression: YEARLY,
        targetType: "workflow",
        workflowId: targetWorkflow,
        description: "created through MCP",
      });
      const madeSchedule = asRecord(madeFlow.structured.schedule);
      const toolFlowId = asString(madeSchedule.id, "tool schedule id");
      schedules.push(toolFlowId);
      expect(
        madeSchedule.createdByAgentId === workerId &&
          madeSchedule.workflowId === targetWorkflow &&
          madeFlow.text.includes(`Created schedule "${tool.flow}"`),
        "create-schedule records the creating agent",
      );
      const madeOnce = await callToolOk(connection, "create-schedule", {
        name: tool.once,
        scheduleType: "one_time",
        delayMs: HOUR_MS,
        taskTemplate: `tool one shot ${marker}`,
        targetAgentId: idleId,
      });
      const toolOnceId = asString(asRecord(madeOnce.structured.schedule).id, "tool one-time id");
      schedules.push(toolOnceId);

      const listed = await callToolOk(connection, "list-schedules", { name: ctx.nonce });
      const listedRows = asRecords(listed.structured, "schedules");
      expect(
        listedRows.some((s) => s.id === toolFlowId) &&
          listedRows.every((s) => "taskTemplatePreview" in s || s.taskTemplate === undefined),
        "list-schedules is slim and finds the schedules",
      );
      const listedFull = await callToolOk(connection, "list-schedules", {
        name: tool.once,
        includeFull: true,
        scheduleType: "one_time",
        enabled: true,
      });
      expect(
        asRecords(listedFull.structured, "schedules")[0]?.taskTemplate ===
          `tool one shot ${marker}`,
        "includeFull returns the template",
      );
      const hiddenTool = await callToolOk(connection, "list-schedules", {
        name: ctx.nonce,
        hideCompleted: true,
      });
      expect(
        !asRecords(hiddenTool.structured, "schedules").some((s) => s.id === onceId),
        "list-schedules hides completed one-time schedules by default",
      );
      const failedList = await callToolOk(connection, "list-schedules", {
        name: ctx.nonce,
        lastRunStatus: "failed",
        consecutiveErrorsMin: 1,
      });
      expect(asRecords(failedList.structured, "schedules").length === 0, "no tool schedule failed");

      const updated = await callToolOk(connection, "update-schedule", {
        scheduleId: toolFlowId,
        newName: name("tool-flow-2"),
        cronExpression: "0 5 1 1 *",
        description: "updated through MCP",
      });
      const updatedSchedule = asRecord(updated.structured.schedule);
      expect(
        updatedSchedule.name === name("tool-flow-2") &&
          updatedSchedule.cronExpression === "0 5 1 1 *" &&
          updated.text.includes("Updated schedule"),
        "update-schedule by id applies a rename and a new cron",
      );
      const patched = await callToolOk(connection, "patch-schedule", {
        name: name("tool-flow-2"),
        priority: 80,
        enabled: true,
      });
      expect(
        asRecord(patched.structured.schedule).priority === 80 &&
          patched.text.includes("Patched schedule"),
        "patch-schedule by name merges fields",
      );
      for (const toolName of ["update-schedule", "patch-schedule"] as const) {
        await callToolErr(
          connection,
          toolName,
          { name: `ghost-${ctx.nonce}`, priority: 1 },
          "not found",
        );
        await callToolErr(
          connection,
          toolName,
          { scheduleId: toolFlowId, cronExpression: "nope" },
          "cron",
        );
        await callToolErr(
          connection,
          toolName,
          { scheduleId: toolFlowId, newName: name("task") },
          "already exists",
        );
        await callToolErr(
          connection,
          toolName,
          { scheduleId: toolFlowId, workflowId: crypto.randomUUID() },
          "Workflow not found",
        );
      }

      await callToolErr(connection, "run-schedule-now", {}, "scheduleId or name");
      await callToolErr(
        connection,
        "run-schedule-now",
        { name: `ghost-${ctx.nonce}` },
        "not found",
      );
      await callToolErr(connection, "run-schedule-now", { name: name("off") }, "disabled");
      const toolRan = await callToolOk(connection, "run-schedule-now", {
        name: name("tool-flow-2"),
      });
      expect(
        asRecord(toolRan.structured.schedule).id === toolFlowId &&
          toolRan.text.includes(`Executed schedule "${name("tool-flow-2")}"`),
        "run-schedule-now by name executes the schedule",
      );
      const toolRunRow = await (async () => {
        for (let attempt = 0; attempt < 50; attempt++) {
          const found = ctx.db.query<{ id: string; status: string }>(
            "SELECT id, status FROM workflow_runs WHERE workflowId = ? AND triggerType = 'schedule' ORDER BY startedAt DESC",
            [targetWorkflow],
          );
          if (found.length >= 2) return found;
          await Bun.sleep(100);
        }
        return [];
      })();
      expect(
        toolRunRow.length >= 2,
        "the tool run started a second schedule-triggered workflow run",
      );
      await getRunDetail(ctx, String(toolRunRow[0]?.id));
      const toolRanById = await callToolOk(connection, "run-schedule-now", {
        scheduleId: toolOnceId,
      });
      expect(
        asRecord(toolRanById.structured.schedule).id === toolOnceId,
        "run-schedule-now by id runs a one-time schedule",
      );
      await callToolErr(connection, "run-schedule-now", { scheduleId: toolOnceId }, "disabled");
      await callToolErr(
        connection,
        "update-schedule",
        { scheduleId: toolOnceId, description: "late" },
        "already executed",
      );

      await callToolErr(connection, "delete-schedule", {}, "scheduleId or name");
      await callToolErr(connection, "delete-schedule", { name: `ghost-${ctx.nonce}` }, "not found");
      const toolDeleted = await callToolOk(connection, "delete-schedule", {
        name: name("tool-flow-2"),
      });
      expect(
        asRecord(toolDeleted.structured.deletedSchedule).id === toolFlowId,
        "delete-schedule by name names the schedule",
      );
      schedules.splice(schedules.indexOf(toolFlowId), 1);
      expectStatus(
        await ctx.api("GET", `/api/schedules/${toolFlowId}`),
        [404],
        "tool-deleted schedule is gone",
      );
      const toolDeletedById = await callToolOk(connection, "delete-schedule", {
        scheduleId: toolOnceId,
      });
      expect(toolDeletedById.text.includes(tool.once), "delete-schedule by id");
      schedules.splice(schedules.indexOf(toolOnceId), 1);
    } finally {
      // Disable what is left so a stray tick can never fire it.
      for (const id of schedules)
        await ctx.api("PATCH", `/api/schedules/${id}`, { body: { enabled: false } });
      await connection.close();
    }
  },
};
