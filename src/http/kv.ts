import type { IncomingMessage, ServerResponse } from "node:http";
import {
  countKv,
  deleteKv,
  getAgentById,
  getKv,
  getTaskById,
  incrKv,
  KvTypeCollisionError,
  listKv,
  upsertKv,
} from "@swarm/storage";
import { KvKeySchema, KvNamespaceSchema, KvValueTypeSchema } from "@swarm/types";
import { agentContextKey, pageContextKey } from "@swarm/workflows";
import { z } from "zod";
import { route } from "./route-def";
import { BODY_TOO_LARGE, enforceContentLengthCap, json, jsonError } from "./utils";

/**
 * KV store HTTP surface — see plan & `src/be/migrations/061_kv_store.sql`.
 *
 * Two URL shapes:
 *
 *   /api/kv/:key                     — namespace resolved server-side from headers
 *   /api/kv/_/:namespace/:key        — namespace given explicitly (the `_` sentinel
 *                                       is illegal as a namespace per `KV_NAME_REGEX`
 *                                       so it can't collide with a real key/ns segment)
 *
 *   GET  /api/kv                     — list, header-resolved namespace
 *   GET  /api/kv/_/:namespace        — list, explicit namespace
 *
 * Namespace header resolution precedence:
 *   X-Page-Id  > X-Source-Task-Id (→ task.contextKey) > X-Agent-ID
 *
 * `X-Page-Id` is set ONLY by `src/http/page-proxy.ts` for a verified page
 * cookie. The kv handler treats it as the highest-priority namespace source
 * and overrides anything in the URL/body so pages can't escape their namespace.
 */

// 2 MiB cap on PUT bodies. Pre-flighted via Content-Length; the parsed JSON
// body itself is enforced too (`value` size ≤ MAX_KV_BODY_BYTES after stringify).
const MAX_KV_BODY_BYTES = 2 * 1024 * 1024;

// `limit` upper bound on list endpoints. Anything higher gets clamped silently
// — callers should paginate via offset.
const MAX_KV_LIST_LIMIT = 1000;

// ─── Schemas ─────────────────────────────────────────────────────────────────

const kvSetBodySchema = z.object({
  value: z.unknown(),
  valueType: KvValueTypeSchema.optional(),
  expiresInSec: z.number().int().positive().optional(),
});

const kvIncrBodySchema = z
  .object({
    by: z.number().int().optional(),
  })
  .optional()
  .nullable();

const kvListQuerySchema = z.object({
  prefix: z.string().optional(),
  limit: z.coerce.number().int().positive().max(MAX_KV_LIST_LIMIT).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

// ─── Routes ──────────────────────────────────────────────────────────────────

const RESPONSES_GET = {
  200: { description: "KV entry" },
  404: { description: "KV entry not found or expired" },
  400: { description: "Validation error or unresolvable namespace" },
} as const;

const RESPONSES_PUT = {
  200: { description: "KV entry stored" },
  400: { description: "Validation error" },
  403: { description: "Caller may not write this namespace" },
  409: { description: "INCR collision: existing value_type is not 'integer'" },
  413: { description: "Body exceeds 2 MiB" },
} as const;

const RESPONSES_LIST = {
  200: { description: "KV entries in the resolved namespace" },
  400: { description: "Validation error or unresolvable namespace" },
} as const;

// Header-resolved (key in path)
const getKvHeader = route({
  method: "get",
  path: "/api/kv/{key}",
  pattern: ["api", "kv", null],
  summary: "Get a KV entry by key (namespace resolved from request headers)",
  tags: ["KV"],
  params: z.object({ key: KvKeySchema }),
  responses: RESPONSES_GET,
});

const putKvHeader = route({
  method: "put",
  path: "/api/kv/{key}",
  pattern: ["api", "kv", null],
  summary: "Upsert a KV entry by key (namespace resolved from request headers)",
  tags: ["KV"],
  params: z.object({ key: KvKeySchema }),
  body: kvSetBodySchema,
  responses: RESPONSES_PUT,
});

const deleteKvHeader = route({
  method: "delete",
  path: "/api/kv/{key}",
  pattern: ["api", "kv", null],
  summary: "Delete a KV entry by key (namespace resolved from request headers)",
  tags: ["KV"],
  params: z.object({ key: KvKeySchema }),
  responses: {
    204: { description: "KV entry deleted" },
    404: { description: "KV entry not found" },
    403: { description: "Caller may not write this namespace" },
    400: { description: "Validation error or unresolvable namespace" },
  },
});

const incrKvHeader = route({
  method: "post",
  path: "/api/kv/{key}/incr",
  pattern: ["api", "kv", null, "incr"],
  summary: "Atomically increment an integer KV entry (header-resolved namespace)",
  tags: ["KV"],
  params: z.object({ key: KvKeySchema }),
  body: kvIncrBodySchema,
  responses: RESPONSES_PUT,
});

const listKvHeader = route({
  method: "get",
  path: "/api/kv",
  pattern: ["api", "kv"],
  summary: "List KV entries in the header-resolved namespace",
  tags: ["KV"],
  query: kvListQuerySchema,
  responses: RESPONSES_LIST,
});

// Explicit-namespace variants (`/_/:namespace/...`)
const getKvExplicit = route({
  method: "get",
  path: "/api/kv/_/{namespace}/{key}",
  pattern: ["api", "kv", "_", null, null],
  summary: "Get a KV entry by explicit namespace + key",
  tags: ["KV"],
  params: z.object({ namespace: KvNamespaceSchema, key: KvKeySchema }),
  responses: RESPONSES_GET,
});

const putKvExplicit = route({
  method: "put",
  path: "/api/kv/_/{namespace}/{key}",
  pattern: ["api", "kv", "_", null, null],
  summary: "Upsert a KV entry by explicit namespace + key",
  tags: ["KV"],
  params: z.object({ namespace: KvNamespaceSchema, key: KvKeySchema }),
  body: kvSetBodySchema,
  responses: RESPONSES_PUT,
});

const deleteKvExplicit = route({
  method: "delete",
  path: "/api/kv/_/{namespace}/{key}",
  pattern: ["api", "kv", "_", null, null],
  summary: "Delete a KV entry by explicit namespace + key",
  tags: ["KV"],
  params: z.object({ namespace: KvNamespaceSchema, key: KvKeySchema }),
  responses: {
    204: { description: "KV entry deleted" },
    404: { description: "KV entry not found" },
    403: { description: "Caller may not write this namespace" },
  },
});

const incrKvExplicit = route({
  method: "post",
  path: "/api/kv/_/{namespace}/{key}/incr",
  pattern: ["api", "kv", "_", null, null, "incr"],
  summary: "Atomically increment an integer KV entry (explicit namespace)",
  tags: ["KV"],
  params: z.object({ namespace: KvNamespaceSchema, key: KvKeySchema }),
  body: kvIncrBodySchema,
  responses: RESPONSES_PUT,
});

const listKvExplicit = route({
  method: "get",
  path: "/api/kv/_/{namespace}",
  pattern: ["api", "kv", "_", null],
  summary: "List KV entries in an explicit namespace",
  tags: ["KV"],
  params: z.object({ namespace: KvNamespaceSchema }),
  query: kvListQuerySchema,
  responses: RESPONSES_LIST,
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Decode + re-validate a path-segment param after `route.parse()`. Path
 * segments arrive percent-encoded (e.g. `task%3Aagent%3A...`); the regex on
 * `KvNamespaceSchema`/`KvKeySchema` is permissive enough to accept the
 * encoded form, but we want to store/compare the decoded value. Returns null
 * + sends a 400 if decoding fails or the decoded value doesn't match the
 * stricter validator.
 */
function decodeKvSegment(
  res: ServerResponse,
  raw: string,
  label: "namespace" | "key",
): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    jsonError(res, `invalid ${label}: malformed percent-encoding`, 400);
    return null;
  }
  if (!/^[a-zA-Z0-9._:/-]{1,512}$/.test(decoded)) {
    jsonError(res, `invalid ${label}: must match [a-zA-Z0-9._:/-]{1,512} after decoding`, 400);
    return null;
  }
  return decoded;
}

function singleHeader(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  if (raw === undefined) return undefined;
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * Resolve the namespace from request headers using the documented precedence.
 * Returns `null` when no header is suitable — caller responds 400.
 *
 * The handler dispatch in `handleKv` calls this AFTER the explicit-path
 * variants have already been ruled out; we never look at URL params here.
 */
function resolveNamespaceFromHeaders(req: IncomingMessage): string | null {
  const pageId = singleHeader(req, "x-page-id");
  if (pageId) {
    try {
      return pageContextKey({ pageId });
    } catch {
      return null;
    }
  }

  const sourceTaskId = singleHeader(req, "x-source-task-id");
  if (sourceTaskId) {
    const task = getTaskById(sourceTaskId);
    if (task?.contextKey) return task.contextKey;
    // Fall through to agent-id default if the task lookup didn't yield a
    // contextKey — the task may be a synthetic / parentless workflow node.
    if (task?.agentId) {
      try {
        return agentContextKey({ agentId: task.agentId });
      } catch {
        // no-op; fall through to header-agent resolution
      }
    }
  }

  const agentId = singleHeader(req, "x-agent-id");
  if (agentId) {
    try {
      return agentContextKey({ agentId });
    } catch {
      return null;
    }
  }

  return null;
}

interface AuthCtx {
  callerAgentId: string | undefined;
  hasPageHeader: boolean;
  isLead: boolean;
}

function buildAuthCtx(req: IncomingMessage): AuthCtx {
  const callerAgentId = singleHeader(req, "x-agent-id");
  const pageId = singleHeader(req, "x-page-id");
  let isLead = false;
  if (callerAgentId) {
    const agent = getAgentById(callerAgentId);
    isLead = agent?.isLead === true;
  }
  return { callerAgentId, hasPageHeader: pageId !== undefined && pageId !== "", isLead };
}

/**
 * Authorize a WRITE against `namespace`. Returns null on allow, or a
 * `(status, message)` tuple to send back.
 *
 * Rules (in order):
 *   - `task:page:<X>` → only the page-proxy can write (it sets `X-Page-Id`).
 *     The proxy injects the page id and we re-derive the expected namespace
 *     from that header; anything else is 403.
 *   - `task:agent:<X>` where X ≠ caller → 403 unless caller is lead.
 *   - everything else → allow (any authenticated caller).
 */
function authorizeWrite(
  namespace: string,
  ctx: AuthCtx,
): { status: number; message: string } | null {
  if (namespace.startsWith("task:page:")) {
    if (!ctx.hasPageHeader) {
      return { status: 403, message: "task:page:* writes require a page-proxy request" };
    }
    // Page-proxy requests have already been forced to their own namespace
    // by the handler before we get here, so by construction the namespace
    // matches the page id. Belt-and-braces: if it doesn't, refuse.
    return null;
  }
  if (namespace.startsWith("task:agent:")) {
    const target = namespace.slice("task:agent:".length);
    if (ctx.callerAgentId && target === ctx.callerAgentId) return null;
    if (ctx.isLead) return null;
    return { status: 403, message: "writes to another agent's namespace require lead" };
  }
  return null;
}

function encodeValueOrError(
  res: ServerResponse,
  value: unknown,
  valueType: "json" | "string" | "integer",
): { stored: string; valueType: "json" | "string" | "integer" } | null {
  try {
    if (valueType === "json") {
      const stored = JSON.stringify(value);
      if (stored === undefined) {
        jsonError(res, "value is not JSON-encodable", 400);
        return null;
      }
      return { stored, valueType };
    }
    if (valueType === "integer") {
      if (typeof value === "number") {
        if (!Number.isInteger(value) || !Number.isSafeInteger(value)) {
          jsonError(res, "integer value must be a JS-safe integer", 400);
          return null;
        }
        return { stored: String(value), valueType };
      }
      if (typeof value === "string" && /^-?\d+$/.test(value)) {
        return { stored: value, valueType };
      }
      jsonError(res, "integer value must be a JS-safe integer", 400);
      return null;
    }
    // 'string'
    if (typeof value !== "string") {
      jsonError(res, "string value must be a string", 400);
      return null;
    }
    return { stored: value, valueType };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "encoding error";
    jsonError(res, `value encoding error: ${msg}`, 400);
    return null;
  }
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleKv(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
): Promise<boolean> {
  // ── Page-proxy override ───────────────────────────────────────────────────
  // X-Page-Id is set ONLY by `src/http/page-proxy.ts` after verifying the
  // page-session cookie. When present we MUST namespace the request under
  // `task:page:<id>` regardless of what the URL says — pages can't write or
  // read any other namespace. Short-circuit the explicit-ns variants by
  // dropping the `_/<ns>/` prefix so the request falls through to the
  // header-resolved path.
  const hasPageHeader = singleHeader(req, "x-page-id") !== undefined;
  if (
    hasPageHeader &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "kv" &&
    pathSegments[2] === "_"
  ) {
    // Reshape `["api","kv","_","<ns>","<key>",...]` →
    //         `["api","kv","<key>",...]` so the header-resolved patterns
    // match. Drop both `_` and the namespace segment.
    pathSegments = [pathSegments[0]!, pathSegments[1]!, ...pathSegments.slice(4)];
  }

  // ── INCR ──────────────────────────────────────────────────────────────────
  if (incrKvExplicit.match(req.method, pathSegments)) {
    return handleIncr(req, res, pathSegments, queryParams, /* explicit */ true);
  }
  if (incrKvHeader.match(req.method, pathSegments)) {
    return handleIncr(req, res, pathSegments, queryParams, /* explicit */ false);
  }

  // ── Explicit ns variants (must come first so `/_/...` doesn't fall through
  // to the header-resolved single-segment patterns) ─────────────────────────
  if (getKvExplicit.match(req.method, pathSegments)) {
    const parsed = await getKvExplicit.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const ns = decodeKvSegment(res, parsed.params.namespace, "namespace");
    if (!ns) return true;
    const key = decodeKvSegment(res, parsed.params.key, "key");
    if (!key) return true;
    return sendGet(res, ns, key);
  }
  if (putKvExplicit.match(req.method, pathSegments)) {
    if (enforceContentLengthCap(req, res, MAX_KV_BODY_BYTES) === BODY_TOO_LARGE) return true;
    const parsed = await putKvExplicit.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const ns = decodeKvSegment(res, parsed.params.namespace, "namespace");
    if (!ns) return true;
    const key = decodeKvSegment(res, parsed.params.key, "key");
    if (!key) return true;
    return sendPut(req, res, ns, key, parsed.body);
  }
  if (deleteKvExplicit.match(req.method, pathSegments)) {
    const parsed = await deleteKvExplicit.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const ns = decodeKvSegment(res, parsed.params.namespace, "namespace");
    if (!ns) return true;
    const key = decodeKvSegment(res, parsed.params.key, "key");
    if (!key) return true;
    return sendDelete(req, res, ns, key);
  }
  if (listKvExplicit.match(req.method, pathSegments)) {
    const parsed = await listKvExplicit.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const ns = decodeKvSegment(res, parsed.params.namespace, "namespace");
    if (!ns) return true;
    return sendList(res, ns, parsed.query);
  }

  // ── Header-resolved variants ──────────────────────────────────────────────
  if (getKvHeader.match(req.method, pathSegments)) {
    const parsed = await getKvHeader.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const ns = resolveNamespaceForRead(req);
    if (!ns) {
      jsonError(res, "namespace is required (pass X-Source-Task-Id or X-Agent-ID)", 400);
      return true;
    }
    const key = decodeKvSegment(res, parsed.params.key, "key");
    if (!key) return true;
    return sendGet(res, ns, key);
  }
  if (putKvHeader.match(req.method, pathSegments)) {
    if (enforceContentLengthCap(req, res, MAX_KV_BODY_BYTES) === BODY_TOO_LARGE) return true;
    const parsed = await putKvHeader.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const ns = resolveNamespaceForWrite(req);
    if (!ns) {
      jsonError(res, "namespace is required (pass X-Source-Task-Id or X-Agent-ID)", 400);
      return true;
    }
    const key = decodeKvSegment(res, parsed.params.key, "key");
    if (!key) return true;
    return sendPut(req, res, ns, key, parsed.body);
  }
  if (deleteKvHeader.match(req.method, pathSegments)) {
    const parsed = await deleteKvHeader.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const ns = resolveNamespaceForWrite(req);
    if (!ns) {
      jsonError(res, "namespace is required (pass X-Source-Task-Id or X-Agent-ID)", 400);
      return true;
    }
    const key = decodeKvSegment(res, parsed.params.key, "key");
    if (!key) return true;
    return sendDelete(req, res, ns, key);
  }
  if (listKvHeader.match(req.method, pathSegments)) {
    const parsed = await listKvHeader.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const ns = resolveNamespaceForRead(req);
    if (!ns) {
      jsonError(res, "namespace is required (pass X-Source-Task-Id or X-Agent-ID)", 400);
      return true;
    }
    return sendList(res, ns, parsed.query);
  }

  return false;
}

/**
 * Reads only ever resolve from headers — there's no auth distinction between
 * reading your own ns and someone else's (any authenticated caller may read
 * any namespace).
 */
function resolveNamespaceForRead(req: IncomingMessage): string | null {
  return resolveNamespaceFromHeaders(req);
}

/**
 * Writes also resolve from headers, with the same precedence — but the
 * page-proxy header path is what gives `task:page:*` writes their privilege
 * (see `authorizeWrite`).
 */
function resolveNamespaceForWrite(req: IncomingMessage): string | null {
  return resolveNamespaceFromHeaders(req);
}

async function handleIncr(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
  explicit: boolean,
): Promise<boolean> {
  if (enforceContentLengthCap(req, res, MAX_KV_BODY_BYTES) === BODY_TOO_LARGE) return true;
  let namespace: string;
  let key: string;
  let body: { by?: number } | null | undefined;
  if (explicit) {
    const parsed = await incrKvExplicit.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const ns = decodeKvSegment(res, parsed.params.namespace, "namespace");
    if (!ns) return true;
    const k = decodeKvSegment(res, parsed.params.key, "key");
    if (!k) return true;
    namespace = ns;
    key = k;
    body = parsed.body;
  } else {
    const parsed = await incrKvHeader.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const ns = resolveNamespaceForWrite(req);
    if (!ns) {
      jsonError(res, "namespace is required (pass X-Source-Task-Id or X-Agent-ID)", 400);
      return true;
    }
    const k = decodeKvSegment(res, parsed.params.key, "key");
    if (!k) return true;
    namespace = ns;
    key = k;
    body = parsed.body;
  }

  const authErr = authorizeWrite(namespace, buildAuthCtx(req));
  if (authErr) {
    jsonError(res, authErr.message, authErr.status);
    return true;
  }

  const by = body?.by ?? 1;
  try {
    const entry = incrKv(namespace, key, by);
    json(res, entry);
  } catch (err) {
    if (err instanceof KvTypeCollisionError) {
      jsonError(res, err.message, 409);
      return true;
    }
    const msg = err instanceof Error ? err.message : "INCR failed";
    jsonError(res, msg, 400);
  }
  return true;
}

function sendGet(res: ServerResponse, namespace: string, key: string): boolean {
  const entry = getKv(namespace, key);
  if (!entry) {
    jsonError(res, "not found", 404);
    return true;
  }
  json(res, entry);
  return true;
}

function sendPut(
  req: IncomingMessage,
  res: ServerResponse,
  namespace: string,
  key: string,
  body: z.infer<typeof kvSetBodySchema>,
): boolean {
  const authErr = authorizeWrite(namespace, buildAuthCtx(req));
  if (authErr) {
    jsonError(res, authErr.message, authErr.status);
    return true;
  }
  const valueType = body.valueType ?? "json";
  const encoded = encodeValueOrError(res, body.value, valueType);
  if (!encoded) return true;
  // Second cap-check on the encoded bytes (post-JSON-stringify) so a tiny
  // Content-Length header can't sneak a huge value past us.
  if (Buffer.byteLength(encoded.stored, "utf8") > MAX_KV_BODY_BYTES) {
    jsonError(res, `Payload too large (max ${MAX_KV_BODY_BYTES} bytes)`, 413);
    return true;
  }
  const expiresAt = body.expiresInSec !== undefined ? Date.now() + body.expiresInSec * 1000 : null;
  try {
    const entry = upsertKv({
      namespace,
      key,
      value: body.value,
      valueType,
      expiresAt,
    });
    json(res, entry);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "upsert failed";
    jsonError(res, msg, 400);
  }
  return true;
}

function sendDelete(
  req: IncomingMessage,
  res: ServerResponse,
  namespace: string,
  key: string,
): boolean {
  const authErr = authorizeWrite(namespace, buildAuthCtx(req));
  if (authErr) {
    jsonError(res, authErr.message, authErr.status);
    return true;
  }
  const removed = deleteKv(namespace, key);
  if (!removed) {
    jsonError(res, "not found", 404);
    return true;
  }
  res.writeHead(204);
  res.end();
  return true;
}

function sendList(
  res: ServerResponse,
  namespace: string,
  query: z.infer<typeof kvListQuerySchema>,
): boolean {
  const limit = Math.min(query.limit ?? 100, MAX_KV_LIST_LIMIT);
  const offset = query.offset ?? 0;
  const prefix = query.prefix && query.prefix.length > 0 ? query.prefix : undefined;
  const entries = listKv(namespace, { prefix, limit, offset });
  const total = countKv(namespace, { prefix });
  json(res, { entries, total, namespace });
  return true;
}
