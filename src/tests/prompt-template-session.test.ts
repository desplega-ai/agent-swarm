import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, initDb } from "../be/db";
import {
  clearTemplateDefinitions,
  getAllTemplateDefinitions,
  getTemplateDefinition,
} from "../prompts/registry";
import { resolveTemplate } from "../prompts/resolver";
import { restoreAllTemplateDefinitions } from "./template-registry-helpers";

// Side-effect import: register session + system templates
import "../prompts/session-templates";

const TEST_DB_PATH = "./test-prompt-session.sqlite";

/** U+2014. Written as an escape so this file stays free of the character. */
const EM_DASH = "\u2014";

/** The prompt v2 block set. Every entry is registered under category "system". */
const SYSTEM_TEMPLATES = [
  "system.agent.communication",
  "system.agent.communication.remote",
  "system.agent.lead",
  "system.agent.memory",
  "system.agent.memory.remote",
  "system.agent.outputs",
  "system.agent.outputs.no_agent_fs",
  "system.agent.repository",
  "system.agent.role",
  "system.agent.scripts_only_mode",
  "system.agent.scripts_only_mode.slack",
  "system.agent.secrets",
  "system.agent.slack",
  "system.agent.steering",
  "system.agent.steering.delivery",
  "system.agent.tool_preload",
  "system.agent.tools_skills",
  "system.agent.worker",
  "system.agent.worker.remote",
  "system.agent.workspace",
  "system.agent.workspace.remote",
];

/** The four composites. base-prompt.ts picks one per session by traits, then role. */
const SESSION_TEMPLATES = [
  "system.session.lead",
  "system.session.lead.managed",
  "system.session.worker",
  "system.session.worker.managed",
  "system.session.worker.remote",
];

/**
 * Re-register session templates if they've been cleared by other tests.
 */
async function ensureTemplatesRegistered(): Promise<void> {
  if (getTemplateDefinition("system.agent.role")) return;
  const ts = Date.now();
  await import(`../prompts/session-templates?t=${ts}`);
}

function sessionSystemEventTypes(category: "system" | "session"): string[] {
  return getAllTemplateDefinitions()
    .filter((d) => d.category === category)
    .map((d) => d.eventType)
    .sort();
}

beforeAll(async () => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {
      // File doesn't exist
    }
  }
  clearTemplateDefinitions();
  initDb(TEST_DB_PATH);
});

afterAll(async () => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {
      // File doesn't exist
    }
  }
  // This file clears the process-wide registry; heal it so later test files
  // (whose import graphs already evaluated the template modules) don't
  // resolve empty templates. CI(Linux)-only breakage otherwise, see
  // template-registry-helpers.ts.
  await restoreAllTemplateDefinitions();
});

// ============================================================================
// Registration
// ============================================================================

describe("Session templates: registration", () => {
  beforeEach(async () => {
    await ensureTemplatesRegistered();
  });

  test("registers exactly the prompt v2 system blocks", () => {
    expect(sessionSystemEventTypes("system")).toEqual([...SYSTEM_TEMPLATES].sort());
  });

  test("registers exactly the five session composites", () => {
    expect(sessionSystemEventTypes("session")).toEqual([...SESSION_TEMPLATES].sort());
  });

  test("registers 26 system and session templates in total", () => {
    const all = getAllTemplateDefinitions();
    const sessionSystem = all.filter((d) => d.category === "system" || d.category === "session");
    // 21 system blocks + 5 session composites.
    expect(sessionSystem.length).toBe(26);
  });

  test("drops the v1 blocks that prompt v2 deleted", () => {
    const removed = [
      "system.agent.register",
      "system.agent.self_awareness",
      "system.agent.filesystem",
      "system.agent.agent_fs",
      "system.agent.context_mode",
      "system.agent.script_authoring_contract",
      "system.agent.script_rubric",
      "system.agent.scheduling",
      "system.agent.seed_scripts",
      "system.agent.system",
      "system.agent.services",
      "system.agent.artifacts",
      "system.agent.apps",
      "system.agent.share_urls",
      "system.agent.code_quality",
      "system.agent.communication_style",
      "system.agent.messaging",
      "system.agent.worker.slack",
      "system.session.worker.pi",
      "system.session.lead.pi",
    ];

    for (const eventType of removed) {
      expect(getTemplateDefinition(eventType)).toBeUndefined();
    }
  });
});

// ============================================================================
// Individual block resolution
// ============================================================================

describe("Session templates: role block", () => {
  beforeEach(async () => {
    await ensureTemplatesRegistered();
  });

  test("interpolates name, role, agentId, and persona", () => {
    const result = resolveTemplate("system.agent.role", {
      name: "Ada",
      role: "worker",
      agentId: "agent-xyz-789",
      persona: "\nBackend worker.\n",
    });
    expect(result.skipped).toBe(false);
    expect(result.unresolved.length).toBe(0);
    expect(result.text).toContain("You are Ada, a worker in the swarm.");
    expect(result.text).toContain("Your agent ID is agent-xyz-789.");
    expect(result.text).toContain("Backend worker.");
  });

  test("leaves no dangling text when the persona is empty", () => {
    const result = resolveTemplate("system.agent.role", {
      name: "Ada",
      role: "worker",
      agentId: "agent-xyz-789",
      persona: "",
    });
    expect(result.unresolved.length).toBe(0);
    expect(result.text.trim()).toBe(
      "You are Ada, a worker in the swarm. Your agent ID is agent-xyz-789.",
    );
  });
});

describe("Session templates: MUST pointers", () => {
  beforeEach(async () => {
    await ensureTemplatesRegistered();
  });

  test("the worker contract points at the swarm-scripts skill", () => {
    const result = resolveTemplate("system.agent.worker", {});
    expect(result.text).toContain("You MUST use the `swarm-scripts` skill for this branch.");
  });

  test("the lead contract points at the heartbeat-runbook skill", () => {
    const result = resolveTemplate("system.agent.lead", {});
    expect(result.text).toContain(
      "You MUST use the `heartbeat-runbook` skill when you handle a heartbeat checklist task.",
    );
  });

  test("the memory block points at the memory skill", () => {
    const result = resolveTemplate("system.agent.memory", {});
    expect(result.text).toContain(
      "You MUST use the `memory` skill before you store, edit, or delete a memory.",
    );
  });

  test("the slack block points at the slack-interaction skill", () => {
    const result = resolveTemplate("system.agent.slack", {});
    expect(result.text).toContain(
      "You MUST use the `slack-interaction` skill before you post to Slack.",
    );
  });

  test("the worker contract names the four task endings", () => {
    const result = resolveTemplate("system.agent.worker", {});
    expect(result.text).toContain("The task has four endings.");
    for (const ending of ["`completed`", "`defer-task`", "`request-human-input`", "`failed`"]) {
      expect(result.text).toContain(ending);
    }
  });

  test("the lead contract names the delegation tools", () => {
    const result = resolveTemplate("system.agent.lead", {});
    expect(result.text).toContain(
      "`send-task`: include `routingReason` and `routingNote` (at least 10 characters after trim, maximum 200) with `agentId`. Read results via `get-task-details`.",
    );
  });

  test("the lead contract names the desplega skills, not slash commands", () => {
    const result = resolveTemplate("system.agent.lead", {});
    expect(result.text).toContain("`researching` skill");
    expect(result.text).toContain("`planning` skill");
    expect(result.text).toContain("`implementing` skill");
    expect(result.text).not.toContain("/researching");
  });
});

// ============================================================================
// Composite resolution
// ============================================================================

describe("Session templates: composite resolution", () => {
  beforeEach(async () => {
    await ensureTemplatesRegistered();
  });

  const vars = {
    name: "Ada",
    role: "worker",
    agentId: "composite-agent-001",
    persona: "",
  };

  for (const eventType of SESSION_TEMPLATES) {
    test(`${eventType} resolves every template reference`, () => {
      const result = resolveTemplate(eventType, vars);
      expect(result.skipped).toBe(false);
      expect(result.unresolved.length).toBe(0);
      expect(result.text).not.toContain("{{@template[");
      expect(result.text).toContain("You are Ada,");
      expect(result.text).toContain("composite-agent-001");
      // Bind the budget to task output in the shared writing block itself,
      // so a budget elsewhere in the composite cannot mask a reply-only rule.
      const writingBlock = result.text.split("## How you write\n")[1]?.split("\n## ")[0];
      expect(writingBlock).toContain("task output (`output` or a remote final message)");
      expect(writingBlock).toContain(
        "Routine replies and free-text task output: under 120 words by default",
      );
      expect(writingBlock).toContain("requested depth, enumerated results, essential evidence");
      expect(writingBlock).toContain("longer output required by the task's `outputSchema`");
      expect(writingBlock).toContain("Preserve investigation and required artifacts");
      expect(writingBlock).toContain(
        "Schema exemptions apply to `outputSchema`-constrained completions",
      );
      expect(writingBlock).toContain("free-text `output` follows the target");
      expect(writingBlock).toContain("link documents instead of inlining them");
      expect(writingBlock).not.toContain("schema-defined output");
      expect(result.text).toContain("Simple replies: one to three sentences");
      expect(result.text).toContain("Use the `comms` skill when available");
      expect(result.text).toContain("Follow the current request and Requester Profile");
      expect(result.text).toContain("Output schemas and channel delivery rules");
    });
  }

  for (const eventType of ["system.agent.worker", "system.agent.worker.remote"]) {
    test(`${eventType} pairs completion requirements with the output budget`, () => {
      const { text } = resolveTemplate(eventType, {});
      expect(text).toContain("under 120 words by default");
      expect(text).toContain("Link documents instead of inlining them; omit process narration");
      expect(text).toContain("under 120 words by default, with the exceptions in How you write");
    });
  }

  for (const eventType of ["system.agent.slack", "system.agent.scripts_only_mode.slack"]) {
    test(`${eventType} applies the output budget to the engine-owned card`, () => {
      const { text } = resolveTemplate(eventType, { slackChannelId: "C123", slackThreadTs: "1.2" });
      expect(text).toContain("The outcome card publishes your `output` verbatim");
      expect(text).toContain(
        "Keep free-text `output` under 120 words by default, with the exceptions in How you write",
      );
    });
  }

  test("lead and worker differ only in the contract block", () => {
    const lead = resolveTemplate("system.session.lead", { ...vars, role: "lead" }).text;
    const worker = resolveTemplate("system.session.worker", vars).text;

    // Shared blocks: workspace, memory, communication, secrets.
    for (const shared of [
      "`/workspace/personal/` is yours.",
      "You MUST use the `memory` skill",
      "## How you write",
      "## Secrets",
    ]) {
      expect(lead).toContain(shared);
      expect(worker).toContain(shared);
    }

    expect(lead).toContain("## How you lead");
    expect(lead).not.toContain("## How you work");
    expect(worker).toContain("## How you work");
    expect(worker).not.toContain("## How you lead");
  });

  test("the managed composite is the worker composite with the remote workspace", () => {
    const managed = resolveTemplate("system.session.worker.managed", vars).text;
    const worker = resolveTemplate("system.session.worker", vars).text;

    expect(managed).toContain("## How you work");
    expect(managed).toContain(
      "Your profile lives in the database. Edit it with `update-profile`: `soulMd`, `identityMd`, `heartbeatMd`, `toolsMd`.",
    );
    expect(managed).not.toContain("`/workspace/personal/` is yours.");
    expect(worker).toContain("`/workspace/personal/` is yours.");

    // Every other block is shared with the local worker composite.
    for (const shared of ["You MUST use the `memory` skill", "## How you write", "## Secrets"]) {
      expect(managed).toContain(shared);
    }
  });

  test("the remote composite names no swarm tool", () => {
    const remote = resolveTemplate("system.session.worker.remote", vars).text;

    for (const tool of ["store-progress", "get-swarm", "memory-store", "update-profile"]) {
      expect(remote).not.toContain(tool);
    }
    expect(remote).toContain("Your final message is the task output.");
    expect(remote).toContain("Your completed output is stored as a memory");
  });
});

// ============================================================================
// Hygiene
// ============================================================================

describe("Session templates: hygiene", () => {
  beforeEach(async () => {
    await ensureTemplatesRegistered();
  });

  test("no system or session template body contains an em dash", () => {
    const offenders = getAllTemplateDefinitions()
      .filter((d) => d.category === "system" || d.category === "session")
      .filter((d) => d.defaultBody.includes(EM_DASH) || d.header.includes(EM_DASH))
      .map((d) => d.eventType);

    expect(offenders).toEqual([]);
  });
});

// ============================================================================
// Integration with getBasePrompt
// ============================================================================

describe("Session templates: getBasePrompt integration", () => {
  beforeEach(async () => {
    await ensureTemplatesRegistered();
  });

  /** getBasePrompt collapses 3+ consecutive newlines; apply the same rule here. */
  function collapse(text: string): string {
    return text.replace(/\n{3,}/g, "\n\n");
  }

  test("a local worker prompt opens with the worker composite verbatim", async () => {
    const { getBasePrompt } = await import("../prompts/base-prompt");
    const agentId = "integration-test-worker";
    const composite = resolveTemplate("system.session.worker", {
      name: "an agent",
      role: "worker",
      agentId,
      persona: "",
    }).text;

    const result = await getBasePrompt({ role: "worker", agentId });
    expect(result).toStartWith(collapse(composite));
  });

  test("a local lead prompt opens with the lead composite verbatim", async () => {
    const { getBasePrompt } = await import("../prompts/base-prompt");
    const agentId = "integration-test-lead";
    const composite = resolveTemplate("system.session.lead", {
      name: "an agent",
      role: "lead",
      agentId,
      persona: "",
    }).text;

    const result = await getBasePrompt({ role: "lead", agentId });
    expect(result).toStartWith(collapse(composite));
  });
});
