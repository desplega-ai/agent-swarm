import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  countAllMetrics,
  countMetricsByAgent,
  createMetric,
  deleteMetric,
  getMetric,
  getMetricVersion,
  getMetricVersions,
  listAllMetrics,
  listMetricsByAgent,
  updateMetric,
} from "../be/db";
import { snapshotMetric } from "../metrics/version";
import {
  type Metric,
  MetricDefinitionSchema,
  type MetricParam,
  type MetricSummary,
  type MetricVariable,
  MetricVersionSchema,
  type MetricWidget,
} from "../types";
import { assertSelectOnlyQuery, executeReadOnlyQuery } from "./db-query";
import { route } from "./route-def";
import { json, jsonError } from "./utils";

const DEFAULT_METRIC_MAX_ROWS = 100;
const HARD_METRIC_MAX_ROWS = 500;
const VARIABLE_TOKEN_RE = /^\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}$/;
const MetricRunBodySchema = z
  .object({
    variables: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .optional(),
  })
  .optional();

function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "metric";
}

function validateMetricDefinition(definition: unknown) {
  const parsed = MetricDefinitionSchema.parse(definition);
  for (const variable of parsed.variables ?? []) {
    if (variable.optionsQuery) {
      assertSelectOnlyQuery(variable.optionsQuery.sql);
    }
  }
  for (const widget of parsed.widgets) {
    assertSelectOnlyQuery(widget.query.sql);
  }
  return parsed;
}

function resolveVariableOptionValues(variable: MetricVariable) {
  if (!variable.optionsQuery) return variable.options ?? [];
  assertSelectOnlyQuery(variable.optionsQuery.sql);
  const result = executeReadOnlyQuery(variable.optionsQuery.sql, [], HARD_METRIC_MAX_ROWS);
  return result.rows.map((row) => {
    const record = Object.fromEntries(
      result.columns.map((column, index) => [column, row[index] as MetricParam]),
    );
    const value = record[variable.optionsQuery!.valueKey];
    const labelKey = variable.optionsQuery!.labelKey ?? variable.optionsQuery!.valueKey;
    const label = record[labelKey] ?? value;
    return {
      label: label == null ? "" : String(label),
      value: value == null ? null : value,
    };
  });
}

function resolveVariableOptions(metric: Metric) {
  const optionsByKey: Record<string, Array<{ label: string; value: MetricParam }>> = {};
  const variables = (metric.definition.variables ?? []).map((variable) => {
    if (!variable.optionsQuery) {
      return variable;
    }
    const options = resolveVariableOptionValues(variable);
    optionsByKey[variable.key] = options;
    return { ...variable, options };
  });
  return { variables, optionsByKey };
}

function coerceVariableValue(variable: MetricVariable, raw: unknown): MetricParam {
  if (raw == null || raw === "") {
    return variable.defaultValue ?? null;
  }
  if (variable.type === "number") {
    const numeric = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(numeric)) {
      throw new Error(`Metric variable "${variable.key}" must be a number`);
    }
    return numeric;
  }
  if (typeof raw === "boolean" || typeof raw === "number" || typeof raw === "string") {
    return raw;
  }
  return String(raw);
}

function resolveMetricVariables(
  metric: Metric,
  provided: Record<string, unknown>,
  dynamicOptionsByKey: Record<string, Array<{ label: string; value: MetricParam }>> = {},
) {
  const values: Record<string, MetricParam> = {};
  for (const variable of metric.definition.variables ?? []) {
    const options = dynamicOptionsByKey[variable.key] ?? variable.options;
    const raw = provided[variable.key];
    const value =
      (raw == null || raw === "") && variable.defaultValue === undefined && options?.length
        ? options[0]!.value
        : coerceVariableValue(variable, raw);
    if (options?.length) {
      const allowed = options.some((option) => option.value === value);
      if (!allowed) {
        throw new Error(`Metric variable "${variable.key}" must match one of its options`);
      }
    }
    values[variable.key] = value;
  }
  return values;
}

function resolveWidgetParams(
  widget: MetricWidget,
  variables: Record<string, MetricParam>,
): MetricParam[] {
  return (widget.query.params ?? []).map((param) => {
    if (typeof param !== "string") return param;
    const match = VARIABLE_TOKEN_RE.exec(param);
    if (!match) return param;
    const key = match[1]!;
    if (!(key in variables)) {
      throw new Error(`Metric variable "${key}" is not defined`);
    }
    return variables[key] ?? null;
  });
}

function runMetricWidget(widget: MetricWidget, variables: Record<string, MetricParam>) {
  assertSelectOnlyQuery(widget.query.sql);
  const requestedRows = widget.query.maxRows ?? DEFAULT_METRIC_MAX_ROWS;
  const maxRows = Math.min(requestedRows, HARD_METRIC_MAX_ROWS);
  const result = executeReadOnlyQuery(
    widget.query.sql,
    resolveWidgetParams(widget, variables),
    maxRows,
  );
  return {
    widget,
    result: {
      ...result,
      rows: result.rows.map((row) =>
        Object.fromEntries(result.columns.map((column, index) => [column, row[index]])),
      ),
      truncated: result.total > result.rows.length,
      maxRows,
    },
  };
}

function runMetric(metric: Metric, providedVariables: Record<string, unknown> = {}) {
  const resolved = resolveVariableOptions(metric);
  const variables = resolveMetricVariables(metric, providedVariables, resolved.optionsByKey);
  const widgets = metric.definition.widgets.map((widget) => runMetricWidget(widget, variables));
  return {
    metric: {
      ...metric,
      definition: { ...metric.definition, variables: resolved.variables },
    },
    variables,
    widgets,
    // Kept as the first widget result for older callers during the PR cycle.
    result: widgets[0]?.result,
  };
}

const metricDefinitionBody = z.object({
  slug: z.string().min(1).optional(),
  title: z.string().min(1),
  description: z.string().nullable().optional(),
  definition: MetricDefinitionSchema,
});

const createMetricRoute = route({
  method: "post",
  path: "/api/metrics/definitions",
  pattern: ["api", "metrics", "definitions"],
  summary: "Create a metric definition",
  tags: ["Metrics"],
  body: metricDefinitionBody,
  responses: {
    201: { description: "Metric created" },
    400: { description: "Invalid metric definition" },
    409: { description: "Slug already exists for this agent" },
  },
});

const listMetricsRoute = route({
  method: "get",
  path: "/api/metrics/definitions",
  pattern: ["api", "metrics", "definitions"],
  summary: "List metric definitions",
  tags: ["Metrics"],
  query: z.object({
    agentId: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
    offset: z.coerce.number().int().min(0).optional(),
    fields: z.enum(["full", "slim"]).optional(),
  }),
  responses: {
    200: { description: "Metric definitions" },
  },
});

const getMetricRoute = route({
  method: "get",
  path: "/api/metrics/definitions/{id}",
  pattern: ["api", "metrics", "definitions", null],
  summary: "Get a metric definition",
  tags: ["Metrics"],
  params: z.object({ id: z.string() }),
  responses: {
    200: { description: "Metric definition" },
    404: { description: "Metric not found" },
  },
});

const updateMetricRoute = route({
  method: "put",
  path: "/api/metrics/definitions/{id}",
  pattern: ["api", "metrics", "definitions", null],
  summary: "Update a metric definition",
  tags: ["Metrics"],
  params: z.object({ id: z.string() }),
  body: metricDefinitionBody.partial(),
  responses: {
    200: { description: "Metric updated" },
    404: { description: "Metric not found" },
  },
});

const deleteMetricRoute = route({
  method: "delete",
  path: "/api/metrics/definitions/{id}",
  pattern: ["api", "metrics", "definitions", null],
  summary: "Delete a metric definition",
  tags: ["Metrics"],
  params: z.object({ id: z.string() }),
  responses: {
    204: { description: "Metric deleted" },
    404: { description: "Metric not found" },
  },
});

const runMetricRoute = route({
  method: "post",
  path: "/api/metrics/definitions/{id}/run",
  pattern: ["api", "metrics", "definitions", null, "run"],
  summary: "Run a metric definition",
  tags: ["Metrics"],
  params: z.object({ id: z.string() }),
  body: MetricRunBodySchema,
  responses: {
    200: { description: "Metric result" },
    400: { description: "Invalid or disallowed query" },
    404: { description: "Metric not found" },
  },
});

const listMetricVersionsRoute = route({
  method: "get",
  path: "/api/metrics/definitions/{id}/versions",
  pattern: ["api", "metrics", "definitions", null, "versions"],
  summary: "List metric definition versions",
  tags: ["Metrics"],
  params: z.object({ id: z.string() }),
  responses: {
    200: { description: "Metric version list" },
    404: { description: "Metric not found" },
  },
});

const getMetricVersionRoute = route({
  method: "get",
  path: "/api/metrics/definitions/{id}/versions/{version}",
  pattern: ["api", "metrics", "definitions", null, "versions", null],
  summary: "Get a metric definition version",
  tags: ["Metrics"],
  params: z.object({ id: z.string(), version: z.coerce.number().int().min(1) }),
  responses: {
    200: { description: "Metric version" },
    404: { description: "Metric or version not found" },
  },
});

const metricSchemaRoute = route({
  method: "get",
  path: "/api/metrics/schema",
  pattern: ["api", "metrics", "schema"],
  summary: "Get the metric definition JSON Schema",
  tags: ["Metrics"],
  responses: {
    200: { description: "Metric definition JSON Schema" },
  },
});

function metricEditCounter(metricId: string): number {
  const versions = getMetricVersions(metricId);
  return versions.length > 0 ? versions[0]!.version + 1 : 1;
}

export async function handleMetrics(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
  myAgentId: string | undefined,
): Promise<boolean> {
  if (metricSchemaRoute.match(req.method, pathSegments)) {
    json(res, { schema: z.toJSONSchema(MetricDefinitionSchema, { target: "draft-7" }) });
    return true;
  }

  if (createMetricRoute.match(req.method, pathSegments)) {
    const parsed = await createMetricRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const ownerAgentId = myAgentId ?? "ui";

    try {
      const definition = validateMetricDefinition(parsed.body.definition);
      const slug = parsed.body.slug ?? slugify(parsed.body.title);
      const metric = createMetric({
        agentId: ownerAgentId,
        slug,
        title: parsed.body.title,
        description: parsed.body.description ?? undefined,
        definition,
      });
      json(res, { id: metric.id, version: 1 }, 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("UNIQUE")) {
        const slug = parsed.body.slug ?? slugify(parsed.body.title);
        jsonError(res, `Metric with slug "${slug}" already exists for this agent`, 409);
        return true;
      }
      jsonError(res, msg);
    }
    return true;
  }

  if (listMetricsRoute.match(req.method, pathSegments)) {
    const parsed = await listMetricsRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const limit = parsed.query.limit ?? 100;
    const offset = parsed.query.offset ?? 0;
    const full = parsed.query.fields === "full";
    let metrics: Array<Metric | MetricSummary>;
    let total: number;
    if (parsed.query.agentId) {
      metrics = full
        ? listMetricsByAgent(parsed.query.agentId, limit, offset)
        : listMetricsByAgent(parsed.query.agentId, limit, offset, { slim: true });
      total = countMetricsByAgent(parsed.query.agentId);
    } else {
      metrics = full
        ? listAllMetrics(limit, offset)
        : listAllMetrics(limit, offset, { slim: true });
      total = countAllMetrics();
    }
    json(res, { metrics, total, limit, offset });
    return true;
  }

  if (runMetricRoute.match(req.method, pathSegments)) {
    const parsed = await runMetricRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const metric = getMetric(parsed.params.id);
    if (!metric) {
      res.writeHead(404);
      res.end();
      return true;
    }
    try {
      json(res, runMetric(metric, parsed.body?.variables ?? {}));
    } catch (err) {
      jsonError(res, err instanceof Error ? err.message : String(err));
    }
    return true;
  }

  if (getMetricVersionRoute.match(req.method, pathSegments)) {
    const parsed = await getMetricVersionRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!getMetric(parsed.params.id)) {
      res.writeHead(404);
      res.end();
      return true;
    }
    const version = getMetricVersion(parsed.params.id, parsed.params.version);
    if (!version) {
      res.writeHead(404);
      res.end();
      return true;
    }
    json(res, MetricVersionSchema.parse(version));
    return true;
  }

  if (listMetricVersionsRoute.match(req.method, pathSegments)) {
    const parsed = await listMetricVersionsRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!getMetric(parsed.params.id)) {
      res.writeHead(404);
      res.end();
      return true;
    }
    json(res, { versions: getMetricVersions(parsed.params.id) });
    return true;
  }

  if (getMetricRoute.match(req.method, pathSegments)) {
    const parsed = await getMetricRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const metric = getMetric(parsed.params.id);
    if (!metric) {
      res.writeHead(404);
      res.end();
      return true;
    }
    json(res, metric);
    return true;
  }

  if (updateMetricRoute.match(req.method, pathSegments)) {
    const parsed = await updateMetricRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!getMetric(parsed.params.id)) {
      res.writeHead(404);
      res.end();
      return true;
    }
    try {
      const definition =
        parsed.body.definition !== undefined
          ? validateMetricDefinition(parsed.body.definition)
          : undefined;
      try {
        snapshotMetric(parsed.params.id, myAgentId);
      } catch {
        // Snapshot failures should not block edits, matching Pages.
      }
      const updated = updateMetric(parsed.params.id, {
        title: parsed.body.title,
        description: parsed.body.description ?? undefined,
        definition,
        slug: parsed.body.slug,
      });
      if (!updated) {
        res.writeHead(404);
        res.end();
        return true;
      }
      json(res, { id: updated.id, version: metricEditCounter(updated.id) });
    } catch (err) {
      jsonError(res, err instanceof Error ? err.message : String(err));
    }
    return true;
  }

  if (deleteMetricRoute.match(req.method, pathSegments)) {
    const parsed = await deleteMetricRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!deleteMetric(parsed.params.id)) {
      res.writeHead(404);
      res.end();
      return true;
    }
    res.writeHead(204);
    res.end();
    return true;
  }

  return false;
}
