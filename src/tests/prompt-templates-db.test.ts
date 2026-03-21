import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  checkoutPromptTemplate,
  closeDb,
  deletePromptTemplate,
  getDb,
  getPromptTemplateById,
  getPromptTemplateHistory,
  getPromptTemplates,
  initDb,
  resetPromptTemplateToDefault,
  resolvePromptTemplate,
  upsertPromptTemplate,
} from "../be/db";

const TEST_DB_PATH = "./test-prompt-templates.sqlite";

describe("Prompt Templates DB", () => {
  beforeAll(async () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {
        // File doesn't exist
      }
    }
    closeDb();
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
  // CRUD: create, read, list, update, delete
  // ============================================================================

  describe("CRUD operations", () => {
    test("create via upsert (insert path) and read by ID", () => {
      const template = upsertPromptTemplate({
        eventType: "github.push",
        scope: "global",
        body: "Handle push event: {{payload}}",
        createdBy: "test-user",
      });

      expect(template.id).toBeTruthy();
      expect(template.eventType).toBe("github.push");
      expect(template.scope).toBe("global");
      expect(template.scopeId).toBeNull();
      expect(template.state).toBe("enabled");
      expect(template.body).toBe("Handle push event: {{payload}}");
      expect(template.isDefault).toBe(false);
      expect(template.version).toBe(1);
      expect(template.createdBy).toBe("test-user");
      expect(template.createdAt).toBeTruthy();
      expect(template.updatedAt).toBeTruthy();

      const fetched = getPromptTemplateById(template.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(template.id);
      expect(fetched!.body).toBe("Handle push event: {{payload}}");
    });

    test("list with filters", () => {
      // Create a few more templates
      upsertPromptTemplate({
        eventType: "github.pull_request.opened",
        scope: "global",
        body: "PR opened template",
      });
      upsertPromptTemplate({
        eventType: "github.pull_request.opened",
        scope: "agent",
        scopeId: "agent-001",
        body: "Agent-specific PR opened",
      });

      const allGlobal = getPromptTemplates({ scope: "global" });
      expect(allGlobal.length).toBeGreaterThanOrEqual(2);

      const prTemplates = getPromptTemplates({ eventType: "github.pull_request.opened" });
      expect(prTemplates.length).toBe(2);

      const agentTemplates = getPromptTemplates({ scope: "agent", scopeId: "agent-001" });
      expect(agentTemplates.length).toBe(1);
      expect(agentTemplates[0].body).toBe("Agent-specific PR opened");
    });

    test("update via upsert bumps version", () => {
      const original = upsertPromptTemplate({
        eventType: "slack.message",
        scope: "global",
        body: "Slack message v1",
      });
      expect(original.version).toBe(1);

      const updated = upsertPromptTemplate({
        eventType: "slack.message",
        scope: "global",
        body: "Slack message v2",
        changeReason: "Improved template",
      });
      expect(updated.id).toBe(original.id);
      expect(updated.version).toBe(2);
      expect(updated.body).toBe("Slack message v2");
    });

    test("delete removes template", () => {
      const template = upsertPromptTemplate({
        eventType: "test.delete_me",
        scope: "global",
        body: "Will be deleted",
      });

      const deleted = deletePromptTemplate(template.id);
      expect(deleted).toBe(true);

      const fetched = getPromptTemplateById(template.id);
      expect(fetched).toBeNull();
    });

    test("delete returns false for non-existent ID", () => {
      const deleted = deletePromptTemplate("non-existent-id");
      expect(deleted).toBe(false);
    });
  });

  // ============================================================================
  // Scope resolution: agent > repo > global
  // ============================================================================

  describe("scope resolution precedence", () => {
    const agentId = "resolve-agent-001";
    const repoId = "resolve-repo-001";

    test("agent scope beats repo and global", () => {
      upsertPromptTemplate({
        eventType: "resolve.test.precedence",
        scope: "global",
        body: "Global body",
      });
      upsertPromptTemplate({
        eventType: "resolve.test.precedence",
        scope: "repo",
        scopeId: repoId,
        body: "Repo body",
      });
      upsertPromptTemplate({
        eventType: "resolve.test.precedence",
        scope: "agent",
        scopeId: agentId,
        body: "Agent body",
      });

      const result = resolvePromptTemplate("resolve.test.precedence", agentId, repoId);
      expect(result).not.toBeNull();
      expect("template" in result!).toBe(true);
      if ("template" in result!) {
        expect(result.template.body).toBe("Agent body");
        expect(result.template.scope).toBe("agent");
      }
    });

    test("repo scope beats global when no agent template", () => {
      upsertPromptTemplate({
        eventType: "resolve.test.repo_global",
        scope: "global",
        body: "Global body",
      });
      upsertPromptTemplate({
        eventType: "resolve.test.repo_global",
        scope: "repo",
        scopeId: repoId,
        body: "Repo body",
      });

      const result = resolvePromptTemplate("resolve.test.repo_global", "other-agent", repoId);
      expect(result).not.toBeNull();
      if ("template" in result!) {
        expect(result.template.body).toBe("Repo body");
      }
    });

    test("falls back to global when no agent/repo template", () => {
      upsertPromptTemplate({
        eventType: "resolve.test.global_only",
        scope: "global",
        body: "Global only body",
      });

      const result = resolvePromptTemplate("resolve.test.global_only", "some-agent", "some-repo");
      expect(result).not.toBeNull();
      if ("template" in result!) {
        expect(result.template.body).toBe("Global only body");
      }
    });

    test("returns null when no template matches", () => {
      const result = resolvePromptTemplate("no.such.event", "agent-x", "repo-x");
      expect(result).toBeNull();
    });
  });

  // ============================================================================
  // Three-state behavior
  // ============================================================================

  describe("three-state behavior", () => {
    test("enabled returns template", () => {
      upsertPromptTemplate({
        eventType: "state.test.enabled",
        scope: "global",
        state: "enabled",
        body: "Enabled body",
      });

      const result = resolvePromptTemplate("state.test.enabled");
      expect(result).not.toBeNull();
      expect("template" in result!).toBe(true);
    });

    test("skip_event returns skip", () => {
      upsertPromptTemplate({
        eventType: "state.test.skip",
        scope: "global",
        state: "skip_event",
        body: "Skip body",
      });

      const result = resolvePromptTemplate("state.test.skip");
      expect(result).not.toBeNull();
      expect("skip" in result!).toBe(true);
      if ("skip" in result!) {
        expect(result.skip).toBe(true);
      }
    });

    test("default_prompt_fallback continues chain", () => {
      upsertPromptTemplate({
        eventType: "state.test.fallback",
        scope: "agent",
        scopeId: "fallback-agent",
        state: "default_prompt_fallback",
        body: "Agent fallback body",
      });
      upsertPromptTemplate({
        eventType: "state.test.fallback",
        scope: "global",
        state: "enabled",
        body: "Global enabled body",
      });

      const result = resolvePromptTemplate("state.test.fallback", "fallback-agent");
      expect(result).not.toBeNull();
      if ("template" in result!) {
        expect(result.template.body).toBe("Global enabled body");
        expect(result.template.scope).toBe("global");
      }
    });

    test("skip_event at agent level stops resolution even if repo/global have templates", () => {
      upsertPromptTemplate({
        eventType: "state.test.agent_skip",
        scope: "global",
        state: "enabled",
        body: "Global body",
      });
      upsertPromptTemplate({
        eventType: "state.test.agent_skip",
        scope: "repo",
        scopeId: "skip-repo",
        state: "enabled",
        body: "Repo body",
      });
      upsertPromptTemplate({
        eventType: "state.test.agent_skip",
        scope: "agent",
        scopeId: "skip-agent",
        state: "skip_event",
        body: "Agent skip body",
      });

      const result = resolvePromptTemplate("state.test.agent_skip", "skip-agent", "skip-repo");
      expect(result).not.toBeNull();
      expect("skip" in result!).toBe(true);
    });
  });

  // ============================================================================
  // Wildcard matching
  // ============================================================================

  describe("wildcard matching", () => {
    test("wildcard matches when exact not found", () => {
      // Remove any seeded exact match so the wildcard can be tested
      const seeded = getPromptTemplates({ eventType: "github.pull_request.review_submitted" });
      for (const t of seeded) {
        getDb().run("DELETE FROM prompt_template_history WHERE templateId = ?", [t.id]);
        getDb().run("DELETE FROM prompt_templates WHERE id = ?", [t.id]);
      }

      upsertPromptTemplate({
        eventType: "github.pull_request.*",
        scope: "global",
        body: "Wildcard PR body",
      });

      // No exact match for this specific event
      const result = resolvePromptTemplate("github.pull_request.review_submitted");
      expect(result).not.toBeNull();
      if ("template" in result!) {
        expect(result.template.body).toBe("Wildcard PR body");
        expect(result.template.eventType).toBe("github.pull_request.*");
      }
    });

    test("exact global match beats wildcard agent match", () => {
      upsertPromptTemplate({
        eventType: "wildcard.test.exact_vs_wild",
        scope: "global",
        body: "Exact global body",
      });
      upsertPromptTemplate({
        eventType: "wildcard.test.*",
        scope: "agent",
        scopeId: "wild-agent",
        body: "Wildcard agent body",
      });

      const result = resolvePromptTemplate("wildcard.test.exact_vs_wild", "wild-agent");
      expect(result).not.toBeNull();
      if ("template" in result!) {
        // Exact match at global should beat wildcard at agent
        expect(result.template.body).toBe("Exact global body");
      }
    });

    test("narrower wildcard is tried before broader wildcard", () => {
      upsertPromptTemplate({
        eventType: "deep.a.*",
        scope: "global",
        body: "Broad wildcard",
      });
      upsertPromptTemplate({
        eventType: "deep.a.b.*",
        scope: "global",
        body: "Narrow wildcard",
      });

      const result = resolvePromptTemplate("deep.a.b.c");
      expect(result).not.toBeNull();
      if ("template" in result!) {
        expect(result.template.body).toBe("Narrow wildcard");
      }
    });
  });

  // ============================================================================
  // History creation on upsert
  // ============================================================================

  describe("history", () => {
    test("history entry created on insert", () => {
      const template = upsertPromptTemplate({
        eventType: "history.test.insert",
        scope: "global",
        body: "History v1",
        changedBy: "creator",
      });

      const history = getPromptTemplateHistory(template.id);
      expect(history.length).toBe(1);
      expect(history[0].version).toBe(1);
      expect(history[0].body).toBe("History v1");
      expect(history[0].changedBy).toBe("creator");
      expect(history[0].changeReason).toBe("Initial creation");
    });

    test("history entry created on update", () => {
      const template = upsertPromptTemplate({
        eventType: "history.test.update",
        scope: "global",
        body: "Original body",
      });

      upsertPromptTemplate({
        eventType: "history.test.update",
        scope: "global",
        body: "Updated body",
        changedBy: "editor",
        changeReason: "Fixed typo",
      });

      const history = getPromptTemplateHistory(template.id);
      expect(history.length).toBe(2);
      // Ordered by version DESC
      expect(history[0].version).toBe(2);
      expect(history[0].body).toBe("Updated body");
      expect(history[0].changedBy).toBe("editor");
      expect(history[0].changeReason).toBe("Fixed typo");
      expect(history[1].version).toBe(1);
      expect(history[1].body).toBe("Original body");
    });
  });

  // ============================================================================
  // Checkout (version restore)
  // ============================================================================

  describe("checkout", () => {
    test("checkout restores body and state from target version (backward)", () => {
      const template = upsertPromptTemplate({
        eventType: "checkout.test.backward",
        scope: "global",
        body: "Version 1 body",
        state: "enabled",
      });

      upsertPromptTemplate({
        eventType: "checkout.test.backward",
        scope: "global",
        body: "Version 2 body",
        state: "skip_event",
      });

      // Check we're at v2
      const v2 = getPromptTemplateById(template.id)!;
      expect(v2.version).toBe(2);
      expect(v2.body).toBe("Version 2 body");
      expect(v2.state).toBe("skip_event");

      // Checkout back to v1
      const restored = checkoutPromptTemplate(template.id, 1);
      expect(restored.version).toBe(3); // Version bumped
      expect(restored.body).toBe("Version 1 body");
      expect(restored.state).toBe("enabled");

      // History should have a checkout entry
      const history = getPromptTemplateHistory(template.id);
      expect(history[0].changeReason).toBe("Checked out from version 1");
    });

    test("checkout restores forward version", () => {
      const template = upsertPromptTemplate({
        eventType: "checkout.test.forward",
        scope: "global",
        body: "V1",
      });

      upsertPromptTemplate({
        eventType: "checkout.test.forward",
        scope: "global",
        body: "V2",
      });

      upsertPromptTemplate({
        eventType: "checkout.test.forward",
        scope: "global",
        body: "V3",
      });

      // Now at v3, checkout to v2
      const restored = checkoutPromptTemplate(template.id, 2);
      expect(restored.version).toBe(4);
      expect(restored.body).toBe("V2");

      // Checkout back to v3
      const restored2 = checkoutPromptTemplate(template.id, 3);
      expect(restored2.version).toBe(5);
      expect(restored2.body).toBe("V3");
    });

    test("checkout throws for non-existent template", () => {
      expect(() => checkoutPromptTemplate("non-existent", 1)).toThrow("not found");
    });

    test("checkout throws for non-existent version", () => {
      const template = upsertPromptTemplate({
        eventType: "checkout.test.bad_version",
        scope: "global",
        body: "Only v1",
      });

      expect(() => checkoutPromptTemplate(template.id, 99)).toThrow("No history entry");
    });
  });

  // ============================================================================
  // isDefault guard on delete
  // ============================================================================

  describe("isDefault guard", () => {
    test("cannot delete a template with isDefault=true", () => {
      // Create a template and then reset it to default
      const template = upsertPromptTemplate({
        eventType: "default.test.guard",
        scope: "global",
        body: "Original",
      });

      resetPromptTemplateToDefault(template.id, "Default body");

      const refreshed = getPromptTemplateById(template.id)!;
      expect(refreshed.isDefault).toBe(true);

      expect(() => deletePromptTemplate(template.id)).toThrow("Cannot delete a default");
    });
  });

  // ============================================================================
  // Global override: upsert flips isDefault to false
  // ============================================================================

  describe("global override of isDefault", () => {
    test("upsert at global scope with existing isDefault=true flips it to false", () => {
      const template = upsertPromptTemplate({
        eventType: "default.test.flip",
        scope: "global",
        body: "Original default body",
      });

      // Set it as default
      resetPromptTemplateToDefault(template.id, "Default body");
      const defaulted = getPromptTemplateById(template.id)!;
      expect(defaulted.isDefault).toBe(true);

      // Upsert at global scope should flip isDefault to false
      const updated = upsertPromptTemplate({
        eventType: "default.test.flip",
        scope: "global",
        body: "Custom override body",
      });
      expect(updated.isDefault).toBe(false);
      expect(updated.body).toBe("Custom override body");
    });
  });

  // ============================================================================
  // Reset to default
  // ============================================================================

  describe("resetPromptTemplateToDefault", () => {
    test("restores body and sets isDefault=true", () => {
      const template = upsertPromptTemplate({
        eventType: "reset.test.basic",
        scope: "global",
        body: "Custom body",
        state: "skip_event",
      });
      expect(template.isDefault).toBe(false);
      expect(template.state).toBe("skip_event");

      const reset = resetPromptTemplateToDefault(template.id, "The default body");
      expect(reset.isDefault).toBe(true);
      expect(reset.body).toBe("The default body");
      expect(reset.state).toBe("enabled");
      expect(reset.version).toBe(2);

      // Check history
      const history = getPromptTemplateHistory(template.id);
      const latestEntry = history[0];
      expect(latestEntry.changeReason).toBe("Reset to default");
    });

    test("throws for non-existent template", () => {
      expect(() => resetPromptTemplateToDefault("non-existent", "body")).toThrow("not found");
    });
  });

  // ============================================================================
  // NULL scopeId handling (global scope)
  // ============================================================================

  describe("NULL scopeId handling", () => {
    test("global scope templates have NULL scopeId", () => {
      const template = upsertPromptTemplate({
        eventType: "null.scope.test",
        scope: "global",
        body: "Global with null scopeId",
      });

      expect(template.scopeId).toBeNull();

      // Upsert again at same global scope should update, not create new
      const updated = upsertPromptTemplate({
        eventType: "null.scope.test",
        scope: "global",
        body: "Updated global",
      });

      expect(updated.id).toBe(template.id);
      expect(updated.version).toBe(2);
    });

    test("global scope with explicit null scopeId works", () => {
      const template = upsertPromptTemplate({
        eventType: "null.scope.explicit",
        scope: "global",
        scopeId: null,
        body: "Explicit null scopeId",
      });

      expect(template.scopeId).toBeNull();
    });
  });
});
