import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { closeDb, getPromptTemplates, initDb, upsertPromptTemplate } from "../be/db";
import { seedDefaultTemplates } from "../be/seed";
import {
  clearTemplateDefinitions,
  getAllTemplateDefinitions,
  getTemplateDefinition,
  registerTemplate,
} from "../prompts/registry";
import { resolveTemplate } from "../prompts/resolver";

const TEST_DB_PATH = "./test-prompt-resolver.sqlite";

describe("Prompt Template Resolver", () => {
  beforeAll(async () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {
        // File doesn't exist
      }
    }
    // Clear any previously registered templates before init
    clearTemplateDefinitions();
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
  // Registry (in-memory Map)
  // ============================================================================

  describe("registry", () => {
    beforeEach(() => {
      clearTemplateDefinitions();
    });

    test("registerTemplate and getTemplateDefinition", () => {
      registerTemplate({
        eventType: "test.basic",
        header: "Header: {{name}}",
        defaultBody: "Body for {{name}}",
        variables: [{ name: "name", description: "The name" }],
        category: "event",
      });

      const def = getTemplateDefinition("test.basic");
      expect(def).toBeDefined();
      expect(def!.eventType).toBe("test.basic");
      expect(def!.header).toBe("Header: {{name}}");
      expect(def!.defaultBody).toBe("Body for {{name}}");
    });

    test("getTemplateDefinition returns undefined for unregistered", () => {
      expect(getTemplateDefinition("no.such.event")).toBeUndefined();
    });

    test("getAllTemplateDefinitions returns all registered", () => {
      registerTemplate({
        eventType: "test.a",
        header: "",
        defaultBody: "A body",
        variables: [],
        category: "system",
      });
      registerTemplate({
        eventType: "test.b",
        header: "",
        defaultBody: "B body",
        variables: [],
        category: "common",
      });

      const all = getAllTemplateDefinitions();
      expect(all.length).toBe(2);
      const eventTypes = all.map((d) => d.eventType).sort();
      expect(eventTypes).toEqual(["test.a", "test.b"]);
    });

    test("clearTemplateDefinitions removes all", () => {
      registerTemplate({
        eventType: "test.clear",
        header: "",
        defaultBody: "body",
        variables: [],
        category: "event",
      });
      expect(getAllTemplateDefinitions().length).toBe(1);

      clearTemplateDefinitions();
      expect(getAllTemplateDefinitions().length).toBe(0);
    });
  });

  // ============================================================================
  // Resolver — basic resolution
  // ============================================================================

  describe("resolver basics", () => {
    beforeEach(() => {
      clearTemplateDefinitions();
    });

    test("basic resolution: eventType + variables → interpolated string", () => {
      registerTemplate({
        eventType: "resolve.basic",
        header: "Event: {{event}}",
        defaultBody: "Hello {{user}}, event is {{event}}",
        variables: [
          { name: "event", description: "Event name" },
          { name: "user", description: "Username" },
        ],
        category: "event",
      });

      const result = resolveTemplate("resolve.basic", { event: "push", user: "alice" });
      expect(result.skipped).toBe(false);
      expect(result.text).toBe("Event: push\n\nHello alice, event is push");
      expect(result.unresolved.length).toBe(0);
    });

    test("header + body composition (header non-empty)", () => {
      registerTemplate({
        eventType: "resolve.header_body",
        header: "HEADER",
        defaultBody: "BODY",
        variables: [],
        category: "system",
      });

      const result = resolveTemplate("resolve.header_body", {});
      expect(result.text).toBe("HEADER\n\nBODY");
    });

    test("header empty → just body", () => {
      registerTemplate({
        eventType: "resolve.no_header",
        header: "",
        defaultBody: "Just the body",
        variables: [],
        category: "system",
      });

      const result = resolveTemplate("resolve.no_header", {});
      expect(result.text).toBe("Just the body");
    });

    test("unresolved variable tracking", () => {
      registerTemplate({
        eventType: "resolve.unresolved",
        header: "",
        defaultBody: "Hello {{user}}, your repo is {{repo}}",
        variables: [
          { name: "user", description: "Username" },
          { name: "repo", description: "Repository" },
        ],
        category: "event",
      });

      const result = resolveTemplate("resolve.unresolved", { user: "alice" });
      expect(result.text).toBe("Hello alice, your repo is ");
      expect(result.unresolved).toContain("repo");
    });

    test("no code definition, no DB record → empty text", () => {
      const result = resolveTemplate("totally.unknown.event", { foo: "bar" });
      expect(result.skipped).toBe(false);
      expect(result.text).toBe("");
      expect(result.templateId).toBeUndefined();
    });
  });

  // ============================================================================
  // Resolver — DB overrides and scope
  // ============================================================================

  describe("resolver DB overrides", () => {
    beforeEach(() => {
      clearTemplateDefinitions();
    });

    test("DB body override replaces code defaultBody", () => {
      registerTemplate({
        eventType: "resolve.db_override",
        header: "H",
        defaultBody: "Default body",
        variables: [],
        category: "event",
      });

      // Insert a DB override
      upsertPromptTemplate({
        eventType: "resolve.db_override",
        scope: "global",
        body: "Custom DB body",
      });

      const result = resolveTemplate("resolve.db_override", {});
      expect(result.text).toBe("H\n\nCustom DB body");
      expect(result.templateId).toBeDefined();
      expect(result.scope).toBe("global");
    });

    test("scope override: agent-level body replaces global default", () => {
      const agentId = "resolver-agent-001";

      registerTemplate({
        eventType: "resolve.scope_override",
        header: "",
        defaultBody: "Default",
        variables: [],
        category: "event",
      });

      upsertPromptTemplate({
        eventType: "resolve.scope_override",
        scope: "global",
        body: "Global body",
      });
      upsertPromptTemplate({
        eventType: "resolve.scope_override",
        scope: "agent",
        scopeId: agentId,
        body: "Agent body",
      });

      const result = resolveTemplate("resolve.scope_override", {}, { agentId });
      expect(result.text).toBe("Agent body");
      expect(result.scope).toBe("agent");
    });

    test("skip_event returns { skipped: true }", () => {
      registerTemplate({
        eventType: "resolve.skip",
        header: "H",
        defaultBody: "Body",
        variables: [],
        category: "event",
      });

      upsertPromptTemplate({
        eventType: "resolve.skip",
        scope: "global",
        state: "skip_event",
        body: "Skipped body",
      });

      const result = resolveTemplate("resolve.skip", {});
      expect(result.skipped).toBe(true);
      expect(result.text).toBe("");
    });

    test("default_prompt_fallback falls through to next scope", () => {
      const agentId = "resolver-fallback-agent";

      registerTemplate({
        eventType: "resolve.fallback",
        header: "",
        defaultBody: "Code default",
        variables: [],
        category: "event",
      });

      upsertPromptTemplate({
        eventType: "resolve.fallback",
        scope: "agent",
        scopeId: agentId,
        state: "default_prompt_fallback",
        body: "Agent fallback",
      });
      upsertPromptTemplate({
        eventType: "resolve.fallback",
        scope: "global",
        state: "enabled",
        body: "Global enabled",
      });

      const result = resolveTemplate("resolve.fallback", {}, { agentId });
      expect(result.text).toBe("Global enabled");
      expect(result.scope).toBe("global");
    });

    test("wildcard resolution in resolver context", () => {
      registerTemplate({
        eventType: "resolve.wild.specific",
        header: "",
        defaultBody: "Specific default",
        variables: [],
        category: "event",
      });

      // Only a wildcard DB entry exists
      upsertPromptTemplate({
        eventType: "resolve.wild.*",
        scope: "global",
        body: "Wildcard body",
      });

      const result = resolveTemplate("resolve.wild.specific", {});
      expect(result.text).toBe("Wildcard body");
    });
  });

  // ============================================================================
  // Resolver — {{@template[id]}} expansion
  // ============================================================================

  describe("template reference expansion", () => {
    beforeEach(() => {
      clearTemplateDefinitions();
    });

    test("basic {{@template[id]}} expansion", () => {
      registerTemplate({
        eventType: "ref.main",
        header: "",
        defaultBody: "Main body. Included: {{@template[ref.common]}}",
        variables: [],
        category: "event",
      });
      registerTemplate({
        eventType: "ref.common",
        header: "",
        defaultBody: "Common snippet",
        variables: [],
        category: "common",
      });

      const result = resolveTemplate("ref.main", {});
      expect(result.text).toBe("Main body. Included: Common snippet");
    });

    test("nested template refs up to depth 3", () => {
      registerTemplate({
        eventType: "depth.0",
        header: "",
        defaultBody: "L0[{{@template[depth.1]}}]",
        variables: [],
        category: "event",
      });
      registerTemplate({
        eventType: "depth.1",
        header: "",
        defaultBody: "L1[{{@template[depth.2]}}]",
        variables: [],
        category: "common",
      });
      registerTemplate({
        eventType: "depth.2",
        header: "",
        defaultBody: "L2[{{@template[depth.3]}}]",
        variables: [],
        category: "common",
      });
      registerTemplate({
        eventType: "depth.3",
        header: "",
        defaultBody: "L3-leaf",
        variables: [],
        category: "common",
      });

      const result = resolveTemplate("depth.0", {});
      expect(result.text).toBe("L0[L1[L2[L3-leaf]]]");
    });

    test("depth limit exceeded (>3 levels) — token left as-is", () => {
      registerTemplate({
        eventType: "deep.0",
        header: "",
        defaultBody: "D0[{{@template[deep.1]}}]",
        variables: [],
        category: "event",
      });
      registerTemplate({
        eventType: "deep.1",
        header: "",
        defaultBody: "D1[{{@template[deep.2]}}]",
        variables: [],
        category: "common",
      });
      registerTemplate({
        eventType: "deep.2",
        header: "",
        defaultBody: "D2[{{@template[deep.3]}}]",
        variables: [],
        category: "common",
      });
      registerTemplate({
        eventType: "deep.3",
        header: "",
        defaultBody: "D3[{{@template[deep.4]}}]",
        variables: [],
        category: "common",
      });
      registerTemplate({
        eventType: "deep.4",
        header: "",
        defaultBody: "D4-leaf",
        variables: [],
        category: "common",
      });

      const result = resolveTemplate("deep.0", {});
      // depth.0 body starts at depth 0, expands depth.1 at depth 1, depth.2 at depth 2,
      // depth.3 at depth 3 — at this point the body of depth.3 contains {{@template[deep.4]}}
      // which would require depth 4, exceeding MAX_TEMPLATE_REF_DEPTH of 3.
      // The leftover token is then treated as a variable by interpolate() and replaced with ""
      // but tracked in unresolved.
      expect(result.text).toBe("D0[D1[D2[D3[]]]]");
      expect(result.unresolved).toContain("@template[deep.4]");
    });

    test("cycle detection — token left as-is", () => {
      registerTemplate({
        eventType: "cycle.a",
        header: "",
        defaultBody: "A[{{@template[cycle.b]}}]",
        variables: [],
        category: "event",
      });
      registerTemplate({
        eventType: "cycle.b",
        header: "",
        defaultBody: "B[{{@template[cycle.a]}}]",
        variables: [],
        category: "common",
      });

      const result = resolveTemplate("cycle.a", {});
      // cycle.a → expand cycle.b (add cycle.b to visited) → cycle.b body has cycle.a ref
      // → cycle.a is NOT in visited yet, so it expands cycle.a again (add cycle.a to visited)
      // → cycle.a body has cycle.b ref → cycle.b IS in visited → cycle detected, left as-is.
      // The leftover token is treated as a variable by interpolate() and replaced with ""
      // but tracked in unresolved.
      expect(result.text).toBe("A[B[A[]]]");
      expect(result.unresolved).toContain("@template[cycle.b]");
    });

    test("template ref with DB override for referenced template", () => {
      registerTemplate({
        eventType: "refdb.main",
        header: "",
        defaultBody: "Main: {{@template[refdb.sub]}}",
        variables: [],
        category: "event",
      });
      registerTemplate({
        eventType: "refdb.sub",
        header: "",
        defaultBody: "Default sub",
        variables: [],
        category: "common",
      });

      // Override the sub template in DB
      upsertPromptTemplate({
        eventType: "refdb.sub",
        scope: "global",
        body: "DB override sub",
      });

      const result = resolveTemplate("refdb.main", {});
      expect(result.text).toBe("Main: DB override sub");
    });
  });

  // ============================================================================
  // Seeding
  // ============================================================================

  describe("seeding", () => {
    beforeEach(() => {
      clearTemplateDefinitions();
    });

    test("fresh DB gets all defaults from registered templates", () => {
      registerTemplate({
        eventType: "seed.test.alpha",
        header: "Alpha header",
        defaultBody: "Alpha default body",
        variables: [],
        category: "event",
      });
      registerTemplate({
        eventType: "seed.test.beta",
        header: "",
        defaultBody: "Beta default body",
        variables: [],
        category: "system",
      });

      seedDefaultTemplates();

      const alphaTemplates = getPromptTemplates({
        eventType: "seed.test.alpha",
        scope: "global",
        isDefault: true,
      });
      expect(alphaTemplates.length).toBe(1);
      expect(alphaTemplates[0].body).toBe("Alpha default body");
      expect(alphaTemplates[0].isDefault).toBe(true);

      const betaTemplates = getPromptTemplates({
        eventType: "seed.test.beta",
        scope: "global",
        isDefault: true,
      });
      expect(betaTemplates.length).toBe(1);
      expect(betaTemplates[0].body).toBe("Beta default body");
    });

    test("re-seeding updates defaults when code body changes", () => {
      registerTemplate({
        eventType: "seed.test.reseed",
        header: "",
        defaultBody: "Original default",
        variables: [],
        category: "event",
      });

      seedDefaultTemplates();

      const before = getPromptTemplates({
        eventType: "seed.test.reseed",
        scope: "global",
        isDefault: true,
      });
      expect(before.length).toBe(1);
      expect(before[0].body).toBe("Original default");

      // Simulate code change by re-registering with different body
      clearTemplateDefinitions();
      registerTemplate({
        eventType: "seed.test.reseed",
        header: "",
        defaultBody: "Updated default",
        variables: [],
        category: "event",
      });

      seedDefaultTemplates();

      const after = getPromptTemplates({
        eventType: "seed.test.reseed",
        scope: "global",
        isDefault: true,
      });
      expect(after.length).toBe(1);
      expect(after[0].body).toBe("Updated default");
    });

    test("re-seeding does not touch user customizations (isDefault=false)", () => {
      registerTemplate({
        eventType: "seed.test.custom",
        header: "",
        defaultBody: "Default body v1",
        variables: [],
        category: "event",
      });

      seedDefaultTemplates();

      // User customizes the template (upsert at global scope flips isDefault to false)
      upsertPromptTemplate({
        eventType: "seed.test.custom",
        scope: "global",
        body: "User custom body",
        changedBy: "user-123",
      });

      // Verify it's no longer default
      const customized = getPromptTemplates({
        eventType: "seed.test.custom",
        scope: "global",
      });
      expect(customized.length).toBe(1);
      expect(customized[0].isDefault).toBe(false);
      expect(customized[0].body).toBe("User custom body");

      // Re-seed with updated code
      clearTemplateDefinitions();
      registerTemplate({
        eventType: "seed.test.custom",
        header: "",
        defaultBody: "Default body v2",
        variables: [],
        category: "event",
      });

      seedDefaultTemplates();

      // User customization should be untouched (isDefault=false won't match the filter)
      const afterReseed = getPromptTemplates({
        eventType: "seed.test.custom",
        scope: "global",
      });
      expect(afterReseed.length).toBe(1);
      expect(afterReseed[0].body).toBe("User custom body");
      expect(afterReseed[0].isDefault).toBe(false);
    });

    test("seeding with no registered templates is a no-op", () => {
      clearTemplateDefinitions();
      // Should not throw
      seedDefaultTemplates();
    });
  });
});
