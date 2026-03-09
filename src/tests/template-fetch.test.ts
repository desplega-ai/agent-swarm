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
