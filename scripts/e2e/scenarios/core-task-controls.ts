import { asRecord, asRecords, expect, expectStatus } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import {
  cancelQuietly,
  claimTask,
  createAssignedTask,
  readTask,
  registerWorker,
  UUID,
} from "./core-helpers";

const GHOST = "00000000-0000-4000-8000-00000000dead";

/** Session id, title and VCS metadata a worker or the dashboard attaches to a task. */
async function taskMetadata(ctx: ScenarioContext, agentId: string, otherId: string) {
  const taskId = await createAssignedTask(ctx, agentId, `metadata task ${ctx.nonce}`);
  await claimTask(ctx, agentId, taskId);

  // PUT /api/tasks/{id}/session
  let response = await ctx.api("PUT", `/api/tasks/${taskId}/session`, {
    body: {
      claudeSessionId: `claude-${ctx.nonce}`,
      provider: "claude",
      model: "sonnet",
      effort: "high",
      providerMeta: { transport: "sdk" },
    },
  });
  expectStatus(response, [200], "record the provider session");
  let task = asRecord(response.json);
  expect(
    task.claudeSessionId === `claude-${ctx.nonce}` &&
      task.provider === "claude" &&
      task.model === "sonnet" &&
      task.resolvedEffort === "high",
    `Session fields not stored: ${JSON.stringify(task)}`,
  );
  expect(
    ctx.db.get<{ claudeSessionId: string }>(
      "SELECT claudeSessionId FROM agent_tasks WHERE id = ?",
      [taskId],
    )?.claudeSessionId === `claude-${ctx.nonce}`,
    "agent_tasks row lacks the session id",
  );
  response = await ctx.api("PUT", `/api/tasks/${taskId}/session`, {
    body: {
      claudeSessionId: `devin-${ctx.nonce}`,
      provider: "devin",
      providerMeta: { sessionUrl: "https://example.com/session/1" },
    },
  });
  expectStatus(response, [200], "record a devin session");
  expect(
    asRecord(asRecord(response.json).providerMeta).sessionUrl === "https://example.com/session/1",
    "Devin providerMeta not stored",
  );
  expectStatus(
    await ctx.api("PUT", `/api/tasks/${taskId}/session`, {
      body: { claudeSessionId: "x", provider: "not-a-provider" },
    }),
    [400],
    "unknown provider",
  );
  expectStatus(
    await ctx.api("PUT", `/api/tasks/${GHOST}/session`, { body: { claudeSessionId: "x" } }),
    [404],
    "session of an unknown task",
  );

  // PATCH /api/tasks/{id}/title: set, clear with null, clear with "", 404.
  response = await ctx.api("PATCH", `/api/tasks/${taskId}/title`, {
    body: { title: `Renamed ${ctx.nonce}` },
  });
  expectStatus(response, [200], "set the title");
  expect(asRecord(asRecord(response.json).task).title === `Renamed ${ctx.nonce}`, "Title not set");
  expect((await readTask(ctx, taskId)).title === `Renamed ${ctx.nonce}`, "Title not persisted");
  response = await ctx.api("PATCH", `/api/tasks/${taskId}/title`, { body: { title: null } });
  expectStatus(response, [200], "clear the title with null");
  expect(!("title" in asRecord(asRecord(response.json).task)), "null did not clear the title");
  await ctx.api("PATCH", `/api/tasks/${taskId}/title`, { body: { title: "again" } });
  response = await ctx.api("PATCH", `/api/tasks/${taskId}/title`, { body: { title: "" } });
  expectStatus(response, [200], "clear the title with an empty string");
  expect(!("title" in asRecord(asRecord(response.json).task)), "Empty title did not clear it");
  expectStatus(
    await ctx.api("PATCH", `/api/tasks/${taskId}/title`, { body: { title: 5 } }),
    [400],
    "title of the wrong type",
  );
  expectStatus(
    await ctx.api("PATCH", `/api/tasks/${GHOST}/title`, { body: { title: "x" } }),
    [404],
    "title of an unknown task",
  );

  // PATCH /api/tasks/{id}/vcs
  const vcs = {
    vcsProvider: "github",
    vcsRepo: `desplega-ai/core-${ctx.nonce}`,
    vcsNumber: 42,
    vcsUrl: `https://github.com/desplega-ai/core-${ctx.nonce}/pull/42`,
  };
  response = await ctx.api("PATCH", `/api/tasks/${taskId}/vcs`, { body: vcs });
  expectStatus(response, [200], "attach a pull request");
  task = await readTask(ctx, taskId);
  expect(
    task.vcsProvider === "github" && task.vcsNumber === 42 && task.vcsUrl === vcs.vcsUrl,
    "VCS fields not persisted",
  );
  expectStatus(
    await ctx.api("PATCH", `/api/tasks/${taskId}/vcs`, { body: { ...vcs, vcsProvider: "nope" } }),
    [400],
    "unknown VCS provider",
  );
  expectStatus(
    await ctx.api("PATCH", `/api/tasks/${GHOST}/vcs`, { body: vcs }),
    [404],
    "vcs of an unknown task",
  );
  // A worker token may only touch its own agent's tasks.
  const minted = await ctx.api("POST", `/api/agents/${otherId}/token`, { body: {} });
  expectStatus(minted, [200], "mint the other agent's token");
  const otherToken = String(asRecord(minted.json).plaintext);
  response = await ctx.api("PATCH", `/api/tasks/${taskId}/vcs`, { apiKey: otherToken, body: vcs });
  expectStatus(response, [403], "vcs from another agent's token");
  expect(String(asRecord(response.json).error).includes("another token agent"), "403 lacks reason");
  await ctx.api("DELETE", `/api/agents/${otherId}/token`);

  await cancelQuietly(ctx, taskId);
}

/** Context-window snapshots a worker reports while it runs. */
async function contextSnapshots(ctx: ScenarioContext, agentId: string) {
  const taskId = await createAssignedTask(ctx, agentId, `context task ${ctx.nonce}`);
  await claimTask(ctx, agentId, taskId);

  let response = await ctx.api("POST", `/api/tasks/${taskId}/context`, {
    agentId,
    body: {
      eventType: "progress",
      sessionId: `ctx-${ctx.nonce}`,
      contextUsedTokens: 40_000,
      contextTotalTokens: 200_000,
      contextPercent: 20,
    },
  });
  expectStatus(response, [200], "record a progress snapshot");
  expect(
    asRecord(response.json).ok === true && UUID.test(String(asRecord(response.json).snapshotId)),
    "Snapshot response is malformed",
  );
  response = await ctx.api("POST", `/api/tasks/${taskId}/context`, {
    agentId,
    body: {
      eventType: "compaction",
      sessionId: `ctx-${ctx.nonce}`,
      contextUsedTokens: 90_000,
      contextTotalTokens: 200_000,
      contextPercent: 45,
      compactTrigger: "auto",
      preCompactTokens: 170_000,
    },
  });
  expectStatus(response, [200], "record a compaction snapshot");

  response = await ctx.api("GET", `/api/tasks/${taskId}/context`);
  expectStatus(response, [200], "read context history");
  const history = asRecord(response.json);
  const snapshots = asRecords(history, "snapshots");
  expect(snapshots.length === 2, `Expected 2 snapshots, got ${snapshots.length}`);
  expect(
    snapshots.every((row) => row.taskId === taskId && row.agentId === agentId),
    "Snapshots carry the wrong task or agent",
  );
  const summary = asRecord(history.summary);
  expect(
    summary.snapshotCount === 2 &&
      summary.compactionCount === 1 &&
      summary.peakContextPercent === 45 &&
      summary.contextWindowSize === 200_000,
    `Unexpected context summary ${JSON.stringify(summary)}`,
  );
  response = await ctx.api("GET", `/api/tasks/${taskId}/context?limit=1`);
  expect(asRecords(response.json, "snapshots").length === 1, "limit=1 returned more than one row");
  expect(
    ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM task_context_snapshots WHERE taskId = ?", [
      taskId,
    ])?.n === 2,
    "task_context_snapshots does not hold both rows",
  );

  expectStatus(
    await ctx.api("POST", `/api/tasks/${taskId}/context`, {
      body: { eventType: "progress", sessionId: "x" },
    }),
    [400],
    "snapshot without X-Agent-ID",
  );
  expectStatus(
    await ctx.api("POST", `/api/tasks/${taskId}/context`, {
      agentId,
      body: { eventType: "nonsense", sessionId: "x" },
    }),
    [400],
    "snapshot with an unknown event type",
  );
  expectStatus(
    await ctx.api("POST", `/api/tasks/${GHOST}/context`, {
      agentId,
      body: { eventType: "progress", sessionId: "x" },
    }),
    [404],
    "snapshot of an unknown task",
  );
  expectStatus(
    await ctx.api("GET", `/api/tasks/${GHOST}/context`),
    [404],
    "context of unknown task",
  );
  await cancelQuietly(ctx, taskId);
}

/** Pause, resume and the paused-task list. */
async function pauseAndResume(ctx: ScenarioContext, agentId: string, otherId: string) {
  const taskId = await createAssignedTask(ctx, agentId, `pause task ${ctx.nonce}`);
  expectStatus(
    await ctx.api("POST", `/api/tasks/${taskId}/pause`, { agentId }),
    [400],
    "pause a task that has not started",
  );
  await claimTask(ctx, agentId, taskId);

  expectStatus(
    await ctx.api("POST", `/api/tasks/${taskId}/pause`, { agentId: otherId }),
    [403],
    "pause as another agent",
  );
  let response = await ctx.api("POST", `/api/tasks/${taskId}/pause`, { agentId });
  expectStatus(response, [200], "pause");
  expect(
    asRecord(response.json).success === true &&
      asRecord(asRecord(response.json).task).status === "paused",
    "Pause did not report a paused task",
  );
  expect((await readTask(ctx, taskId)).status === "paused", "Task is not paused");
  expectStatus(
    await ctx.api("POST", `/api/tasks/${taskId}/pause`, { agentId }),
    [400],
    "pause a paused task",
  );

  response = await ctx.api("GET", "/api/paused-tasks", { agentId });
  expectStatus(response, [200], "list paused tasks");
  const paused = asRecords(response.json, "tasks");
  expect(
    paused.some((task) => task.id === taskId),
    "Paused list omitted the task",
  );
  response = await ctx.api("GET", "/api/paused-tasks", { agentId: otherId });
  expect(
    !asRecords(response.json, "tasks").some((task) => task.id === taskId),
    "Another agent sees the paused task",
  );
  expectStatus(await ctx.api("GET", "/api/paused-tasks"), [400], "paused list without X-Agent-ID");

  expectStatus(
    await ctx.api("POST", `/api/tasks/${taskId}/resume`, { agentId: otherId }),
    [403],
    "resume as another agent",
  );
  response = await ctx.api("POST", `/api/tasks/${taskId}/resume`, { agentId });
  expectStatus(response, [200], "resume");
  expect(asRecord(asRecord(response.json).task).status === "in_progress", "Resume did not restart");
  expect((await readTask(ctx, taskId)).wasPaused === true, "wasPaused flag not set after resume");
  expectStatus(
    await ctx.api("POST", `/api/tasks/${taskId}/resume`, { agentId }),
    [400],
    "resume a running task",
  );
  expectStatus(await ctx.api("POST", `/api/tasks/${GHOST}/pause`), [404], "pause unknown task");
  expectStatus(await ctx.api("POST", `/api/tasks/${GHOST}/resume`), [404], "resume unknown task");
  await cancelQuietly(ctx, taskId);
}

/** Supersede: terminate a running task and spawn its resume task. */
async function supersede(ctx: ScenarioContext, agentId: string, otherId: string) {
  const pending = await createAssignedTask(ctx, agentId, `supersede pending ${ctx.nonce}`);
  expectStatus(
    await ctx.api("POST", `/api/tasks/${pending}/supersede`, {
      agentId,
      body: { reason: "manual_supersede" },
    }),
    [400],
    "supersede a task that has not started",
  );
  await cancelQuietly(ctx, pending);

  const taskId = await createAssignedTask(ctx, agentId, `supersede running ${ctx.nonce}`);
  await claimTask(ctx, agentId, taskId);
  expectStatus(
    await ctx.api("POST", `/api/tasks/${taskId}/supersede`, {
      agentId: otherId,
      body: { reason: "manual_supersede" },
    }),
    [403],
    "supersede as another agent",
  );
  expectStatus(
    await ctx.api("POST", `/api/tasks/${taskId}/supersede`, { agentId, body: { reason: "bogus" } }),
    [400],
    "supersede with an unknown reason",
  );
  let response = await ctx.api("POST", `/api/tasks/${taskId}/supersede`, {
    agentId,
    body: { reason: "manual_supersede" },
  });
  expectStatus(response, [200], "supersede");
  const result = asRecord(response.json);
  expect(
    result.kind === "resumed" && result.success === true,
    `Supersede kind ${String(result.kind)}`,
  );
  expect(asRecord(result.task).status === "superseded", "Original task is not superseded");
  expect((await readTask(ctx, taskId)).status === "superseded", "superseded status not persisted");
  // FINDING: cancel and finish recompute the agent's status from its capacity, supersede does not.
  // After superseding its only running task the agent still reads "busy" with capacity.current 0.
  const afterSupersede = asRecord((await ctx.api("GET", `/api/agents/${agentId}`)).json);
  expect(
    asRecord(afterSupersede.capacity).current === 0 && afterSupersede.status === "busy",
    `Expected the stale busy status after supersede (FINDING), got ${String(afterSupersede.status)}`,
  );

  const resumeId = result.resumeTaskId;
  expect(typeof resumeId === "string" && UUID.test(resumeId), "Supersede created no resume task");
  const resume = await readTask(ctx, resumeId);
  expect(
    resume.parentTaskId === taskId && resume.taskType === "resume",
    `Resume task is wrong: parent ${String(resume.parentTaskId)} type ${String(resume.taskType)}`,
  );

  response = await ctx.api("POST", `/api/tasks/${taskId}/supersede`, {
    agentId,
    body: { reason: "manual_supersede" },
  });
  expectStatus(response, [200], "supersede again");
  expect(
    asRecord(response.json).kind === "alreadyFinished",
    "A second supersede is not idempotent",
  );
  expectStatus(
    await ctx.api("POST", `/api/tasks/${GHOST}/supersede`, {
      body: { reason: "manual_supersede" },
    }),
    [404],
    "supersede unknown task",
  );

  // Lineage walks from any task to the root and down again.
  response = await ctx.api("GET", `/api/tasks/${resumeId}/lineage`);
  expectStatus(response, [200], "lineage of the resume task");
  const lineage = asRecord(response.json);
  const ids = asRecords(lineage, "tasks").map((row) => row.id);
  expect(
    lineage.rootTaskId === taskId && ids.includes(taskId) && ids.includes(resumeId),
    `Lineage ${JSON.stringify(lineage)}`,
  );
  response = await ctx.api("GET", `/api/tasks/${taskId}/lineage?maxNodes=1`);
  expectStatus(response, [200], "bounded lineage");
  expect(asRecord(response.json).truncated === true, "A one-node lineage should be truncated");
  expectStatus(await ctx.api("GET", `/api/tasks/${GHOST}/lineage`), [404], "unknown lineage");
  expectStatus(
    await ctx.api("GET", `/api/tasks/${taskId}/lineage?maxNodes=0`),
    [400],
    "lineage with maxNodes=0",
  );

  await cancelQuietly(ctx, resumeId);
}

/** Draft tasks stay out of dispatch until they are promoted. */
async function drafts(ctx: ScenarioContext, agentId: string) {
  const response = await ctx.api("POST", "/api/tasks", {
    body: {
      task: `draft task ${ctx.nonce}`,
      agentId,
      routingReason: "human_pinned",
      source: "api",
      draft: true,
    },
  });
  expectStatus(response, [201], "create a draft");
  const draftId = String(asRecord(response.json).id);
  expect(asRecord(response.json).status === "draft", "A draft task is not in the draft status");

  const poll = await ctx.api("GET", "/api/poll", { agentId });
  expectStatus(poll, [200], "poll with a draft pending");
  expect(
    asRecord(asRecord(poll.json).trigger ?? {}).taskId !== draftId,
    "A draft task was dispatched",
  );

  const promoted = await ctx.api("POST", `/api/tasks/${draftId}/promote-draft`);
  expectStatus(promoted, [200], "promote the draft");
  expect(asRecord(promoted.json).status === "pending", "A promoted owned draft is not pending");
  expect((await readTask(ctx, draftId)).status === "pending", "Promotion not persisted");
  const again = await ctx.api("POST", `/api/tasks/${draftId}/promote-draft`);
  expectStatus(again, [200], "promote again");
  expect(asRecord(again.json).status === "pending", "Promotion is not idempotent");
  expectStatus(
    await ctx.api("POST", `/api/tasks/${GHOST}/promote-draft`),
    [404],
    "promote an unknown task",
  );
  await claimTask(ctx, agentId, draftId);
  await cancelQuietly(ctx, draftId);
}

export const coreTaskControls: Scenario = {
  name: "core-task-controls",
  order: 220,
  async run(ctx) {
    const agentId = await registerWorker(ctx, "controls", { maxTasks: 4 });
    const otherId = await registerWorker(ctx, "controls-other");
    await taskMetadata(ctx, agentId, otherId);
    await contextSnapshots(ctx, agentId);
    await pauseAndResume(ctx, agentId, otherId);
    await supersede(ctx, agentId, otherId);
    await drafts(ctx, agentId);
  },
};
