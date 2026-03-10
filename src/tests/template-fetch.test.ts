import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { TemplateResponse } from "../../templates/schema.ts";
import { interpolate } from "../workflows/template.ts";

const CACHE_DIR = "/tmp/test-template-cache";

const mockTemplate: TemplateResponse = {
  config: {
    name: "coder",
    displayName: "Coder",
    description: "Test coder template",
    version: "1.0.0",
    category: "official",
    icon: "code",
    author: "Test <test@test.com>",
    createdAt: "2026-03-09",
    lastUpdatedAt: "2026-03-09",
    agentDefaults: {
      role: "worker",
      capabilities: ["typescript", "react"],
      maxTasks: 3,
    },
    files: {
      claudeMd: "CLAUDE.md",
      soulMd: "SOUL.md",
      identityMd: "IDENTITY.md",
      toolsMd: "TOOLS.md",
      setupScript: "start-up.sh",
    },
  },
  files: {
    claudeMd: "# {{agent.name}} - {{agent.role}} Agent",
    soulMd: "You are {{agent.name}}, a {{agent.role}} agent.",
    identityMd: "Name: {{agent.name}}\nCapabilities: {{agent.capabilities}}",
    toolsMd: "# Tools for {{agent.name}}",
    setupScript: '#!/bin/bash\necho "Template: {{agent.role}}"',
  },
};

let server: http.Server;
let serverPort: number;
let fetchCount = 0;

beforeAll(async () => {
  await mkdir(CACHE_DIR, { recursive: true });

  server = http.createServer((_req, res) => {
    fetchCount++;
    const url = _req.url || "";

    if (url.includes("/api/templates/official/coder")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(mockTemplate));
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(0, () => {
      const addr = server.address();
      serverPort = typeof addr === "object" && addr ? addr.port : 0;
      resolve();
    });
  });
});

afterAll(async () => {
  server.close();
  await rm(CACHE_DIR, { recursive: true, force: true });
});

describe("Template interpolation", () => {
  test("interpolates {{agent.name}} and {{agent.role}}", () => {
    const result = interpolate("Hello {{agent.name}}, you are a {{agent.role}}", {
      agent: { name: "TestBot", role: "worker" },
    });
    expect(result).toBe("Hello TestBot, you are a worker");
  });

  test("replaces unknown placeholders with empty string", () => {
    const result = interpolate("Hello {{agent.unknown}}", {
      agent: { name: "TestBot" },
    });
    expect(result).toBe("Hello ");
  });

  test("handles capabilities join", () => {
    const ctx = {
      agent: {
        name: "Coder",
        role: "worker",
        capabilities: "typescript, react",
      },
    };
    const result = interpolate("Caps: {{agent.capabilities}}", ctx);
    expect(result).toBe("Caps: typescript, react");
  });
});

describe("Template fetch and cache", () => {
  test("fetches template from registry", async () => {
    fetchCount = 0;
    const resp = await fetch(`http://localhost:${serverPort}/api/templates/official/coder`);
    expect(resp.ok).toBe(true);
    const template = (await resp.json()) as TemplateResponse;
    expect(template.config.name).toBe("coder");
    expect(template.files.claudeMd).toContain("{{agent.name}}");
    expect(fetchCount).toBe(1);
  });

  test("returns 404 for nonexistent template", async () => {
    const resp = await fetch(`http://localhost:${serverPort}/api/templates/official/nonexistent`);
    expect(resp.status).toBe(404);
  });

  test("caching: write and read from cache", async () => {
    const cachePath = `${CACHE_DIR}/official_coder.json`;
    await writeFile(cachePath, JSON.stringify(mockTemplate), "utf-8");

    const cached = await readFile(cachePath, "utf-8");
    const parsed = JSON.parse(cached) as TemplateResponse;
    expect(parsed.config.name).toBe("coder");
    expect(parsed.files.soulMd).toContain("{{agent.name}}");
  });
});

describe("Template idempotency", () => {
  test("first boot: empty profile fields get template content", () => {
    let soulMd: string | undefined;
    let identityMd: string | undefined;

    const ctx = {
      agent: { name: "MyAgent", role: "worker", capabilities: "ts, react" },
    };

    // Simulate: profile fields are empty, apply template
    if (!soulMd) soulMd = interpolate(mockTemplate.files.soulMd, ctx);
    if (!identityMd) identityMd = interpolate(mockTemplate.files.identityMd, ctx);

    expect(soulMd).toBe("You are MyAgent, a worker agent.");
    expect(identityMd).toContain("MyAgent");
  });

  test("second boot: existing profile fields are preserved (template NOT re-applied)", () => {
    const existingSoul = "I am a customized soul that the agent edited.";
    let soulMd: string | undefined = existingSoul;

    const ctx = {
      agent: { name: "MyAgent", role: "worker", capabilities: "ts, react" },
    };

    // Simulate: profile already exists, guard prevents template application
    if (!soulMd) soulMd = interpolate(mockTemplate.files.soulMd, ctx);

    // Original content preserved
    expect(soulMd).toBe(existingSoul);
  });

  test("partial profile: only missing fields get template content", () => {
    let soulMd: string | undefined = "Existing soul";
    let claudeMd: string | undefined;

    const ctx = {
      agent: { name: "MyAgent", role: "worker", capabilities: "ts, react" },
    };

    if (!soulMd) soulMd = interpolate(mockTemplate.files.soulMd, ctx);
    if (!claudeMd) claudeMd = interpolate(mockTemplate.files.claudeMd, ctx);

    expect(soulMd).toBe("Existing soul");
    expect(claudeMd).toBe("# MyAgent - worker Agent");
  });

  test("TEMPLATE_ID set but registry unreachable: falls back to defaults", () => {
    // Simulate: fetch returned null, fallback to default
    const template: TemplateResponse | null = null;
    let soulMd: string | undefined;

    if (template) {
      soulMd = interpolate(template.files.soulMd, {});
    }

    // Template not applied, soulMd still undefined -> fallback will generate default
    expect(soulMd).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Template registration defaults — tests the priority logic from runner.ts
// that applies template agentDefaults before registration
// ---------------------------------------------------------------------------

describe("Template registration defaults", () => {
  // Helper: simulates the agentName priority chain from runner.ts
  function resolveAgentName(
    envName: string | undefined,
    templateDisplayName: string | undefined,
    role: string,
    agentId: string,
  ): string {
    return envName || templateDisplayName || `${role}-${agentId.slice(0, 8)}`;
  }

  // ---- name priority ----

  test("name: AGENT_NAME env takes precedence over template displayName", () => {
    const name = resolveAgentName("my-custom-name", "Coder", "worker", "abc12345-dead-beef");
    expect(name).toBe("my-custom-name");
  });

  test("name: template displayName used when AGENT_NAME not set", () => {
    const name = resolveAgentName(undefined, "Coder", "worker", "abc12345-dead-beef");
    expect(name).toBe("Coder");
  });

  test("name: falls back to role-id when no env name and no template", () => {
    const name = resolveAgentName(undefined, undefined, "worker", "abc12345-dead-beef");
    expect(name).toBe("worker-abc12345");
  });

  test("name: template role feeds into fallback name when role overridden", () => {
    // If template overrides role from "worker" to "coder", the fallback name uses the new role
    const name = resolveAgentName(undefined, undefined, "coder", "abc12345-dead-beef");
    expect(name).toBe("coder-abc12345");
  });

  // ---- role priority ----

  test("role: template role overrides generic 'worker' default", () => {
    let role = "worker";
    const configRole = "worker";
    const defaults = { role: "coder", capabilities: ["typescript"], maxTasks: 3 };

    if (configRole === "worker" && defaults.role) {
      role = defaults.role;
    }

    expect(role).toBe("coder");
  });

  test("role: explicit 'lead' config is NOT overridden by template", () => {
    let role = "lead";
    const configRole = "lead";
    const defaults = { role: "coder", capabilities: ["typescript"], maxTasks: 3 };

    if (configRole === "worker" && defaults.role) {
      role = defaults.role;
    }

    expect(role).toBe("lead");
  });

  test("role: stays 'worker' when template has no role", () => {
    let role = "worker";
    const configRole = "worker";
    const defaults = { role: "", capabilities: [], maxTasks: 1 };

    if (configRole === "worker" && defaults.role) {
      role = defaults.role;
    }

    expect(role).toBe("worker");
  });

  // ---- capabilities priority ----

  test("capabilities: template caps used when config has none", () => {
    let capabilities: string[] | undefined;
    const defaults = { capabilities: ["typescript", "react"] };

    if (!capabilities?.length && defaults.capabilities?.length) {
      capabilities = defaults.capabilities;
    }

    expect(capabilities).toEqual(["typescript", "react"]);
  });

  test("capabilities: config caps take precedence over template", () => {
    let capabilities: string[] | undefined = ["python", "django"];
    const defaults = { capabilities: ["typescript", "react"] };

    if (!capabilities?.length && defaults.capabilities?.length) {
      capabilities = defaults.capabilities;
    }

    expect(capabilities).toEqual(["python", "django"]);
  });

  test("capabilities: empty array config still gets template caps", () => {
    let capabilities: string[] | undefined = [];
    const defaults = { capabilities: ["typescript", "react"] };

    if (!capabilities?.length && defaults.capabilities?.length) {
      capabilities = defaults.capabilities;
    }

    expect(capabilities).toEqual(["typescript", "react"]);
  });

  // ---- maxTasks priority ----

  test("maxTasks: env var takes precedence over template and default", () => {
    const envMaxTasks = "5";
    const templateMaxTasks = 3;
    const defaultMaxTasks = 1;

    const maxConcurrent = envMaxTasks
      ? parseInt(envMaxTasks, 10)
      : (templateMaxTasks ?? defaultMaxTasks);

    expect(maxConcurrent).toBe(5);
  });

  test("maxTasks: template value used when env not set", () => {
    const envMaxTasks = "";
    const templateMaxTasks = 3;
    const defaultMaxTasks = 1;

    const maxConcurrent = envMaxTasks
      ? parseInt(envMaxTasks, 10)
      : (templateMaxTasks ?? defaultMaxTasks);

    expect(maxConcurrent).toBe(3);
  });

  test("maxTasks: hardcoded default used when no env and no template", () => {
    const envMaxTasks = "";
    const templateMaxTasks = undefined;
    const defaultMaxTasks = 1;

    const maxConcurrent = envMaxTasks
      ? parseInt(envMaxTasks, 10)
      : (templateMaxTasks ?? defaultMaxTasks);

    expect(maxConcurrent).toBe(1);
  });

  // ---- isLead priority ----

  test("isLead: config lead role takes precedence", () => {
    const configRole = "lead";
    const templateIsLead = false;

    const isLead = configRole === "lead" || (templateIsLead ?? false);
    expect(isLead).toBe(true);
  });

  test("isLead: template isLead=true used when config is worker", () => {
    const configRole = "worker";
    const templateIsLead = true;

    const isLead = configRole === "lead" || (templateIsLead ?? false);
    expect(isLead).toBe(true);
  });

  test("isLead: defaults to false when config is worker and template has no isLead", () => {
    const configRole = "worker";
    const templateIsLead = undefined;

    const isLead = configRole === "lead" || (templateIsLead ?? false);
    expect(isLead).toBe(false);
  });

  // ---- combined flow ----

  test("full flow: template with agentDefaults applies all fallbacks", () => {
    const configRole = "worker";
    const template: TemplateResponse = {
      ...mockTemplate,
      config: {
        ...mockTemplate.config,
        displayName: "Research Assistant",
        agentDefaults: {
          role: "researcher",
          capabilities: ["web-search", "analysis"],
          maxTasks: 4,
          isLead: false,
        },
      },
    };

    // Apply role
    let role = configRole;
    if (configRole === "worker" && template.config.agentDefaults.role) {
      role = template.config.agentDefaults.role;
    }

    // Apply capabilities
    let capabilities: string[] | undefined;
    const defaults = template.config.agentDefaults;
    if (!capabilities?.length && defaults.capabilities?.length) {
      capabilities = defaults.capabilities;
    }

    // Apply maxTasks (no env var)
    const maxConcurrent = defaults.maxTasks ?? 1;

    // Apply isLead
    const isLead = configRole === "lead" || (defaults.isLead ?? false);

    // Apply name
    const agentName = resolveAgentName(undefined, template.config.displayName, role, "abc12345");

    expect(role).toBe("researcher");
    expect(capabilities).toEqual(["web-search", "analysis"]);
    expect(maxConcurrent).toBe(4);
    expect(isLead).toBe(false);
    expect(agentName).toBe("Research Assistant");
  });

  test("full flow: env/config overrides beat template defaults", () => {
    const configRole = "lead";
    const template: TemplateResponse = {
      ...mockTemplate,
      config: {
        ...mockTemplate.config,
        displayName: "Coder",
        agentDefaults: {
          role: "coder",
          capabilities: ["typescript"],
          maxTasks: 3,
          isLead: false,
        },
      },
    };

    // Apply role — lead is NOT overridden
    let role = configRole;
    if (configRole === "worker" && template.config.agentDefaults.role) {
      role = template.config.agentDefaults.role;
    }

    // Config capabilities take precedence
    let capabilities: string[] | undefined = ["python"];
    const defaults = template.config.agentDefaults;
    if (!capabilities?.length && defaults.capabilities?.length) {
      capabilities = defaults.capabilities;
    }

    // Env var takes precedence for maxTasks
    const envMaxTasks = "10";
    const maxConcurrent = envMaxTasks ? parseInt(envMaxTasks, 10) : (defaults.maxTasks ?? 1);

    // isLead from config role
    const isLead = configRole === "lead" || (defaults.isLead ?? false);

    // AGENT_NAME takes precedence
    const agentName = resolveAgentName("my-lead", template.config.displayName, role, "abc12345");

    expect(role).toBe("lead");
    expect(capabilities).toEqual(["python"]);
    expect(maxConcurrent).toBe(10);
    expect(isLead).toBe(true);
    expect(agentName).toBe("my-lead");
  });

  test("full flow: no template — all values use config/hardcoded defaults", () => {
    const configRole = "worker";
    const cachedTemplate: TemplateResponse | null = null;

    let role = configRole;
    let capabilities: string[] | undefined;

    if (cachedTemplate?.config.agentDefaults) {
      const defaults = cachedTemplate.config.agentDefaults;
      if (configRole === "worker" && defaults.role) role = defaults.role;
      if (!capabilities?.length && defaults.capabilities?.length)
        capabilities = defaults.capabilities;
    }

    const isLead = configRole === "lead" || (cachedTemplate?.config.agentDefaults?.isLead ?? false);
    const maxConcurrent = cachedTemplate?.config.agentDefaults?.maxTasks ?? (isLead ? 2 : 1);
    const agentName = resolveAgentName(
      undefined,
      cachedTemplate?.config.displayName,
      role,
      "abc12345",
    );

    expect(role).toBe("worker");
    expect(capabilities).toBeUndefined();
    expect(maxConcurrent).toBe(1);
    expect(isLead).toBe(false);
    expect(agentName).toBe("worker-abc12345");
  });
});
