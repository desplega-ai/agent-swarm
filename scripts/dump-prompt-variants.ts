#!/usr/bin/env bun
/**
 * Render every system-prompt variant the swarm can produce (code defaults,
 * no DB overrides) plus a catalog of every registered prompt template.
 *
 * Usage:
 *   bun scripts/dump-prompt-variants.ts [outDir]
 *
 * Default outDir: work/prompt-variants/ (gitignored, regenerable)
 *
 * Output:
 *   00-INDEX.md                     variant matrix + branch decisions + sizes
 *   system/<variant>.md             fully rendered system prompt per variant
 *   blocks/<eventType>.md           each system.* building block, standalone
 *   templates/<category>.md         every registered template (header, body, vars)
 *   task-prompts.md                 sample renders of the per-task (turn) prompts
 *
 * Pure worker-side code: no DB, no HTTP. The resolver falls back to code
 * defaults because neither configureDbResolver nor configureHttpResolver runs.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type BasePromptArgs, getBasePrompt } from "../src/prompts/base-prompt";
import { getAllTemplateDefinitions } from "../src/prompts/registry";
import { resolveTemplateAsync } from "../src/prompts/resolver";
import type { ProviderTraits } from "../src/providers/types";

// Side-effect imports: register every template module that exists in the repo.
import "../src/prompts/session-templates";
import "../src/commands/templates";
import "../src/github/templates";
import "../src/gitlab/templates";
import "../src/slack/templates";
import "../src/linear/templates";
import "../src/jira/templates";
import "../src/agentmail/templates";
import "../src/heartbeat/templates";
import "../src/tools/templates";

// ─── Provider trait fixtures (mirrors src/providers/*-adapter.ts) ────────────

const TRAITS: Record<string, ProviderTraits> = {
  claude: {
    hasMcp: true,
    nativeSkillDiscovery: true,
    hasLocalEnvironment: true,
    steerModes: ["queue"],
  },
  codex: {
    hasMcp: true,
    nativeSkillDiscovery: false,
    hasLocalEnvironment: true,
    steerModes: ["queue"],
  },
  opencode: {
    hasMcp: true,
    nativeSkillDiscovery: false,
    hasLocalEnvironment: true,
    steerModes: ["queue"],
  },
  pi: {
    hasMcp: true,
    nativeSkillDiscovery: true,
    hasLocalEnvironment: true,
    steerModes: ["steer", "queue"],
  },
  "claude-managed": {
    hasMcp: true,
    hasLocalEnvironment: false,
    steerModes: ["steer", "queue"],
  },
  devin: {
    hasMcp: false,
    nativeSkillDiscovery: false,
    hasLocalEnvironment: false,
    steerModes: ["queue"],
  },
};

const AGENT_ID = "11111111-2222-3333-4444-555555555555";

const FULL_SERVER_CAPS = [
  "core",
  "slack",
  "messaging",
  "services",
  "pages",
  "memory",
  "skills",
  "scripts",
];

const SKILLS = [
  { name: "work-on-task", description: "Work on a specific task assigned to you" },
  { name: "review-pr", description: "Review a pull request and provide feedback" },
  { name: "swarm-scripts", description: "Bulk SDK calls via scripts" },
];

const MCP_SERVERS = ["linear"];

const REPO_CONTEXT: NonNullable<BasePromptArgs["repoContext"]> = {
  clonePath: "/workspace/personal/repos/example-repo",
  claudeMd: "# Example Repo\n\nUse bun. Run `bun test` before pushing.\n",
  autoStashes: [{ ref: "stash@{0}", message: "WIP: half-done refactor" }],
  guidelines: {
    prChecks: ["bun run lint", "bun run tsc:check", "bun run test"],
    mergeChecks: ["CI green", "1 approval"],
    allowMerge: false,
    review: ["Flag any new env var without docs"],
  },
};

const IDENTITY = {
  name: "Picateclas",
  description: "Backend-focused worker that ships small PRs.",
  soulMd: "# SOUL.md (sample)\n\nYou are Picateclas. Terse, careful, ships.\n",
  // Edited (non-default) identity + notes, so the inject-when-edited rule fires.
  identityMd: "# IDENTITY.md (sample)\n\n- Name: Picateclas\n- Role: worker\n",
  claudeMd: "# Agent: Picateclas (sample CLAUDE.md)\n\n## Notes\n- Prefer small PRs.\n",
};

// ─── Variant matrix ──────────────────────────────────────────────────────────

type Env = Record<string, string | undefined>;

interface Variant {
  id: string;
  title: string;
  env: Env;
  args: BasePromptArgs;
  notes: string;
}

const baseEnv: Env = {
  SLACK_DISABLE: undefined,
  SLACK_BOT_TOKEN: undefined,
  SLACK_APP_TOKEN: undefined,
  STEERING_ENABLED: undefined,
  AGENT_FS_API_URL: undefined,
  AGENT_FS_SHARED_ORG_ID: undefined,
  SCRIPTS_ONLY_MCP: undefined,
};

const slackEnv: Env = { SLACK_BOT_TOKEN: "xoxb-sample", SLACK_APP_TOKEN: "xapp-sample" };

function v(
  id: string,
  title: string,
  provider: keyof typeof TRAITS,
  role: "lead" | "worker",
  extra: Partial<BasePromptArgs>,
  env: Env,
  notes: string,
): Variant {
  return {
    id,
    title,
    env: { ...baseEnv, ...env },
    args: {
      role,
      agentId: AGENT_ID,
      traits: TRAITS[provider],
      provider: provider as BasePromptArgs["provider"],
      ...extra,
    },
    notes,
  };
}

const kitchenSinkArgs: Partial<BasePromptArgs> = {
  serverCapabilities: FULL_SERVER_CAPS,
  capabilities: ["artifacts", "pages", "services"],
  ...IDENTITY,
  repoContext: REPO_CONTEXT,
  skillsSummary: SKILLS,
  mcpServers: MCP_SERVERS,
};

const kitchenSinkEnv: Env = {
  ...slackEnv,
  STEERING_ENABLED: "true",
  AGENT_FS_API_URL: "https://agent-fs.example.dev",
  AGENT_FS_SHARED_ORG_ID: "org_shared_sample",
};

const VARIANTS: Variant[] = [
  v(
    "01-claude-worker-minimal",
    "Claude worker, minimal (fresh agent, no Slack, no steering, older server)",
    "claude",
    "worker",
    {},
    {},
    "serverCapabilities undefined → legacy gating (pages, slack, core assumed). No identity files: role line only.",
  ),
  v(
    "02-claude-lead-minimal",
    "Claude lead, minimal",
    "claude",
    "lead",
    {},
    {},
    "Same as 01 but composite = system.session.lead.",
  ),
  v(
    "03-claude-worker-full",
    "Claude worker, everything on (Slack task, steering, agent-fs, repo + guidelines, identity, skills, MCP servers)",
    "claude",
    "worker",
    { ...kitchenSinkArgs, slackContext: { channelId: "C0SAMPLE", threadTs: "1723456789.000100" } },
    kitchenSinkEnv,
    "Every conditional block fires. nativeSkillDiscovery=true → skills rendered as a count + discovery pointer.",
  ),
  v(
    "04-claude-lead-full",
    "Claude lead, everything on",
    "claude",
    "lead",
    { ...kitchenSinkArgs, slackContext: { channelId: "C0SAMPLE" } },
    kitchenSinkEnv,
    "Same Slack block as the worker (one block for both roles in v2).",
  ),
  v(
    "05-codex-worker-full",
    "Codex worker, everything on",
    "codex",
    "worker",
    { ...kitchenSinkArgs, slackContext: { channelId: "C0SAMPLE" } },
    kitchenSinkEnv,
    "nativeSkillDiscovery=false → skills enumerated as /name bullets. Prompt is delivered via a managed AGENTS.md in cwd, not a CLI flag.",
  ),
  v(
    "06-opencode-worker-full",
    "opencode worker, everything on",
    "opencode",
    "worker",
    { ...kitchenSinkArgs },
    kitchenSinkEnv,
    "Identical traits to codex for prompt purposes.",
  ),
  v(
    "07-pi-worker-full",
    "pi worker, everything on",
    "pi",
    "worker",
    { ...kitchenSinkArgs, slackContext: { channelId: "C0SAMPLE" } },
    kitchenSinkEnv,
    "Same composite as claude in v2 (no pi-specific composite). CLAUDE.md injected because pi does not load it natively.",
  ),
  v(
    "08-pi-lead-full",
    "pi lead, everything on",
    "pi",
    "lead",
    { ...kitchenSinkArgs },
    kitchenSinkEnv,
    "Same lead composite as claude in v2.",
  ),
  v(
    "09-claude-managed-worker",
    "claude-managed worker (MCP yes, local env no)",
    "claude-managed",
    "worker",
    {
      serverCapabilities: FULL_SERVER_CAPS,
      name: IDENTITY.name,
      description: IDENTITY.description,
      skillsSummary: SKILLS,
      mcpServers: MCP_SERVERS,
      repoContext: REPO_CONTEXT,
      slackContext: { channelId: "C0SAMPLE" },
    },
    kitchenSinkEnv,
    "Composite = system.session.worker.managed (remote workspace block). Outputs without agent-fs. No CLAUDE.md. Repo guidelines kept.",
  ),
  v(
    "10-devin-worker-remote",
    "Devin worker (no MCP, no local env)",
    "devin",
    "worker",
    {
      name: IDENTITY.name,
      description: IDENTITY.description,
      repoContext: REPO_CONTEXT,
      skillsSummary: SKILLS,
    },
    kitchenSinkEnv,
    "Composite = system.session.worker.remote. No tool names, no outputs/slack/steering/skills/MCP sections. Guidelines still injected.",
  ),
  v(
    "11-claude-worker-scripts-only",
    "Claude worker, scripts-only MCP (code-mode) + Slack task",
    "claude",
    "worker",
    { ...kitchenSinkArgs, scriptsOnly: true, slackContext: { channelId: "C0SAMPLE" } },
    kitchenSinkEnv,
    "Appends system.agent.scripts_only_mode; Slack via scripts_only_mode.slack; steering + named Slack block suppressed.",
  ),
  v(
    "12-claude-lead-scripts-only",
    "Claude lead, scripts-only MCP",
    "claude",
    "lead",
    { ...kitchenSinkArgs, scriptsOnly: true },
    kitchenSinkEnv,
    "Lead composite still lists named tools (send-task, get-swarm) that do not exist in scripts-only mode; scripts_only_mode block then contradicts them.",
  ),
  v(
    "13-claude-worker-newserver-no-optional-caps",
    "Claude worker, server reports capabilities = core only",
    "claude",
    "worker",
    { serverCapabilities: ["core"], capabilities: ["artifacts"] },
    slackEnv,
    "Shows the capability-gated path: no Slack block, no outputs block (pages capability off).",
  ),
];

// ─── Branch-decision readout ─────────────────────────────────────────────────

function describeBranches(variant: Variant, rendered: string): string[] {
  const has = (s: string) => rendered.includes(s);
  return [
    `composite: ${detectComposite(variant)}`,
    `scripts_only_mode: ${has("## Code-Mode: script tools ONLY")}`,
    `system.agent.outputs: ${has("## Outputs")} (${has("agent-fs is the shared drive") ? "agent-fs" : has("agent-fs is not configured") ? "no agent-fs" : "n/a"})`,
    `system.agent.slack: ${has("## Slack\n")}`,
    `system.agent.scripts_only_mode.slack: ${has("## Slack (scripts-only)")}`,
    `system.agent.steering: ${has("## Live task steering")}`,
    `persona: soul=${has("SOUL.md")} identity=${has("IDENTITY.md")}`,
    `tools and skills: ${has("## Tools and skills")} (${has("skills installed.") ? "count+pointer" : has("Installed skills.") ? "enumerated" : "no skills"})`,
    `MCP servers: ${has("Connected MCP servers:")}`,
    `repository: ${has("## Repository\n")}`,
    `repo guidelines (MANDATORY): ${has("### Repository Guidelines (MANDATORY)")}`,
    `repo CLAUDE.md inlined: ${has("The repository's CLAUDE.md")}`,
    `agent CLAUDE.md: ${has("## Your notes (CLAUDE.md)")}`,
  ];
}

function detectComposite(variant: Variant): string {
  const { traits, role } = variant.args;
  if (!traits?.hasMcp) return "system.session.worker.remote";
  if (traits.hasLocalEnvironment === false)
    return role === "lead" ? "system.session.lead.managed" : "system.session.worker.managed";
  return role === "lead" ? "system.session.lead" : "system.session.worker";
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function applyEnv(env: Env) {
  for (const [k, val] of Object.entries(env)) {
    if (val === undefined) delete process.env[k];
    else process.env[k] = val;
  }
}

const approxTokens = (s: string) => Math.round(s.length / 4);

function fence(s: string, lang = "markdown"): string {
  // Use a 5-backtick fence so nested ``` blocks in prompt bodies survive.
  return `\`\`\`\`\`${lang}\n${s}\n\`\`\`\`\``;
}

// ─── Task (turn) prompt sample renders ───────────────────────────────────────
// Mirrors buildPromptForTrigger / buildResumePrompt in src/commands/runner.ts.

async function renderTaskPrompts(): Promise<string> {
  const taskId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const fmt = (c: string) => `/${c}`;
  const out: string[] = ["# Per-task (turn) prompts, sample renders", ""];
  out.push(
    "These are what the harness receives as the *user turn* when a trigger fires. Built by `buildPromptForTrigger` / `buildResumePrompt` in `src/commands/runner.ts`.",
    "",
    "Final turn prompt = `[context preamble] + trigger prompt + [memories] + [working-directory note]`, with an optional profile-sync-rejection banner prepended.",
    "",
  );

  const genericOut =
    '\n\nWhen done, use `store-progress` with status: "completed" and include your output.';
  const schema = {
    type: "object",
    properties: { summary: { type: "string" } },
    required: ["summary"],
  };
  const schemaOut = `\n\n**Required Output Format**: When completing this task, you MUST call store-progress with output that is valid JSON conforming to this schema:\n\`\`\`json\n${JSON.stringify(schema, null, 2)}\n\`\`\`\nCall store-progress with status "completed" and your JSON output. If your output doesn't match the schema, the tool call will fail and you should fix and retry.`;
  const attachments = `\n\n📎 Attachment(s) — fetch directly, no need to discover the storage path yourself:\n- spec.pdf (application/pdf, 20480 bytes): \`curl -s -H "Authorization: Bearer \${AGENT_SWARM_API_KEY:-$API_KEY}" -H "X-Agent-ID: $AGENT_ID" "$MCP_BASE_URL/api/fs/tasks/${taskId}/files/att_1/raw" -o /tmp/spec.pdf\``;

  const samples: Array<{
    title: string;
    eventType: string;
    vars: Record<string, unknown>;
    note?: string;
  }> = [
    {
      title: "task_assigned (Claude/codex/opencode, generic output)",
      eventType: "task.trigger.assigned",
      vars: {
        work_on_task_cmd: fmt("work-on-task"),
        task_id: taskId,
        task_desc_section: `\n\nTask: "Fix the flaky heartbeat test"\n\nRequested by: Taras (t@desplega.ai)`,
        attachments_section: "",
        output_instructions: genericOut,
      },
    },
    {
      title: "task_assigned with outputSchema + attachment",
      eventType: "task.trigger.assigned",
      vars: {
        work_on_task_cmd: fmt("work-on-task"),
        task_id: taskId,
        task_desc_section: `\n\nTask: "Summarize the attached spec"`,
        attachments_section: attachments,
        output_instructions: schemaOut,
      },
    },
    {
      title: "task_assigned (pi: /skill: prefix)",
      eventType: "task.trigger.assigned",
      vars: {
        work_on_task_cmd: "/skill:work-on-task",
        task_id: taskId,
        task_desc_section: `\n\nTask: "Fix the flaky heartbeat test"`,
        attachments_section: "",
        output_instructions: genericOut,
      },
    },
    {
      title: "task_assigned (devin: no MCP → no command, no task id, no output instructions)",
      eventType: "task.trigger.assigned",
      vars: {
        work_on_task_cmd: "",
        task_id: "",
        task_desc_section: `\n\nTask: "Fix the flaky heartbeat test"`,
        attachments_section: "",
        output_instructions: "",
      },
      note: "Devin's formatCommand is `@skills:<name>` but hasMcp=false blanks the command entirely.",
    },
    {
      title: "task_offered",
      eventType: "task.trigger.offered",
      vars: {
        review_offered_task_cmd: fmt("review-offered-task"),
        task_id: taskId,
        task_desc_section: `\n\nA task has been offered to you:\n"Review PR #42"`,
      },
    },
    {
      title: "unread_mentions",
      eventType: "task.trigger.unread_mentions",
      vars: { mention_count: 3 },
    },
    {
      title: "pool_tasks_available",
      eventType: "task.trigger.pool_available",
      vars: { task_count: 2 },
    },
    {
      title: "channel_activity (Slack)",
      eventType: "task.trigger.channel_activity",
      vars: {
        message_count: 2,
        messages_detail:
          "- **#swarm-dev-2** (user: U0TARAS): can someone look at the failing deploy?\n- **#general** (user: U0OTHER): lunch at 1?\n",
      },
    },
    {
      title: "resumption with progress (deploy interruption path)",
      eventType: "task.resumption.with_progress",
      vars: {
        work_on_task_cmd: fmt("work-on-task"),
        task_id: taskId,
        task_description: "Fix the flaky heartbeat test",
        progress: "Reproduced locally. Root cause: fractional threshold rounding.",
        completion_instructions: genericOut,
      },
    },
    {
      title: "resumption without progress",
      eventType: "task.resumption.no_progress",
      vars: {
        work_on_task_cmd: fmt("work-on-task"),
        task_id: taskId,
        task_description: "Fix the flaky heartbeat test",
        completion_instructions: genericOut,
      },
    },
    {
      title: "Requester Profile (appended to the SYSTEM prompt, not the turn)",
      eventType: "task.requester.profile",
      vars: {
        requester_name: "Taras",
        requester_role_suffix: " (founder)",
        requester_comms_section:
          "\nTheir communication preferences: tone: direct, language: en, verbosity: terse.",
        requester_notes_section:
          "\nTheir stated notes for how you should respond and act:\nNever use em dashes.",
      },
      note: "Only rendered when role, notes, or comms exist. Joined after the base prompt and before SYSTEM_PROMPT extra text.",
    },
    {
      title: "Steering delivery envelope (injected mid-session)",
      eventType: "system.agent.steering.delivery",
      vars: { steeringMessageId: "steer_123", body: "Also update the runbook when you are done." },
    },
    {
      title: "App action task (task description, created by src/http/apps.ts)",
      eventType: "task.app.action",
      vars: {
        prompt: "Triage this incident and post a summary.",
        app_id: "incidents",
        action_name: "triage",
        input_json: '{"incidentId":"inc_7"}',
      },
    },
  ];

  for (const s of samples) {
    const r = await resolveTemplateAsync(s.eventType, s.vars);
    out.push(`## ${s.title}`, "", `Template: \`${s.eventType}\``, "");
    if (s.note) out.push(`> ${s.note}`, "");
    out.push(fence(r.text), "");
  }

  out.push(
    "## Relevant Past Knowledge (memories, appended to the turn prompt)",
    "",
    "Rendered by `src/prompts/memories.ts` → `renderMemoriesPrompt`. Only memories with similarity > 0.4, content cut at 300 chars, max 5 results. Rating hint appended only when `MEMORY_RATERS` contains `explicit-self`.",
    "",
    fence(
      "\n\n### Relevant Past Knowledge\n\nThese memories from your previous sessions may be useful. Use `memory-get` with the memory ID to retrieve full details.\n\n- **heartbeat-threshold-gotcha** (id: mem_1): Fractional thresholds round down in the sweep...\n",
    ),
    "",
    "## Follow-up context preamble (prepended when task.parentTaskId is set)",
    "",
    "Built by `src/commands/context-preamble.ts`. Two shapes: `## Prior Conversation Context` (regular follow-up, default 4k-token budget, up to 5 ancestors) and `## Resuming Interrupted Task` (taskType=resume, larger budget, includes last 50 tool-call lines, artifacts in flight, undelivered steering). Not rendered here because it needs live task data.",
    "",
    "## Working directory note (appended when cwd != process.cwd())",
    "",
    fence(
      "\n\n---\n**Working Directory**: You are starting in `/workspace/personal/repos/example-repo`. This is the repository clone path for this task's VCS repo. You can still access any path on the filesystem — this is just your starting directory.",
    ),
    "",
  );

  return out.join("\n");
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const outDir = process.argv[2] ?? join("work", "prompt-variants");
  await mkdir(join(outDir, "system"), { recursive: true });
  await mkdir(join(outDir, "blocks"), { recursive: true });
  await mkdir(join(outDir, "templates"), { recursive: true });

  const index: string[] = [
    "# System prompt variants (code defaults, no DB overrides)",
    "",
    `Generated ${today} by \`bun scripts/dump-prompt-variants.ts\`. Re-run after editing \`src/prompts/session-templates.ts\` or \`src/prompts/base-prompt.ts\`.`,
    "",
    "## Variant matrix",
    "",
    "| # | Variant | Chars | ~Tokens | Notes |",
    "|---|---|---:|---:|---|",
  ];
  const branchSections: string[] = [];

  for (const variant of VARIANTS) {
    applyEnv(variant.env);
    const rendered = await getBasePrompt(variant.args);
    const file = `system/${variant.id}.md`;
    await Bun.write(join(outDir, file), rendered);
    index.push(
      `| ${variant.id.slice(0, 2)} | [${variant.title}](${file}) | ${rendered.length} | ${approxTokens(rendered)} | ${variant.notes} |`,
    );
    branchSections.push(
      `### ${variant.id}`,
      "",
      `env: \`${JSON.stringify(Object.fromEntries(Object.entries(variant.env).filter(([, x]) => x !== undefined)))}\``,
      "",
      ...describeBranches(variant, rendered).map((l) => `- ${l}`),
      "",
    );
  }
  applyEnv(baseEnv);

  index.push("", "## Branch decisions per variant", "", ...branchSections);

  // Blocks: every system.* template standalone (with refs expanded).
  const defs = getAllTemplateDefinitions().sort((a, b) => a.eventType.localeCompare(b.eventType));
  index.push(
    "## Building blocks (`system.*`)",
    "",
    "| eventType | Chars | ~Tokens | Variables |",
    "|---|---:|---:|---|",
  );
  for (const d of defs.filter((d) => d.category === "system" || d.category === "session")) {
    const vars: Record<string, string> = {
      name: "Picateclas",
      role: "worker",
      agentId: AGENT_ID,
      persona: "",
      slackChannelId: "C0SAMPLE",
      slackThreadTs: "1723456789.000100",
      steeringMessageId: "steer_123",
      body: "<steering body>",
      thread_messages: "user: hi\nbot: hello",
    };
    const r = await resolveTemplateAsync(d.eventType, vars);
    const file = `blocks/${d.eventType}.md`;
    await Bun.write(join(outDir, file), r.text);
    index.push(
      `| [${d.eventType}](${file}) | ${r.text.length} | ${approxTokens(r.text)} | ${d.variables.map((x) => x.name).join(", ") || "-"} |`,
    );
  }

  // Templates catalog by category (raw defaultBody, refs NOT expanded).
  const byCat = new Map<string, typeof defs>();
  for (const d of defs) {
    const list = byCat.get(d.category) ?? [];
    list.push(d);
    byCat.set(d.category, list);
  }
  index.push("", "## Template catalog by category", "");
  for (const [cat, list] of [...byCat.entries()].sort()) {
    const file = `templates/${cat}.md`;
    const doc: string[] = [
      `# Templates: category \`${cat}\``,
      "",
      `${list.length} templates. Raw \`defaultBody\` (template refs not expanded). Header is the non-overridable prefix.`,
      "",
    ];
    for (const d of list) {
      doc.push(`## \`${d.eventType}\``, "");
      if (d.variables.length) {
        doc.push("Variables:", "");
        for (const x of d.variables)
          doc.push(`- \`${x.name}\`: ${x.description}${x.example ? ` (e.g. ${x.example})` : ""}`);
        doc.push("");
      }
      if (d.header) doc.push("Header (always-on):", "", fence(d.header), "");
      doc.push("Body:", "", fence(d.defaultBody), "");
    }
    await Bun.write(join(outDir, file), doc.join("\n"));
    index.push(`- [${cat}](${file}): ${list.map((d) => `\`${d.eventType}\``).join(", ")}`);
  }

  await Bun.write(join(outDir, "task-prompts.md"), await renderTaskPrompts());
  index.push("", "## Per-task turn prompts", "", "- [task-prompts.md](task-prompts.md)", "");

  await Bun.write(join(outDir, "00-INDEX.md"), index.join("\n"));
  console.log(`Wrote ${VARIANTS.length} variants + ${defs.length} templates to ${outDir}`);
}

await main();
