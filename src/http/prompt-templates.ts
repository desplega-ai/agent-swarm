import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  checkoutPromptTemplate,
  deletePromptTemplate,
  getPromptTemplateById,
  getPromptTemplateHistory,
  getPromptTemplates,
  resetPromptTemplateToDefault,
  resolvePromptTemplate,
  upsertPromptTemplate,
} from "../be/db";
import { getAllTemplateDefinitions, getTemplateDefinition } from "../prompts/registry";
import { resolveTemplate } from "../prompts/resolver";
import { interpolate } from "../workflows/template";
import { route } from "./route-def";
import { json, jsonError } from "./utils";

// ─── Route Definitions ───────────────────────────────────────────────────────

const resolvedRoute = route({
  method: "get",
  path: "/api/prompt-templates/resolved",
  pattern: ["api", "prompt-templates", "resolved"],
  summary: "Resolve a prompt template for a given event type and scope chain",
  tags: ["PromptTemplates"],
  query: z.object({
    eventType: z.string(),
    agentId: z.string().optional(),
    repoId: z.string().optional(),
  }),
  responses: {
    200: { description: "Resolved template info" },
    400: { description: "Missing eventType" },
  },
  auth: { apiKey: true },
});

const eventsRoute = route({
  method: "get",
  path: "/api/prompt-templates/events",
  pattern: ["api", "prompt-templates", "events"],
  summary: "List all registered event types with their available variables",
  tags: ["PromptTemplates"],
  responses: {
    200: { description: "List of event template definitions" },
  },
  auth: { apiKey: true },
});

const previewRoute = route({
  method: "post",
  path: "/api/prompt-templates/preview",
  pattern: ["api", "prompt-templates", "preview"],
  summary: "Dry-run render a template with provided variables",
  tags: ["PromptTemplates"],
  body: z.object({
    eventType: z.string(),
    body: z.string().optional(),
    variables: z.record(z.string(), z.unknown()).optional(),
  }),
  responses: {
    200: { description: "Rendered template preview" },
    400: { description: "Validation error" },
  },
  auth: { apiKey: true },
});

const renderRoute = route({
  method: "post",
  path: "/api/prompt-templates/render",
  pattern: ["api", "prompt-templates", "render"],
  summary: "Full scope-aware template resolution with interpolation (used by workers via HTTP)",
  tags: ["PromptTemplates"],
  body: z.object({
    eventType: z.string(),
    variables: z.record(z.string(), z.unknown()).optional(),
    agentId: z.string().optional(),
    repoId: z.string().optional(),
  }),
  responses: {
    200: { description: "Fully resolved and interpolated template" },
    400: { description: "Validation error" },
  },
  auth: { apiKey: true },
});

const checkoutRoute = route({
  method: "post",
  path: "/api/prompt-templates/{id}/checkout",
  pattern: ["api", "prompt-templates", null, "checkout"],
  summary: "Checkout a specific version of a prompt template from history",
  tags: ["PromptTemplates"],
  params: z.object({ id: z.string() }),
  body: z.object({ version: z.number() }),
  responses: {
    200: { description: "Checked-out template" },
    400: { description: "Validation error" },
    404: { description: "Template or version not found" },
  },
  auth: { apiKey: true },
});

const resetRoute = route({
  method: "post",
  path: "/api/prompt-templates/{id}/reset",
  pattern: ["api", "prompt-templates", null, "reset"],
  summary: "Reset a prompt template to its code-defined default",
  tags: ["PromptTemplates"],
  params: z.object({ id: z.string() }),
  responses: {
    200: { description: "Reset template" },
    404: { description: "Template not found or no code default available" },
  },
  auth: { apiKey: true },
});

const getByIdRoute = route({
  method: "get",
  path: "/api/prompt-templates/{id}",
  pattern: ["api", "prompt-templates", null],
  summary: "Get a single prompt template with its version history",
  tags: ["PromptTemplates"],
  params: z.object({ id: z.string() }),
  responses: {
    200: { description: "Template with history" },
    404: { description: "Template not found" },
  },
  auth: { apiKey: true },
});

const deleteByIdRoute = route({
  method: "delete",
  path: "/api/prompt-templates/{id}",
  pattern: ["api", "prompt-templates", null],
  summary: "Delete a prompt template override",
  tags: ["PromptTemplates"],
  params: z.object({ id: z.string() }),
  responses: {
    200: { description: "Template deleted" },
    400: { description: "Cannot delete default template" },
    404: { description: "Template not found" },
  },
  auth: { apiKey: true },
});

const listRoute = route({
  method: "get",
  path: "/api/prompt-templates",
  pattern: ["api", "prompt-templates"],
  summary: "List prompt templates with optional filters",
  tags: ["PromptTemplates"],
  query: z.object({
    eventType: z.string().optional(),
    scope: z.string().optional(),
    scopeId: z.string().optional(),
    isDefault: z.enum(["true", "false"]).optional(),
  }),
  responses: {
    200: { description: "List of prompt templates" },
  },
  auth: { apiKey: true },
});

const upsertRoute = route({
  method: "put",
  path: "/api/prompt-templates",
  pattern: ["api", "prompt-templates"],
  summary: "Create or update a prompt template override",
  tags: ["PromptTemplates"],
  body: z.object({
    eventType: z.string().min(1),
    scope: z.enum(["global", "agent", "repo"]).optional(),
    scopeId: z.string().optional(),
    state: z.enum(["enabled", "default_prompt_fallback", "skip_event"]).optional(),
    body: z.string(),
    changedBy: z.string().optional(),
    changeReason: z.string().optional(),
  }),
  responses: {
    200: { description: "Upserted template" },
    400: { description: "Validation error" },
  },
  auth: { apiKey: true },
});

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handlePromptTemplates(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
): Promise<boolean> {
  // 3-segment literal: /api/prompt-templates/resolved
  if (resolvedRoute.match(req.method, pathSegments)) {
    const parsed = await resolvedRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const { eventType, agentId, repoId } = parsed.query;
    if (!eventType) {
      jsonError(res, "eventType query parameter is required", 400);
      return true;
    }

    const result = resolveTemplate(eventType, {}, { agentId, repoId });
    const dbResult = resolvePromptTemplate(eventType, agentId, repoId);
    const definition = getTemplateDefinition(eventType);

    json(res, {
      resolution: result,
      dbResult,
      definition: definition
        ? {
            eventType: definition.eventType,
            header: definition.header,
            defaultBody: definition.defaultBody,
            variables: definition.variables,
            category: definition.category,
          }
        : null,
    });
    return true;
  }

  // 3-segment literal: /api/prompt-templates/events
  if (eventsRoute.match(req.method, pathSegments)) {
    const parsed = await eventsRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const definitions = getAllTemplateDefinitions();
    json(res, {
      events: definitions.map((d) => ({
        eventType: d.eventType,
        header: d.header,
        defaultBody: d.defaultBody,
        variables: d.variables,
        category: d.category,
      })),
    });
    return true;
  }

  // 3-segment literal: /api/prompt-templates/preview
  if (previewRoute.match(req.method, pathSegments)) {
    const parsed = await previewRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const { eventType, body: customBody, variables } = parsed.body;
    const definition = getTemplateDefinition(eventType);
    const templateBody = customBody ?? definition?.defaultBody ?? "";
    const header = definition?.header ?? "";
    const composed = header ? `${header}\n\n${templateBody}` : templateBody;
    const { result: rendered, unresolved } = interpolate(composed, variables ?? {});

    json(res, { rendered, unresolved });
    return true;
  }

  // 3-segment literal: /api/prompt-templates/render
  if (renderRoute.match(req.method, pathSegments)) {
    const parsed = await renderRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const { eventType, variables, agentId, repoId } = parsed.body;
    const result = resolveTemplate(eventType, variables ?? {}, { agentId, repoId });
    json(res, result);
    return true;
  }

  // 4-segment with param: /api/prompt-templates/{id}/checkout
  if (checkoutRoute.match(req.method, pathSegments)) {
    const parsed = await checkoutRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    try {
      const template = checkoutPromptTemplate(parsed.params.id, parsed.body.version);
      json(res, { template });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      if (message.includes("not found")) {
        jsonError(res, message, 404);
      } else {
        jsonError(res, message, 400);
      }
    }
    return true;
  }

  // 4-segment with param: /api/prompt-templates/{id}/reset
  if (resetRoute.match(req.method, pathSegments)) {
    const parsed = await resetRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const existing = getPromptTemplateById(parsed.params.id);
    if (!existing) {
      jsonError(res, `Prompt template ${parsed.params.id} not found`, 404);
      return true;
    }

    const definition = getTemplateDefinition(existing.eventType);
    if (!definition) {
      jsonError(res, `No code default found for event type "${existing.eventType}"`, 404);
      return true;
    }

    try {
      const template = resetPromptTemplateToDefault(parsed.params.id, definition.defaultBody);
      json(res, { template });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      jsonError(res, message, 400);
    }
    return true;
  }

  // 3-segment with param: GET /api/prompt-templates/{id}
  if (getByIdRoute.match(req.method, pathSegments)) {
    const parsed = await getByIdRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const template = getPromptTemplateById(parsed.params.id);
    if (!template) {
      jsonError(res, "Prompt template not found", 404);
      return true;
    }

    const history = getPromptTemplateHistory(parsed.params.id);
    json(res, { template, history });
    return true;
  }

  // 3-segment with param: DELETE /api/prompt-templates/{id}
  if (deleteByIdRoute.match(req.method, pathSegments)) {
    const parsed = await deleteByIdRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    try {
      const deleted = deletePromptTemplate(parsed.params.id);
      if (!deleted) {
        jsonError(res, "Prompt template not found", 404);
        return true;
      }
      json(res, { deleted: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      jsonError(res, message, 400);
    }
    return true;
  }

  // 2-segment: GET /api/prompt-templates
  if (listRoute.match(req.method, pathSegments)) {
    const parsed = await listRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const templates = getPromptTemplates({
      eventType: parsed.query.eventType || undefined,
      scope: parsed.query.scope || undefined,
      scopeId: parsed.query.scopeId || undefined,
      isDefault: parsed.query.isDefault ? parsed.query.isDefault === "true" : undefined,
    });

    json(res, { templates });
    return true;
  }

  // 2-segment: PUT /api/prompt-templates
  if (upsertRoute.match(req.method, pathSegments)) {
    const parsed = await upsertRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const {
      eventType,
      scope: rawScope,
      scopeId,
      state,
      body,
      changedBy,
      changeReason,
    } = parsed.body;
    const scope = rawScope ?? "global";

    if (scope === "global" && scopeId) {
      jsonError(res, "Global scope must not have scopeId", 400);
      return true;
    }
    if ((scope === "agent" || scope === "repo") && !scopeId) {
      jsonError(res, "Agent/repo scope requires scopeId", 400);
      return true;
    }

    try {
      const template = upsertPromptTemplate({
        eventType,
        scope,
        scopeId: scopeId || null,
        state,
        body,
        changedBy,
        changeReason,
      });
      json(res, { template });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      jsonError(res, message, 500);
    }
    return true;
  }

  return false;
}
