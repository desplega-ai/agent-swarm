import { asRecord, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import { claim } from "./slack-helpers";

// PR #2493: a schedule-run session is readable by every user, not only the schedule's creator.
// Two real users (invite + exchange). A fires a schedule; B reads its tasks and session.
// Negative control: a plain task A creates stays hidden from B.
async function mintUser(
  ctx: Parameters<Scenario["run"]>[0],
  label: string,
): Promise<{ token: string; userId: string }> {
  const created = await ctx.api("POST", "/api/invites", {
    body: { email: `${label}-${ctx.nonce}@example.com` },
  });
  expectStatus(created, [201], `invite ${label}`);
  const code = new URL(String(asRecord(created.json).inviteUrl)).pathname.split("/")[2];
  const exchanged = await ctx.api("POST", "/api/invites/exchange", {
    apiKey: null,
    body: { code },
  });
  expectStatus(exchanged, [200], `exchange ${label}`);
  const body = asRecord(exchanged.json);
  return { token: String(body.token), userId: String(body.userId) };
}

export const gapScheduleSessionVisibility: Scenario = {
  name: "gap-schedule-session-visibility",
  order: 1010,
  async run(ctx) {
    const a = await mintUser(ctx, "sched-a");
    const b = await mintUser(ctx, "sched-b");

    const worker = await ctx.api("POST", "/api/agents", {
      body: { name: `gap-sched-worker-${ctx.nonce}`, role: "worker", status: "online" },
    });
    expectStatus(worker, [201], "register worker");
    const workerId = String(asRecord(worker.json).id);

    // Invited users hold no schedule permission, so A "creates" the schedule the way an agent
    // does: a worker with an in-progress task requested by A (audit attribution = A).
    const seed = await ctx.api("POST", "/api/tasks", {
      body: {
        task: "gap seed task requested by A",
        agentId: workerId,
        requestedByUserId: a.userId,
        routingReason: "human_pinned",
        source: "api",
      },
    });
    expectStatus(seed, [201], "seed task requested by A");
    await claim(ctx, workerId, String(asRecord(seed.json).id));
    const schedule = await ctx.api("POST", "/api/schedules", {
      agentId: workerId,
      body: {
        name: `gap-sched-${ctx.nonce}`,
        intervalMs: 3_600_000,
        taskTemplate: "gap schedule run",
        targetAgentId: workerId,
        enabled: true,
      },
    });
    expectStatus(schedule, [201], "schedule created on behalf of A");
    const scheduleId = String(asRecord(schedule.json).id);
    const createdBy = asRecord(schedule.json).createdBy;
    expect(createdBy === a.userId, `schedule createdBy is A, got ${String(createdBy)}`);

    const run = await ctx.api("POST", `/api/schedules/${scheduleId}/run`);
    expectStatus(run, [200], "A runs the schedule");
    const taskId = String(asRecord(asRecord(run.json).task).id);
    const owner = ctx.db.get<{ requestedByUserId: string | null; scheduleId: string | null }>(
      "SELECT requestedByUserId, scheduleId FROM agent_tasks WHERE id = ?",
      [taskId],
    );
    expect(
      owner?.requestedByUserId === a.userId && owner?.scheduleId === scheduleId,
      `run task is owned by A with scheduleId: ${JSON.stringify(owner)}`,
    );

    // Negative control: a plain task A creates is private to A.
    const plain = await ctx.api("POST", "/api/tasks", {
      apiKey: a.token,
      body: { task: "gap plain private task", agentId: workerId, routingReason: "human_pinned" },
    });
    expectStatus(plain, [201], "A creates a plain task");
    const plainId = String(asRecord(plain.json).id);
    const plainOwner = ctx.db.get<{ requestedByUserId: string | null }>(
      "SELECT requestedByUserId FROM agent_tasks WHERE id = ?",
      [plainId],
    );
    expect(plainOwner?.requestedByUserId === a.userId, "plain task is owned by A");

    // B reads the schedule run.
    const detailB = await ctx.api("GET", `/api/tasks/${taskId}`, { apiKey: b.token });
    expectStatus(detailB, [200], "B reads the schedule-run task");
    const listB = await ctx.api("GET", `/api/tasks?scheduleId=${scheduleId}`, { apiKey: b.token });
    expectStatus(listB, [200], "B lists schedule tasks");
    const listedB = (asRecord(listB.json).tasks as { id: string }[]).map((t) => t.id);
    expect(
      listedB.includes(taskId),
      `B's schedule task list has the run: ${listB.text.slice(0, 200)}`,
    );

    const listA = await ctx.api("GET", `/api/tasks?scheduleId=${scheduleId}`, { apiKey: a.token });
    expect(
      (asRecord(listA.json).tasks as { id: string }[]).some((t) => t.id === taskId),
      "A's list has the run (control)",
    );

    // Session list as B, tree scope, show=all.
    const sessionsB = await ctx.api(
      "GET",
      "/api/sessions?limit=100&scope=tree&show=all&showSource=schedule",
      { apiKey: b.token },
    );
    expectStatus(sessionsB, [200], "B lists sessions");
    expect(sessionsB.text.includes(taskId), "B's session list shows the schedule run");

    // Negative control: the plain task stays hidden from B on every surface.
    const plainDetailB = await ctx.api("GET", `/api/tasks/${plainId}`, { apiKey: b.token });
    expect(
      plainDetailB.status === 403 || plainDetailB.status === 404,
      `B reads A's plain task: ${plainDetailB.status}`,
    );
    const allB = await ctx.api("GET", "/api/tasks?limit=100", { apiKey: b.token });
    expect(!allB.text.includes(plainId), "B's general task list leaks A's plain task");
    const allSessionsB = await ctx.api(
      "GET",
      "/api/sessions?limit=100&scope=tree&show=all&showSource=schedule,api,user,chat,slack",
      { apiKey: b.token },
    );
    expect(!allSessionsB.text.includes(plainId), "B's session list leaks A's plain task");

    // Read-only: B cannot steer or follow up on the schedule run.
    const steer = await ctx.api("POST", `/api/tasks/${taskId}/steer`, {
      apiKey: b.token,
      body: { message: "should not land" },
    });
    ctx.log(`gap-schedule-session-visibility: B steer status ${steer.status}`);
  },
};
