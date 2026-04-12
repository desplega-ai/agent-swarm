#!/usr/bin/env bun
/**
 * Database seeding script for agent-swarm.
 *
 * Seeds a local SQLite database with realistic demo data for development,
 * E2E testing, and showcasing. Configurable via CLI flags or a JSON config file.
 *
 * Uses faker.js for realistic data generation with a fixed seed for reproducibility.
 *
 * Usage:
 *   bun run scripts/seed.ts                    # Use defaults from seed.default.json
 *   bun run scripts/seed.ts --clean            # Wipe DB before seeding
 *   bun run scripts/seed.ts --agents 8         # Override agent count
 *   bun run scripts/seed.ts --config my.json   # Use custom config file
 *   bun run scripts/seed.ts --db ./test.sqlite # Custom DB path
 *   bun run scripts/seed.ts --help             # Show help
 */

import { Database } from "bun:sqlite";
import { faker } from "@faker-js/faker";
import { dirname, resolve } from "node:path";
import { runMigrations } from "../src/be/migrations/runner";

// Deterministic seed for reproducible output
faker.seed(42);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentSeed {
  name: string;
  role: string;
  description: string;
  isLead: boolean;
  status: "idle" | "busy" | "offline";
  capabilities: string[];
}

interface ChannelSeed {
  name: string;
  description: string;
  type: "public" | "dm";
}

interface WorkflowSeed {
  name: string;
  description: string;
  definition: Record<string, unknown>;
}

interface ScheduleSeed {
  name: string;
  description: string;
  cronExpression: string;
  taskTemplate: string;
  tags: string[];
  priority: number;
}

interface ServiceSeed {
  name: string;
  description: string;
  port: number;
  healthCheckPath: string;
  status: "starting" | "healthy" | "unhealthy" | "stopped";
  script: string;
}

interface SeedConfig {
  db: string;
  clean: boolean;
  agents: { count: number; data?: AgentSeed[] };
  channels: { count: number; data?: ChannelSeed[] };
  messages: { perChannel: number };
  tasks: { count: number };
  workflows: { count: number; data?: WorkflowSeed[] };
  schedules: { count: number; data?: ScheduleSeed[] };
  memories: { count: number };
  services: { count: number; data?: ServiceSeed[] };
  sessionLogs: { perTask: number };
  mcpServers: { count: number; data?: McpServerSeed[] };
}

interface McpServerSeed {
  name: string;
  description?: string;
  transport: "stdio" | "http" | "sse";
  scope?: "global" | "swarm" | "agent";
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  envConfigKeys?: Record<string, string>;
  headerConfigKeys?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Deterministic UUID derived from a namespace + key for idempotent seeding. */
function seedId(namespace: string, key: string | number): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(`seed:${namespace}:${key}`);
  const hex = hasher.digest("hex");
  // Format as UUID v4 shape: 8-4-4-4-12
  return [hex.slice(0, 8), hex.slice(8, 12), `4${hex.slice(13, 16)}`, `a${hex.slice(17, 20)}`, hex.slice(20, 32)].join(
    "-",
  );
}

function now(): string {
  return new Date().toISOString();
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

function pick<T>(arr: T[]): T {
  return faker.helpers.arrayElement(arr);
}

// ---------------------------------------------------------------------------
// Faker-based data generators
// ---------------------------------------------------------------------------

const AGENT_ROLES = [
  "Lead Coordinator",
  "Implementation Engineer",
  "Researcher",
  "Code Reviewer",
  "DevOps Engineer",
  "Frontend Developer",
  "Security Analyst",
  "Technical Writer",
  "QA Engineer",
  "Data Engineer",
];

const CAPABILITY_POOL = [
  "typescript",
  "react",
  "testing",
  "git",
  "docker",
  "ci-cd",
  "monitoring",
  "security",
  "documentation",
  "research",
  "code-review",
  "bash",
  "css",
  "accessibility",
  "api-docs",
  "analysis",
  "planning",
  "coordination",
  "task-management",
  "markdown",
];

function generateAgent(index: number): AgentSeed {
  const isLead = index === 0;
  const role = isLead ? "Lead Coordinator" : faker.helpers.arrayElement(AGENT_ROLES.slice(1));
  return {
    name: faker.person.firstName(),
    role,
    description: `${faker.person.jobTitle()} — ${faker.lorem.sentence()}`,
    isLead,
    status: faker.helpers.arrayElement(["idle", "busy", "offline"]),
    capabilities: faker.helpers.arrayElements(CAPABILITY_POOL, { min: 2, max: 5 }),
  };
}

const TASK_TYPES = [
  "implementation",
  "bugfix",
  "testing",
  "research",
  "review",
  "documentation",
  "investigation",
  "optimization",
];

const TAG_POOL = [
  "backend",
  "frontend",
  "api",
  "auth",
  "security",
  "performance",
  "database",
  "testing",
  "e2e",
  "workflows",
  "dashboard",
  "devops",
  "ci-cd",
  "slack",
  "documentation",
  "templates",
  "scheduling",
  "webhooks",
  "websocket",
  "debugging",
];

function generateTaskDescription(): { task: string; tags: string[]; taskType: string } {
  const taskType = faker.helpers.arrayElement(TASK_TYPES);
  const verbs: Record<string, string> = {
    implementation: "Implement",
    bugfix: "Fix",
    testing: "Write tests for",
    research: "Research",
    review: "Review",
    documentation: "Document",
    investigation: "Investigate",
    optimization: "Optimize",
  };

  return {
    task: `${verbs[taskType] ?? "Implement"} ${faker.hacker.phrase().toLowerCase()}`,
    tags: faker.helpers.arrayElements(TAG_POOL, { min: 1, max: 3 }),
    taskType,
  };
}

function generateChannelName(): ChannelSeed {
  const prefix = faker.helpers.arrayElement([
    "engineering",
    "deployments",
    "standup",
    "incidents",
    "design",
    "security",
    "product",
    "random",
    "releases",
    "oncall",
  ]);
  return {
    name: `${prefix}-${faker.string.alphanumeric(4)}`,
    description: faker.company.buzzPhrase(),
    type: faker.helpers.weightedArrayElement([
      { value: "public" as const, weight: 4 },
      { value: "dm" as const, weight: 1 },
    ]),
  };
}

function generateWorkflow(): WorkflowSeed {
  const action1 = faker.hacker.verb();
  const action2 = faker.hacker.verb();
  return {
    name: `${faker.helpers.arrayElement(["PR", "Deploy", "Release", "Review", "Test", "Build"])} ${faker.helpers.arrayElement(["Pipeline", "Workflow", "Automation", "Process"])}`,
    description: faker.lorem.sentence(),
    definition: {
      nodes: [
        {
          id: action1,
          type: "agent-task",
          config: { template: faker.hacker.phrase() },
          next: [action2],
        },
        {
          id: action2,
          type: "agent-task",
          config: { template: faker.hacker.phrase() },
        },
      ],
    },
  };
}

function generateSchedule(): ScheduleSeed {
  const cronPresets = ["0 9 * * 1-5", "0 0 * * *", "*/30 * * * *", "0 12 * * 1", "0 18 * * 5"];
  return {
    name: faker.company.buzzPhrase(),
    description: faker.lorem.sentence(),
    cronExpression: faker.helpers.arrayElement(cronPresets),
    taskTemplate: faker.hacker.phrase(),
    tags: faker.helpers.arrayElements(TAG_POOL, { min: 1, max: 2 }),
    priority: faker.number.int({ min: 20, max: 80 }),
  };
}

function generateService(index: number): ServiceSeed {
  const names = [
    "dashboard-api",
    "metrics-collector",
    "webhook-relay",
    "auth-proxy",
    "log-aggregator",
  ];
  return {
    name: names[index % names.length],
    description: faker.lorem.sentence(),
    port: 8080 + index,
    healthCheckPath: "/health",
    status: faker.helpers.arrayElement(["starting", "healthy", "unhealthy", "stopped"]),
    script: `bun run src/services/${names[index % names.length]}.ts`,
  };
}

function generateMemory(): {
  name: string;
  content: string;
  source: "manual" | "task_completion" | "session_summary" | "file_index";
} {
  return {
    name: faker.helpers.slugify(faker.hacker.phrase()).toLowerCase(),
    content: faker.lorem.paragraph(),
    source: faker.helpers.arrayElement([
      "manual",
      "task_completion",
      "session_summary",
      "file_index",
    ]),
  };
}

const TASK_STATUSES: Array<{
  status: string;
  needsAgent: boolean;
  needsFinish: boolean;
}> = [
  { status: "pending", needsAgent: true, needsFinish: false },
  { status: "in_progress", needsAgent: true, needsFinish: false },
  { status: "completed", needsAgent: true, needsFinish: true },
  { status: "failed", needsAgent: true, needsFinish: true },
  { status: "unassigned", needsAgent: false, needsFinish: false },
  { status: "cancelled", needsAgent: false, needsFinish: true },
];

// ---------------------------------------------------------------------------
// Seeding functions
// ---------------------------------------------------------------------------

function seedAgents(
  db: Database,
  config: SeedConfig,
): { id: string; name: string; isLead: boolean }[] {
  const count = config.agents.count;
  const explicit = config.agents.data ?? [];

  const agents: { id: string; name: string; isLead: boolean }[] = [];
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO agents (id, name, isLead, status, description, role, capabilities, maxTasks, createdAt, lastUpdatedAt, lastActivityAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (let i = 0; i < count; i++) {
    const seed = i < explicit.length ? explicit[i] : generateAgent(i);
    const id = seedId("agent", i);
    const ts = daysAgo(faker.number.int({ min: 1, max: 30 }));
    stmt.run(
      id,
      seed.name,
      seed.isLead ? 1 : 0,
      seed.status,
      seed.description,
      seed.role,
      JSON.stringify(seed.capabilities),
      seed.isLead ? 5 : 1,
      ts,
      now(),
      daysAgo(faker.number.int({ min: 0, max: 3 })),
    );
    agents.push({ id, name: seed.name, isLead: seed.isLead });
  }

  console.log(`  ✓ Seeded ${count} agents`);
  return agents;
}

function seedChannels(
  db: Database,
  config: SeedConfig,
  agents: { id: string }[],
): { id: string; name: string }[] {
  const count = config.channels.count;
  const explicit = config.channels.data ?? [];
  const channels: { id: string; name: string }[] = [];

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO channels (id, name, description, type, createdBy, participants, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  for (let i = 0; i < count; i++) {
    const seed = i < explicit.length ? explicit[i] : generateChannelName();
    const id = seedId("channel", i);
    const createdBy = pick(agents).id;
    const participants = JSON.stringify(agents.map((a) => a.id));
    stmt.run(id, seed.name, seed.description, seed.type, createdBy, participants, daysAgo(14));
    channels.push({ id, name: seed.name });
  }

  console.log(`  ✓ Seeded ${count} channels`);
  return channels;
}

function seedMessages(
  db: Database,
  config: SeedConfig,
  agents: { id: string }[],
  channels: { id: string }[],
): void {
  const perChannel = config.messages.perChannel;
  let total = 0;

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO channel_messages (id, channelId, agentId, content, mentions, createdAt)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  for (const channel of channels) {
    for (let i = 0; i < perChannel; i++) {
      const agent = pick(agents);
      const content = faker.lorem.sentences({ min: 1, max: 3 });
      const mentioned = faker.datatype.boolean(0.3)
        ? [faker.helpers.arrayElement(agents).id]
        : [];
      stmt.run(
        seedId("message", `${channel.id}:${i}`),
        channel.id,
        agent.id,
        content,
        JSON.stringify(mentioned),
        daysAgo(faker.number.int({ min: 0, max: 7 })),
      );
      total++;
    }
  }

  console.log(`  ✓ Seeded ${total} messages across ${channels.length} channels`);
}

function seedTasks(
  db: Database,
  config: SeedConfig,
  agents: { id: string }[],
): { id: string; agentId: string | null }[] {
  const count = config.tasks.count;

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO agent_tasks (
      id, agentId, creatorAgentId, task, status, source, taskType, tags,
      priority, dependsOn, createdAt, lastUpdatedAt, finishedAt,
      failureReason, output, progress,
      model, dir, parentTaskId, claudeSessionId,
      vcsProvider, vcsRepo, vcsNumber, vcsEventType, vcsUrl, vcsAuthor
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const logStmt = db.prepare(`
    INSERT OR IGNORE INTO agent_log (id, eventType, agentId, taskId, newValue, createdAt)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const seededTasks: { id: string; agentId: string | null }[] = [];

  for (let i = 0; i < count; i++) {
    const template = generateTaskDescription();
    const statusInfo = TASK_STATUSES[i % TASK_STATUSES.length];
    const id = seedId("task", i);
    const agent = statusInfo.needsAgent ? pick(agents) : null;
    const creator = pick(agents);
    const priority = faker.number.int({ min: 20, max: 80 });
    const createdAt = daysAgo(faker.number.int({ min: 0, max: 14 }));
    const finishedAt = statusInfo.needsFinish
      ? daysAgo(faker.number.int({ min: 0, max: 3 }))
      : null;

    let failureReason: string | null = null;
    let output: string | null = null;
    let progress: string | null = null;

    if (statusInfo.status === "failed") {
      failureReason = faker.lorem.sentence();
    } else if (statusInfo.status === "completed") {
      output = `Task completed successfully. ${faker.lorem.sentence()}`;
    } else if (statusInfo.status === "in_progress") {
      progress = `Working on ${faker.hacker.ingverb()} — ~${faker.number.int({ min: 10, max: 90 })}% done`;
    }

    const source = faker.helpers.arrayElement(["mcp", "slack", "api"]);

    // ~60% of tasks get a model
    const model = faker.datatype.boolean(0.6)
      ? faker.helpers.arrayElement(["sonnet", "opus", "haiku"])
      : null;

    // ~30% get a working directory
    const dir = faker.datatype.boolean(0.3)
      ? faker.helpers.arrayElement([
          "/workspace/agent-swarm/src",
          "/workspace/api",
          "/workspace/frontend",
          "/workspace/agent-swarm",
          "/workspace/docs",
        ])
      : null;

    // ~15% get a parentTaskId (only if we have previous tasks)
    const parentTaskId =
      seededTasks.length >= 3 && faker.datatype.boolean(0.15)
        ? seededTasks[faker.number.int({ min: 0, max: seededTasks.length - 1 })].id
        : null;

    // ~25% of in_progress/completed tasks get a claudeSessionId
    const claudeSessionId =
      (statusInfo.status === "in_progress" || statusInfo.status === "completed") &&
      faker.datatype.boolean(0.25)
        ? seedId("session", i)
        : null;

    // ~20% get VCS fields; slack-sourced tasks are more likely (~50%)
    const hasVcs = source === "slack" ? faker.datatype.boolean(0.5) : faker.datatype.boolean(0.2);
    let vcsProvider: string | null = null;
    let vcsRepo: string | null = null;
    let vcsNumber: number | null = null;
    let vcsEventType: string | null = null;
    let vcsUrl: string | null = null;
    let vcsAuthor: string | null = null;

    if (hasVcs) {
      const isGithub = faker.datatype.boolean(0.7);
      vcsProvider = isGithub ? "github" : "gitlab";
      const org = faker.helpers.arrayElement(["acme-corp", "desplega-ai", "cool-startup", "mega-inc"]);
      const repo = faker.helpers.arrayElement(["api", "frontend", "core", "platform", "infra", "docs"]);
      vcsRepo = `${org}/${repo}`;
      vcsNumber = faker.number.int({ min: 1, max: 999 });
      vcsEventType = faker.helpers.arrayElement([
        "pull_request",
        "pull_request_review",
        "issue_comment",
        "push",
      ]);
      vcsUrl = isGithub
        ? `https://github.com/${vcsRepo}/pull/${vcsNumber}`
        : `https://gitlab.com/${vcsRepo}/-/merge_requests/${vcsNumber}`;
      vcsAuthor = faker.internet.username();
    }

    stmt.run(
      id,
      agent?.id ?? null,
      creator.id,
      template.task,
      statusInfo.status,
      source,
      template.taskType,
      JSON.stringify(template.tags),
      priority,
      "[]",
      createdAt,
      now(),
      finishedAt,
      failureReason,
      output,
      progress,
      model,
      dir,
      parentTaskId,
      claudeSessionId,
      vcsProvider,
      vcsRepo,
      vcsNumber,
      vcsEventType,
      vcsUrl,
      vcsAuthor,
    );

    logStmt.run(seedId("log", `task:${i}`), "task_created", creator.id, id, statusInfo.status, createdAt);
    seededTasks.push({ id, agentId: agent?.id ?? null });
  }

  console.log(`  ✓ Seeded ${count} tasks`);
  return seededTasks;
}

function seedWorkflows(db: Database, config: SeedConfig): void {
  const count = config.workflows.count;
  const explicit = config.workflows.data ?? [];

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO workflows (id, name, description, enabled, definition, triggers, createdAt, lastUpdatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (let i = 0; i < count; i++) {
    const seed = i < explicit.length ? explicit[i] : generateWorkflow();
    stmt.run(
      seedId("workflow", i),
      seed.name,
      seed.description,
      1,
      JSON.stringify(seed.definition),
      "[]",
      daysAgo(7),
      now(),
    );
  }

  console.log(`  ✓ Seeded ${count} workflows`);
}

function seedSchedules(
  db: Database,
  config: SeedConfig,
  agents: { id: string }[],
): void {
  const count = config.schedules.count;
  const explicit = config.schedules.data ?? [];

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO scheduled_tasks (
      id, name, description, cronExpression, taskTemplate, taskType, tags,
      priority, targetAgentId, enabled, timezone, scheduleType, createdAt, lastUpdatedAt
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (let i = 0; i < count; i++) {
    const seed = i < explicit.length ? explicit[i] : generateSchedule();
    const target = pick(agents);
    stmt.run(
      seedId("schedule", i),
      seed.name,
      seed.description,
      seed.cronExpression,
      seed.taskTemplate,
      "scheduled",
      JSON.stringify(seed.tags),
      seed.priority,
      target.id,
      1,
      "UTC",
      "recurring",
      daysAgo(10),
      now(),
    );
  }

  console.log(`  ✓ Seeded ${count} schedules`);
}

function seedMemories(
  db: Database,
  config: SeedConfig,
  agents: { id: string }[],
): void {
  const count = config.memories.count;

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO agent_memory (id, agentId, scope, name, content, source, tags, createdAt, accessedAt, expiresAt, accessCount, embeddingModel)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)
  `);

  const ttlDefaults: Record<string, number | null> = {
    task_completion: 7,
    session_summary: 3,
    file_index: 30,
    manual: null,
  };

  for (let i = 0; i < count; i++) {
    const mem = generateMemory();
    const agent = pick(agents);
    const scope = faker.helpers.arrayElement(["swarm", "agent"]);
    const createdAt = daysAgo(faker.number.int({ min: 0, max: 14 }));
    const ttlDays = ttlDefaults[mem.source];
    const expiresAt =
      ttlDays != null
        ? new Date(new Date(createdAt).getTime() + ttlDays * 86400000).toISOString()
        : null;
    stmt.run(
      seedId("memory", i),
      agent.id,
      scope,
      mem.name,
      mem.content,
      mem.source,
      "[]",
      createdAt,
      daysAgo(faker.number.int({ min: 0, max: 3 })),
      expiresAt,
    );
  }

  console.log(`  ✓ Seeded ${count} memories`);
}

function seedServices(
  db: Database,
  config: SeedConfig,
  agents: { id: string }[],
): void {
  const count = config.services.count;
  const explicit = config.services.data ?? [];

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO services (id, agentId, name, port, description, healthCheckPath, status, script, metadata, createdAt, lastUpdatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (let i = 0; i < count; i++) {
    const seed = i < explicit.length ? explicit[i] : generateService(i);
    const agent = pick(agents);
    stmt.run(
      seedId("service", i),
      agent.id,
      seed.name,
      seed.port,
      seed.description,
      seed.healthCheckPath,
      seed.status,
      seed.script,
      "{}",
      daysAgo(5),
      now(),
    );
  }

  console.log(`  ✓ Seeded ${count} services`);
}

// ---------------------------------------------------------------------------
// MCP Servers
// ---------------------------------------------------------------------------

const DEFAULT_MCP_SERVERS: McpServerSeed[] = [
  {
    name: "github",
    description: "GitHub API access via MCP",
    transport: "stdio",
    scope: "global",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    envConfigKeys: { GITHUB_TOKEN: "github-token" },
  },
  {
    name: "filesystem",
    description: "Local filesystem access",
    transport: "stdio",
    scope: "global",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
  },
  {
    name: "brave-search",
    description: "Web search via Brave Search API",
    transport: "http",
    scope: "swarm",
    url: "https://mcp.brave.com/v1",
    headerConfigKeys: { Authorization: "brave-api-key" },
  },
  {
    name: "custom-api",
    description: "Internal API integration",
    transport: "http",
    scope: "agent",
    url: "http://localhost:8090/mcp",
    headers: { "X-Source": "agent-swarm" },
  },
];

function seedMcpServers(
  db: Database,
  config: SeedConfig,
  agents: { id: string }[],
): void {
  const count = config.mcpServers.count;
  const explicit = config.mcpServers.data ?? [];

  const serverStmt = db.prepare(`
    INSERT OR IGNORE INTO mcp_servers (
      id, name, description, scope, ownerAgentId, transport,
      command, args, url, headers,
      envConfigKeys, headerConfigKeys,
      isEnabled, version, createdAt, lastUpdatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)
  `);

  const installStmt = db.prepare(`
    INSERT OR IGNORE INTO agent_mcp_servers (id, agentId, mcpServerId, isActive, installedAt)
    VALUES (?, ?, ?, 1, ?)
  `);

  const serverIds: string[] = [];

  for (let i = 0; i < count; i++) {
    const seed = i < explicit.length ? explicit[i] : DEFAULT_MCP_SERVERS[i % DEFAULT_MCP_SERVERS.length];
    const scope = seed.scope ?? "agent";
    const ownerAgent = scope === "agent" ? pick(agents) : null;
    const serverId = seedId("mcp_server", i);

    const result = serverStmt.run(
      serverId,
      seed.name,
      seed.description ?? null,
      scope,
      ownerAgent?.id ?? null,
      seed.transport,
      seed.command ?? null,
      seed.args ? JSON.stringify(seed.args) : null,
      seed.url ?? null,
      seed.headers ? JSON.stringify(seed.headers) : null,
      seed.envConfigKeys ? JSON.stringify(seed.envConfigKeys) : null,
      seed.headerConfigKeys ? JSON.stringify(seed.headerConfigKeys) : null,
      daysAgo(3),
      now(),
    );
    // Only track if actually inserted (INSERT OR IGNORE may skip duplicates)
    if (result.changes > 0) {
      serverIds.push(serverId);
    }
  }

  // Install 2-3 servers per agent
  for (const agent of agents) {
    const toInstall = serverIds.slice(0, Math.min(3, serverIds.length));
    for (const serverId of toInstall) {
      installStmt.run(
        seedId("agent_mcp_server", `${agent.id}:${serverId}`),
        agent.id,
        serverId,
        daysAgo(2),
      );
    }
  }

  console.log(`  ✓ Seeded ${count} MCP servers (installed on ${agents.length} agents)`);
}

// ---------------------------------------------------------------------------
// Session log content generators — realistic Claude conversation fragments
// ---------------------------------------------------------------------------

/** Build a JSON session log line in the format the UI expects. */
function logLine(
  type: "assistant" | "user" | "system",
  content: string | Array<Record<string, unknown>>,
  model?: string,
): string {
  const msg: Record<string, unknown> = {
    type,
    message: {
      role: type === "system" ? "system" : type,
      content,
      ...(model ? { model } : {}),
    },
  };
  return JSON.stringify(msg);
}

/** A set of realistic multi-turn Claude session conversations with tool calls. */
function generateSessionConversation(taskIndex: number): string[] {
  const conversations: string[][] = [
    // 0: Read + Edit workflow (typical code fix)
    [
      logLine("user", "Fix the broken import in src/utils/auth.ts — it references a module that was renamed."),
      logLine("assistant", [
        { type: "thinking", thinking: "Let me read the file first to understand the current import structure." },
      ], "claude-opus-4-6"),
      logLine("assistant", [
        {
          type: "tool_use",
          id: "toolu_01A",
          name: "Read",
          input: { file_path: "/workspace/repos/agent-swarm/src/utils/auth.ts" },
        },
      ], "claude-opus-4-6"),
      logLine("assistant", [
        {
          type: "tool_result",
          tool_use_id: "toolu_01A",
          content: '1→import { verifyToken } from "./jwt-utils";\n2→import { getUserById } from "../be/db";\n3→\n4→export async function authenticate(token: string) {\n5→  const payload = verifyToken(token);\n6→  return getUserById(payload.sub);\n7→}',
        },
      ], "claude-opus-4-6"),
      logLine("assistant", [
        { type: "text", text: "Found the issue — `jwt-utils` was renamed to `token-utils`. Let me fix the import." },
        {
          type: "tool_use",
          id: "toolu_01B",
          name: "Edit",
          input: {
            file_path: "/workspace/repos/agent-swarm/src/utils/auth.ts",
            old_string: 'import { verifyToken } from "./jwt-utils";',
            new_string: 'import { verifyToken } from "./token-utils";',
          },
        },
      ], "claude-opus-4-6"),
      logLine("assistant", [
        { type: "text", text: "Fixed the import. The file now correctly references `token-utils` instead of the old `jwt-utils` module." },
      ], "claude-opus-4-6"),
    ],

    // 1: Bash + Grep workflow (investigation)
    [
      logLine("user", "Find all usages of the deprecated `fetchData` function and tell me which files need updating."),
      logLine("assistant", [
        {
          type: "tool_use",
          id: "toolu_02A",
          name: "Grep",
          input: { pattern: "fetchData", output_mode: "files_with_matches" },
        },
      ], "claude-opus-4-6"),
      logLine("assistant", [
        {
          type: "tool_result",
          tool_use_id: "toolu_02A",
          content: "src/api/client.ts\nsrc/hooks/useData.ts\nsrc/services/sync.ts\nsrc/tests/api.test.ts",
        },
      ], "claude-opus-4-6"),
      logLine("assistant", [
        {
          type: "text",
          text: "Found `fetchData` in 4 files:\n\n1. `src/api/client.ts` — likely the definition\n2. `src/hooks/useData.ts` — React hook consumer\n3. `src/services/sync.ts` — background sync service\n4. `src/tests/api.test.ts` — test file\n\nAll four need to be migrated to `queryData`. Want me to do the replacement?",
        },
      ], "claude-opus-4-6"),
    ],

    // 2: Write + Bash (new file + test run)
    [
      logLine("user", "Create a health check endpoint at /api/health that returns the server uptime."),
      logLine("assistant", [
        { type: "thinking", thinking: "I need to create a new route handler following the existing pattern with the route() factory." },
      ], "claude-opus-4-6"),
      logLine("assistant", [
        {
          type: "tool_use",
          id: "toolu_03A",
          name: "Write",
          input: {
            file_path: "/workspace/repos/agent-swarm/src/http/health.ts",
            content: 'import { route } from "./route-def";\nimport { json } from "./utils";\n\nconst healthRoute = route({\n  method: "get",\n  path: "/api/health",\n  pattern: ["api", "health"],\n  summary: "Health check with uptime",\n  tags: ["System"],\n  responses: { 200: { description: "OK" } },\n  auth: {},\n});\n\nconst startTime = Date.now();\n\nexport async function handleHealth(req, res, pathSegments) {\n  if (!healthRoute.match(req.method, pathSegments)) return false;\n  json(res, { status: "ok", uptimeMs: Date.now() - startTime });\n  return true;\n}\n',
          },
        },
      ], "claude-opus-4-6"),
      logLine("assistant", [
        {
          type: "tool_use",
          id: "toolu_03B",
          name: "Bash",
          input: { command: "bun run tsc:check" },
        },
      ], "claude-opus-4-6"),
      logLine("assistant", [
        {
          type: "tool_result",
          tool_use_id: "toolu_03B",
          content: "No errors found.",
        },
      ], "claude-opus-4-6"),
      logLine("assistant", [
        { type: "text", text: "Health check endpoint created at `src/http/health.ts`. Type check passes." },
      ], "claude-opus-4-6"),
    ],

    // 3: Glob + Read (exploration)
    [
      logLine("user", "How are database migrations structured in this project?"),
      logLine("assistant", [
        {
          type: "tool_use",
          id: "toolu_04A",
          name: "Glob",
          input: { pattern: "src/be/migrations/**/*" },
        },
      ], "claude-opus-4-6"),
      logLine("assistant", [
        {
          type: "tool_result",
          tool_use_id: "toolu_04A",
          content: "src/be/migrations/001_initial.sql\nsrc/be/migrations/runner.ts",
        },
      ], "claude-opus-4-6"),
      logLine("assistant", [
        {
          type: "tool_use",
          id: "toolu_04B",
          name: "Read",
          input: { file_path: "/workspace/repos/agent-swarm/src/be/migrations/runner.ts", limit: 40 },
        },
      ], "claude-opus-4-6"),
      logLine("assistant", [
        {
          type: "text",
          text: "The migration system uses numbered SQL files in `src/be/migrations/`:\n\n- **`001_initial.sql`** — Baseline schema with all tables\n- **`runner.ts`** — Migration runner that tracks applied versions via a `_migrations` table\n\nOn startup, the runner compares SQL files against `_migrations` and applies pending ones in a transaction. Checksums detect accidental edits to already-applied migrations.",
        },
      ], "claude-opus-4-6"),
    ],

    // 4: MCP tool calls (store-progress + memory-search)
    [
      logLine("user", "Check your memory for anything related to the auth middleware rewrite, then update task progress."),
      logLine("assistant", [
        {
          type: "tool_use",
          id: "toolu_05A",
          name: "mcp__agent-swarm__memory-search",
          input: { query: "auth middleware rewrite", limit: 5 },
        },
      ], "claude-opus-4-6"),
      logLine("assistant", [
        {
          type: "tool_result",
          tool_use_id: "toolu_05A",
          content: '{"success":true,"results":[{"id":"mem-001","name":"auth-middleware-compliance","summary":"Legal flagged session token storage...","similarity":0.82}]}',
        },
      ], "claude-opus-4-6"),
      logLine("assistant", [
        {
          type: "tool_use",
          id: "toolu_05B",
          name: "mcp__agent-swarm__store-progress",
          input: { taskId: "task-placeholder", progress: "Investigated auth middleware — found prior context in memory. Starting implementation." },
        },
      ], "claude-opus-4-6"),
      logLine("assistant", [
        { type: "text", text: "Found a relevant memory about the auth middleware rewrite being driven by compliance requirements. Updated task progress." },
      ], "claude-opus-4-6"),
    ],

    // 5: Multi-tool parallel (Grep + Glob)
    [
      logLine("user", "Find all React components that use the useAuth hook and list the test files for them."),
      logLine("assistant", [
        {
          type: "tool_use",
          id: "toolu_06A",
          name: "Grep",
          input: { pattern: "useAuth\\(\\)", type: "tsx", output_mode: "files_with_matches" },
        },
        {
          type: "tool_use",
          id: "toolu_06B",
          name: "Glob",
          input: { pattern: "src/**/*.test.tsx" },
        },
      ], "claude-sonnet-4-6"),
      logLine("assistant", [
        {
          type: "tool_result",
          tool_use_id: "toolu_06A",
          content: "src/components/LoginForm.tsx\nsrc/components/UserProfile.tsx\nsrc/pages/Settings.tsx",
        },
        {
          type: "tool_result",
          tool_use_id: "toolu_06B",
          content: "src/components/LoginForm.test.tsx\nsrc/components/UserProfile.test.tsx\nsrc/pages/Settings.test.tsx\nsrc/pages/Dashboard.test.tsx",
        },
      ], "claude-sonnet-4-6"),
      logLine("assistant", [
        {
          type: "text",
          text: "Three components use `useAuth()`:\n\n| Component | Test File |\n|---|---|\n| `LoginForm.tsx` | `LoginForm.test.tsx` |\n| `UserProfile.tsx` | `UserProfile.test.tsx` |\n| `Settings.tsx` | `Settings.test.tsx` |\n\nAll three have corresponding test files.",
        },
      ], "claude-sonnet-4-6"),
    ],

    // 6: WebSearch + analysis
    [
      logLine("user", "Research the best approach for implementing rate limiting in Bun.serve()."),
      logLine("assistant", [
        { type: "thinking", thinking: "Let me search for Bun-specific rate limiting patterns since Bun.serve() has a different API than Express." },
      ], "claude-opus-4-6"),
      logLine("assistant", [
        {
          type: "tool_use",
          id: "toolu_07A",
          name: "WebSearch",
          input: { query: "Bun.serve rate limiting middleware pattern 2026" },
        },
      ], "claude-opus-4-6"),
      logLine("assistant", [
        {
          type: "tool_result",
          tool_use_id: "toolu_07A",
          content: "Results: 1. Bun docs: Rate limiting with Map-based token bucket... 2. GitHub issue #4521: Native rate limiter support...",
        },
      ], "claude-opus-4-6"),
      logLine("assistant", [
        {
          type: "text",
          text: "For `Bun.serve()`, the recommended approach is a **token bucket** algorithm using a `Map<string, { tokens: number, lastRefill: number }>`. Since Bun doesn't have Express-style middleware, you implement it directly in the `fetch` handler.\n\nKey points:\n- Use client IP from `server.requestIP(req)` as the bucket key\n- Refill tokens based on elapsed time since last request\n- Return 429 with `Retry-After` header when bucket is empty",
        },
      ], "claude-opus-4-6"),
    ],

    // 7: Agent + delegation
    [
      logLine("user", "Refactor the error handling across all API endpoints to use a consistent error response format."),
      logLine("assistant", [
        { type: "thinking", thinking: "This is a large refactoring task. Let me first explore the codebase to understand the current error handling patterns before making changes." },
      ], "claude-opus-4-6"),
      logLine("assistant", [
        {
          type: "tool_use",
          id: "toolu_08A",
          name: "Agent",
          input: {
            description: "Find error handling patterns",
            subagent_type: "Explore",
            prompt: "Find all error handling patterns in src/http/ — look for try/catch blocks, error response helpers, and status code usage.",
          },
        },
      ], "claude-opus-4-6"),
      logLine("assistant", [
        {
          type: "tool_result",
          tool_use_id: "toolu_08A",
          content: "Found 3 patterns: 1) jsonError(res, msg, code) — used in 12 places, 2) raw res.end() with status — 4 places, 3) unhandled throws — 2 places in webhook handlers.",
        },
      ], "claude-opus-4-6"),
      logLine("assistant", [
        {
          type: "text",
          text: "Found inconsistent error handling across the API:\n\n- **12 endpoints** use `jsonError()` correctly\n- **4 endpoints** use raw `res.end()` — need migration\n- **2 webhook handlers** have unhandled throws — need try/catch\n\nI'll standardize all 6 inconsistent cases to use `jsonError()`. Starting with the webhook handlers since unhandled throws are the highest risk.",
        },
      ], "claude-opus-4-6"),
    ],
  ];

  return conversations[taskIndex % conversations.length];
}

// ---------------------------------------------------------------------------
// Session logs seeding
// ---------------------------------------------------------------------------

function seedSessionLogs(
  db: Database,
  config: SeedConfig,
  tasks: { id: string; agentId: string | null }[],
): void {
  const perTask = config.sessionLogs.perTask;
  if (perTask <= 0) {
    console.log("  ⏭ Skipping session logs (perTask = 0)");
    return;
  }

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO session_logs (id, taskId, sessionId, iteration, cli, content, lineNumber, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let total = 0;
  const tasksWithAgents = tasks.filter((t) => t.agentId);

  for (let ti = 0; ti < tasksWithAgents.length && ti < perTask; ti++) {
    const task = tasksWithAgents[ti];
    const sessionId = seedId("session", ti);
    const lines = generateSessionConversation(ti);
    const createdBase = new Date(daysAgo(faker.number.int({ min: 0, max: 7 })));
    const cli = faker.helpers.weightedArrayElement([
      { value: "claude" as const, weight: 8 },
      { value: "claude-code" as const, weight: 2 },
    ]);

    for (let li = 0; li < lines.length; li++) {
      const lineCreatedAt = new Date(createdBase.getTime() + li * 2000).toISOString();
      stmt.run(
        seedId("session_log", `${ti}:${li}`),
        task.id,
        sessionId,
        1,
        cli,
        lines[li],
        li + 1,
        lineCreatedAt,
      );
      total++;
    }
  }

  console.log(`  ✓ Seeded ${total} session log entries across ${Math.min(tasksWithAgents.length, perTask)} tasks`);
}

// ---------------------------------------------------------------------------
// Context snapshots
// ---------------------------------------------------------------------------

function seedContextSnapshots(
  db: Database,
  _config: SeedConfig,
  tasks: { id: string; agentId: string | null }[],
): void {
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO task_context_snapshots
      (id, taskId, agentId, sessionId, contextUsedTokens, contextTotalTokens, contextPercent,
       eventType, compactTrigger, preCompactTokens, cumulativeInputTokens, cumulativeOutputTokens, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const updateTaskStmt = db.prepare(`
    UPDATE agent_tasks
    SET compactionCount = ?, peakContextPercent = ?, totalContextTokensUsed = ?, contextWindowSize = ?
    WHERE id = ?
  `);

  const tasksWithAgents = tasks.filter((t) => t.agentId);
  const CONTEXT_WINDOW = 1_000_000; // 1M tokens (Opus/Sonnet)
  let total = 0;

  for (let ti = 0; ti < tasksWithAgents.length; ti++) {
    const task = tasksWithAgents[ti];
    const sessionId = seedId("session", ti);
    const createdBase = new Date(daysAgo(faker.number.int({ min: 0, max: 7 })));
    const hasCompaction = ti % 2 === 0; // half of tasks get a compaction event

    // Build a realistic growth trajectory
    const progressSteps = [
      { pct: faker.number.int({ min: 5, max: 15 }) },
      { pct: faker.number.int({ min: 20, max: 35 }) },
      { pct: faker.number.int({ min: 40, max: 55 }) },
      { pct: faker.number.int({ min: 60, max: 75 }) },
      { pct: faker.number.int({ min: 78, max: 88 }) },
    ];

    let snapIdx = 0;
    let peakPct = 0;
    let cumulativeInput = 0;
    let cumulativeOutput = 0;
    let lastUsedTokens = 0;

    // Progress events (pre-compaction)
    const preCompactionSteps = hasCompaction ? progressSteps.slice(0, 4) : progressSteps;

    for (const step of preCompactionSteps) {
      const usedTokens = Math.round((step.pct / 100) * CONTEXT_WINDOW);
      cumulativeInput += faker.number.int({ min: 5000, max: 20000 });
      cumulativeOutput += faker.number.int({ min: 2000, max: 8000 });
      peakPct = Math.max(peakPct, step.pct);
      lastUsedTokens = usedTokens;

      const ts = new Date(createdBase.getTime() + snapIdx * 30000).toISOString();
      insertStmt.run(
        seedId("ctx_snap", `${ti}:${snapIdx}`),
        task.id,
        task.agentId,
        sessionId,
        usedTokens,
        CONTEXT_WINDOW,
        step.pct,
        "progress",
        null, // compactTrigger
        null, // preCompactTokens
        cumulativeInput,
        cumulativeOutput,
        ts,
      );
      snapIdx++;
      total++;
    }

    // Compaction event
    if (hasCompaction) {
      const preCompactTokens = lastUsedTokens;
      const dropRatio = faker.number.float({ min: 0.3, max: 0.45 });
      const postCompactTokens = Math.round(preCompactTokens * dropRatio);
      const postCompactPct = (postCompactTokens / CONTEXT_WINDOW) * 100;
      const trigger = ti % 4 === 0 ? "manual" : "auto";

      const ts = new Date(createdBase.getTime() + snapIdx * 30000).toISOString();
      insertStmt.run(
        seedId("ctx_snap", `${ti}:${snapIdx}`),
        task.id,
        task.agentId,
        sessionId,
        postCompactTokens,
        CONTEXT_WINDOW,
        postCompactPct,
        "compaction",
        trigger,
        preCompactTokens,
        cumulativeInput,
        cumulativeOutput,
        ts,
      );
      snapIdx++;
      total++;
      lastUsedTokens = postCompactTokens;

      // Post-compaction growth (2 progress events)
      const postSteps = [
        { pct: faker.number.int({ min: 35, max: 50 }) },
        { pct: faker.number.int({ min: 55, max: 72 }) },
      ];

      for (const step of postSteps) {
        const usedTokens = Math.round((step.pct / 100) * CONTEXT_WINDOW);
        cumulativeInput += faker.number.int({ min: 5000, max: 20000 });
        cumulativeOutput += faker.number.int({ min: 2000, max: 8000 });
        peakPct = Math.max(peakPct, step.pct);
        lastUsedTokens = usedTokens;

        const ts2 = new Date(createdBase.getTime() + snapIdx * 30000).toISOString();
        insertStmt.run(
          seedId("ctx_snap", `${ti}:${snapIdx}`),
          task.id,
          task.agentId,
          sessionId,
          usedTokens,
          CONTEXT_WINDOW,
          step.pct,
          "progress",
          null,
          null,
          cumulativeInput,
          cumulativeOutput,
          ts2,
        );
        snapIdx++;
        total++;
      }
    }

    // Completion event
    cumulativeInput += faker.number.int({ min: 1000, max: 5000 });
    cumulativeOutput += faker.number.int({ min: 500, max: 2000 });
    const finalPct = (lastUsedTokens / CONTEXT_WINDOW) * 100;
    const ts = new Date(createdBase.getTime() + snapIdx * 30000).toISOString();
    insertStmt.run(
      seedId("ctx_snap", `${ti}:${snapIdx}`),
      task.id,
      task.agentId,
      sessionId,
      lastUsedTokens,
      CONTEXT_WINDOW,
      finalPct,
      "completion",
      null,
      null,
      cumulativeInput,
      cumulativeOutput,
      ts,
    );
    total++;

    // Update task aggregates
    const compactionCount = hasCompaction ? 1 : 0;
    updateTaskStmt.run(compactionCount, peakPct, lastUsedTokens, CONTEXT_WINDOW, task.id);
  }

  console.log(`  ✓ Seeded ${total} context snapshots across ${tasksWithAgents.length} tasks`);
}

// ---------------------------------------------------------------------------
// Table cleanup
// ---------------------------------------------------------------------------

// Tables listed in FK-safe delete order (children before parents).
// Keep this list in sync with src/be/migrations/ when tables are added or removed.
const TABLES_IN_DELETE_ORDER = [
  "channel_read_state",
  "channel_messages",
  "channel_activity_cursors",
  "inbox_messages",
  "session_logs",
  "session_costs",
  "task_context_snapshots",
  "active_sessions",
  "workflow_run_steps",
  "workflow_runs",
  "workflow_versions",
  "workflows",
  "agent_log",
  "agent_memory",
  "context_versions",
  "tracker_sync",
  "tracker_agent_mapping",
  "oauth_tokens",
  "oauth_apps",
  "prompt_template_history",
  "prompt_templates",
  "agent_tasks",
  "scheduled_tasks",
  "services",
  "channels",
  "swarm_config",
  "swarm_repos",
  "agent_mcp_servers",
  "mcp_servers",
  "agentmail_inbox_mappings",
  "agents",
];

function cleanDatabase(db: Database): void {
  console.log("  Cleaning existing data...");

  for (const table of TABLES_IN_DELETE_ORDER) {
    try {
      db.run(`DELETE FROM ${table}`);
    } catch {
      // Table might not exist in older schemas, skip silently
    }
  }

  console.log("  ✓ Database cleaned");
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function printHelp(): void {
  console.log(`
agent-swarm database seeding script

Usage:
  bun run scripts/seed.ts [options]

Options:
  --config <path>     Path to JSON config file (default: scripts/seed.default.json)
  --db <path>         Path to SQLite database (default: ./agent-swarm-db.sqlite)
  --clean             Wipe existing data before seeding
  --agents <n>        Number of agents to seed
  --tasks <n>         Number of tasks to seed
  --channels <n>      Number of channels to seed
  --messages <n>      Messages per channel
  --help              Show this help message

Examples:
  bun run scripts/seed.ts                         # Seed with defaults
  bun run scripts/seed.ts --clean                 # Clean and reseed
  bun run scripts/seed.ts --agents 8 --tasks 20   # Override counts
  bun run scripts/seed.ts --config custom.json    # Use custom config
  bun run seed                                    # Via package.json script
`);
}

function parseArgs(argv: string[]): {
  configPath: string;
  overrides: Partial<SeedConfig> & {
    agentCount?: number;
    taskCount?: number;
    channelCount?: number;
    messagesPerChannel?: number;
  };
} {
  const scriptDir = dirname(new URL(import.meta.url).pathname);
  let configPath = resolve(scriptDir, "seed.default.json");
  const overrides: Record<string, unknown> = {};

  const args = argv.slice(2); // skip bun and script path
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      case "--config":
        configPath = resolve(args[++i]);
        break;
      case "--db":
        overrides.db = args[++i];
        break;
      case "--clean":
        overrides.clean = true;
        break;
      case "--agents":
        overrides.agentCount = Number.parseInt(args[++i], 10);
        break;
      case "--tasks":
        overrides.taskCount = Number.parseInt(args[++i], 10);
        break;
      case "--channels":
        overrides.channelCount = Number.parseInt(args[++i], 10);
        break;
      case "--messages":
        overrides.messagesPerChannel = Number.parseInt(args[++i], 10);
        break;
      default:
        console.error(`Unknown option: ${arg}. Use --help for usage.`);
        process.exit(1);
    }
  }

  return { configPath, overrides: overrides as ReturnType<typeof parseArgs>["overrides"] };
}

async function loadConfig(
  configPath: string,
  overrides: ReturnType<typeof parseArgs>["overrides"],
): Promise<SeedConfig> {
  const file = Bun.file(configPath);
  if (!(await file.exists())) {
    console.error(`Config file not found: ${configPath}`);
    process.exit(1);
  }

  const raw = JSON.parse(await file.text());
  const config: SeedConfig = {
    db: overrides.db ?? raw.db ?? "./agent-swarm-db.sqlite",
    clean: overrides.clean ?? raw.clean ?? false,
    agents: {
      count: overrides.agentCount ?? raw.agents?.count ?? 4,
      data: raw.agents?.data,
    },
    channels: {
      count: overrides.channelCount ?? raw.channels?.count ?? 3,
      data: raw.channels?.data,
    },
    messages: {
      perChannel: overrides.messagesPerChannel ?? raw.messages?.perChannel ?? 5,
    },
    tasks: {
      count: overrides.taskCount ?? raw.tasks?.count ?? 12,
    },
    workflows: {
      count: raw.workflows?.count ?? 1,
      data: raw.workflows?.data,
    },
    schedules: {
      count: raw.schedules?.count ?? 1,
      data: raw.schedules?.data,
    },
    memories: {
      count: raw.memories?.count ?? 4,
    },
    services: {
      count: raw.services?.count ?? 1,
      data: raw.services?.data,
    },
    sessionLogs: {
      perTask: raw.sessionLogs?.perTask ?? 8,
    },
    mcpServers: {
      count: raw.mcpServers?.count ?? 4,
      data: raw.mcpServers?.data,
    },
  };

  return config;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { configPath, overrides } = parseArgs(process.argv);
  const config = await loadConfig(configPath, overrides);

  console.log("\n🌱 Agent Swarm Database Seeder");
  console.log(`  Config: ${configPath}`);
  console.log(`  Database: ${config.db}`);
  console.log("");

  // Initialize DB with migrations (reuses the project's migration runner)
  const db = new Database(config.db, { create: true });
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA foreign_keys = ON;");

  // Run migrations to ensure schema exists
  runMigrations(db);

  if (config.clean) {
    cleanDatabase(db);
  }

  console.log("Seeding data...");

  // Seed in FK-safe order
  const agents = seedAgents(db, config);
  const channels = seedChannels(db, config, agents);
  seedMessages(db, config, agents, channels);
  const tasks = seedTasks(db, config, agents);
  seedSessionLogs(db, config, tasks);
  seedContextSnapshots(db, config, tasks);
  seedWorkflows(db, config);
  seedSchedules(db, config, agents);
  seedMemories(db, config, agents);
  seedServices(db, config, agents);
  seedMcpServers(db, config, agents);

  db.close();

  console.log(`\n✅ Seeding complete! Database: ${config.db}\n`);
}

main();
