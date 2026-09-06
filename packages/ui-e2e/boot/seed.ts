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

async function ensureUser(options: SeedOptions): Promise<User> {
  const users = await request<{ users: (User | null)[] }>(options, "GET", "/api/users");
  const existing = users.users.find((user): user is User => user?.name === "e2e-user");
  if (existing) return existing;
  const result = await request<{ user: User }>(options, "POST", "/api/users", {
    body: { name: "e2e-user" },
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
  return request<Task>(options, "POST", "/api/tasks", { body: { key, ...body } });
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

async function poll(options: SeedOptions, agentId: string): Promise<void> {
  await request(options, "GET", "/api/poll", { agentId });
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

  const publicPage = await ensurePage(options, lead.id, "e2e public page", "public");
  const authedPage = await ensurePage(options, lead.id, "e2e authed page", "authed");
  await ensureMemory(options);

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
    },
    pages: { public: publicPage, authed: authedPage },
    session: { id: sessionId },
    memory: { name: "e2e memory" },
  };
}
