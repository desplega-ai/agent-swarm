import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, initDb } from "../be/db";
import {
  clearTemplateDefinitions,
  getAllTemplateDefinitions,
  getTemplateDefinition,
} from "../prompts/registry";
import { resolveTemplate } from "../prompts/resolver";

// Side-effect import: register session + system templates
import "../prompts/session-templates";

const TEST_DB_PATH = "./test-prompt-session.sqlite";

/**
 * Re-register session templates if they've been cleared by other tests.
 */
async function ensureTemplatesRegistered(): Promise<void> {
  if (getTemplateDefinition("system.agent.role")) return;
  const ts = Date.now();
  await import(`../prompts/session-templates?t=${ts}`);
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
});

// ============================================================================
// System template registration
// ============================================================================

describe("Session templates — registration", () => {
  beforeEach(async () => {
    await ensureTemplatesRegistered();
  });

  test("all 12 system templates are registered", () => {
    const systemTemplates = [
      "system.agent.role",
      "system.agent.register",
      "system.agent.lead",
      "system.agent.worker",
      "system.agent.filesystem",
      "system.agent.agent_fs",
      "system.agent.self_awareness",
      "system.agent.context_mode",

      "system.agent.system",
      "system.agent.services",
      "system.agent.artifacts",
    ];

    for (const eventType of systemTemplates) {
      const def = getTemplateDefinition(eventType);
      expect(def).toBeDefined();
      expect(def!.category).toBe("system");
    }
  });

  test("2 session composite templates are registered", () => {
    const sessionTemplates = ["system.session.lead", "system.session.worker"];

    for (const eventType of sessionTemplates) {
      const def = getTemplateDefinition(eventType);
      expect(def).toBeDefined();
      expect(def!.category).toBe("session");
    }
  });

  test("total of 14 session/system templates registered", () => {
    const all = getAllTemplateDefinitions();
    const sessionSystem = all.filter((d) => d.category === "system" || d.category === "session");
    expect(sessionSystem.length).toBe(13);
  });
});

// ============================================================================
// Individual system template resolution
// ============================================================================

describe("Session templates — individual resolution", () => {
  beforeEach(async () => {
    await ensureTemplatesRegistered();
  });

  test("system.agent.role interpolates role and agentId", () => {
    const result = resolveTemplate("system.agent.role", {
      role: "worker",
      agentId: "agent-xyz-789",
    });
    expect(result.skipped).toBe(false);
    expect(result.text).toContain("your role is: worker");
    expect(result.text).toContain("agent-xyz-789");
    expect(result.unresolved.length).toBe(0);
  });

  test("system.agent.filesystem interpolates agentId", () => {
    const result = resolveTemplate("system.agent.filesystem", {
      agentId: "agent-fs-test",
    });
    expect(result.skipped).toBe(false);
    expect(result.text).toContain("/workspace/shared/thoughts/agent-fs-test/plans/");
    expect(result.text).toContain("/workspace/shared/memory/agent-fs-test/");
    expect(result.unresolved.length).toBe(0);
  });

  test("system.agent.agent_fs interpolates agentId and sharedOrgId", () => {
    const result = resolveTemplate("system.agent.agent_fs", {
      agentId: "agent-afs-test",
      sharedOrgId: "org-shared-123",
    });
    expect(result.skipped).toBe(false);
    expect(result.text).toContain("agent-fs --org org-shared-123 write thoughts/agent-afs-test/");
    expect(result.unresolved.length).toBe(0);
  });

  test("system.agent.services interpolates agentId and swarmUrl", () => {
    const result = resolveTemplate("system.agent.services", {
      agentId: "agent-svc-test",
      swarmUrl: "swarm.example.com",
    });
    expect(result.skipped).toBe(false);
    expect(result.text).toContain("https://agent-svc-test.swarm.example.com");
    expect(result.unresolved.length).toBe(0);
  });

  test("system.agent.lead contains delegation rules", () => {
    const result = resolveTemplate("system.agent.lead", {});
    expect(result.text).toContain("CRITICAL: You are a coordinator");
    expect(result.text).toContain("coordinator");
  });

  test("system.agent.worker contains worker tools", () => {
    const result = resolveTemplate("system.agent.worker", {});
    expect(result.text).toContain("store-progress");
    expect(result.text).toContain("task-action");
  });

  test("system.agent.register contains join-swarm", () => {
    const result = resolveTemplate("system.agent.register", {});
    expect(result.text).toContain("join-swarm");
  });

  test("system.agent.self_awareness contains architecture details", () => {
    const result = resolveTemplate("system.agent.self_awareness", {});
    expect(result.text).toContain("desplega-ai/agent-swarm");
    expect(result.text).toContain("Docker container");
  });

  test("system.agent.context_mode contains context-mode reference", () => {
    const result = resolveTemplate("system.agent.context_mode", {});
    expect(result.text).toContain("context-mode");
    expect(result.text).toContain("batch_execute");
  });

  // system.agent.guidelines was removed — its content was redundant with worker/lead templates

  test("system.agent.system contains package info", () => {
    const result = resolveTemplate("system.agent.system", {});
    expect(result.text).toContain("Ubuntu");
    expect(result.text).toContain("gh");
    expect(result.text).toContain("glab");
  });

  test("system.agent.artifacts contains artifact info", () => {
    const result = resolveTemplate("system.agent.artifacts", {});
    expect(result.text).toContain("localtunnel");
    expect(result.text).toContain("/workspace/personal/artifacts/");
  });
});

// ============================================================================
// Composite session template resolution
// ============================================================================

describe("Session templates — composite resolution", () => {
  beforeEach(async () => {
    await ensureTemplatesRegistered();
  });

  test("system.session.lead resolves all template references", () => {
    const result = resolveTemplate("system.session.lead", {
      role: "lead",
      agentId: "lead-agent-001",
    });
    expect(result.skipped).toBe(false);
    expect(result.unresolved.length).toBe(0);

    // Contains role section
    expect(result.text).toContain("your role is: lead");
    expect(result.text).toContain("lead-agent-001");

    // Contains register section
    expect(result.text).toContain("join-swarm");

    // Contains lead-specific section (not worker)
    expect(result.text).toContain("CRITICAL: You are a coordinator");
    expect(result.text).toContain("coordinator");
    expect(result.text).not.toContain("task-action");

    // Contains filesystem section with interpolated agentId
    expect(result.text).toContain("/workspace/shared/thoughts/lead-agent-001/");

    // Contains self_awareness
    expect(result.text).toContain("How You Are Built");

    // Contains context_mode
    expect(result.text).toContain("Context Window Management");

    // Guidelines template was removed (redundant with lead/worker templates)

    // Contains system
    expect(result.text).toContain("System packages available");
  });

  test("system.session.worker resolves all template references", () => {
    const result = resolveTemplate("system.session.worker", {
      role: "worker",
      agentId: "worker-agent-001",
    });
    expect(result.skipped).toBe(false);
    expect(result.unresolved.length).toBe(0);

    // Contains role section
    expect(result.text).toContain("your role is: worker");
    expect(result.text).toContain("worker-agent-001");

    // Contains register section
    expect(result.text).toContain("join-swarm");

    // Contains worker-specific section (not lead)
    expect(result.text).toContain("store-progress");
    expect(result.text).toContain("task-action");
    expect(result.text).not.toContain("CRITICAL: You are a coordinator");

    // Contains filesystem section with interpolated agentId
    expect(result.text).toContain("/workspace/shared/thoughts/worker-agent-001/");

    // Contains self_awareness
    expect(result.text).toContain("How You Are Built");

    // Contains context_mode
    expect(result.text).toContain("Context Window Management");

    // Guidelines template was removed (redundant with lead/worker templates)

    // Contains system
    expect(result.text).toContain("System packages available");
  });

  test("composite does NOT include conditional sections (agent_fs, services, artifacts)", () => {
    const result = resolveTemplate("system.session.lead", {
      role: "lead",
      agentId: "test-agent",
    });

    // agent_fs, services, artifacts are NOT in the composite
    expect(result.text).not.toContain("Agent Filesystem (agent-fs)");
    expect(result.text).not.toContain("Service Registry");
    expect(result.text).not.toContain("localtunnel");
  });

  test("lead and worker composites differ only in lead vs worker section", () => {
    const leadResult = resolveTemplate("system.session.lead", {
      role: "lead",
      agentId: "test-agent",
    });
    const workerResult = resolveTemplate("system.session.worker", {
      role: "worker",
      agentId: "test-agent",
    });

    // Both share common sections
    expect(leadResult.text).toContain("join-swarm");
    expect(workerResult.text).toContain("join-swarm");
    expect(leadResult.text).toContain("How You Are Built");
    expect(workerResult.text).toContain("How You Are Built");

    // Lead has lead content, not worker
    expect(leadResult.text).toContain("CRITICAL: You are a coordinator");
    expect(leadResult.text).not.toContain("task-action");

    // Worker has worker content, not lead
    expect(workerResult.text).toContain("task-action");
    expect(workerResult.text).not.toContain("CRITICAL: You are a coordinator");
  });
});

// ============================================================================
// Integration with getBasePrompt
// ============================================================================

describe("Session templates — getBasePrompt integration", () => {
  beforeEach(async () => {
    await ensureTemplatesRegistered();
  });

  test("getBasePrompt uses session composite for worker", async () => {
    const { getBasePrompt } = await import("../prompts/base-prompt");
    const result = await getBasePrompt({
      role: "worker",
      agentId: "integration-test-worker",
      swarmUrl: "swarm.test.com",
    });

    // Core sections from composite
    expect(result).toContain("your role is: worker");
    expect(result).toContain("integration-test-worker");
    expect(result).toContain("join-swarm");
    expect(result).toContain("store-progress");
    expect(result).toContain("How You Are Built");
    expect(result).toContain("System packages available");

    // Conditional sections (services included by default)
    expect(result).toContain("Service Registry");
    expect(result).toContain("https://integration-test-worker.swarm.test.com");

    // Artifacts included by default
    expect(result).toContain("Artifacts");
  });

  test("getBasePrompt uses session composite for lead", async () => {
    const { getBasePrompt } = await import("../prompts/base-prompt");
    const result = await getBasePrompt({
      role: "lead",
      agentId: "integration-test-lead",
      swarmUrl: "swarm.test.com",
    });

    // Core sections from composite
    expect(result).toContain("your role is: lead");
    expect(result).toContain("integration-test-lead");
    expect(result).toContain("CRITICAL: You are a coordinator");

    // Should NOT have worker content
    expect(result).not.toContain("task-action");
  });
});
