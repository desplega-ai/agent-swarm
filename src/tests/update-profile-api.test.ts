import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { closeDb, createAgent, getAgentById, initDb, updateAgentProfile } from "../be/db";

const TEST_DB_PATH = "./test-update-profile-api.sqlite";
const TEST_PORT = 13020;

// Helper to parse path segments
function getPathSegments(url: string): string[] {
  const pathEnd = url.indexOf("?");
  const path = pathEnd === -1 ? url : url.slice(0, pathEnd);
  return path.split("/").filter(Boolean);
}

// Minimal HTTP handler for profile update endpoint
async function handleRequest(
  req: { method: string; url: string },
  bodyText: string,
): Promise<{ status: number; body: unknown }> {
  const pathSegments = getPathSegments(req.url || "");

  // PUT /api/agents/:id/profile - Update agent profile
  if (
    req.method === "PUT" &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "agents" &&
    pathSegments[2] &&
    pathSegments[3] === "profile"
  ) {
    const agentId = pathSegments[2];

    let body: {
      role?: string;
      description?: string;
      capabilities?: string[];
      claudeMd?: string;
      soulMd?: string;
      identityMd?: string;
    };
    try {
      body = JSON.parse(bodyText);
    } catch {
      return { status: 400, body: { error: "Invalid JSON" } };
    }

    // At least one field must be provided
    if (
      body.role === undefined &&
      body.description === undefined &&
      body.capabilities === undefined &&
      body.claudeMd === undefined &&
      body.soulMd === undefined &&
      body.identityMd === undefined
    ) {
      return {
        status: 400,
        body: {
          error:
            "At least one field (role, description, capabilities, claudeMd, soulMd, or identityMd) must be provided",
        },
      };
    }

    // Validate role length if provided
    if (body.role !== undefined && body.role.length > 100) {
      return { status: 400, body: { error: "Role must be 100 characters or less" } };
    }

    // Validate capabilities if provided
    if (body.capabilities !== undefined && !Array.isArray(body.capabilities)) {
      return { status: 400, body: { error: "Capabilities must be an array of strings" } };
    }

    // Validate claudeMd size if provided (max 64KB)
    if (body.claudeMd !== undefined && body.claudeMd.length > 65536) {
      return { status: 400, body: { error: "claudeMd must be 64KB or less" } };
    }

    // Validate soulMd size if provided (max 64KB)
    if (body.soulMd !== undefined && body.soulMd.length > 65536) {
      return { status: 400, body: { error: "soulMd must be 64KB or less" } };
    }

    // Validate identityMd size if provided (max 64KB)
    if (body.identityMd !== undefined && body.identityMd.length > 65536) {
      return { status: 400, body: { error: "identityMd must be 64KB or less" } };
    }

    const agent = updateAgentProfile(agentId, {
      role: body.role,
      description: body.description,
      capabilities: body.capabilities,
      claudeMd: body.claudeMd,
      soulMd: body.soulMd,
      identityMd: body.identityMd,
    });

    if (!agent) {
      return { status: 404, body: { error: "Agent not found" } };
    }

    return { status: 200, body: agent };
  }

  return { status: 404, body: { error: "Not found" } };
}

// Create test HTTP server
function createTestServer(): Server {
  return createHttpServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString();

    const result = await handleRequest({ method: req.method || "GET", url: req.url || "/" }, body);

    res.writeHead(result.status);
    res.end(JSON.stringify(result.body));
  });
}

describe("PUT /api/agents/:id/profile", () => {
  let server: Server;
  const baseUrl = `http://localhost:${TEST_PORT}`;

  beforeAll(async () => {
    // Clean up any existing test database
    try {
      await unlink(TEST_DB_PATH);
    } catch {
      // File doesn't exist, that's fine
    }

    // Initialize test database
    initDb(TEST_DB_PATH);

    // Start test server
    server = createTestServer();
    await new Promise<void>((resolve) => {
      server.listen(TEST_PORT, () => {
        console.log(`Test server listening on port ${TEST_PORT}`);
        resolve();
      });
    });
  });

  afterAll(async () => {
    // Close server
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    // Close database
    closeDb();

    // Clean up test database file
    try {
      await unlink(TEST_DB_PATH);
      await unlink(`${TEST_DB_PATH}-wal`);
      await unlink(`${TEST_DB_PATH}-shm`);
    } catch {
      // Files may not exist
    }
  });

  describe("Validation", () => {
    test("should return 400 for invalid JSON", async () => {
      const response = await fetch(`${baseUrl}/api/agents/test-agent/profile`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "not valid json",
      });

      expect(response.status).toBe(400);
      const data = (await response.json()) as { error?: string };
      expect(data.error).toBe("Invalid JSON");
    });

    test("should return 400 if no fields are provided", async () => {
      const response = await fetch(`${baseUrl}/api/agents/test-agent/profile`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(400);
      const data = (await response.json()) as { error?: string };
      expect(data.error).toContain("At least one field");
    });

    test("should return 400 if role exceeds 100 characters", async () => {
      const longRole = "a".repeat(101);
      const response = await fetch(`${baseUrl}/api/agents/test-agent/profile`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: longRole }),
      });

      expect(response.status).toBe(400);
      const data = (await response.json()) as { error?: string };
      expect(data.error).toContain("100 characters");
    });

    test("should return 400 if capabilities is not an array", async () => {
      const response = await fetch(`${baseUrl}/api/agents/test-agent/profile`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capabilities: "not an array" }),
      });

      expect(response.status).toBe(400);
      const data = (await response.json()) as { error?: string };
      expect(data.error).toContain("array");
    });

    test("should return 404 if agent does not exist", async () => {
      const response = await fetch(`${baseUrl}/api/agents/non-existent-agent/profile`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "Developer" }),
      });

      expect(response.status).toBe(404);
      const data = (await response.json()) as { error?: string };
      expect(data.error).toContain("not found");
    });
  });

  describe("Update Role", () => {
    test("should update agent role successfully", async () => {
      const agentId = "test-agent-role-update";
      createAgent({
        id: agentId,
        name: "Test Agent Role Update",
        isLead: false,
        status: "idle",
      });

      const response = await fetch(`${baseUrl}/api/agents/${agentId}/profile`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "Frontend Developer" }),
      });

      expect(response.status).toBe(200);
      const data = (await response.json()) as { id?: string; role?: string };
      expect(data.id).toBe(agentId);
      expect(data.role).toBe("Frontend Developer");

      // Verify in database
      const agent = getAgentById(agentId);
      expect(agent?.role).toBe("Frontend Developer");
    });

    test("should allow role at exactly 100 characters", async () => {
      const agentId = "test-agent-role-100";
      createAgent({
        id: agentId,
        name: "Test Agent Role 100",
        isLead: false,
        status: "idle",
      });

      const role100Chars = "a".repeat(100);
      const response = await fetch(`${baseUrl}/api/agents/${agentId}/profile`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: role100Chars }),
      });

      expect(response.status).toBe(200);
      const data = (await response.json()) as { role?: string };
      expect(data.role).toBe(role100Chars);
    });

    test("should allow clearing role by setting empty string", async () => {
      const agentId = "test-agent-role-clear";
      createAgent({
        id: agentId,
        name: "Test Agent Role Clear",
        isLead: false,
        status: "idle",
      });

      // First set a role
      await fetch(`${baseUrl}/api/agents/${agentId}/profile`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "Developer" }),
      });

      // Then clear it
      const response = await fetch(`${baseUrl}/api/agents/${agentId}/profile`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "" }),
      });

      expect(response.status).toBe(200);
      const data = (await response.json()) as { role?: string };
      expect(data.role).toBe("");
    });
  });

  describe("Update Description", () => {
    test("should update agent description successfully", async () => {
      const agentId = "test-agent-desc-update";
      createAgent({
        id: agentId,
        name: "Test Agent Desc Update",
        isLead: false,
        status: "idle",
      });

      const response = await fetch(`${baseUrl}/api/agents/${agentId}/profile`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: "This is a test agent for development tasks" }),
      });

      expect(response.status).toBe(200);
      const data = (await response.json()) as { id?: string; description?: string };
      expect(data.id).toBe(agentId);
      expect(data.description).toBe("This is a test agent for development tasks");

      // Verify in database
      const agent = getAgentById(agentId);
      expect(agent?.description).toBe("This is a test agent for development tasks");
    });
  });

  describe("Update Capabilities", () => {
    test("should update agent capabilities successfully", async () => {
      const agentId = "test-agent-caps-update";
      createAgent({
        id: agentId,
        name: "Test Agent Caps Update",
        isLead: false,
        status: "idle",
      });

      const response = await fetch(`${baseUrl}/api/agents/${agentId}/profile`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capabilities: ["typescript", "react", "node"] }),
      });

      expect(response.status).toBe(200);
      const data = (await response.json()) as { id?: string; capabilities?: string[] };
      expect(data.id).toBe(agentId);
      expect(data.capabilities).toEqual(["typescript", "react", "node"]);

      // Verify in database
      const agent = getAgentById(agentId);
      expect(agent?.capabilities).toEqual(["typescript", "react", "node"]);
    });

    test("should allow empty capabilities array", async () => {
      const agentId = "test-agent-caps-empty";
      createAgent({
        id: agentId,
        name: "Test Agent Caps Empty",
        isLead: false,
        status: "idle",
      });

      const response = await fetch(`${baseUrl}/api/agents/${agentId}/profile`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capabilities: [] }),
      });

      expect(response.status).toBe(200);
      const data = (await response.json()) as { capabilities?: string[] };
      expect(data.capabilities).toEqual([]);
    });
  });

  describe("Update Multiple Fields", () => {
    test("should update all profile fields at once", async () => {
      const agentId = "test-agent-all-fields";
      createAgent({
        id: agentId,
        name: "Test Agent All Fields",
        isLead: false,
        status: "idle",
      });

      const response = await fetch(`${baseUrl}/api/agents/${agentId}/profile`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          role: "Senior Engineer",
          description: "Handles complex tasks",
          capabilities: ["python", "docker", "kubernetes"],
        }),
      });

      expect(response.status).toBe(200);
      const data = (await response.json()) as {
        id?: string;
        role?: string;
        description?: string;
        capabilities?: string[];
      };
      expect(data.id).toBe(agentId);
      expect(data.role).toBe("Senior Engineer");
      expect(data.description).toBe("Handles complex tasks");
      expect(data.capabilities).toEqual(["python", "docker", "kubernetes"]);

      // Verify in database
      const agent = getAgentById(agentId);
      expect(agent?.role).toBe("Senior Engineer");
      expect(agent?.description).toBe("Handles complex tasks");
      expect(agent?.capabilities).toEqual(["python", "docker", "kubernetes"]);
    });

    test("should preserve existing fields when updating only some fields", async () => {
      const agentId = "test-agent-partial-update";
      createAgent({
        id: agentId,
        name: "Test Agent Partial Update",
        isLead: false,
        status: "idle",
      });

      // Set initial profile
      await fetch(`${baseUrl}/api/agents/${agentId}/profile`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          role: "Developer",
          description: "Initial description",
          capabilities: ["javascript"],
        }),
      });

      // Update only the role
      const response = await fetch(`${baseUrl}/api/agents/${agentId}/profile`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "Lead Developer" }),
      });

      expect(response.status).toBe(200);
      const data = (await response.json()) as {
        role?: string;
        description?: string;
        capabilities?: string[];
      };
      expect(data.role).toBe("Lead Developer");
      // Other fields should be preserved (due to COALESCE in the SQL)
      expect(data.description).toBe("Initial description");
      expect(data.capabilities).toEqual(["javascript"]);
    });
  });

  describe("Update claudeMd", () => {
    test("should update agent claudeMd successfully", async () => {
      const agentId = "test-agent-claudemd-update";
      createAgent({
        id: agentId,
        name: "Test Agent ClaudeMd Update",
        isLead: false,
        status: "idle",
      });

      const claudeMdContent = "# My Notes\n\nThis is my personal CLAUDE.md content.";
      const response = await fetch(`${baseUrl}/api/agents/${agentId}/profile`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claudeMd: claudeMdContent }),
      });

      expect(response.status).toBe(200);
      const data = (await response.json()) as { id?: string; claudeMd?: string };
      expect(data.id).toBe(agentId);
      expect(data.claudeMd).toBe(claudeMdContent);

      // Verify in database
      const agent = getAgentById(agentId);
      expect(agent?.claudeMd).toBe(claudeMdContent);
    });

    test("should return 400 if claudeMd exceeds 64KB", async () => {
      const largeContent = "a".repeat(65537); // 64KB + 1 byte
      const response = await fetch(`${baseUrl}/api/agents/test-agent/profile`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claudeMd: largeContent }),
      });

      expect(response.status).toBe(400);
      const data = (await response.json()) as { error?: string };
      expect(data.error).toContain("64KB");
    });

    test("should allow claudeMd at exactly 64KB", async () => {
      const agentId = "test-agent-claudemd-64kb";
      createAgent({
        id: agentId,
        name: "Test Agent ClaudeMd 64KB",
        isLead: false,
        status: "idle",
      });

      const exactContent = "a".repeat(65536); // Exactly 64KB
      const response = await fetch(`${baseUrl}/api/agents/${agentId}/profile`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claudeMd: exactContent }),
      });

      expect(response.status).toBe(200);
      const data = (await response.json()) as { claudeMd?: string };
      expect(data.claudeMd?.length).toBe(65536);
    });

    test("should allow clearing claudeMd by setting empty string", async () => {
      const agentId = "test-agent-claudemd-clear";
      createAgent({
        id: agentId,
        name: "Test Agent ClaudeMd Clear",
        isLead: false,
        status: "idle",
      });

      // First set claudeMd
      await fetch(`${baseUrl}/api/agents/${agentId}/profile`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claudeMd: "Some content" }),
      });

      // Then clear it
      const response = await fetch(`${baseUrl}/api/agents/${agentId}/profile`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claudeMd: "" }),
      });

      expect(response.status).toBe(200);
      const data = (await response.json()) as { claudeMd?: string };
      expect(data.claudeMd).toBe("");
    });

    test("should preserve claudeMd when updating other fields", async () => {
      const agentId = "test-agent-claudemd-preserve";
      createAgent({
        id: agentId,
        name: "Test Agent ClaudeMd Preserve",
        isLead: false,
        status: "idle",
      });

      // Set initial claudeMd
      await fetch(`${baseUrl}/api/agents/${agentId}/profile`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claudeMd: "My notes" }),
      });

      // Update only the role
      const response = await fetch(`${baseUrl}/api/agents/${agentId}/profile`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "Developer" }),
      });

      expect(response.status).toBe(200);
      const data = (await response.json()) as { role?: string; claudeMd?: string };
      expect(data.role).toBe("Developer");
      // claudeMd should be preserved (due to COALESCE in the SQL)
      expect(data.claudeMd).toBe("My notes");
    });
  });

  describe("Update soulMd", () => {
    test("should update agent soulMd successfully", async () => {
      const agentId = "test-agent-soulmd-update";
      createAgent({
        id: agentId,
        name: "Test Agent SoulMd Update",
        isLead: false,
        status: "idle",
      });

      const soulContent = "# SOUL.md — Test Agent\n\nYou are a coding specialist.";
      const response = await fetch(`${baseUrl}/api/agents/${agentId}/profile`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ soulMd: soulContent }),
      });

      expect(response.status).toBe(200);
      const data = (await response.json()) as { id?: string; soulMd?: string };
      expect(data.id).toBe(agentId);
      expect(data.soulMd).toBe(soulContent);

      // Verify in database
      const agent = getAgentById(agentId);
      expect(agent?.soulMd).toBe(soulContent);
    });

    test("should return 400 if soulMd exceeds 64KB", async () => {
      const largeContent = "a".repeat(65537);
      const response = await fetch(`${baseUrl}/api/agents/test-agent/profile`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ soulMd: largeContent }),
      });

      expect(response.status).toBe(400);
      const data = (await response.json()) as { error?: string };
      expect(data.error).toContain("64KB");
    });
  });

  describe("Update identityMd", () => {
    test("should update agent identityMd successfully", async () => {
      const agentId = "test-agent-identitymd-update";
      createAgent({
        id: agentId,
        name: "Test Agent IdentityMd Update",
        isLead: false,
        status: "idle",
      });

      const identityContent = "# IDENTITY.md — Test Agent\n\nRole: developer\nVibe: focused";
      const response = await fetch(`${baseUrl}/api/agents/${agentId}/profile`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identityMd: identityContent }),
      });

      expect(response.status).toBe(200);
      const data = (await response.json()) as { id?: string; identityMd?: string };
      expect(data.id).toBe(agentId);
      expect(data.identityMd).toBe(identityContent);

      // Verify in database
      const agent = getAgentById(agentId);
      expect(agent?.identityMd).toBe(identityContent);
    });

    test("should return 400 if identityMd exceeds 64KB", async () => {
      const largeContent = "a".repeat(65537);
      const response = await fetch(`${baseUrl}/api/agents/test-agent/profile`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identityMd: largeContent }),
      });

      expect(response.status).toBe(400);
      const data = (await response.json()) as { error?: string };
      expect(data.error).toContain("64KB");
    });

    test("should preserve soulMd and identityMd when updating other fields", async () => {
      const agentId = "test-agent-identity-preserve";
      createAgent({
        id: agentId,
        name: "Test Agent Identity Preserve",
        isLead: false,
        status: "idle",
      });

      // Set initial soul and identity
      await fetch(`${baseUrl}/api/agents/${agentId}/profile`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          soulMd: "My soul",
          identityMd: "My identity",
        }),
      });

      // Update only the role
      const response = await fetch(`${baseUrl}/api/agents/${agentId}/profile`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "Developer" }),
      });

      expect(response.status).toBe(200);
      const data = (await response.json()) as {
        role?: string;
        soulMd?: string;
        identityMd?: string;
      };
      expect(data.role).toBe("Developer");
      expect(data.soulMd).toBe("My soul");
      expect(data.identityMd).toBe("My identity");
    });
  });
});
