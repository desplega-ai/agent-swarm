import { z } from "zod";

export const argsSchema = z.object({
  sourceId: z.string().uuid().describe("AriaHQ knowledge source ID to synchronize"),
});

function getPath(value: any, path: string): any {
  if (!path) return value;
  return path.split(".").reduce((current, segment) => {
    if (current === null || current === undefined) return undefined;
    return current[segment];
  }, value);
}

function setPath(target: Record<string, any>, path: string, value: unknown) {
  const segments = path.split(".").filter(Boolean);
  if (segments.length === 0) throw new Error("cursor requestPath must not be empty");
  let current = target;
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment];
    current[segment] = next && typeof next === "object" && !Array.isArray(next) ? { ...next } : {};
    current = current[segment];
  }
  current[segments[segments.length - 1] as string] = value;
}

function template(value: any, record: any, cursor: string | undefined): any {
  if (typeof value === "string") {
    const exact = value.match(/^\{\{(record\.[^}]+|cursor)\}\}$/);
    const exactExpression = exact?.[1];
    if (exactExpression) {
      return exactExpression === "cursor" ? cursor : getPath(record, exactExpression.slice(7));
    }
    return value.replace(/\{\{(record\.[^}]+|cursor)\}\}/g, (_match, expression) => {
      const resolved = expression === "cursor" ? cursor : getPath(record, expression.slice(7));
      return resolved === undefined || resolved === null ? "" : String(resolved);
    });
  }
  if (Array.isArray(value)) return value.map((entry) => template(entry, record, cursor));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, template(entry, record, cursor)]),
    );
  }
  return value;
}

function requiredString(record: any, mapping: any, field: string): string {
  const path = mapping && typeof mapping[field] === "string" ? mapping[field] : undefined;
  if (!path) throw new Error("missing required field mapping: " + field);
  const value = getPath(record, path);
  if (value === undefined || value === null || value === "") {
    throw new Error("record is missing required mapped value: " + field + " at " + path);
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

function unwrapToolResult(result: any): any {
  if (!result || result.success !== true) throw new Error("AriaHQ source tool request failed");
  const body = result.data;
  if (!body || body.success !== true) {
    throw new Error(body && body.message ? String(body.message) : "AriaHQ source operation failed");
  }
  return body;
}

/** Synchronize one declarative OpenAPI source into AriaHQ's tenant-scoped evidence store. */
export default async function ariaKnowledgeSync(args: any, ctx: any) {
  const parsed = argsSchema.safeParse(args);
  if (!parsed.success) throw new Error("invalid args: " + parsed.error.message);

  let source: any;
  let run: any;
  try {
    const begun = unwrapToolResult(
      await ctx.swarm.ariahq_source({ action: "begin", sourceId: parsed.data.sourceId }),
    );
    source = begun.source;
    run = begun.run;
    if (!source || !run || typeof run.id !== "string") {
      throw new Error("AriaHQ source begin response is incomplete");
    }
    if (source.adapter !== undefined && source.adapter !== "openapi") {
      throw new Error("scheduled synchronization only supports the openapi adapter");
    }
    if (typeof source.connectionSlug !== "string" || !source.connectionSlug) {
      throw new Error("knowledge source has no connection slug");
    }

    const config = source.syncConfig;
    if (!config || typeof config !== "object") throw new Error("knowledge source config is missing");
    if (typeof config.listOperation !== "string" || !config.listOperation) {
      throw new Error("knowledge source listOperation is missing");
    }
    if (typeof config.recordsPath !== "string") {
      throw new Error("knowledge source recordsPath is missing");
    }
    const connection = ctx.api[source.connectionSlug];
    const listCall = connection && connection[config.listOperation];
    if (typeof listCall !== "function") {
      throw new Error(
        "connection operation is unavailable: " + source.connectionSlug + "." + config.listOperation,
      );
    }

    const listArgs = template(config.listArgs || {}, {}, source.cursor);
    if (
      source.cursor &&
      config.cursor &&
      typeof config.cursor.requestPath === "string"
    ) {
      setPath(listArgs, config.cursor.requestPath, source.cursor);
    }
    const page = await listCall(listArgs);
    const listed = getPath(page, config.recordsPath);
    if (!Array.isArray(listed)) {
      throw new Error("recordsPath did not resolve to an array: " + config.recordsPath);
    }

    const records = [];
    for (const listedRecord of listed) {
      let mappedRecord = listedRecord;
      if (config.detail) {
        if (typeof config.detail.operation !== "string" || !config.detail.operation) {
          throw new Error("detail.operation is missing");
        }
        const detailCall = connection[config.detail.operation];
        if (typeof detailCall !== "function") {
          throw new Error(
            "connection detail operation is unavailable: " +
              source.connectionSlug +
              "." +
              config.detail.operation,
          );
        }
        const detailResponse = await detailCall(
          template(config.detail.args || {}, listedRecord, source.cursor),
        );
        mappedRecord = config.detail.responsePath
          ? getPath(detailResponse, config.detail.responsePath)
          : detailResponse;
      }
      if (!mappedRecord || typeof mappedRecord !== "object") {
        throw new Error("provider record is not an object");
      }

      const fieldMap = config.fieldMap;
      const sourceUrlPath =
        fieldMap && typeof fieldMap.sourceUrl === "string" ? fieldMap.sourceUrl : undefined;
      const sourceUrlValue = sourceUrlPath ? getPath(mappedRecord, sourceUrlPath) : undefined;
      const metadata: Record<string, unknown> = {};
      if (config.metadataMap && typeof config.metadataMap === "object") {
        for (const [key, path] of Object.entries(config.metadataMap)) {
          if (typeof path === "string") metadata[key] = getPath(mappedRecord, path);
        }
      }
      records.push({
        sourceRef: requiredString(mappedRecord, fieldMap, "sourceRef"),
        sourceRevision: requiredString(mappedRecord, fieldMap, "sourceRevision"),
        title: requiredString(mappedRecord, fieldMap, "title"),
        content: requiredString(mappedRecord, fieldMap, "content"),
        effectiveAt: requiredString(mappedRecord, fieldMap, "effectiveAt"),
        ...(typeof sourceUrlValue === "string" && sourceUrlValue ? { sourceUrl: sourceUrlValue } : {}),
        metadata,
      });
    }

    const nextCursor =
      config.cursor && typeof config.cursor.responsePath === "string"
        ? getPath(page, config.cursor.responsePath)
        : undefined;
    unwrapToolResult(
      await ctx.swarm.ariahq_source({
        action: "commit",
        sourceId: source.id,
        runId: run.id,
        ...(nextCursor === undefined || nextCursor === null
          ? {}
          : { nextCursor: String(nextCursor) }),
        records,
      }),
    );
    return {
      recordsSeen: records.length,
      ...(nextCursor === undefined || nextCursor === null
        ? {}
        : { nextCursor: String(nextCursor) }),
    };
  } catch (error) {
    if (source && run && typeof run.id === "string") {
      try {
        await ctx.swarm.ariahq_source({
          action: "fail",
          sourceId: source.id,
          runId: run.id,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      } catch {
        // Preserve the provider/mapping error; the server separately journals a successful fail call.
      }
    }
    throw error;
  }
}
