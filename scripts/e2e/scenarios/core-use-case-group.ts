import { asRecord, asRecords, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import { asUser, createAssignedTask, createUser, expectToolOk, readTask } from "./core-helpers";

export const coreUseCaseGroup: Scenario = {
  name: "core-use-case-group",
  order: 242,
  async run(ctx) {
    const owner = await createUser(ctx, "use-case-owner");
    const groupKey = `shared/use-case-${ctx.nonce}/`;
    // A planning session started in the Inbox: its key is the default `shared/task:<id>/`.
    const planKey = `shared/use-case-plan-${ctx.nonce}/`;
    const planText = `Plan a use case ${ctx.nonce}`;
    let scheduleId = "";
    let planScheduleId = "";
    let movedRootId: unknown;
    const agent = await ctx.startAgent({
      name: `use-case-worker-${ctx.nonce}`,
      async onTask({ taskId, task }) {
        if (task.task === planText) {
          const connection = await ctx.connectMcp(agent.agentId, {
            headers: { "X-Source-Task-Id": taskId },
          });
          try {
            const result = await expectToolOk(connection, "create-schedule", {
              key: planKey,
              name: `use-case-plan-schedule-${ctx.nonce}`,
              taskTemplate: `Planned research ${ctx.nonce}`,
              intervalMs: 86_400_000,
              targetAgentId: agent.agentId,
            });
            planScheduleId = String(asRecord(result.data.schedule).id);
            movedRootId = result.data.movedSessionRootId;
            return { status: "completed", output: "Filed the planning session" };
          } finally {
            await connection.close();
          }
        }
        if (task.key !== groupKey) return { status: "ignore" };
        const connection = await ctx.connectMcp(agent.agentId, {
          headers: { "X-Source-Task-Id": taskId },
        });
        try {
          const result = await expectToolOk(connection, "create-schedule", {
            name: `use-case-schedule-${ctx.nonce}`,
            taskTemplate: `Scheduled research ${ctx.nonce}`,
            intervalMs: 86_400_000,
            targetAgentId: agent.agentId,
          });
          const schedule = asRecord(result.data.schedule);
          expect(schedule.key === groupKey, "Schedule did not inherit the task's group key");
          expect(schedule.createdBy === owner, "Schedule did not inherit the task's audit user");
          scheduleId = String(schedule.id);
          return { status: "completed", output: "Created the grouped schedule" };
        } finally {
          await connection.close();
        }
      },
    });
    try {
      const taskId = await createAssignedTask(ctx, agent.agentId, `Use case ${ctx.nonce}`, {
        key: groupKey,
        requestedByUserId: owner,
      });
      const outcome = await agent.waitForTask(taskId);
      expect(
        outcome.status === "completed" && scheduleId.length > 0,
        "The agent did not create the schedule",
      );
      const planTaskId = await createAssignedTask(ctx, agent.agentId, planText, {
        requestedByUserId: owner,
      });
      expect(
        (await readTask(ctx, planTaskId)).key === `shared/task:${planTaskId}/`,
        "The planning task did not start with its default key",
      );
      const planned = await agent.waitForTask(planTaskId);
      expect(
        planned.status === "completed" && planScheduleId.length > 0,
        "The agent did not create the planned schedule",
      );
      expect(movedRootId === planTaskId, "create-schedule did not report the moved session");
      expect(
        (await readTask(ctx, planTaskId)).key === planKey,
        "The planning session did not move into the schedule's group",
      );
      await agent.stop();
      const run = await ctx.api("POST", `/api/schedules/${scheduleId}/run`);
      expectStatus(run, [200], "run the grouped schedule");
      const task = asRecord(asRecord(run.json).task);
      expect(
        task.key === groupKey && task.source === "schedule" && task.scheduleId === scheduleId,
        "Schedule run lost its group or schedule identity",
      );
      expect(task.requestedByUserId === owner, "Schedule run lost its audit requester");
      const headers = asUser(owner);
      const listed = await ctx.api(
        "GET",
        `/api/sessions?scope=tree&groupKey=${encodeURIComponent(groupKey)}&showSource=comb,ui`,
        { headers },
      );
      expectStatus(listed, [200], "list the use case group");
      expect(
        asRecords(listed.json, "sessions").some((row) => asRecord(row.root).id === task.id),
        "The group omits the schedule run",
      );
      expect(
        asRecord(listed.json).total === 1,
        "The group total differs from its schedule run count",
      );
      const tree = await ctx.api("GET", "/api/session-tree?showSource=comb,ui", { headers });
      expectStatus(tree, [200], "read the group tree");
      expect(
        asRecords(tree.json, "groups").some(
          (row) => row.key === groupKey && row.total === 1 && row.running === 1,
        ),
        "The tree omits the schedule group",
      );
      const inbox = await ctx.api("GET", "/api/sessions?scope=tree&showSource=comb,ui", {
        headers,
      });
      expectStatus(inbox, [200], "read default sessions");
      expect(
        !asRecords(inbox.json, "sessions").some((row) => asRecord(row.root).id === task.id),
        "Default sessions include the schedule run",
      );
    } finally {
      await agent.stop();
      if (scheduleId) {
        expectStatus(
          await ctx.api("DELETE", `/api/schedules/${scheduleId}`),
          [200],
          "delete the use case schedule",
        );
      }
      if (planScheduleId) {
        expectStatus(
          await ctx.api("DELETE", `/api/schedules/${planScheduleId}`),
          [200],
          "delete the planned schedule",
        );
      }
    }
  },
};
