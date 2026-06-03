import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { getAgentById, upsertKv } from "../be/db";
import { createEvent } from "../be/events";
import { deleteScript, getScript, upsertScriptByName } from "../be/scripts/db";
import { searchScripts } from "../be/scripts/embeddings";
import { extractArgsJsonSchema } from "../be/scripts/extract-schema";
import { SCRIPT_SDK_TYPES, SCRIPT_STDLIB_TYPES, typecheckScript } from "../be/scripts/typecheck";
import { extractScriptSignature } from "../scripts-runtime/extract-signature";
import { runScript } from "../scripts-runtime/loader";
import {
  ScriptFsModeSchema,
  type ScriptRecord,
  type ScriptScope,
  ScriptScopeSchema,
} from "../types";
import { scrubObject } from "../utils/secret-scrubber";
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

    if (parsed.body.scope === "global" && !agent.isLead) {
      jsonError(res, "Global scripts require a lead agent", 403);
      return true;
    }

    const typecheck = typecheckScript(parsed.body.source);
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

    const output = await runScript({
      source: source as string,
      args: parsed.body.args,
      fsMode,
      agentId: agent.id,
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
      sdkTypes: SCRIPT_SDK_TYPES,
      stdlibTypes: SCRIPT_STDLIB_TYPES,
    });
    return true;
  }

  if (deleteRoute.match(req.method, pathSegments)) {
    const parsed = await deleteRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const agent = requireAgent(res, agentId);
    if (!agent) return true;

    if (parsed.query.scope === "global" && !agent.isLead) {
      jsonError(res, "Global scripts require a lead agent", 403);
      return true;
    }

    const deleted = deleteScript({
      name: parsed.params.name,
      scope: parsed.query.scope,
      scopeId: parsed.query.scope === "agent" ? agent.id : null,
    });
    json(res, { deleted });
    return true;
  }

  return false;
}
