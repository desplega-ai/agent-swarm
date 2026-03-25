#!/usr/bin/env bun
/**
 * Database seeding script for agent-swarm.
 *
 * Seeds a local SQLite database with realistic demo data for development,
 * E2E testing, and showcasing. Configurable via CLI flags or a JSON config file.
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
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { runMigrations } from "../src/be/migrations/runner";

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

interface EpicSeed {
  name: string;
  goal: string;
  description: string;
  status: "draft" | "active" | "paused" | "completed" | "cancelled";
  priority: number;
  tags: string[];
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
  epics: { count: number; data?: EpicSeed[] };
  workflows: { count: number; data?: WorkflowSeed[] };
  schedules: { count: number; data?: ScheduleSeed[] };
  memories: { count: number };
  services: { count: number; data?: ServiceSeed[] };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uuid(): string {
  return crypto.randomUUID();
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
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickN<T>(arr: T[], n: number): T[] {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(n, arr.length));
}

// ---------------------------------------------------------------------------
// Default agent pool (used when config doesn't provide enough explicit data)
// ---------------------------------------------------------------------------

const DEFAULT_AGENTS: AgentSeed[] = [
  {
    name: "Atlas",
    role: "Lead Coordinator",
    description: "Orchestrates the swarm, assigns tasks, and monitors progress.",
    isLead: true,
    status: "idle",
    capabilities: ["coordination", "planning", "task-management"],
  },
  {
    name: "Forge",
    role: "Implementation Engineer",
    description: "Expert coder who turns plans into working PRs.",
    isLead: false,
    status: "busy",
    capabilities: ["typescript", "react", "testing", "git"],
  },
  {
    name: "Scout",
    role: "Researcher",
    description: "Investigates codebases and gathers context for tasks.",
    isLead: false,
    status: "idle",
    capabilities: ["research", "documentation", "analysis"],
  },
  {
    name: "Sentinel",
    role: "Code Reviewer",
    description: "Reviews PRs for correctness and security.",
    isLead: false,
    status: "offline",
    capabilities: ["code-review", "security", "testing"],
  },
  {
    name: "Blaze",
    role: "DevOps Engineer",
    description: "Manages deployments, CI/CD pipelines, and infrastructure.",
    isLead: false,
    status: "idle",
    capabilities: ["docker", "ci-cd", "monitoring", "bash"],
  },
  {
    name: "Pixel",
    role: "Frontend Developer",
    description: "Builds and polishes user interfaces with React and CSS.",
    isLead: false,
    status: "busy",
    capabilities: ["react", "css", "accessibility", "design"],
  },
  {
    name: "Cipher",
    role: "Security Analyst",
    description: "Audits code for vulnerabilities and enforces security practices.",
    isLead: false,
    status: "idle",
    capabilities: ["security", "penetration-testing", "compliance"],
  },
  {
    name: "Quill",
    role: "Technical Writer",
    description: "Writes documentation, API guides, and onboarding materials.",
    isLead: false,
    status: "offline",
    capabilities: ["documentation", "markdown", "api-docs"],
  },
];

const TASK_TEMPLATES = [
  {
    task: "Implement user authentication middleware with JWT validation",
    tags: ["backend", "auth", "security"],
    taskType: "implementation",
  },
  {
    task: "Fix race condition in WebSocket connection handler",
    tags: ["backend", "bugfix", "websocket"],
    taskType: "bugfix",
  },
  {
    task: "Add pagination to the /api/tasks endpoint",
    tags: ["backend", "api", "performance"],
    taskType: "implementation",
  },
  {
    task: "Write unit tests for the workflow engine executor",
    tags: ["testing", "workflows"],
    taskType: "testing",
  },
  {
    task: "Research best practices for SQLite WAL mode in production",
    tags: ["research", "database"],
    taskType: "research",
  },
  {
    task: "Review PR #142: Add rate limiting to API endpoints",
    tags: ["review", "security", "api"],
    taskType: "review",
  },
  {
    task: "Migrate dashboard charts from Chart.js to Recharts",
    tags: ["frontend", "dashboard", "migration"],
    taskType: "implementation",
  },
  {
    task: "Set up GitHub Actions workflow for automated releases",
    tags: ["devops", "ci-cd", "github"],
    taskType: "implementation",
  },
  {
    task: "Investigate memory leak in long-running agent sessions",
    tags: ["debugging", "performance"],
    taskType: "investigation",
  },
  {
    task: "Add Slack notification for failed workflow runs",
    tags: ["slack", "workflows", "notifications"],
    taskType: "implementation",
  },
  {
    task: "Update API documentation for new MCP tool endpoints",
    tags: ["documentation", "api"],
    taskType: "documentation",
  },
  {
    task: "Optimize database queries for the agent dashboard",
    tags: ["performance", "database", "dashboard"],
    taskType: "optimization",
  },
  {
    task: "Implement configurable retry logic for webhook deliveries",
    tags: ["backend", "webhooks", "reliability"],
    taskType: "implementation",
  },
  {
    task: "Add end-to-end tests for the task lifecycle flow",
    tags: ["testing", "e2e", "tasks"],
    taskType: "testing",
  },
  {
    task: "Create onboarding guide for new agent templates",
    tags: ["documentation", "templates"],
    taskType: "documentation",
  },
  {
    task: "Fix timezone handling in scheduled task cron execution",
    tags: ["bugfix", "scheduling"],
    taskType: "bugfix",
  },
];

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
  { status: "cancelled", needsAgent: true, needsFinish: true },
];

const MESSAGE_TEMPLATES = [
  "Just finished the implementation. PR is up for review.",
  "I'm seeing some flaky tests in CI. Investigating now.",
  "Can someone review the changes to the auth middleware?",
  "Deployed v1.51 to staging. All health checks passing.",
  "The database migration ran smoothly. No issues found.",
  "I've updated the API docs to reflect the new endpoints.",
  "Found the root cause of the memory leak — it's in the WebSocket handler.",
  "Good morning! Starting work on the dashboard charts migration.",
  "The E2E tests are all green. Ready to merge.",
  "Blocked on the auth PR. Need security review before proceeding.",
  "Created a new epic for the API v2 migration. Please review the PRD.",
  "The cron scheduler is now handling timezone offsets correctly.",
  "I'll pick up the Slack notification task next.",
  "Just submitted my code review. A few suggestions in the comments.",
  "The worktree setup is working well for parallel development.",
];

const MEMORY_TEMPLATES = [
  {
    name: "auth-middleware-patterns",
    content:
      "The API uses Bearer token auth via the Authorization header. API_KEY from .env is the master key. Agent-specific requests also require X-Agent-ID header.",
    source: "manual" as const,
  },
  {
    name: "sqlite-wal-gotcha",
    content:
      "SQLite WAL mode requires that the -wal and -shm files are NOT deleted while the DB is open. Always close connections before removing DB files in tests.",
    source: "manual" as const,
  },
  {
    name: "workflow-interpolation",
    content:
      'Workflow template interpolation uses {{path.to.value}} syntax. Upstream node outputs are NOT available by default — you must declare an inputs mapping to access them.',
    source: "task_completion" as const,
  },
  {
    name: "docker-entrypoint-idempotency",
    content:
      "Docker entrypoint must be idempotent. On second boot with same AGENT_ID, registration should be skipped. Use config checks to detect previous registration.",
    source: "session_summary" as const,
  },
  {
    name: "biome-formatting-rules",
    content:
      "Codebase uses Biome with 2-space indent, double quotes, 100 char line width. Run bun run lint:fix before every commit.",
    source: "manual" as const,
  },
  {
    name: "test-db-isolation",
    content:
      "Tests must use isolated SQLite DBs (e.g. ./test-<name>.sqlite) with initDb()/closeDb() in beforeAll/afterAll. Clean up -wal and -shm files too.",
    source: "file_index" as const,
  },
  {
    name: "mcp-session-handshake",
    content:
      'MCP tool testing requires a session handshake: initialize → extract session ID → send initialized notification → call tools. Accept header must include both application/json and text/event-stream.',
    source: "session_summary" as const,
  },
  {
    name: "worker-api-boundary",
    content:
      "Worker-side code must NEVER import from src/be/db or bun:sqlite. Workers communicate with the API exclusively via HTTP. Enforced by scripts/check-db-boundary.sh.",
    source: "manual" as const,
  },
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
  const pool = [...explicit];

  // Fill remaining from defaults if needed
  for (const def of DEFAULT_AGENTS) {
    if (pool.length >= count) break;
    if (!pool.find((a) => a.name === def.name)) {
      pool.push(def);
    }
  }

  const agents: { id: string; name: string; isLead: boolean }[] = [];
  const stmt = db.prepare(`
    INSERT INTO agents (id, name, isLead, status, description, role, capabilities, maxTasks, createdAt, lastUpdatedAt, lastActivityAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (let i = 0; i < count; i++) {
    const seed = pool[i % pool.length];
    const id = uuid();
    const ts = daysAgo(Math.floor(Math.random() * 30));
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
      daysAgo(Math.floor(Math.random() * 3)),
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

  const defaults: ChannelSeed[] = [
    {
      name: "engineering",
      description: "Engineering discussions",
      type: "public",
    },
    {
      name: "deployments",
      description: "Deployment coordination",
      type: "public",
    },
    {
      name: "standup",
      description: "Daily standup updates",
      type: "public",
    },
    { name: "random", description: "Off-topic chat", type: "public" },
    { name: "incidents", description: "Incident response", type: "public" },
  ];

  const pool = [...explicit];
  for (const def of defaults) {
    if (pool.length >= count) break;
    if (!pool.find((c) => c.name === def.name)) pool.push(def);
  }

  const stmt = db.prepare(`
    INSERT INTO channels (id, name, description, type, createdBy, participants, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  for (let i = 0; i < count; i++) {
    const seed = pool[i % pool.length];
    const id = uuid();
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
    INSERT INTO channel_messages (id, channelId, agentId, content, mentions, createdAt)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  for (const channel of channels) {
    for (let i = 0; i < perChannel; i++) {
      const agent = pick(agents);
      const content = pick(MESSAGE_TEMPLATES);
      const mentioned = Math.random() > 0.7 ? pickN(agents, 1).map((a) => a.id) : [];
      stmt.run(
        uuid(),
        channel.id,
        agent.id,
        content,
        JSON.stringify(mentioned),
        daysAgo(Math.floor(Math.random() * 7)),
      );
      total++;
    }
  }

  console.log(`  ✓ Seeded ${total} messages across ${channels.length} channels`);
}

function seedEpics(
  db: Database,
  config: SeedConfig,
  agents: { id: string; isLead: boolean }[],
  channels: { id: string }[],
): { id: string; name: string }[] {
  const count = config.epics.count;
  const explicit = config.epics.data ?? [];
  const epics: { id: string; name: string }[] = [];

  const defaults: EpicSeed[] = [
    {
      name: "Auth System Overhaul",
      goal: "Replace legacy session-based auth with JWT tokens and OAuth2 support",
      description: "Complete rewrite of the authentication system",
      status: "active",
      priority: 80,
      tags: ["security", "auth"],
    },
    {
      name: "Dashboard v2",
      goal: "Rebuild the monitoring dashboard with real-time updates",
      description: "Next-gen dashboard with WebSocket updates",
      status: "draft",
      priority: 60,
      tags: ["frontend", "dashboard"],
    },
    {
      name: "API v2 Migration",
      goal: "Migrate all REST endpoints to v2 with improved pagination and filtering",
      description: "Standardize API responses and add cursor-based pagination",
      status: "active",
      priority: 70,
      tags: ["api", "backend"],
    },
  ];

  const pool = [...explicit];
  for (const def of defaults) {
    if (pool.length >= count) break;
    if (!pool.find((e) => e.name === def.name)) pool.push(def);
  }

  const lead = agents.find((a) => a.isLead) ?? agents[0];
  const stmt = db.prepare(`
    INSERT INTO epics (id, name, description, goal, status, priority, tags, createdByAgentId, leadAgentId, channelId, createdAt, lastUpdatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (let i = 0; i < count; i++) {
    const seed = pool[i % pool.length];
    const id = uuid();
    const channel = channels.length > 0 ? pick(channels).id : null;
    stmt.run(
      id,
      seed.name,
      seed.description,
      seed.goal,
      seed.status,
      seed.priority,
      JSON.stringify(seed.tags),
      lead.id,
      lead.id,
      channel,
      daysAgo(21),
      now(),
    );
    epics.push({ id, name: seed.name });
  }

  console.log(`  ✓ Seeded ${count} epics`);
  return epics;
}

function seedTasks(
  db: Database,
  config: SeedConfig,
  agents: { id: string }[],
  epics: { id: string }[],
): void {
  const count = config.tasks.count;

  const stmt = db.prepare(`
    INSERT INTO agent_tasks (
      id, agentId, creatorAgentId, task, status, source, taskType, tags,
      priority, dependsOn, epicId, createdAt, lastUpdatedAt, finishedAt,
      failureReason, output, progress
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const logStmt = db.prepare(`
    INSERT INTO agent_log (id, eventType, agentId, taskId, newValue, createdAt)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  for (let i = 0; i < count; i++) {
    const template = TASK_TEMPLATES[i % TASK_TEMPLATES.length];
    const statusInfo = TASK_STATUSES[i % TASK_STATUSES.length];
    const id = uuid();
    const agent = statusInfo.needsAgent ? pick(agents) : null;
    const creator = pick(agents);
    const epic = Math.random() > 0.5 && epics.length > 0 ? pick(epics) : null;
    const priority = 20 + Math.floor(Math.random() * 60);
    const createdAt = daysAgo(Math.floor(Math.random() * 14));
    const finishedAt = statusInfo.needsFinish ? daysAgo(Math.floor(Math.random() * 3)) : null;

    let failureReason: string | null = null;
    let output: string | null = null;
    let progress: string | null = null;

    if (statusInfo.status === "failed") {
      failureReason = "Test suite failed: 3 assertions did not pass";
    } else if (statusInfo.status === "completed") {
      output = "Task completed successfully. PR #" + (100 + i) + " merged.";
    } else if (statusInfo.status === "in_progress") {
      progress = "Working on implementation, ~60% done";
    }

    stmt.run(
      id,
      agent?.id ?? null,
      creator.id,
      template.task,
      statusInfo.status,
      pick(["mcp", "slack", "api"]),
      template.taskType,
      JSON.stringify(template.tags),
      priority,
      "[]",
      epic?.id ?? null,
      createdAt,
      now(),
      finishedAt,
      failureReason,
      output,
      progress,
    );

    // Add a log entry for each task
    logStmt.run(uuid(), "task_created", creator.id, id, statusInfo.status, createdAt);
  }

  console.log(`  ✓ Seeded ${count} tasks`);
}

function seedWorkflows(db: Database, config: SeedConfig): void {
  const count = config.workflows.count;
  const explicit = config.workflows.data ?? [];

  const defaults: WorkflowSeed[] = [
    {
      name: "PR Review Pipeline",
      description: "Automated PR review, testing, and feedback",
      definition: {
        nodes: [
          {
            id: "review",
            type: "agent-task",
            config: { template: "Review the PR for code quality issues" },
            next: ["test"],
          },
          {
            id: "test",
            type: "agent-task",
            config: { template: "Run the test suite and report results" },
          },
        ],
      },
    },
  ];

  const pool = [...explicit];
  for (const def of defaults) {
    if (pool.length >= count) break;
    if (!pool.find((w) => w.name === def.name)) pool.push(def);
  }

  const stmt = db.prepare(`
    INSERT INTO workflows (id, name, description, enabled, definition, triggers, createdAt, lastUpdatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (let i = 0; i < count; i++) {
    const seed = pool[i % pool.length];
    stmt.run(
      uuid(),
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

  const defaults: ScheduleSeed[] = [
    {
      name: "Daily Standup Summary",
      description: "Collects status from all agents and posts a daily summary",
      cronExpression: "0 9 * * 1-5",
      taskTemplate: "Collect status updates from all agents and post a summary",
      tags: ["standup", "daily"],
      priority: 40,
    },
  ];

  const pool = [...explicit];
  for (const def of defaults) {
    if (pool.length >= count) break;
    if (!pool.find((s) => s.name === def.name)) pool.push(def);
  }

  const stmt = db.prepare(`
    INSERT INTO scheduled_tasks (
      id, name, description, cronExpression, taskTemplate, taskType, tags,
      priority, targetAgentId, enabled, timezone, scheduleType, createdAt, lastUpdatedAt
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (let i = 0; i < count; i++) {
    const seed = pool[i % pool.length];
    const target = pick(agents);
    stmt.run(
      uuid(),
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
  const pool = MEMORY_TEMPLATES.slice(0, count);

  const stmt = db.prepare(`
    INSERT INTO agent_memory (id, agentId, scope, name, content, source, tags, createdAt, accessedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (let i = 0; i < count; i++) {
    const template = pool[i % pool.length];
    const agent = pick(agents);
    const scope = Math.random() > 0.5 ? "swarm" : "agent";
    stmt.run(
      uuid(),
      agent.id,
      scope,
      template.name,
      template.content,
      template.source,
      "[]",
      daysAgo(Math.floor(Math.random() * 14)),
      daysAgo(Math.floor(Math.random() * 3)),
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

  const defaults: ServiceSeed[] = [
    {
      name: "dashboard-api",
      description: "Dashboard backend API",
      port: 8080,
      healthCheckPath: "/health",
      status: "healthy",
      script: "bun run src/dashboard/server.ts",
    },
  ];

  const pool = [...explicit];
  for (const def of defaults) {
    if (pool.length >= count) break;
    if (!pool.find((s) => s.name === def.name)) pool.push(def);
  }

  const stmt = db.prepare(`
    INSERT INTO services (id, agentId, name, port, description, healthCheckPath, status, script, metadata, createdAt, lastUpdatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (let i = 0; i < count; i++) {
    const seed = pool[i % pool.length];
    const agent = pick(agents);
    stmt.run(
      uuid(),
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
// Table cleanup
// ---------------------------------------------------------------------------

const TABLES_IN_DELETE_ORDER = [
  "channel_read_state",
  "channel_messages",
  "channel_activity_cursors",
  "inbox_messages",
  "session_logs",
  "session_costs",
  "active_sessions",
  "agent_skills",
  "skills",
  "approval_requests",
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
  "epics",
  "channels",
  "swarm_config",
  "swarm_repos",
  "agentmail_inbox_mappings",
  "agents",
];

function cleanDatabase(db: Database): void {
  console.log("  Cleaning existing data...");
  db.run("PRAGMA foreign_keys = OFF;");

  for (const table of TABLES_IN_DELETE_ORDER) {
    try {
      db.run(`DELETE FROM ${table}`);
    } catch {
      // Table might not exist in older schemas, skip silently
    }
  }

  db.run("PRAGMA foreign_keys = ON;");
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
  --epics <n>         Number of epics to seed
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
  overrides: Partial<SeedConfig> & { agentCount?: number; taskCount?: number; channelCount?: number; epicCount?: number; messagesPerChannel?: number };
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
      case "--epics":
        overrides.epicCount = Number.parseInt(args[++i], 10);
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

function loadConfig(configPath: string, overrides: ReturnType<typeof parseArgs>["overrides"]): SeedConfig {
  if (!existsSync(configPath)) {
    console.error(`Config file not found: ${configPath}`);
    process.exit(1);
  }

  const raw = JSON.parse(readFileSync(configPath, "utf-8"));
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
    epics: {
      count: overrides.epicCount ?? raw.epics?.count ?? 2,
      data: raw.epics?.data,
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
  };

  return config;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const { configPath, overrides } = parseArgs(process.argv);
  const config = loadConfig(configPath, overrides);

  console.log(`\n🌱 Agent Swarm Database Seeder`);
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
  const epics = seedEpics(db, config, agents, channels);
  seedTasks(db, config, agents, epics);
  seedWorkflows(db, config);
  seedSchedules(db, config, agents);
  seedMemories(db, config, agents);
  seedServices(db, config, agents);

  db.close();

  console.log(`\n✅ Seeding complete! Database: ${config.db}\n`);
}

main();
