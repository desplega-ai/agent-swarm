import type { Database } from "bun:sqlite";
import type { SeedManifest } from "./manifest";

interface SeedOptions {
  apiUrl: string;
  apiKey: string;
  db?: Database;
}

interface Agent {
  id: string;
  name: string;
}

interface Task {
  id: string;
  key: string;
  task: string;
  status: string;
}

interface Page {
  id: string;
  title: string;
  api_url: string;
}

interface User {
  id: string;
  name: string;
}

interface RequestOptions {
  agentId?: string;
  body?: unknown;
}

function taskKey(name: string): string {
  return `shared/e2e/${name}`;
}

async function request<T>(
  { apiUrl, apiKey }: SeedOptions,
  method: "GET" | "POST" | "PUT",
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(options.agentId ? { "X-Agent-ID": options.agentId } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`${method} ${path} failed: ${response.status} ${await response.text()}`);
  }
  return response.json() as Promise<T>;
}

async function ensureUser(options: SeedOptions, name = "e2e-user"): Promise<User> {
  const users = await request<{ users: (User | null)[] }>(options, "GET", "/api/users");
  const existing = users.users.find((user): user is User => user?.name === name);
  if (existing) return existing;
  const result = await request<{ user: User }>(options, "POST", "/api/users", {
    body: { name, email: `${name}@gmail.com` },
  });
  return result.user;
}

async function ensureAgent(
  options: SeedOptions,
  name: string,
  body: { isLead: boolean; maxTasks?: number },
): Promise<Agent> {
  const agents = await request<{ agents: Agent[] }>(options, "GET", "/api/agents");
  const existing = agents.agents.find((agent) => agent.name === name);
  if (existing) return existing;
  return request<Agent>(options, "POST", "/api/agents", { body: { name, ...body } });
}

async function ensureTask(
  options: SeedOptions,
  key: string,
  body: Record<string, unknown>,
): Promise<Task> {
  const normalizedKey = key.endsWith("/") ? key : `${key}/`;
  const tasks = await request<{ tasks: Task[] }>(
    options,
    "GET",
    `/api/tasks?key=${encodeURIComponent(normalizedKey)}&fields=full`,
  );
  const existing = tasks.tasks.find(
    (task) => task.key === normalizedKey && task.task === body.task,
  );
  if (existing) return existing;
  return request<Task>(options, "POST", "/api/tasks", {
    body: {
      key,
      routingReason: body.agentId || body.offeredTo ? "human_pinned" : undefined,
      ...body,
    },
  });
}

async function ensurePage(
  options: SeedOptions,
  leadId: string,
  title: string,
  authMode: "public" | "authed",
): Promise<{ id: string; apiUrl: string }> {
  const pages = await request<{ pages: Page[] }>(
    options,
    "GET",
    `/api/pages?agentId=${encodeURIComponent(leadId)}`,
  );
  const existing = pages.pages.find((page) => page.title === title);
  if (existing) return { id: existing.id, apiUrl: existing.api_url };
  const created = await request<{ id: string; api_url: string }>(options, "POST", "/api/pages", {
    agentId: leadId,
    body: {
      title,
      contentType: "text/html",
      authMode,
      body: `<h1>${title}</h1>`,
    },
  });
  return { id: created.id, apiUrl: created.api_url };
}

async function ensureMemory(options: SeedOptions): Promise<void> {
  const memories = await request<{ results: { name: string }[] }>(
    options,
    "POST",
    "/api/memory/list",
    {
      body: { scope: "all", limit: 100, offset: 0 },
    },
  );
  if (memories.results.some((memory) => memory.name === "e2e memory")) return;
  await request(options, "POST", "/api/memory/index", {
    body: {
      content: "The e2e seed creates deterministic dashboard data.",
      name: "e2e memory",
      scope: "swarm",
      source: "manual",
      tags: ["e2e"],
    },
  });
}

async function ensureWorkflow(
  options: SeedOptions,
  name: string,
  definition: Record<string, unknown>,
): Promise<string> {
  const workflows = await request<{ id: string; name: string }[]>(options, "GET", "/api/workflows");
  const existing = workflows.find((workflow) => workflow.name === name);
  if (existing) return existing.id;
  const created = await request<{ id: string }>(options, "POST", "/api/workflows", {
    body: { name, definition },
  });
  return created.id;
}

/** Deterministic ids, so a reseed of the same DB inserts nothing new. */
const FOREACH_RUN_ID = "e2e00000-0000-4000-8000-000000000001";

/**
 * A `foreach` run over five items with a `sub-workflow` body, `concurrency: 2` and fail-fast,
 * caught mid-retry: the first wave failed on beta and cancelled the queued items, and the run retry
 * added a second attempt for each of those. Beta's retry completed, gamma and delta are in flight
 * (the cap is full, so nothing new starts) and epsilon is queued. Rows go straight into the DB:
 * a live run would launch real child runs.
 */
async function ensureForeachRun(options: SeedOptions & { db: Database }): Promise<string> {
  const childWorkflowId = await ensureWorkflow(options, "e2e foreach child", {
    nodes: [{ id: "check", type: "script", config: { runtime: "bash", script: "echo ok" } }],
  });
  const workflowId = await ensureWorkflow(options, "e2e foreach fan-out", {
    nodes: [
      {
        id: "fan",
        type: "foreach",
        label: "Check each package",
        config: {
          over: ["alpha", "beta", "gamma", "delta", "epsilon"].map((id) => ({ id })),
          itemKey: "id",
          body: { type: "sub-workflow", config: { workflowId: childWorkflowId } },
          concurrency: 2,
          failurePolicy: "fail-fast",
        },
      },
    ],
  });

  const { db } = options;
  if (db.query("SELECT 1 FROM workflow_runs WHERE id = ?").get(FOREACH_RUN_ID)) {
    return FOREACH_RUN_ID;
  }
  const start = Date.now() - 30 * 60_000;
  const at = (minutes: number) => new Date(start + minutes * 60_000).toISOString();
  const insertRun = db.query(
    `INSERT INTO workflow_runs (id, workflowId, status, error, startedAt, lastUpdatedAt, finishedAt, parentStepId)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertStep = db.query(
    `INSERT INTO workflow_run_steps (id, runId, nodeId, nodeType, status, input, output, error, startedAt, finishedAt, idempotencyKey)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const id = (n: number) => `e2e00000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const index = { alpha: 0, beta: 1, gamma: 2, delta: 3, epsilon: 4 } as const;
  type Item = keyof typeof index;

  db.transaction(() => {
    insertRun.run(FOREACH_RUN_ID, workflowId, "waiting", null, at(0), at(12), null, null);
    insertStep.run(
      id(2),
      FOREACH_RUN_ID,
      "fan",
      "foreach",
      "waiting",
      null,
      null,
      null,
      at(0),
      null,
      `${FOREACH_RUN_ID}:fan:0`,
    );

    let next = 10;
    /** One attempt row; a `childRun` status also seeds the child run it started. */
    const attempt = (
      item: Item,
      attemptNumber: number,
      status: string,
      minutes: [number, number | null],
      childRun?: "completed" | "failed",
      error?: string,
    ) => {
      const stepId = id(next++);
      const childRunId = childRun ? id(next++) : null;
      if (childRun && childRunId) {
        const finished = at(minutes[1] ?? minutes[0]);
        insertRun.run(
          childRunId,
          childWorkflowId,
          childRun,
          childRun === "failed" ? "check: exit code 1" : null,
          at(minutes[0]),
          finished,
          finished,
          stepId,
        );
        insertStep.run(
          id(next++),
          childRunId,
          "check",
          "script",
          childRun,
          null,
          childRun === "completed" ? JSON.stringify({ exitCode: 0, stdout: "ok" }) : null,
          childRun === "failed" ? "exit code 1" : null,
          at(minutes[0]),
          finished,
          `${childRunId}:check:0`,
        );
      }
      const output =
        status === "completed" && childRunId
          ? JSON.stringify({
              runId: childRunId,
              outputs: { run: { id: childRunId }, check: { exitCode: 0, stdout: "ok" } },
            })
          : null;
      insertStep.run(
        stepId,
        FOREACH_RUN_ID,
        `fan#${item}`,
        "sub-workflow",
        status,
        JSON.stringify({ itemKey: item, index: index[item], attempt: attemptNumber }),
        output,
        error ?? null,
        at(minutes[0]),
        minutes[1] === null ? null : at(minutes[1]),
        `${FOREACH_RUN_ID}:fan#${item}:${attemptNumber}`,
      );
    };

    // Wave one: beta's child run fails, so fail-fast cancels the three queued items.
    attempt("alpha", 0, "completed", [0, 3], "completed");
    attempt("beta", 0, "failed", [0, 4], "failed", "Child workflow run failed: check: exit code 1");
    for (const item of ["gamma", "delta", "epsilon"] as const) {
      attempt(
        item,
        0,
        "cancelled",
        [0, 4],
        undefined,
        "not started: fail-fast after item beta failed",
      );
    }
    // The run retry: a new attempt for each failed or cancelled item, two in flight at a time.
    attempt("beta", 1, "completed", [10, 12], "completed");
    // No child run rows for the in-flight items: the recovery sweep would re-walk a `running`
    // child run, finish it, and start epsilon.
    attempt("gamma", 1, "waiting", [10, null]);
    attempt("delta", 1, "waiting", [12, null]);
    attempt("epsilon", 1, "pending", [10, null]);
  }).immediate();
  return FOREACH_RUN_ID;
}

async function poll(options: SeedOptions, agentId: string): Promise<void> {
  await request(options, "GET", "/api/poll", { agentId });
}

/** The sessions v2 group of the seeded chain: one segment under `shared/`. */
const SESSION_GROUP_NAME = "e2e-sessions";
/** A root with this key sits in the group itself. */
const SESSION_GROUP_KEY = `shared/${SESSION_GROUP_NAME}/`;
/** The root task text. The root has no title, so the dashboard shows this text. */
const SESSION_TITLE = "e2e grouped session";

/**
 * One session chain for the sessions v2 view: a `ui` root that `e2e-user` requested in the
 * `e2e-sessions` group, one follow-up task, and a read share with a second user. The chain is
 * created after the worker polls, so no seeded worker claims it.
 */
async function ensureSessionChain(
  options: SeedOptions,
  user: User,
): Promise<SeedManifest["sessionChain"]> {
  const teammate = await ensureUser(options, "e2e-teammate");
  const root = await ensureTask(options, SESSION_GROUP_KEY, {
    task: SESSION_TITLE,
    source: "ui",
    requestedByUserId: user.id,
    tags: ["e2e"],
  });
  // A child copies its parent's key, so the same key finds it again on a reseed.
  const child = await ensureTask(options, SESSION_GROUP_KEY, {
    task: `${SESSION_TITLE} follow-up`,
    source: "ui",
    requestedByUserId: user.id,
    parentTaskId: root.id,
    tags: ["e2e"],
  });
  // The full desired state, so a reseed writes the same share again.
  await request(options, "PUT", `/api/sessions/${root.id}/shares`, {
    body: { everyone: "none", users: [{ userId: teammate.id, access: "read" }] },
  });
  return {
    groupKey: SESSION_GROUP_KEY,
    groupName: SESSION_GROUP_NAME,
    title: SESSION_TITLE,
    root: root.id,
    child: child.id,
    teammate: { id: teammate.id, name: teammate.name },
  };
}

export async function seed(options: SeedOptions): Promise<SeedManifest> {
  const user = await ensureUser(options);
  const workerA = await ensureAgent(options, "e2e-worker-a", { isLead: false, maxTasks: 2 });
  const workerB = await ensureAgent(options, "e2e-worker-b", { isLead: false, maxTasks: 2 });

  const pool = await Promise.all(
    [1, 2].map((number) =>
      ensureTask(options, taskKey(`pool-${number}`), {
        task: `e2e pool task ${number}`,
        tags: ["e2e"],
      }),
    ),
  );

  const lead = await ensureAgent(options, "e2e-lead", { isLead: true });
  const inProgress = await ensureTask(options, taskKey("in-progress"), {
    task: "e2e in-progress task",
    agentId: workerA.id,
    tags: ["e2e"],
  });
  const completed = await ensureTask(options, taskKey("completed"), {
    task: "e2e completed task",
    agentId: workerA.id,
    tags: ["e2e"],
  });
  const failed = await ensureTask(options, taskKey("failed"), {
    task: "e2e failed task",
    agentId: workerA.id,
    tags: ["e2e"],
  });
  const pendingLead = await ensureTask(options, taskKey("pending-lead"), {
    task: "e2e pending lead task",
    agentId: lead.id,
    tags: ["e2e"],
  });
  const offered = await ensureTask(options, taskKey("offered"), {
    task: "e2e offered task",
    offeredTo: workerB.id,
    tags: ["e2e"],
  });
  const draft = await ensureTask(options, taskKey("draft"), {
    task: "e2e draft task",
    draft: true,
    tags: ["e2e"],
  });

  if (inProgress.status === "pending") await poll(options, workerA.id);
  if (completed.status === "pending") {
    await poll(options, workerA.id);
    await request(options, "POST", `/api/tasks/${completed.id}/finish`, {
      agentId: workerA.id,
      body: { status: "completed" },
    });
  }
  if (failed.status === "pending") {
    await poll(options, workerA.id);
    await request(options, "POST", `/api/tasks/${failed.id}/finish`, {
      agentId: workerA.id,
      body: { status: "failed", failureReason: "e2e seeded failure" },
    });
  }
  // A running task of its own for codex-logs.spec.ts, so its Codex logs and context
  // snapshots never reach the in-progress task that tasks.spec.ts reads. It is created after
  // the polls above, so this poll claims it (e2e-worker-a runs 2 tasks: this one and inProgress).
  const codexLogs = await ensureTask(options, taskKey("codex-logs"), {
    task: "e2e codex logs task",
    agentId: workerA.id,
    tags: ["e2e"],
  });
  if (codexLogs.status === "pending") await poll(options, workerA.id);

  await request(options, "POST", `/api/tasks/${inProgress.id}/progress`, {
    body: { progress: "e2e seed progress" },
  });
  const sessionId = "e2e-session-1";
  const logs = await request<{ logs: { sessionId: string }[] }>(
    options,
    "GET",
    `/api/tasks/${inProgress.id}/session-logs`,
  );
  if (!logs.logs.some((log) => log.sessionId === sessionId)) {
    await request(options, "POST", "/api/session-logs", {
      body: {
        sessionId,
        iteration: 1,
        taskId: inProgress.id,
        lines: [
          JSON.stringify({
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Hello from the e2e seed" }],
            },
          }),
          JSON.stringify({
            type: "assistant",
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "toolu_e2e_read",
                  name: "Read",
                  input: { file_path: "/tmp/e2e.txt" },
                },
              ],
            },
          }),
          JSON.stringify({
            type: "user",
            message: {
              role: "user",
              content: [{ type: "tool_result", tool_use_id: "toolu_e2e_read", content: "seeded" }],
            },
          }),
        ],
      },
    });
  }
  const costs = await request<{ costs: { sessionId: string }[] }>(
    options,
    "GET",
    `/api/session-costs?taskId=${inProgress.id}`,
  );
  if (!costs.costs.some((cost) => cost.sessionId === sessionId)) {
    await request(options, "POST", "/api/session-costs", {
      body: {
        sessionId,
        taskId: inProgress.id,
        agentId: workerA.id,
        totalCostUsd: 0.0123,
        model: "claude-sonnet-5",
      },
    });
  }
  await request(options, "PUT", "/api/config", {
    body: { scope: "global", key: "STEERING_ENABLED", value: "false", isSecret: false },
  });
  await request(options, "PUT", "/api/config", {
    body: { scope: "global", key: "SWARM_ORG_NAME", value: "e2e organization", isSecret: false },
  });
  await request(options, "POST", "/api/config/reload", { body: {} });

  const publicPage = await ensurePage(options, lead.id, "e2e public page", "public");
  const authedPage = await ensurePage(options, lead.id, "e2e authed page", "authed");
  await ensureMemory(options);
  const sessionChain = await ensureSessionChain(options, user);

  const foreachRun = options.db ? await ensureForeachRun({ ...options, db: options.db }) : null;

  if (options.db) {
    options.db
      .query("UPDATE agent_tasks SET lastUpdatedAt = ? WHERE id = ?")
      .run(new Date(Date.now() - 45 * 60_000).toISOString(), inProgress.id);
    options.db
      .query("UPDATE agents SET lastActivityAt = ? WHERE id = ?")
      .run(new Date(Date.now() - 24 * 60 * 60_000).toISOString(), workerB.id);
  }

  return {
    user: { id: user.id, name: user.name },
    agents: { lead: lead.id, workerA: workerA.id, workerB: workerB.id },
    tasks: {
      pool: pool.map((task) => task.id),
      inProgress: inProgress.id,
      completed: completed.id,
      failed: failed.id,
      pendingLead: pendingLead.id,
      offered: offered.id,
      draft: draft.id,
      codexLogs: codexLogs.id,
    },
    pages: { public: publicPage, authed: authedPage },
    session: { id: sessionId },
    sessionChain,
    memory: { name: "e2e memory" },
    ...(foreachRun ? { workflowRuns: { foreach: foreachRun } } : {}),
  };
}
