import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  claimTask,
  closeDb,
  createAgent,
  createTaskExtended,
  getDb,
  getTaskById,
  initDb,
} from "../be/db";
import { createEdgeHandler } from "../be/edge-handlers-db";
import { getEventsByEvent } from "../be/events";
import { listTraceForTask } from "../be/routing-trace-db";
import { upsertScriptByName } from "../be/scripts/db";
import { setScriptEmbeddingProviderForTests } from "../be/scripts/embeddings";
import { handlePoll } from "../http/poll";
import { createTaskRouted } from "../tasks/create-task-routed";
import { createResumeFollowUp, createWorkerTaskFollowUp } from "../tasks/worker-follow-up";
import { sendTaskHandler } from "../tools/send-task";
import type { AgentTask, EdgeHandlerMatcher } from "../types";

const TEST_DB_PATH = "./test-routing-vias.sqlite";
const API_KEY = "test-routing-vias-key-1234567890";

const noOpEmbeddingProvider = {
  name: "test/noop-routing-vias-embedding",
  dimensions: 1,
  async embed() {
    return null;
  },
  async embedBatch(texts: string[]) {
    return texts.map(() => null);
  },
};

let savedEnv: NodeJS.ProcessEnv;
let leadId: string;
let workerAId: string;
let workerBId: string;

function removeDbFiles(): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(TEST_DB_PATH + suffix);
    } catch {
      // Missing test DB files are expected.
    }
  }
}

async function saveRoutingScript(name: string, result: unknown): Promise<void> {
  await upsertScriptByName({
    name,
    scope: "global",
    source: `export default async function run() { return ${JSON.stringify(result)}; }`,
    description: `${name} routing test fixture`,
    intent: "routing vias test fixture",
    signatureJson: JSON.stringify({ args: { type: "object" }, result: { type: "object" } }),
    agentId: leadId,
    typeChecked: true,
  });
}

async function registerHandler(args: {
  name: string;
  result: unknown;
  flavor?: "route" | "guard";
  mode?: "soft" | "hard";
  matcher: EdgeHandlerMatcher;
}): Promise<void> {
  await saveRoutingScript(args.name, args.result);
  createEdgeHandler({
    name: args.name,
    edge: "task.before_assign",
    scriptName: args.name,
    flavor: args.flavor ?? "route",
    mode: args.mode ?? "hard",
    matcher: args.matcher,
    createdByAgentId: leadId,
  });
}

async function pollForTrigger(agentId: string): Promise<{
  trigger: { type: string; taskId?: string } | null;
}> {
  let body = "";
  const req = { method: "GET", headers: {} } as IncomingMessage;
  const res = {
    writeHead() {
      return this;
    },
    end(chunk?: string) {
      body = chunk ?? "";
      return this;
    },
  } as unknown as ServerResponse;

  expect(await handlePoll(req, res, ["api", "poll"], new URLSearchParams(), agentId)).toBe(true);
  return JSON.parse(body) as { trigger: { type: string; taskId?: string } | null };
}

function countRerouteDecisionChildren(parentTaskId: string): number {
  return (
    getDb()
      .prepare<{ count: number }, [string]>(
        `SELECT COUNT(*) AS count
         FROM agent_tasks
         WHERE parentTaskId = ? AND taskType = 'reroute-decision'`,
      )
      .get(parentTaskId)?.count ?? 0
  );
}

beforeAll(async () => {
  savedEnv = { ...process.env };
  removeDbFiles();
  initDb(TEST_DB_PATH);
  process.env.AGENT_SWARM_API_KEY = API_KEY;
  delete process.env.API_KEY;
  setScriptEmbeddingProviderForTests(noOpEmbeddingProvider);
  leadId = createAgent({
    name: "routing-vias-lead",
    isLead: true,
    status: "idle",
    maxTasks: 20,
  }).id;
  workerAId = createAgent({
    name: "routing-vias-worker-a",
    isLead: false,
    status: "idle",
    maxTasks: 20,
  }).id;
  workerBId = createAgent({
    name: "routing-vias-worker-b",
    isLead: false,
    status: "idle",
    maxTasks: 20,
  }).id;
});

afterEach(() => {
  getDb().run("DELETE FROM edge_handlers");
  // Poll tests must not consume live fixtures left by an earlier creation or
  // delegation case. Each test is self-contained, so terminalize all remaining
  // claimable work between cases (also isolates Bun's retry attempts).
  getDb().run(
    "UPDATE agent_tasks SET status = 'cancelled' WHERE status IN ('unassigned', 'pending', 'in_progress', 'offered')",
  );
});

afterAll(() => {
  setScriptEmbeddingProviderForTests(null);
  closeDb();
  removeDbFiles();
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("routing creation and delegation vias", () => {
  test("creation hard-assigns Slack-shaped work, backfills trace, and emits applied", async () => {
    await registerHandler({
      name: "creation-slack-hard-assign",
      result: { assignTo: workerBId },
      matcher: { via: "creation", slackChannelId: "C-TEST" },
    });

    const { task } = await createTaskRouted("Slack-shaped routed creation", {
      agentId: workerAId,
      source: "slack",
      slackChannelId: "C-TEST",
      slackThreadTs: "123.456",
    });
    const trace = listTraceForTask(task.id);

    expect(task.agentId).toBe(workerBId);
    expect(trace).toHaveLength(1);
    expect(trace[0]).toMatchObject({
      taskId: task.id,
      handlerName: "creation-slack-hard-assign",
      decisive: true,
    });
    expect(
      getEventsByEvent("routing.applied").some(
        (event) => event.data?.routingRunId === trace[0]?.routingRunId,
      ),
    ).toBe(true);
  });

  test("delegation continuity is resolved before a hard assignment override", async () => {
    const parent = createTaskExtended("delegation continuity parent", {
      agentId: workerAId,
      creatorAgentId: leadId,
    });
    await registerHandler({
      name: "delegation-hard-override",
      result: { assignTo: workerBId },
      matcher: { via: "delegation", agentId: workerAId, taskType: "delegation-override" },
    });

    const response = await sendTaskHandler(
      { kind: "owner", agentId: leadId, sourceTaskId: parent.id },
      {
        task: "delegated child with continuity",
        taskType: "delegation-override",
        offerMode: false,
        allowDuplicate: false,
        overrideSlackContext: false,
      },
    );
    const structured = response.structuredContent as {
      success: boolean;
      task?: AgentTask;
    };

    expect(structured.success).toBe(true);
    expect(structured.task).toMatchObject({
      agentId: workerBId,
      parentTaskId: parent.id,
    });
    expect(listTraceForTask(structured.task?.id ?? "")).toHaveLength(1);
  });

  test("delegation unassign drops the inherited parent-worker pin", async () => {
    const parent = createTaskExtended("delegation unassign parent", {
      agentId: workerAId,
      creatorAgentId: leadId,
    });
    await registerHandler({
      name: "delegation-unassign",
      result: { unassign: true, promptDirectives: ["fresh dispatch"] },
      matcher: { via: "delegation", agentId: workerAId, taskType: "delegation-unassign" },
    });

    const response = await sendTaskHandler(
      { kind: "owner", agentId: leadId, sourceTaskId: parent.id },
      {
        task: "delegated child that should be pooled",
        taskType: "delegation-unassign",
        offerMode: false,
        allowDuplicate: false,
        overrideSlackContext: false,
      },
    );
    const structured = response.structuredContent as { success: boolean; task?: AgentTask };

    // send-task defaults agentId to the parent's worker BEFORE routing; the
    // handler must be able to undo that and send the child to the pool.
    expect(structured.success).toBe(true);
    expect(structured.task?.agentId).toBeNull();
    expect(structured.task?.status).toBe("unassigned");
  });

  test("a SOFT handler's unassign drops the pin; its assignTo stays advisory", async () => {
    const parent = createTaskExtended("soft unassign parent", {
      agentId: workerAId,
      creatorAgentId: leadId,
    });
    await registerHandler({
      name: "delegation-soft-unassign",
      result: { unassign: true, promptDirectives: ["different kind of work"] },
      mode: "soft",
      matcher: { via: "delegation", agentId: workerAId, taskType: "delegation-soft-unassign" },
    });

    const response = await sendTaskHandler(
      { kind: "owner", agentId: leadId, sourceTaskId: parent.id },
      {
        task: "soft-unassigned child",
        taskType: "delegation-soft-unassign",
        offerMode: false,
        allowDuplicate: false,
        overrideSlackContext: false,
      },
    );
    const structured = response.structuredContent as { success: boolean; task?: AgentTask };

    // `unassign` is the one decisive action a soft handler may apply: it hands
    // routing back to the default router rather than taking authority.
    expect(structured.success).toBe(true);
    expect(structured.task?.agentId).toBeNull();
    expect(structured.task?.status).toBe("unassigned");
  });

  test("a SOFT handler's assignTo remains a suggestion only", async () => {
    const parent = createTaskExtended("soft assign parent", {
      agentId: workerAId,
      creatorAgentId: leadId,
    });
    await registerHandler({
      name: "delegation-soft-assign",
      result: { assignTo: workerBId },
      mode: "soft",
      matcher: { via: "delegation", agentId: workerAId, taskType: "delegation-soft-assign" },
    });

    const response = await sendTaskHandler(
      { kind: "owner", agentId: leadId, sourceTaskId: parent.id },
      {
        task: "soft-suggested child",
        taskType: "delegation-soft-assign",
        offerMode: false,
        allowDuplicate: false,
        overrideSlackContext: false,
      },
    );
    const structured = response.structuredContent as { success: boolean; task?: AgentTask };

    // Guard against the soft-unassign carve-out leaking into assignTo.
    expect(structured.success).toBe(true);
    expect(structured.task?.agentId).toBe(workerAId);
  });

  test("delegation fails open when a handler hard-assigns an unknown agent", async () => {
    const parent = createTaskExtended("delegation bogus target parent", {
      agentId: workerAId,
      creatorAgentId: leadId,
    });
    await registerHandler({
      name: "delegation-bogus-target",
      result: { assignTo: "00000000-0000-4000-8000-000000000000" },
      matcher: { via: "delegation", agentId: workerAId, taskType: "delegation-bogus" },
    });

    const response = await sendTaskHandler(
      { kind: "owner", agentId: leadId, sourceTaskId: parent.id },
      {
        task: "delegated child with a bogus routing target",
        taskType: "delegation-bogus",
        offerMode: false,
        allowDuplicate: false,
        overrideSlackContext: false,
      },
    );
    const structured = response.structuredContent as { success: boolean; task?: AgentTask };

    // An unknown target must be ignored, not stranded on an id no worker polls.
    expect(structured.success).toBe(true);
    expect(structured.task?.agentId).toBe(workerAId);
  });

  test("creation block returns a Lead reroute-decision task instead of original work", async () => {
    await registerHandler({
      name: "creation-block",
      result: { block: { reason: "creation policy denied" } },
      flavor: "guard",
      matcher: { via: "creation", taskType: "blocked-create" },
    });

    const { task, blocked } = await createTaskRouted("original blocked creation", {
      agentId: workerAId,
      taskType: "blocked-create",
    });

    expect(blocked).toEqual({ reason: "creation policy denied" });
    expect(task).toMatchObject({
      agentId: leadId,
      taskType: "reroute-decision",
      status: "pending",
    });
    expect(task.tags).toContain("routing-blocked");
    expect(task.task).toContain("creation policy denied");
    expect(task.task).toContain("original blocked creation");
  });

  test("delegation block creates a Lead decision and returns the reason to the caller", async () => {
    const parent = createTaskExtended("delegation block parent", {
      agentId: workerAId,
      creatorAgentId: leadId,
    });
    await registerHandler({
      name: "delegation-block",
      result: { block: { reason: "delegation policy denied" } },
      flavor: "guard",
      matcher: { via: "delegation", taskType: "blocked-delegation" },
    });

    const response = await sendTaskHandler(
      { kind: "owner", agentId: leadId, sourceTaskId: parent.id },
      {
        task: "blocked delegated work",
        taskType: "blocked-delegation",
        offerMode: false,
        allowDuplicate: false,
        overrideSlackContext: false,
      },
    );
    const structured = response.structuredContent as {
      success: boolean;
      message: string;
      task?: AgentTask;
    };

    expect(structured.success).toBe(false);
    expect(structured.message).toContain("delegation policy denied");
    expect(structured.task).toMatchObject({
      agentId: leadId,
      taskType: "reroute-decision",
      parentTaskId: parent.id,
    });
  });

  test("soft assignment suggestion does not change creation assignment", async () => {
    await registerHandler({
      name: "creation-soft-suggestion",
      result: { assignTo: workerBId },
      mode: "soft",
      matcher: { via: "creation", taskType: "soft-suggestion" },
    });

    const { task } = await createTaskRouted("soft routed creation", {
      agentId: workerAId,
      taskType: "soft-suggestion",
    });

    expect(task.agentId).toBe(workerAId);
    expect(listTraceForTask(task.id)[0]).toMatchObject({
      suggestion: workerBId,
      decisive: false,
    });
  });
});

describe("routing claim, resume, and completion vias", () => {
  test("claim assigns another agent so this poller skips and the task stays pooled", async () => {
    const task = createTaskExtended("claim redirected away from poller", {
      taskType: "claim-skip-other",
      priority: 100,
    });
    await registerHandler({
      name: "claim-skip-other",
      result: { assignTo: workerBId },
      matcher: { via: "claim", agentId: workerAId, taskType: "claim-skip-other" },
    });

    expect((await pollForTrigger(workerAId)).trigger).toBeNull();
    expect(getTaskById(task.id)).toMatchObject({
      agentId: null,
      status: "unassigned",
    });
    expect(listTraceForTask(task.id)).toHaveLength(1);

    // Keep this pooled fixture from becoming a candidate in later tests.
    expect(claimTask(task.id, workerBId)).not.toBeNull();
  });

  test("claim proceeds when the handler assigns the proposed poller", async () => {
    const task = createTaskExtended("claim accepted for proposer", {
      taskType: "claim-proceed",
      priority: 100,
    });
    await registerHandler({
      name: "claim-proceed",
      result: { assignTo: workerAId },
      matcher: { via: "claim", agentId: workerAId, taskType: "claim-proceed" },
    });

    const response = await pollForTrigger(workerAId);
    expect(response.trigger).toMatchObject({
      type: "task_assigned",
      taskId: task.id,
    });
    expect(getTaskById(task.id)).toMatchObject({
      agentId: workerAId,
      status: "in_progress",
    });
    expect(listTraceForTask(task.id)).toHaveLength(1);
  });

  test("claim block creates one idempotent Lead reroute decision", async () => {
    const task = createTaskExtended("claim blocked by guard", {
      taskType: "claim-block",
      priority: 100,
    });
    await registerHandler({
      name: "claim-block",
      result: { block: { reason: "claim policy denied" } },
      flavor: "guard",
      matcher: { via: "claim", agentId: workerAId, taskType: "claim-block" },
    });

    expect((await pollForTrigger(workerAId)).trigger).toBeNull();
    expect(countRerouteDecisionChildren(task.id)).toBe(1);
    expect(getTaskById(task.id)?.status).toBe("unassigned");

    expect((await pollForTrigger(workerAId)).trigger).toBeNull();
    expect(countRerouteDecisionChildren(task.id)).toBe(1);
    expect(getTaskById(task.id)?.status).toBe("unassigned");

    // Once the Lead FINISHES the decision, the blocked task is still pooled and
    // still hits the guard on the next poll. Decision creation must stay
    // idempotent across that boundary — otherwise every subsequent poll spawns
    // another decision (endless loop + duplicated replacement work).
    getDb()
      .prepare(
        "UPDATE agent_tasks SET status = 'completed' WHERE parentTaskId = ? AND taskType = 'reroute-decision'",
      )
      .run(task.id);
    expect((await pollForTrigger(workerAId)).trigger).toBeNull();
    expect(countRerouteDecisionChildren(task.id)).toBe(1);
    expect(getTaskById(task.id)?.status).toBe("unassigned");

    // The guard is scoped to worker A, so worker B must still be able to claim.
    expect(claimTask(task.id, workerBId)).not.toBeNull();
  });

  test("resume hard assignment overrides the same-agent pin", async () => {
    const parent = createTaskExtended("resume pin override parent", {
      agentId: workerAId,
      taskType: "resume-pin-override",
    });
    await registerHandler({
      name: "resume-pin-override",
      result: { assignTo: workerBId },
      matcher: { via: "resume", agentId: workerAId, taskType: "resume-pin-override" },
    });

    const result = await createResumeFollowUp({
      parentId: parent.id,
      reason: "context_limits",
    });

    expect(result.kind).toBe("created");
    if (result.kind !== "created") throw new Error("expected routed resume");
    expect(result.task).toMatchObject({
      agentId: workerBId,
      status: "pending",
      parentTaskId: parent.id,
      taskType: "resume",
    });
    expect(listTraceForTask(parent.id)).toHaveLength(1);
  });

  test("completion tag filter redirects the follow-up to a reviewer", async () => {
    const task = createTaskExtended("completion review route", {
      agentId: workerAId,
      tags: ["needs-review"],
    });
    await registerHandler({
      name: "completion-reviewer",
      result: { assignTo: workerBId },
      matcher: {
        via: "completion",
        filter: "(payload) => payload.task.tags.includes('needs-review')",
      },
    });

    const followUp = await createWorkerTaskFollowUp({
      task,
      status: "completed",
      output: "implementation ready for review",
    });

    expect(followUp).toMatchObject({
      agentId: workerBId,
      parentTaskId: task.id,
      taskType: "follow-up",
    });
    expect(listTraceForTask(task.id)).toHaveLength(1);
  });

  test("completion block suppresses the follow-up", async () => {
    const task = createTaskExtended("completion blocked route", {
      agentId: workerAId,
      tags: ["no-follow-up"],
    });
    await registerHandler({
      name: "completion-block",
      result: { block: { reason: "completion policy denied" } },
      flavor: "guard",
      matcher: {
        via: "completion",
        filter: "(payload) => payload.task.tags.includes('no-follow-up')",
      },
    });

    const followUp = await createWorkerTaskFollowUp({
      task,
      status: "completed",
      output: "should not produce a follow-up",
    });

    expect(followUp).toBeNull();
    expect(
      getDb()
        .prepare<{ count: number }, [string]>(
          "SELECT COUNT(*) AS count FROM agent_tasks WHERE parentTaskId = ? AND taskType = 'follow-up'",
        )
        .get(task.id)?.count ?? 0,
    ).toBe(0);
    expect(listTraceForTask(task.id)).toHaveLength(1);
  });
});
