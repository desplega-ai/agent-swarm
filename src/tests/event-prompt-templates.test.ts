import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  deleteEventPromptTemplate,
  getEventPromptTemplate,
  initDb,
  listEventPromptTemplates,
  upsertEventPromptTemplate,
} from "../be/db";
import { resolveEventTaskDescription } from "../events/template-resolver";

const TEST_DB_PATH = "./test-event-prompt-templates.sqlite";

beforeAll(async () => {
  try {
    await unlink(TEST_DB_PATH);
  } catch {}
  initDb(TEST_DB_PATH);
});

afterAll(async () => {
  closeDb();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(`${TEST_DB_PATH}${suffix}`);
    } catch {}
  }
});

// ═══════════════════════════════════════════════════════
// DB Functions
// ═══════════════════════════════════════════════════════

describe("upsertEventPromptTemplate", () => {
  test("creates a new global template", () => {
    const result = upsertEventPromptTemplate({
      provider: "github",
      eventType: "pull_request.assigned",
      template: "Custom PR: {{pr.title}} in {{repo.full_name}}",
      description: "Test template",
    });

    expect(result.id).toBeDefined();
    expect(result.provider).toBe("github");
    expect(result.eventType).toBe("pull_request.assigned");
    expect(result.template).toBe("Custom PR: {{pr.title}} in {{repo.full_name}}");
    expect(result.enabled).toBe(true);
    expect(result.agentId).toBeNull();
    expect(result.description).toBe("Test template");
  });

  test("creates an agent-specific template", () => {
    const agentId = "00000000-0000-0000-0000-000000000001";
    const result = upsertEventPromptTemplate({
      provider: "github",
      eventType: "pull_request.assigned",
      template: "Agent-specific: {{pr.title}}",
      agentId,
    });

    expect(result.agentId).toBe(agentId);
    expect(result.template).toBe("Agent-specific: {{pr.title}}");
  });

  test("upserts on conflict (same provider+eventType+agentId)", () => {
    upsertEventPromptTemplate({
      provider: "gitlab",
      eventType: "pipeline.failed",
      template: "Version 1",
    });

    const second = upsertEventPromptTemplate({
      provider: "gitlab",
      eventType: "pipeline.failed",
      template: "Version 2",
      description: "Updated",
    });

    // Same id because upsert returns the existing row (updated)
    expect(second.template).toBe("Version 2");
    expect(second.description).toBe("Updated");
    // Should not create a duplicate
    const all = listEventPromptTemplates({ provider: "gitlab" });
    const matching = all.filter((t) => t.eventType === "pipeline.failed" && t.agentId === null);
    expect(matching).toHaveLength(1);
  });

  test("creates disabled template", () => {
    const result = upsertEventPromptTemplate({
      provider: "agentmail",
      eventType: "message.follow_up",
      template: "Disabled template",
      enabled: false,
    });

    expect(result.enabled).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════
// Template Resolution
// ═══════════════════════════════════════════════════════

describe("getEventPromptTemplate", () => {
  test("returns null when no template exists", () => {
    const result = getEventPromptTemplate("github", "nonexistent.event");
    expect(result).toBeNull();
  });

  test("returns global template", () => {
    const result = getEventPromptTemplate("github", "pull_request.assigned");
    expect(result).not.toBeNull();
    expect(result!.agentId).toBeNull();
  });

  test("returns agent-specific template when agentId matches", () => {
    const agentId = "00000000-0000-0000-0000-000000000001";
    const result = getEventPromptTemplate("github", "pull_request.assigned", agentId);
    expect(result).not.toBeNull();
    expect(result!.agentId).toBe(agentId);
    expect(result!.template).toBe("Agent-specific: {{pr.title}}");
  });

  test("falls back to global when agent-specific not found", () => {
    const otherAgent = "00000000-0000-0000-0000-000000000099";
    const result = getEventPromptTemplate("github", "pull_request.assigned", otherAgent);
    expect(result).not.toBeNull();
    expect(result!.agentId).toBeNull(); // fell back to global
  });

  test("skips disabled templates", () => {
    const result = getEventPromptTemplate("agentmail", "message.follow_up");
    expect(result).toBeNull(); // disabled template should not be returned
  });
});

// ═══════════════════════════════════════════════════════
// List & Delete
// ═══════════════════════════════════════════════════════

describe("listEventPromptTemplates", () => {
  test("returns all templates", () => {
    const all = listEventPromptTemplates();
    expect(all.length).toBeGreaterThanOrEqual(3);
  });

  test("filters by provider", () => {
    const github = listEventPromptTemplates({ provider: "github" });
    expect(github.every((t) => t.provider === "github")).toBe(true);
  });
});

describe("deleteEventPromptTemplate", () => {
  test("deletes an existing template", () => {
    const created = upsertEventPromptTemplate({
      provider: "github",
      eventType: "check_run.failed",
      template: "To be deleted",
    });

    const deleted = deleteEventPromptTemplate(created.id);
    expect(deleted).toBe(true);

    const result = getEventPromptTemplate("github", "check_run.failed");
    expect(result).toBeNull();
  });

  test("returns false for nonexistent id", () => {
    const deleted = deleteEventPromptTemplate("00000000-0000-0000-0000-000000000000");
    expect(deleted).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════
// resolveEventTaskDescription (integration)
// ═══════════════════════════════════════════════════════

describe("resolveEventTaskDescription", () => {
  test("returns null when no template exists", () => {
    const result = resolveEventTaskDescription("github", "workflow_run.failed", {
      workflow: { name: "CI" },
    });
    expect(result).toBeNull();
  });

  test("returns interpolated string when template exists", () => {
    // We have a global template for github:pull_request.assigned
    const result = resolveEventTaskDescription("github", "pull_request.assigned", {
      pr: { title: "Fix bug #42" },
      repo: { full_name: "org/repo" },
    });
    expect(result).not.toBeNull();
    expect(result).toBe("Custom PR: Fix bug #42 in org/repo");
  });

  test("agent-specific override takes precedence", () => {
    const agentId = "00000000-0000-0000-0000-000000000001";
    const result = resolveEventTaskDescription(
      "github",
      "pull_request.assigned",
      { pr: { title: "My PR" } },
      agentId,
    );
    expect(result).toBe("Agent-specific: My PR");
  });

  test("handles missing context values gracefully", () => {
    const result = resolveEventTaskDescription("github", "pull_request.assigned", {});
    expect(result).not.toBeNull();
    // Missing values become empty strings
    expect(result).toBe("Custom PR:  in ");
  });
});
