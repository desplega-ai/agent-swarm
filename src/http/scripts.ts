import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { resolveHttpAuditUserId } from "../be/audit-user";
import { getAgentById, recordInlineScriptRun, upsertKv } from "../be/db";
import { createEvent } from "../be/events";
import {
  getScriptApiConnectionDescriptors,
  getScriptApiTypes,
  getScriptMcpConnectionDescriptors,
  getScriptMcpTypes,
} from "../be/script-connections";
import { buildScriptCredentialBindingsWithFailures } from "../be/script-credential-broker";
import {
  createScriptApi,
  deleteScript,
  deleteScriptApi,
  getScript,
  getScriptApiById,
  getScriptApiSecret,
  getScriptById,
  listScriptApisForScript,
  listScripts,
  listScriptVersions,
  rotateScriptApiSecret,
  updateScriptApi,
  upsertScriptByName,
} from "../be/scripts/db";
import { searchScripts } from "../be/scripts/embeddings";
import { extractArgsJsonSchema } from "../be/scripts/extract-schema";
import {
  scriptSdkTypesWithGeneratedApis,
  scriptStdlibTypesWithGeneratedApis,
  typecheckScript,
} from "../be/scripts/typecheck";
import { can } from "../rbac";
import { extractScriptSignature } from "../scripts-runtime/extract-signature";
import { runScript } from "../scripts-runtime/loader";
import {
  ScriptApiAuthModeSchema,
  type ScriptDetail,
  ScriptFsModeSchema,
  type ScriptListItem,
  type ScriptRecord,
  type ScriptScope,
  ScriptScopeSchema,
} from "../types";
import { scrubObject, scrubSecrets } from "../utils/secret-scrubber";
import { route } from "./route-def";
import { json, jsonError } from "./utils";

const scriptNameSchema = z.string().min(1).max(200);

const upsertBodySchema = z.object({
  name: scriptNameSchema,
  source: z.string().min(1),
  description: z.string().default(""),
  intent: z.string().default(""),
  scope: ScriptScopeSchema.default("agent"),
  fsMode: ScriptFsModeSchema.default("none"),
});

const runBodySchema = z
  .object({
    name: scriptNameSchema.optional(),
    source: z.string().min(1).optional(),
    args: z.unknown().optional(),
    intent: z.string().default(""),
    scope: ScriptScopeSchema.optional(),
    fsMode: ScriptFsModeSchema.default("none"),
    idempotencyKey: z.string().max(200).optional(),
  })
  .refine((body) => Boolean(body.name) !== Boolean(body.source), {
    message: "Provide exactly one of name or source",
  });

const searchBodySchema = z.object({
  query: z.string().default(""),
  scope: ScriptScopeSchema.optional(),
  limit: z.number().int().min(1).max(100).default(10),
});

const nameParamsSchema = z.object({ name: scriptNameSchema });
const scopeQuerySchema = z.object({ scope: ScriptScopeSchema.default("agent") });
const optionalScopeQuerySchema = z.object({ scope: ScriptScopeSchema.optional() });
const idParamsSchema = z.object({ id: z.string().uuid() });
const listScriptsQuerySchema = z.object({
  scope: ScriptScopeSchema.optional(),
  includeScratch: z.enum(["true", "false"]).optional(),
});

const upsertRoute = route({
  method: "post",
  path: "/api/scripts/upsert",
  pattern: ["api", "scripts", "upsert"],
  operationId: "scripts_upsert",
  summary: "Create or update a reusable script",
  description: "Explicit script upserts run a TypeScript typecheck before writing.",
  tags: ["Scripts"],
  body: upsertBodySchema,
  responses: {
    200: { description: "Script upserted" },
    400: { description: "Validation or typecheck failure" },
    403: { description: "Global write requires lead agent" },
  },
  rbac: { permission: "script.global.write" },
});

const runRoute = route({
  method: "post",
  path: "/api/scripts/run",
  pattern: ["api", "scripts", "run"],
  operationId: "scripts_run",
  summary: "Run a reusable or inline script",
  description:
    "Inline source skips typecheck and is auto-saved as a scratch script only on success.",
  tags: ["Scripts"],
  body: runBodySchema,
  responses: {
    200: { description: "Script run completed" },
    400: { description: "Validation error" },
    404: { description: "Script not found" },
    501: { description: "workspace-rw scripts are not supported in v1" },
  },
});

const searchRoute = route({
  method: "post",
  path: "/api/scripts/search",
  pattern: ["api", "scripts", "search"],
  operationId: "scripts_search",
  summary: "Search reusable scripts",
  description: "Phase 3 search is substring-only over script name and metadata.",
  tags: ["Scripts"],
  body: searchBodySchema,
  responses: {
    200: { description: "Matching scripts" },
    400: { description: "Validation error" },
  },
  rbac: { permission: "script.search" },
});

const deleteRoute = route({
  method: "delete",
  path: "/api/scripts/{name}",
  pattern: ["api", "scripts", null],
  operationId: "scripts_delete",
  summary: "Delete a reusable script",
  tags: ["Scripts"],
  params: nameParamsSchema,
  query: scopeQuerySchema,
  responses: {
    200: { description: "Delete result" },
    400: { description: "Validation error" },
    403: { description: "Global delete requires lead agent" },
  },
  rbac: { permission: "script.global.delete" },
});

const typesRoute = route({
  method: "get",
  path: "/api/scripts/{name}/types",
  pattern: ["api", "scripts", null, "types"],
  operationId: "scripts_types",
  summary: "Get script signature and authoring types",
  tags: ["Scripts"],
  params: nameParamsSchema,
  query: optionalScopeQuerySchema,
  responses: {
    200: { description: "Script signature and type blobs" },
    404: { description: "Script not found" },
  },
});

// ── Dashboard read routes ──
// The worker-facing routes above resolve scripts relative to the calling agent
// and therefore requireAgent (X-Agent-ID). The routes below are cross-scope
// admin reads for the dashboard: API-key auth only, no agent identity — the
// same model as /api/script-runs.

const listScriptsRoute = route({
  method: "get",
  path: "/api/scripts",
  pattern: ["api", "scripts"],
  operationId: "scripts_list",
  summary: "List saved scripts",
  description:
    "Dashboard read: lean projection without source. Scratch scripts are excluded unless includeScratch=true.",
  tags: ["Scripts"],
  query: listScriptsQuerySchema,
  responses: {
    200: { description: "Saved scripts" },
    400: { description: "Validation error" },
  },
});

// Declared (and matched) BEFORE the by-id route: the by-id pattern
// ["api", "scripts", null] matches any single segment, so the literal
// "type-defs" segment must win first.
const typeDefsRoute = route({
  method: "get",
  path: "/api/scripts/type-defs",
  pattern: ["api", "scripts", "type-defs"],
  operationId: "scripts_type_defs",
  summary: "Get script SDK and stdlib type definitions",
  description: "Static .d.ts blobs for editor integration (e.g. Monaco extraLibs). Cacheable.",
  tags: ["Scripts"],
  responses: {
    200: { description: "SDK and stdlib type definition blobs" },
  },
});

const getScriptByIdRoute = route({
  method: "get",
  path: "/api/scripts/{id}",
  pattern: ["api", "scripts", null],
  operationId: "scripts_get",
  summary: "Get a saved script by id",
  description: "Dashboard read: full record including source and parsed signature.",
  tags: ["Scripts"],
  params: idParamsSchema,
  responses: {
    200: { description: "Script detail" },
    404: { description: "Script not found" },
  },
});

const listVersionsRoute = route({
  method: "get",
  path: "/api/scripts/{id}/versions",
  pattern: ["api", "scripts", null, "versions"],
  operationId: "scripts_versions",
  summary: "List versions of a saved script",
  description: "Dashboard read: version history, newest first.",
  tags: ["Scripts"],
  params: idParamsSchema,
  responses: {
    200: { description: "Script versions" },
    404: { description: "Script not found" },
  },
});

// ─── External API endpoint management (script_apis) ──────────────────────────
// These authenticated dashboard routes create/manage the public endpoints that
// `POST /api/x/script/<id>` (src/http/x.ts) serves.

const apiEndpointParamsSchema = z.object({
  id: z.string().uuid(),
  endpointId: z.string(),
});

const createScriptApiBodySchema = z.object({
  authMode: ScriptApiAuthModeSchema.default("bearer"),
  label: z.string().max(200).optional(),
  agentId: z.string().optional(),
});

const patchScriptApiBodySchema = z.object({
  enabled: z.boolean().optional(),
  label: z.string().max(200).nullable().optional(),
});

const createScriptApiRoute = route({
  method: "post",
  path: "/api/scripts/{id}/apis",
  pattern: ["api", "scripts", null, "apis"],
  operationId: "scripts_api_create",
  summary: "Expose a script as an external HTTP API endpoint",
  description: "Returns the endpoint plus the plaintext bearer token (when authMode is 'bearer').",
  tags: ["Scripts"],
  params: idParamsSchema,
  body: createScriptApiBodySchema,
  responses: {
    201: { description: "Endpoint created" },
    400: { description: "Validation error or script has no owning agent" },
    404: { description: "Script not found" },
  },
  rbac: { permission: "script.api.create" },
});

const listScriptApisRoute = route({
  method: "get",
  path: "/api/scripts/{id}/apis",
  pattern: ["api", "scripts", null, "apis"],
  operationId: "scripts_api_list",
  summary: "List external API endpoints for a script",
  tags: ["Scripts"],
  params: idParamsSchema,
  responses: {
    200: { description: "Endpoints (without secrets)" },
    404: { description: "Script not found" },
  },
});

const revealScriptApiSecretRoute = route({
  method: "get",
  path: "/api/scripts/{id}/apis/{endpointId}/secret",
  pattern: ["api", "scripts", null, "apis", null, "secret"],
  operationId: "scripts_api_reveal_secret",
  summary: "Reveal an endpoint's bearer token",
  tags: ["Scripts"],
  params: apiEndpointParamsSchema,
  responses: {
    200: { description: "Decrypted token (null when authMode is 'none')" },
    404: { description: "Endpoint not found" },
  },
  rbac: { permission: "script.api.read.secrets" },
});

const patchScriptApiRoute = route({
  method: "patch",
  path: "/api/scripts/{id}/apis/{endpointId}",
  pattern: ["api", "scripts", null, "apis", null],
  operationId: "scripts_api_update",
  summary: "Enable/disable or relabel an external API endpoint",
  tags: ["Scripts"],
  params: apiEndpointParamsSchema,
  body: patchScriptApiBodySchema,
  responses: {
    200: { description: "Updated endpoint" },
    404: { description: "Endpoint not found" },
  },
  rbac: { permission: "script.api.update" },
});

const rotateScriptApiRoute = route({
  method: "post",
  path: "/api/scripts/{id}/apis/{endpointId}/rotate",
  pattern: ["api", "scripts", null, "apis", null, "rotate"],
  operationId: "scripts_api_rotate",
  summary: "Rotate an endpoint's bearer token",
  tags: ["Scripts"],
  params: apiEndpointParamsSchema,
  responses: {
    200: { description: "Endpoint with new plaintext token" },
    400: { description: "Endpoint uses 'none' auth — nothing to rotate" },
    404: { description: "Endpoint not found" },
  },
  rbac: { permission: "script.api.rotate" },
});

const deleteScriptApiRoute = route({
  method: "delete",
  path: "/api/scripts/{id}/apis/{endpointId}",
  pattern: ["api", "scripts", null, "apis", null],
  operationId: "scripts_api_delete",
  summary: "Delete an external API endpoint",
  tags: ["Scripts"],
  params: apiEndpointParamsSchema,
  responses: {
    200: { description: "Deleted" },
    404: { description: "Endpoint not found" },
  },
  rbac: { permission: "script.api.delete" },
});

function requireAgent(res: ServerResponse, agentId: string | undefined) {
  if (!agentId) {
    jsonError(res, "X-Agent-ID required for scripts API", 400);
    return null;
  }
  const agent = getAgentById(agentId);
  if (!agent) {
    jsonError(res, "Agent not found", 404);
    return null;
  }
  return agent;
}

function signatureJsonFor(source: string): string {
  return JSON.stringify(extractScriptSignature(source));
}

function resolveScript(name: string, agentId: string, scope?: ScriptScope): ScriptRecord | null {
  if (scope === "global") return getScript({ name, scope: "global" });
  if (scope === "agent") return getScript({ name, scope: "agent", scopeId: agentId });
  return (
    getScript({ name, scope: "agent", scopeId: agentId }) ?? getScript({ name, scope: "global" })
  );
}

function scratchSlug(intent: string, source: string): string {
  const base = (intent || "inline-script")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const hash = new Bun.CryptoHasher("sha256").update(source).digest("hex").slice(0, 8);
  return `scratch-${base || "inline-script"}-${hash}`;
}

function emitGlobalUpsertEvent(args: {
  agentId: string;
  script: ScriptRecord;
  isNew: boolean;
  isPromotion: boolean;
}) {
  createEvent({
    category: "system",
    event: "script.global_upsert",
    source: "api",
    agentId: args.agentId,
    data: {
      scriptId: args.script.id,
      name: args.script.name,
      version: args.script.version,
      contentHash: args.script.contentHash,
      changedByAgentId: args.agentId,
      isNew: args.isNew,
      isPromotion: args.isPromotion,
    },
  });
}

export async function handleScripts(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
  agentId: string | undefined,
): Promise<boolean> {
  if (upsertRoute.match(req.method, pathSegments)) {
    const parsed = await upsertRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const agent = requireAgent(res, agentId);
    if (!agent) return true;

    // Global-scope writes require lead — the 403 this route has always
    // documented, enforced since DES-445 slice 1. Agent-scope ops unchanged.
    if (parsed.body.scope === "global") {
      const decision = can({
        principal: { kind: "agent", agentId: agent.id, isLead: agent.isLead },
        verb: "script.global.write",
        resource: { kind: "owned", scope: "global" },
        source: "http",
      });
      if (!decision.allow) {
        jsonError(res, "Global write requires lead agent", 403);
        return true;
      }
    }

    const typecheck = typecheckScript(parsed.body.source, { agentId: agent.id });
    if (!typecheck.ok) {
      json(
        res,
        {
          error: "typecheck_failed",
          diagnostics: typecheck.diagnostics,
          structured: typecheck.structured,
        },
        400,
      );
      return true;
    }

    const createdBy = resolveHttpAuditUserId(req, agent.id);

    const existingAgentScript =
      parsed.body.scope === "global"
        ? getScript({ name: parsed.body.name, scope: "agent", scopeId: agent.id })
        : null;
    const argsJsonSchema = await extractArgsJsonSchema(parsed.body.source);
    const result = await upsertScriptByName({
      name: parsed.body.name,
      scope: parsed.body.scope,
      scopeId: parsed.body.scope === "agent" ? agent.id : null,
      source: parsed.body.source,
      description: parsed.body.description,
      intent: parsed.body.intent,
      signatureJson: signatureJsonFor(parsed.body.source),
      argsJsonSchema,
      fsMode: parsed.body.fsMode,
      agentId: agent.id,
      isScratch: false,
      typeChecked: true,
      createdBy,
    });

    if (parsed.body.scope === "global" && !result.contentDeduped) {
      emitGlobalUpsertEvent({
        agentId: agent.id,
        script: result.script,
        isNew: result.isNew,
        isPromotion: Boolean(existingAgentScript),
      });
    }

    json(res, {
      name: result.script.name,
      version: result.script.version,
      contentDeduped: result.contentDeduped,
    });
    return true;
  }

  if (runRoute.match(req.method, pathSegments)) {
    const parsed = await runRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const agent = requireAgent(res, agentId);
    if (!agent) return true;

    let source = parsed.body.source;
    let fsMode = parsed.body.fsMode;
    if (parsed.body.name) {
      const script = resolveScript(parsed.body.name, agent.id, parsed.body.scope);
      if (!script) {
        jsonError(res, "Script not found", 404);
        return true;
      }
      source = script.source;
      fsMode = script.fsMode;
    }

    if (fsMode === "workspace-rw") {
      jsonError(res, "workspace-rw scripts are not supported by /api/scripts/run in v1", 501);
      return true;
    }

    const startedAt = new Date().toISOString();
    const credentials = await buildScriptCredentialBindingsWithFailures({ agentId: agent.id });
    const output = await runScript({
      source: source as string,
      args: parsed.body.args,
      fsMode,
      agentId: agent.id,
      egressSecrets: credentials.egressSecrets,
      failedBindings: credentials.failedBindings,
      apiConnections: getScriptApiConnectionDescriptors({ agentId: agent.id }),
      mcpConnections: getScriptMcpConnectionDescriptors({ agentId: agent.id }),
    });

    // Persist output to KV when idempotencyKey is provided and run succeeded
    let kvSaved: { namespace: string; key: string } | undefined;
    if (parsed.body.idempotencyKey && !output.error && output.exitCode === 0) {
      const kvNamespace = `script:executions`;
      const kvKey = parsed.body.idempotencyKey;
      const kvValue = {
        result: output.result,
        durationMs: output.durationMs,
        scriptName: parsed.body.name ?? null,
        executedAt: new Date().toISOString(),
      };
      upsertKv({
        namespace: kvNamespace,
        key: kvKey,
        value: kvValue,
        valueType: "json",
        expiresAt: null,
      });
      kvSaved = { namespace: kvNamespace, key: kvKey };
    }

    let autoSaved: { slug: string; reason: string } | undefined;
    if (parsed.body.source && !output.error && output.exitCode === 0) {
      const slug = scratchSlug(parsed.body.intent, parsed.body.source);
      await upsertScriptByName({
        name: slug,
        scope: "agent",
        scopeId: agent.id,
        source: parsed.body.source,
        description: `Scratch script: ${parsed.body.intent || slug}`,
        intent: parsed.body.intent || "Inline script auto-saved after successful run",
        signatureJson: signatureJsonFor(parsed.body.source),
        fsMode: "none",
        agentId: agent.id,
        isScratch: true,
        typeChecked: false,
        changeReason: "Auto-saved successful inline run",
      });
      autoSaved = { slug, reason: "successful_inline_run" };
    }

    // Persist the inline run (no journal) so one-off executions show up alongside
    // durable workflow runs in the Script Runs dashboard. Best-effort: recording
    // must never fail the actual execution.
    const ok = output.exitCode === 0 && !output.error && !output.runtimeError;
    const runError = ok
      ? undefined
      : scrubSecrets(
          [
            output.error,
            output.runtimeError
              ? `${output.runtimeError.name}: ${output.runtimeError.message}`
              : undefined,
          ]
            .filter(Boolean)
            .join(" — ") || `Script exited with code ${output.exitCode}`,
        );
    try {
      recordInlineScriptRun({
        id: crypto.randomUUID(),
        agentId: agent.id,
        source: source as string,
        // Scrub args + result before persisting: the stored row is later served
        // raw by GET /api/script-runs/{id} to the dashboard, so it needs the same
        // redaction guarantees as the scrubbed run response below.
        args: scrubObject(parsed.body.args ?? null),
        scriptName: parsed.body.name,
        status: ok ? "completed" : "failed",
        output: scrubObject(output.result),
        error: runError,
        startedAt,
        finishedAt: new Date().toISOString(),
      });
    } catch {
      // swallow — the run already executed; persistence is observability only.
    }

    json(
      res,
      scrubObject({
        result: output.result,
        autoSaved,
        kvSaved,
        truncated: output.truncated,
        durationMs: output.durationMs,
        stdout: output.stdout,
        stderr: output.stderr,
        exitCode: output.exitCode,
        error: output.error,
        runtimeError: output.runtimeError,
      }),
    );
    return true;
  }

  if (searchRoute.match(req.method, pathSegments)) {
    const parsed = await searchRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const agent = requireAgent(res, agentId);
    if (!agent) return true;

    const matches = await searchScripts({
      query: parsed.body.query,
      scope: parsed.body.scope,
      scopeId: agent.id,
      limit: parsed.body.limit,
    });

    json(res, {
      results: matches.map(({ script, score }) => ({
        name: script.name,
        signature: JSON.parse(script.signatureJson),
        argsJsonSchema: script.argsJsonSchema
          ? (JSON.parse(script.argsJsonSchema) as unknown)
          : null,
        description: script.description,
        score,
      })),
    });
    return true;
  }

  // ── Dashboard reads (no requireAgent — API-key auth only, like /api/script-runs) ──

  if (listScriptsRoute.match(req.method, pathSegments)) {
    const parsed = await listScriptsRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const scripts: ScriptListItem[] = listScripts({
      scope: parsed.query.scope,
      includeScratch: parsed.query.includeScratch === "true",
    }).map((script) => ({
      id: script.id,
      name: script.name,
      scope: script.scope,
      scopeId: script.scopeId,
      description: script.description,
      intent: script.intent,
      version: script.version,
      isScratch: script.isScratch,
      typeChecked: script.typeChecked,
      fsMode: script.fsMode,
      createdByAgentId: script.createdByAgentId,
      createdAt: script.createdAt,
      updatedAt: script.updatedAt,
    }));
    json(res, { scripts });
    return true;
  }

  // Must be matched before getScriptByIdRoute — its ["api", "scripts", null]
  // pattern would otherwise swallow the literal "type-defs" segment.
  if (typeDefsRoute.match(req.method, pathSegments)) {
    const apiTypes = getScriptApiTypes();
    const mcpTypes = getScriptMcpTypes();
    json(res, {
      sdkTypes: scriptSdkTypesWithGeneratedApis(apiTypes, mcpTypes),
      stdlibTypes: scriptStdlibTypesWithGeneratedApis(apiTypes, mcpTypes),
    });
    return true;
  }

  if (getScriptByIdRoute.match(req.method, pathSegments)) {
    const parsed = await getScriptByIdRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const script = getScriptById(parsed.params.id);
    if (!script) {
      jsonError(res, "Script not found", 404);
      return true;
    }
    // `source` is author-supplied TS (same trust surface as script_runs.source,
    // already served raw by GET /api/script-runs/{id}) — no env/secret material.
    const detail: ScriptDetail = {
      ...script,
      signature: JSON.parse(script.signatureJson) as unknown,
      argsJsonSchema: script.argsJsonSchema ? (JSON.parse(script.argsJsonSchema) as unknown) : null,
    };
    json(res, { script: detail });
    return true;
  }

  if (listVersionsRoute.match(req.method, pathSegments)) {
    const parsed = await listVersionsRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!getScriptById(parsed.params.id)) {
      jsonError(res, "Script not found", 404);
      return true;
    }
    json(res, { versions: listScriptVersions(parsed.params.id) });
    return true;
  }

  if (typesRoute.match(req.method, pathSegments)) {
    const parsed = await typesRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const agent = requireAgent(res, agentId);
    if (!agent) return true;

    const script = resolveScript(parsed.params.name, agent.id, parsed.query.scope);
    if (!script) {
      jsonError(res, "Script not found", 404);
      return true;
    }
    json(res, {
      signature: JSON.parse(script.signatureJson),
      argsJsonSchema: script.argsJsonSchema ? (JSON.parse(script.argsJsonSchema) as unknown) : null,
      sdkTypes: scriptSdkTypesWithGeneratedApis(
        getScriptApiTypes({ agentId: agent.id }),
        getScriptMcpTypes({ agentId: agent.id }),
      ),
      stdlibTypes: scriptStdlibTypesWithGeneratedApis(
        getScriptApiTypes({ agentId: agent.id }),
        getScriptMcpTypes({ agentId: agent.id }),
      ),
    });
    return true;
  }

  if (deleteRoute.match(req.method, pathSegments)) {
    const parsed = await deleteRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const agent = requireAgent(res, agentId);
    if (!agent) return true;

    // Global-scope deletes require lead — the 403 this route has always
    // documented, enforced since DES-445 slice 1. Agent-scope ops unchanged.
    if (parsed.query.scope === "global") {
      const decision = can({
        principal: { kind: "agent", agentId: agent.id, isLead: agent.isLead },
        verb: "script.global.delete",
        resource: { kind: "owned", scope: "global" },
        source: "http",
      });
      if (!decision.allow) {
        jsonError(res, "Global delete requires lead agent", 403);
        return true;
      }
    }

    const deleted = deleteScript({
      name: parsed.params.name,
      scope: parsed.query.scope,
      scopeId: parsed.query.scope === "agent" ? agent.id : null,
    });
    json(res, { deleted });
    return true;
  }

  // ── External API endpoint management (script_apis) ──
  if (createScriptApiRoute.match(req.method, pathSegments)) {
    const parsed = await createScriptApiRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const script = getScriptById(parsed.params.id);
    if (!script) {
      jsonError(res, "Script not found", 404);
      return true;
    }
    // Run external calls as the script's owning agent (so its egress secrets +
    // API connections resolve). Global scripts with no owner must name one.
    const runAsAgentId = parsed.body.agentId ?? script.scopeId ?? script.createdByAgentId;
    if (!runAsAgentId) {
      jsonError(res, "agentId is required: this script has no owning agent to run as", 400);
      return true;
    }
    const endpoint = createScriptApi({
      scriptId: script.id,
      agentId: runAsAgentId,
      authMode: parsed.body.authMode,
      label: parsed.body.label ?? null,
      createdBy: resolveHttpAuditUserId(req, agentId),
    });
    json(res, endpoint, 201);
    return true;
  }

  if (listScriptApisRoute.match(req.method, pathSegments)) {
    const parsed = await listScriptApisRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!getScriptById(parsed.params.id)) {
      jsonError(res, "Script not found", 404);
      return true;
    }
    json(res, { apis: listScriptApisForScript(parsed.params.id) });
    return true;
  }

  if (revealScriptApiSecretRoute.match(req.method, pathSegments)) {
    const parsed = await revealScriptApiSecretRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const endpoint = getScriptApiById(parsed.params.endpointId);
    if (!endpoint || endpoint.scriptId !== parsed.params.id) {
      jsonError(res, "Endpoint not found", 404);
      return true;
    }
    json(res, { token: getScriptApiSecret(endpoint.id) });
    return true;
  }

  if (rotateScriptApiRoute.match(req.method, pathSegments)) {
    const parsed = await rotateScriptApiRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const endpoint = getScriptApiById(parsed.params.endpointId);
    if (!endpoint || endpoint.scriptId !== parsed.params.id) {
      jsonError(res, "Endpoint not found", 404);
      return true;
    }
    const rotated = rotateScriptApiSecret(endpoint.id, resolveHttpAuditUserId(req, agentId));
    if (!rotated) {
      jsonError(res, "Cannot rotate a token on a 'none' auth endpoint", 400);
      return true;
    }
    json(res, rotated);
    return true;
  }

  if (patchScriptApiRoute.match(req.method, pathSegments)) {
    const parsed = await patchScriptApiRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const endpoint = getScriptApiById(parsed.params.endpointId);
    if (!endpoint || endpoint.scriptId !== parsed.params.id) {
      jsonError(res, "Endpoint not found", 404);
      return true;
    }
    const updated = updateScriptApi(endpoint.id, {
      enabled: parsed.body.enabled,
      label: parsed.body.label,
      updatedBy: resolveHttpAuditUserId(req, agentId),
    });
    json(res, updated);
    return true;
  }

  if (deleteScriptApiRoute.match(req.method, pathSegments)) {
    const parsed = await deleteScriptApiRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const endpoint = getScriptApiById(parsed.params.endpointId);
    if (!endpoint || endpoint.scriptId !== parsed.params.id) {
      jsonError(res, "Endpoint not found", 404);
      return true;
    }
    json(res, { deleted: deleteScriptApi(endpoint.id) });
    return true;
  }

  return false;
}
