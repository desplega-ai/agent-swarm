import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { resolveHttpAuditUserId } from "../be/audit-user";
import { getAgentById } from "../be/db";
import {
  deleteExtension,
  ExtensionOwnershipError,
  getExtensionById,
  getExtensionByName,
  getExtensionFiles,
  type InstallExtensionResult,
  installExtension,
  listExtensionRuns,
  listExtensions,
  listExtensionVersions,
  updateExtensionMeta,
} from "../be/extensions/db";
import { validateBundle } from "../be/extensions/validate";
import { EXTENSION_TYPE_DEFINITIONS } from "../extensions/contract-types.generated";
import {
  activateVersion,
  disableExtension,
  ExtensionLifecycleError,
  enableExtension,
  reloadExtension,
} from "../extensions/lifecycle";
import { ExtensionConfigError } from "../extensions/loader";
import {
  can,
  LEGACY_RULES,
  type PermissionVerb,
  type RbacPrincipal,
  type RbacResource,
} from "../rbac";
import {
  type Extension,
  ExtensionInstallBodySchema,
  ExtensionManifestSchema,
  ExtensionRunSchema,
  ExtensionSchema,
  ExtensionVersionSchema,
} from "../types";
import { getRequestAuth } from "../utils/request-auth-context";
import { scrubSecrets } from "../utils/secret-scrubber";
import { route } from "./route-def";
import { json, jsonError } from "./utils";

const idParamsSchema = z.object({ id: z.string().min(1) });

const installRoute = route({
  method: "post",
  path: "/api/extensions/install",
  pattern: ["api", "extensions", "install"],
  operationId: "extensions_install",
  summary: "Validate and install an extension bundle",
  description:
    "Any authenticated agent can install a disabled draft owned by its agent ID. Workers can update only their own bundles; activation remains lead/operator-only.",
  tags: ["Extensions"],
  body: ExtensionInstallBodySchema,
  responses: {
    200: {
      description: "Installed extension",
      schema: z.object({
        extension: ExtensionSchema,
        manifest: ExtensionManifestSchema,
        contentDeduped: z.boolean(),
      }),
    },
    400: { description: "Bundle validation failed" },
    403: { description: "Permission denied" },
  },
  rbac: { permission: "extension.write" },
});

const listRoute = route({
  method: "get",
  path: "/api/extensions",
  pattern: ["api", "extensions"],
  operationId: "extensions_list",
  summary: "List installed extensions",
  tags: ["Extensions"],
  responses: {
    200: {
      description: "Installed extensions",
      schema: z.object({ extensions: z.array(ExtensionSchema) }),
    },
  },
});

const typeDefsRoute = route({
  method: "get",
  path: "/api/extensions/type-defs",
  pattern: ["api", "extensions", "type-defs"],
  operationId: "extensions_type_defs",
  summary: "Get extension authoring type definitions",
  tags: ["Extensions"],
  responses: {
    200: {
      description: "Generated swarm-extension.d.ts",
      unstructured: "Plain TypeScript declaration text",
    },
  },
});

const getRoute = route({
  method: "get",
  path: "/api/extensions/{id}",
  pattern: ["api", "extensions", null],
  operationId: "extensions_get",
  summary: "Get an extension bundle",
  tags: ["Extensions"],
  params: idParamsSchema,
  responses: {
    200: {
      description: "Extension bundle",
      schema: z.object({
        extension: ExtensionSchema,
        manifest: ExtensionManifestSchema,
        files: z.record(z.string(), z.string()),
      }),
    },
    404: { description: "Extension not found" },
  },
});

const versionsRoute = route({
  method: "get",
  path: "/api/extensions/{id}/versions",
  pattern: ["api", "extensions", null, "versions"],
  operationId: "extensions_versions",
  summary: "List extension versions",
  tags: ["Extensions"],
  params: idParamsSchema,
  responses: {
    200: {
      description: "Extension versions",
      schema: z.object({ versions: z.array(ExtensionVersionSchema) }),
    },
    404: { description: "Extension not found" },
  },
});

const runsRoute = route({
  method: "get",
  path: "/api/extensions/{id}/runs",
  pattern: ["api", "extensions", null, "runs"],
  operationId: "extensions_runs",
  summary: "List extension run log entries",
  tags: ["Extensions"],
  params: idParamsSchema,
  query: z.object({ limit: z.coerce.number().int().min(1).max(500).optional() }),
  responses: {
    200: {
      description: "Extension run log",
      schema: z.object({ runs: z.array(ExtensionRunSchema) }),
    },
    404: { description: "Extension not found" },
  },
});

const patchRoute = route({
  method: "patch",
  path: "/api/extensions/{id}",
  pattern: ["api", "extensions", null],
  operationId: "extensions_update",
  summary: "Update extension priority, config, or description",
  description:
    "Workers may edit their own disabled extensions. Leads, operators, and dashboard users retain access to all extensions.",
  tags: ["Extensions"],
  params: idParamsSchema,
  body: z
    .object({
      priority: z.number().int().optional(),
      config: z.record(z.string(), z.unknown()).optional(),
      description: z.string().optional(),
    })
    .strict(),
  responses: {
    200: { description: "Updated extension", schema: z.object({ extension: ExtensionSchema }) },
    400: { description: "Extension config validation failed" },
    403: { description: "Permission denied" },
    404: { description: "Extension not found" },
  },
  rbac: { permission: "extension.write" },
});

const deleteRoute = route({
  method: "delete",
  path: "/api/extensions/{id}",
  pattern: ["api", "extensions", null],
  operationId: "extensions_delete",
  summary: "Uninstall a disabled extension",
  description:
    "Workers may uninstall their own disabled extensions. Leads, operators, and dashboard users retain access to all extensions.",
  tags: ["Extensions"],
  params: idParamsSchema,
  responses: {
    200: {
      description: "Extension uninstalled",
      schema: z.object({ deleted: z.literal(true) }),
    },
    403: { description: "Permission denied" },
    404: { description: "Extension not found" },
    409: { description: "Enabled extensions cannot be uninstalled" },
  },
  rbac: { permission: "extension.write" },
});

const enableRoute = route({
  method: "post",
  path: "/api/extensions/{id}/enable",
  pattern: ["api", "extensions", null, "enable"],
  operationId: "extensions_enable",
  summary: "Enable an extension",
  description:
    "Loads and enables an extension. Available to leads, operators, and dashboard users.",
  tags: ["Extensions"],
  params: idParamsSchema,
  responses: {
    200: { description: "Enabled extension", schema: z.object({ extension: ExtensionSchema }) },
    400: { description: "Extension load or config validation failed" },
    403: { description: "Permission denied" },
    404: { description: "Extension not found" },
  },
  rbac: { permission: "extension.activate" },
});

const disableRoute = route({
  method: "post",
  path: "/api/extensions/{id}/disable",
  pattern: ["api", "extensions", null, "disable"],
  operationId: "extensions_disable",
  summary: "Disable an extension",
  description:
    "Unloads and disables an extension. Available to leads, operators, and dashboard users.",
  tags: ["Extensions"],
  params: idParamsSchema,
  responses: {
    200: { description: "Disabled extension", schema: z.object({ extension: ExtensionSchema }) },
    403: { description: "Permission denied" },
    404: { description: "Extension not found" },
  },
  rbac: { permission: "extension.activate" },
});

const activateVersionRoute = route({
  method: "post",
  path: "/api/extensions/{id}/activate-version",
  pattern: ["api", "extensions", null, "activate-version"],
  operationId: "extensions_activate_version",
  summary: "Activate an extension version",
  description: "Activates a stored version. Available to leads, operators, and dashboard users.",
  tags: ["Extensions"],
  params: idParamsSchema,
  body: z.object({ version: z.number().int().min(1) }).strict(),
  responses: {
    200: { description: "Activated extension", schema: z.object({ extension: ExtensionSchema }) },
    400: { description: "Extension load or config validation failed" },
    403: { description: "Permission denied" },
    404: { description: "Extension or version not found" },
  },
  rbac: { permission: "extension.activate" },
});

/** Operator-supplied config may carry tokens; scrub before it leaves the API. */
function redactExtension<T extends { configJson: string }>(extension: T): T {
  return { ...extension, configJson: scrubSecrets(extension.configJson) };
}

// Matches every marker shape `scrubSecrets` emits: env-key names (`EXT_TOKEN`) and
// structural pattern names (`github_token`, `sk-ant`).
const REDACTED_CONFIG_VALUE = /^\[REDACTED:[A-Za-z0-9_.:-]+\]$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Walk `incoming` alongside `stored`; wherever the operator submitted an unchanged
 * redaction placeholder, restore the stored value at that path (objects and arrays
 * are recursed so nested secrets survive a dashboard round trip).
 */
function restoreRedacted(incoming: unknown, stored: unknown): unknown {
  if (typeof incoming === "string") {
    return REDACTED_CONFIG_VALUE.test(incoming) && stored !== undefined ? stored : incoming;
  }
  if (Array.isArray(incoming)) {
    const storedArray = Array.isArray(stored) ? stored : [];
    return incoming.map((item, index) => restoreRedacted(item, storedArray[index]));
  }
  if (isPlainObject(incoming)) {
    const storedObject = isPlainObject(stored) ? stored : {};
    return Object.fromEntries(
      Object.entries(incoming).map(([key, value]) => [
        key,
        restoreRedacted(value, storedObject[key]),
      ]),
    );
  }
  return incoming;
}

function preserveRedactedConfigValues(
  incoming: Record<string, unknown>,
  storedJson: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(storedJson);
  } catch {
    parsed = {};
  }
  return restoreRedacted(incoming, parsed) as Record<string, unknown>;
}

/**
 * Prefer the supplied X-Agent-ID even when the request carries the shared API key.
 * This prevents agents from using that key to bypass the route's declared RBAC permission.
 */
async function extensionPrincipal(
  req: IncomingMessage,
  callerAgentId: string | undefined,
): Promise<RbacPrincipal> {
  if (callerAgentId) {
    const agent = await getAgentById(callerAgentId);
    return { kind: "agent", agentId: callerAgentId, isLead: agent?.isLead ?? false };
  }
  const auth = getRequestAuth(req);
  if (auth?.kind === "operator") return { kind: "operator" };
  if (auth?.kind === "user") return { kind: "user", userId: auth.userId };
  return { kind: "agent", agentId: "", isLead: false };
}

/** Restrict ordinary agents; retain the existing blanket access for elevated writers. */
function ownerOnlyAgentId(principal: RbacPrincipal): string | undefined {
  return principal.kind === "agent" &&
    !LEGACY_RULES["lead-or-operator-or-user"].evaluate(principal, undefined)
    ? principal.agentId
    : undefined;
}

async function requirePermission(
  req: IncomingMessage,
  res: ServerResponse,
  callerAgentId: string | undefined,
  verb: Extract<PermissionVerb, "extension.write" | "extension.activate">,
  resource: RbacResource = { kind: "none" },
): Promise<RbacPrincipal | null> {
  const principal = await extensionPrincipal(req, callerAgentId);
  const decision = can({ principal, verb, resource, source: "http" });
  if (decision.allow) return principal;
  jsonError(res, `Forbidden: ${decision.reason}`, 403);
  return null;
}

function respondLifecycleError(res: ServerResponse, error: unknown): void {
  const status =
    error instanceof ExtensionOwnershipError
      ? 403
      : error instanceof ExtensionConfigError
        ? 400
        : error instanceof ExtensionLifecycleError
          ? error.status
          : 500;
  jsonError(res, scrubSecrets(error instanceof Error ? error.message : String(error)), status);
}

export async function handleExtensions(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
  agentId?: string,
): Promise<boolean> {
  if (installRoute.match(req.method, pathSegments)) {
    const parsed = await installRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const existing = await getExtensionByName(parsed.body.manifest.name);
    const principal = await requirePermission(req, res, agentId, "extension.write", {
      kind: "extension",
      extensionId: existing?.id,
      createdByAgentId: existing?.createdByAgentId,
    });
    if (!principal) return true;
    const validation = await validateBundle(parsed.body);
    if (!validation.ok) {
      json(res, { error: "extension_validation_failed", diagnostics: validation.diagnostics }, 400);
      return true;
    }
    const writerAgentId = principal.kind === "agent" ? principal.agentId : undefined;
    const updatedBy = await resolveHttpAuditUserId(req, writerAgentId);
    const shouldActivate = principal.kind !== "agent" && existing?.enabled === true;
    // Enforce ownership again inside the upsert transaction: validation can yield
    // while another agent installs the same name.
    const ownerOnly = ownerOnlyAgentId(principal);
    let result: InstallExtensionResult;
    try {
      result = await installExtension({
        manifest: validation.manifest,
        files: parsed.body.files,
        priority: parsed.body.priority,
        config: parsed.body.config,
        agentId: writerAgentId,
        createdBy: updatedBy,
        activate: shouldActivate,
        ownerOnly,
      });
    } catch (error) {
      if (!(error instanceof ExtensionOwnershipError)) throw error;
      jsonError(res, error.message, 403);
      return true;
    }
    let extension = result.extension;
    if (shouldActivate) {
      try {
        extension = await reloadExtension(extension.id, { by: updatedBy });
      } catch (error) {
        respondLifecycleError(res, error);
        return true;
      }
    }
    installRoute.respond(res, 200, {
      extension: redactExtension(extension),
      manifest: validation.manifest,
      contentDeduped: result.contentDeduped,
    });
    return true;
  }

  if (listRoute.match(req.method, pathSegments)) {
    const parsed = await listRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    listRoute.respond(res, 200, { extensions: (await listExtensions()).map(redactExtension) });
    return true;
  }

  if (typeDefsRoute.match(req.method, pathSegments)) {
    const parsed = await typeDefsRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(EXTENSION_TYPE_DEFINITIONS);
    return true;
  }

  if (versionsRoute.match(req.method, pathSegments)) {
    const parsed = await versionsRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!(await getExtensionById(parsed.params.id))) {
      jsonError(res, "Extension not found", 404);
      return true;
    }
    versionsRoute.respond(res, 200, {
      versions: await listExtensionVersions(parsed.params.id),
    });
    return true;
  }

  if (runsRoute.match(req.method, pathSegments)) {
    const parsed = await runsRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!(await getExtensionById(parsed.params.id))) {
      jsonError(res, "Extension not found", 404);
      return true;
    }
    runsRoute.respond(res, 200, {
      runs: await listExtensionRuns(parsed.params.id, parsed.query.limit),
    });
    return true;
  }

  if (getRoute.match(req.method, pathSegments)) {
    const parsed = await getRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const extension = await getExtensionById(parsed.params.id);
    if (!extension) {
      jsonError(res, "Extension not found", 404);
      return true;
    }
    getRoute.respond(res, 200, {
      extension: redactExtension(extension),
      manifest: ExtensionManifestSchema.parse(JSON.parse(extension.manifestJson)),
      files: await getExtensionFiles(extension.id),
    });
    return true;
  }

  if (patchRoute.match(req.method, pathSegments)) {
    const parsed = await patchRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const stored = await getExtensionById(parsed.params.id);
    if (!stored) {
      jsonError(res, "Extension not found", 404);
      return true;
    }
    const principal = await requirePermission(req, res, agentId, "extension.write", {
      kind: "extension",
      extensionId: stored.id,
      createdByAgentId: stored.createdByAgentId,
    });
    if (!principal) return true;
    const writerAgentId = principal.kind === "agent" ? principal.agentId : undefined;
    const ownerOnly = ownerOnlyAgentId(principal);
    // PATCH reloads live code; ordinary owners may edit only disabled drafts.
    if (
      stored.enabled &&
      ownerOnly &&
      !(await requirePermission(req, res, agentId, "extension.activate"))
    ) {
      return true;
    }
    const config = parsed.body.config
      ? preserveRedactedConfigValues(parsed.body.config, stored.configJson)
      : parsed.body.config;
    let extension: Extension | null;
    try {
      extension = await updateExtensionMeta(parsed.params.id, {
        ...parsed.body,
        ...(config === undefined ? {} : { config }),
        updatedBy: await resolveHttpAuditUserId(req, writerAgentId),
        ownerOnly,
      });
    } catch (error) {
      respondLifecycleError(res, error);
      return true;
    }
    if (!extension) {
      jsonError(res, "Extension not found", 404);
      return true;
    }
    if (extension.enabled) {
      try {
        extension = await reloadExtension(extension.id);
      } catch (error) {
        respondLifecycleError(res, error);
        return true;
      }
    }
    patchRoute.respond(res, 200, { extension: redactExtension(extension) });
    return true;
  }

  if (deleteRoute.match(req.method, pathSegments)) {
    const parsed = await deleteRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const stored = await getExtensionById(parsed.params.id);
    if (!stored) {
      jsonError(res, "Extension not found", 404);
      return true;
    }
    const principal = await requirePermission(req, res, agentId, "extension.write", {
      kind: "extension",
      extensionId: stored.id,
      createdByAgentId: stored.createdByAgentId,
    });
    if (!principal) return true;
    const extension = stored;
    if (extension.enabled) {
      jsonError(res, "Disable the extension before uninstalling it", 409);
      return true;
    }
    try {
      await deleteExtension(extension.id, ownerOnlyAgentId(principal));
    } catch (error) {
      respondLifecycleError(res, error);
      return true;
    }
    deleteRoute.respond(res, 200, { deleted: true });
    return true;
  }

  if (enableRoute.match(req.method, pathSegments)) {
    const parsed = await enableRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const principal = await requirePermission(req, res, agentId, "extension.activate");
    if (!principal) return true;
    const writerAgentId = principal.kind === "agent" ? principal.agentId : undefined;
    try {
      const extension = await enableExtension(parsed.params.id, {
        by: await resolveHttpAuditUserId(req, writerAgentId),
        agentId: writerAgentId,
      });
      enableRoute.respond(res, 200, { extension: redactExtension(extension) });
    } catch (error) {
      respondLifecycleError(res, error);
    }
    return true;
  }

  if (disableRoute.match(req.method, pathSegments)) {
    const parsed = await disableRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const principal = await requirePermission(req, res, agentId, "extension.activate");
    if (!principal) return true;
    const writerAgentId = principal.kind === "agent" ? principal.agentId : undefined;
    try {
      const extension = await disableExtension(parsed.params.id, {
        by: await resolveHttpAuditUserId(req, writerAgentId),
        agentId: writerAgentId,
      });
      disableRoute.respond(res, 200, { extension: redactExtension(extension) });
    } catch (error) {
      respondLifecycleError(res, error);
    }
    return true;
  }

  if (activateVersionRoute.match(req.method, pathSegments)) {
    const parsed = await activateVersionRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const principal = await requirePermission(req, res, agentId, "extension.activate");
    if (!principal) return true;
    const writerAgentId = principal.kind === "agent" ? principal.agentId : undefined;
    try {
      const extension = await activateVersion(parsed.params.id, parsed.body.version, {
        by: await resolveHttpAuditUserId(req, writerAgentId),
        agentId: writerAgentId,
      });
      activateVersionRoute.respond(res, 200, { extension: redactExtension(extension) });
    } catch (error) {
      respondLifecycleError(res, error);
    }
    return true;
  }

  return false;
}
