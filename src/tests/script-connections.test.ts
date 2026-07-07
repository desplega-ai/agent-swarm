import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createAgent, deleteSwarmConfig, getDb, upsertSwarmConfig } from "../be/db";
import {
  getScriptApiConnectionDescriptors,
  refreshScriptConnection,
  upsertCredentialBinding,
  upsertScriptConnection,
} from "../be/script-connections";
import { buildScriptCredentialBindings } from "../be/script-credential-broker";
import { typecheckScript } from "../be/scripts/typecheck";
import { runScript } from "../scripts-runtime/loader";
import { registerScriptConnectionsTool } from "../tools/script-connections";

const createdBindingIds: string[] = [];
const createdConnectionIds: string[] = [];
const createdConfigIds: string[] = [];
const originalFetch = globalThis.fetch;
const savedEnv = { ...process.env };
const resources = { memoryMb: 2048, cpuTimeSec: 20, maxStdoutBytes: 1_048_576 };

type RegisteredTool = {
  handler: (args: unknown, extra: unknown) => Promise<unknown>;
};

function scriptConnectionsTool() {
  const server = new McpServer({ name: "script-connections-test", version: "1.0.0" });
  registerScriptConnectionsTool(server);
  const registered = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
  const tool = registered["script-connections"];
  if (!tool) throw new Error("script-connections tool not registered");
  return tool;
}

function meta(agentId: string) {
  return {
    sessionId: "script-connections-test-session",
    requestInfo: { headers: { "x-agent-id": agentId } },
  };
}

const openapiSpec = JSON.stringify({
  openapi: "3.1.0",
  info: { title: "Vendor", version: "1.0.0" },
  paths: {
    "/repos/{owner}/{repo}": {
      get: {
        operationId: "getRepo",
        parameters: [
          { name: "owner", in: "path", required: true, schema: { type: "string" } },
          { name: "repo", in: "path", required: true, schema: { type: "string" } },
          { name: "include", in: "query", schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "repo",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["full_name"],
                  properties: {
                    full_name: { type: "string" },
                    private: { type: "boolean" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/repos": {
      post: {
        operationId: "createRepo",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name"],
                properties: {
                  name: { type: "string" },
                  private: { type: "boolean" },
                },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "created repo",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["full_name"],
                  properties: {
                    full_name: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
});

function specWithExtraOperation(operationId: string) {
  const spec = JSON.parse(openapiSpec) as {
    paths: Record<string, Record<string, unknown>>;
  };
  spec.paths["/orgs/{org}/repos"] = {
    get: {
      operationId,
      parameters: [{ name: "org", in: "path", required: true, schema: { type: "string" } }],
      responses: {
        "200": {
          description: "repos",
          content: {
            "application/json": {
              schema: {
                type: "array",
                items: {
                  type: "object",
                  required: ["name"],
                  properties: { name: { type: "string" } },
                },
              },
            },
          },
        },
      },
    },
  };
  return JSON.stringify(spec);
}

function serveOpenapiSpec(initialBody: string, initialEtag = '"v1"') {
  let body = initialBody;
  let etag = initialEtag;
  const requests: Array<{ accept: string | null; ifNoneMatch: string | null }> = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/openapi.json") {
        return new Response("not found", { status: 404 });
      }
      requests.push({
        accept: req.headers.get("accept"),
        ifNoneMatch: req.headers.get("if-none-match"),
      });
      if (req.headers.get("if-none-match") === etag) {
        return new Response(null, { status: 304, headers: { ETag: etag } });
      }
      return new Response(body, {
        headers: { "Content-Type": "application/json", ETag: etag },
      });
    },
  });
  return {
    requests,
    url: `http://127.0.0.1:${server.port}/openapi.json`,
    baseUrl: `http://127.0.0.1:${server.port}`,
    setBody(nextBody: string, nextEtag: string) {
      body = nextBody;
      etag = nextEtag;
    },
    stop() {
      server.stop(true);
    },
  };
}

beforeEach(() => {
  process.env.AGENT_SWARM_API_KEY = "script-connections-test-key";
  delete process.env.API_KEY;
  process.env.MCP_BASE_URL = "http://localhost:3013";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const db = getDb();
  for (const id of createdConnectionIds.splice(0)) {
    db.run("DELETE FROM script_connections WHERE id = ?", id);
  }
  for (const id of createdBindingIds.splice(0)) {
    db.run("DELETE FROM script_credential_bindings WHERE id = ?", id);
  }
  for (const id of createdConfigIds.splice(0)) {
    deleteSwarmConfig(id);
  }
});

describe("script connections", () => {
  test("relational credential bindings are resolved before legacy JSON config", () => {
    const binding = upsertCredentialBinding({
      configKey: "REL_VENDOR_KEY",
      allowedHosts: ["api.vendor.test"],
      headerTemplate: "Authorization: Bearer [REDACTED:REL_VENDOR_KEY]",
    });
    createdBindingIds.push(binding.id);
    const secretConfig = upsertSwarmConfig({
      scope: "global",
      key: "REL_VENDOR_KEY",
      value: "rel-secret",
      isSecret: true,
    });
    createdConfigIds.push(secretConfig.id);

    const egressSecrets = buildScriptCredentialBindings({});

    expect(egressSecrets).toContainEqual(
      expect.objectContaining({
        configKey: "REL_VENDOR_KEY",
        allowedHosts: ["api.vendor.test"],
        value: "rel-secret",
      }),
    );
  });

  test("credential binding upsert is idempotent by binding identity", () => {
    const first = upsertCredentialBinding({
      configKey: "IDEMPOTENT_VENDOR_KEY",
      allowedHosts: ["old.vendor.test"],
      headerTemplate: "Authorization: Bearer [REDACTED:IDEMPOTENT_VENDOR_KEY]",
    });
    createdBindingIds.push(first.id);

    const second = upsertCredentialBinding({
      configKey: "IDEMPOTENT_VENDOR_KEY",
      allowedHosts: ["new.vendor.test"],
      headerTemplate: "Authorization: Bearer [REDACTED:IDEMPOTENT_VENDOR_KEY]",
    });

    expect(second.id).toBe(first.id);
    expect(second.allowedHosts).toEqual(["new.vendor.test"]);
  });

  test("OpenAPI connections generate full ctx.api method, args, and response types", async () => {
    const binding = upsertCredentialBinding({
      configKey: "TYPE_VENDOR_KEY",
      allowedHosts: ["api.vendor.test"],
      headerTemplate: "Authorization: Bearer [REDACTED:TYPE_VENDOR_KEY]",
    });
    createdBindingIds.push(binding.id);
    const connection = await upsertScriptConnection({
      slug: "vendorApi",
      kind: "openapi",
      baseUrl: "https://api.vendor.test",
      credentialBindingId: binding.id,
      openapiSpecJson: openapiSpec,
    });
    createdConnectionIds.push(connection.id);

    expect(connection.generationError).toBeNull();
    const source = `
      import type { ScriptMain } from "swarm-sdk";
      const main: ScriptMain = async (_args, ctx) => {
        const repo = await ctx.api.vendorApi.getRepo({
          path: { owner: "desplega-ai", repo: "agent-swarm" },
          query: { include: "stats" },
        });
        const created = await ctx.api.vendorApi.createRepo({
          body: { name: "agent-swarm", private: false },
        });
        const name: string = repo.full_name;
        const createdName: string = created.full_name;
        const isPrivate: boolean | undefined = repo.private;
        return { name, createdName, isPrivate };
      };
      export default main;
    `;

    expect(typecheckScript(source)).toEqual({ ok: true });
    const descriptor = getScriptApiConnectionDescriptors().find(
      (candidate) => candidate.slug === "vendorApi",
    );
    const getRepo = descriptor?.operations.find((operation) => operation.name === "getRepo");
    expect(getRepo?.parameters).toContainEqual({
      name: "owner",
      in: "path",
      required: true,
      schema: { type: "string" },
    });
    expect(getRepo?.responseSchema).toEqual({
      type: "object",
      required: ["full_name"],
      properties: {
        full_name: { type: "string" },
        private: { type: "boolean" },
      },
    });
    const createRepo = descriptor?.operations.find((operation) => operation.name === "createRepo");
    expect(createRepo?.requestBodySchema).toEqual({
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string" },
        private: { type: "boolean" },
      },
    });
  });

  test("OpenAPI connections can be registered from a spec URL", async () => {
    const server = serveOpenapiSpec(openapiSpec);
    try {
      const suffix = crypto.randomUUID().replace(/-/g, "");
      const connection = await upsertScriptConnection({
        slug: `urlVendor${suffix}`,
        kind: "openapi",
        baseUrl: server.baseUrl,
        openapiSpecUrl: server.url,
      });
      createdConnectionIds.push(connection.id);

      expect(connection.generationError).toBeNull();
      expect(connection.openapiSpecSourceKind).toBe("url");
      expect(connection.openapiSpecSource).toBe(server.url);
      expect(connection.openapiSpecJson).toBe(JSON.stringify(JSON.parse(openapiSpec)));
      expect(connection.openapiSpecEtag).toBe('"v1"');
      expect(connection.openapiSpecFetchedAt).toBeString();
      expect(server.requests).toEqual([{ accept: "application/json", ifNoneMatch: null }]);
      expect(connection.generatedTypes).toContain("getRepo");
    } finally {
      server.stop();
    }
  });

  test("refresh sends If-None-Match and only bumps fetched_at on 304", async () => {
    const server = serveOpenapiSpec(openapiSpec);
    try {
      const suffix = crypto.randomUUID().replace(/-/g, "");
      const connection = await upsertScriptConnection({
        slug: `etagVendor${suffix}`,
        kind: "openapi",
        baseUrl: server.baseUrl,
        openapiSpecUrl: server.url,
      });
      createdConnectionIds.push(connection.id);
      await Bun.sleep(5);

      const refreshed = await refreshScriptConnection(connection.id);

      expect(refreshed).toBeDefined();
      expect(refreshed?.version).toBe(connection.version);
      expect(refreshed?.openapiSpecEtag).toBe('"v1"');
      expect(refreshed?.generatedRuntimeJson).toBe(connection.generatedRuntimeJson);
      expect(refreshed?.openapiSpecFetchedAt).not.toBe(connection.openapiSpecFetchedAt);
      expect(server.requests).toEqual([
        { accept: "application/json", ifNoneMatch: null },
        { accept: "application/json", ifNoneMatch: '"v1"' },
      ]);
    } finally {
      server.stop();
    }
  });

  test("refresh updates changed URL specs and regenerates types", async () => {
    const server = serveOpenapiSpec(openapiSpec);
    try {
      const suffix = crypto.randomUUID().replace(/-/g, "");
      const connection = await upsertScriptConnection({
        slug: `changedVendor${suffix}`,
        kind: "openapi",
        baseUrl: server.baseUrl,
        openapiSpecUrl: server.url,
      });
      createdConnectionIds.push(connection.id);
      expect(connection.generatedTypes).not.toContain("listOrgRepos");

      server.setBody(specWithExtraOperation("listOrgRepos"), '"v2"');
      const refreshed = await refreshScriptConnection(connection.id);

      expect(refreshed?.version).toBe(connection.version + 1);
      expect(refreshed?.openapiSpecEtag).toBe('"v2"');
      expect(refreshed?.generationError).toBeNull();
      expect(refreshed?.generatedTypes).toContain("listOrgRepos");
      const descriptor = getScriptApiConnectionDescriptors().find(
        (candidate) => candidate.slug === connection.slug,
      );
      expect(descriptor?.operations.some((operation) => operation.name === "listOrgRepos")).toBe(
        true,
      );
    } finally {
      server.stop();
    }
  });

  test("invalid fetched OpenAPI specs are stored with generation_error", async () => {
    const invalidSpec = JSON.stringify({
      openapi: "3.1.0",
      info: { title: "Invalid", version: "1.0.0" },
      paths: {},
    });
    const server = serveOpenapiSpec(invalidSpec);
    try {
      const suffix = crypto.randomUUID().replace(/-/g, "");
      const connection = await upsertScriptConnection({
        slug: `invalidVendor${suffix}`,
        kind: "openapi",
        baseUrl: server.baseUrl,
        openapiSpecUrl: server.url,
      });
      createdConnectionIds.push(connection.id);

      expect(connection.openapiSpecSourceKind).toBe("url");
      expect(connection.generationError).toContain("supported operations");
      expect(connection.generatedTypes).toBeNull();
    } finally {
      server.stop();
    }
  });

  test("invalid fetched spec content is rejected before storing a connection", async () => {
    const server = serveOpenapiSpec("{not-valid-json");
    try {
      const suffix = crypto.randomUUID().replace(/-/g, "");

      await expect(
        upsertScriptConnection({
          slug: `badContentVendor${suffix}`,
          kind: "openapi",
          baseUrl: server.baseUrl,
          openapiSpecUrl: server.url,
        }),
      ).rejects.toThrow(/valid JSON|valid YAML|JSON specs only/);

      const stored = getDb()
        .prepare<{ count: number }, [string]>(
          "SELECT COUNT(*) AS count FROM script_connections WHERE slug = ?",
        )
        .get(`badContentVendor${suffix}`);
      expect(stored?.count).toBe(0);
    } finally {
      server.stop();
    }
  });

  test("script-connections tool registers OpenAPI connections from an agent header without FK failures", async () => {
    const suffix = crypto.randomUUID().replace(/-/g, "");
    const slug = `agentHeaderVendor${suffix}`;
    const configKey = `AGENT_HEADER_VENDOR_KEY_${suffix}`;
    const lead = createAgent({
      name: `script-connections-lead-${crypto.randomUUID()}`,
      isLead: true,
      status: "idle",
    });
    const tool = scriptConnectionsTool();

    const result = (await tool.handler(
      {
        action: "upsert-openapi",
        slug,
        displayName: "Agent Header Vendor",
        baseUrl: "https://api.vendor.test",
        allowedHosts: ["api.vendor.test"],
        configKey,
        openapiSpecJson: openapiSpec,
      },
      meta(lead.id),
    )) as {
      structuredContent: { success: boolean; message: string; connections: Array<{ id: string }> };
    };

    expect(result.structuredContent.success).toBe(true);

    const db = getDb();
    const connectionRow = db
      .prepare<
        {
          id: string;
          credential_binding_id: string | null;
          created_by: string | null;
          updated_by: string | null;
        },
        [string]
      >(
        "SELECT id, credential_binding_id, created_by, updated_by FROM script_connections WHERE slug = ?",
      )
      .get(slug);
    expect(connectionRow).toBeDefined();
    expect(connectionRow?.created_by).toBeNull();
    expect(connectionRow?.updated_by).toBeNull();
    createdConnectionIds.push(connectionRow!.id);

    const bindingRow = db
      .prepare<{ id: string; created_by: string | null; updated_by: string | null }, [string]>(
        "SELECT id, created_by, updated_by FROM script_credential_bindings WHERE config_key = ?",
      )
      .get(configKey);
    expect(bindingRow).toBeDefined();
    expect(bindingRow?.id).toBe(connectionRow?.credential_binding_id);
    expect(bindingRow?.created_by).toBeNull();
    expect(bindingRow?.updated_by).toBeNull();
    createdBindingIds.push(bindingRow!.id);
  });

  test("script-connections tool can upsert OpenAPI connections by URL and refresh them", async () => {
    const server = serveOpenapiSpec(openapiSpec);
    try {
      const suffix = crypto.randomUUID().replace(/-/g, "");
      const slug = `toolUrlVendor${suffix}`;
      const lead = createAgent({
        name: `script-connections-tool-url-lead-${crypto.randomUUID()}`,
        isLead: true,
        status: "idle",
      });
      const tool = scriptConnectionsTool();

      const upsertResult = (await tool.handler(
        {
          action: "upsert-openapi",
          slug,
          displayName: "Tool URL Vendor",
          baseUrl: server.baseUrl,
          openapiSpecUrl: server.url,
        },
        meta(lead.id),
      )) as {
        structuredContent: { success: boolean; message: string };
      };

      expect(upsertResult.structuredContent.success).toBe(true);
      const row = getDb()
        .prepare<{ id: string }, [string]>("SELECT id FROM script_connections WHERE slug = ?")
        .get(slug);
      expect(row).toBeDefined();
      createdConnectionIds.push(row!.id);

      server.setBody(specWithExtraOperation("toolListOrgRepos"), '"v2"');
      const refreshResult = (await tool.handler(
        { action: "refresh", id: row!.id },
        meta(lead.id),
      )) as {
        structuredContent: { success: boolean; message: string };
      };

      expect(refreshResult.structuredContent.success).toBe(true);
      const refreshed = getDb()
        .prepare<{ openapi_spec_etag: string | null; generated_types: string | null }, [string]>(
          "SELECT openapi_spec_etag, generated_types FROM script_connections WHERE id = ?",
        )
        .get(row!.id);
      expect(refreshed?.openapi_spec_etag).toBe('"v2"');
      expect(refreshed?.generated_types).toContain("toolListOrgRepos");
    } finally {
      server.stop();
    }
  });

  test("ctx.api runtime emits plain fetch with credential placeholders", async () => {
    let observed: { url: string; authorization: string | null } | null = null;
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        observed = {
          url: req.url,
          authorization: req.headers.get("authorization"),
        };
        return Response.json({ full_name: "desplega-ai/agent-swarm", private: false });
      },
    });
    const binding = upsertCredentialBinding({
      configKey: "RUNTIME_VENDOR_KEY",
      allowedHosts: [`127.0.0.1:${server.port}`],
      headerTemplate: "Authorization: Bearer [REDACTED:RUNTIME_VENDOR_KEY]",
    });
    createdBindingIds.push(binding.id);
    const connection = await upsertScriptConnection({
      slug: "runtimeVendor",
      kind: "openapi",
      baseUrl: `http://127.0.0.1:${server.port}`,
      credentialBindingId: binding.id,
      openapiSpecJson: openapiSpec,
    });
    createdConnectionIds.push(connection.id);

    try {
      const output = await runScript({
        agentId: "agent-1",
        resources,
        apiConnections: getScriptApiConnectionDescriptors(),
        source: `
          export default async (_args, ctx) => {
            return await ctx.api.runtimeVendor.getRepo({
              path: { owner: "desplega-ai", repo: "agent-swarm" },
              query: { include: "stats" },
            });
          };
        `,
      });

      expect(output.error).toBeUndefined();
      expect(output.result).toEqual({ full_name: "desplega-ai/agent-swarm", private: false });
      expect(observed).toEqual({
        url: `http://127.0.0.1:${server.port}/repos/desplega-ai/agent-swarm?include=stats`,
        authorization: "Bearer [REDACTED:RUNTIME_VENDOR_KEY]",
      });
    } finally {
      server.stop(true);
    }
  });
});
