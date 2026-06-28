import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { deleteSwarmConfig, getDb, upsertSwarmConfig } from "../be/db";
import {
  getScriptApiConnectionDescriptors,
  upsertCredentialBinding,
  upsertScriptConnection,
} from "../be/script-connections";
import { buildScriptCredentialBindings } from "../be/script-credential-broker";
import { typecheckScript } from "../be/scripts/typecheck";
import { runScript } from "../scripts-runtime/loader";

const createdBindingIds: string[] = [];
const createdConnectionIds: string[] = [];
const createdConfigIds: string[] = [];
const originalFetch = globalThis.fetch;
const savedEnv = { ...process.env };
const resources = { memoryMb: 2048, cpuTimeSec: 20, maxStdoutBytes: 1_048_576 };

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

  test("OpenAPI connections generate full ctx.api method, args, and response types", () => {
    const binding = upsertCredentialBinding({
      configKey: "TYPE_VENDOR_KEY",
      allowedHosts: ["api.vendor.test"],
      headerTemplate: "Authorization: Bearer [REDACTED:TYPE_VENDOR_KEY]",
    });
    createdBindingIds.push(binding.id);
    const connection = upsertScriptConnection({
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
    const connection = upsertScriptConnection({
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
