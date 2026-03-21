/**
 * Template resolver — combines the in-memory code registry with DB overrides
 * to produce the final interpolated prompt text for a given event.
 *
 * Supports two modes:
 * - **DB mode** (default): Direct DB access via resolvePromptTemplate() — used by the API server.
 * - **HTTP mode**: Calls the API server's /api/prompt-templates/render endpoint — used by Docker
 *   workers which have no local database (architecture invariant: workers communicate via HTTP only).
 */

import { interpolate } from "../workflows/template";
import { getTemplateDefinition } from "./registry";

// ─── DB Resolver Injection ──────────────────────────────────────────────────
// The DB resolver is injected by the API server at startup (see src/be/db.ts).
// This avoids a direct import from ../be/db, preserving the worker/API boundary.
// Workers use HTTP mode instead; this DB path is only used by the API server.

type DbResolverFn = (
  eventType: string,
  agentId?: string,
  repoId?: string,
) => { skip: true } | { template: { id: string; body: string; scope: string } } | null;

let dbResolverFn: DbResolverFn | null = null;

/**
 * Inject the DB resolver function (called by API server at startup).
 */
export function configureDbResolver(fn: DbResolverFn): void {
  dbResolverFn = fn;
}

/**
 * Reset DB resolver (for tests).
 */
export function resetDbResolver(): void {
  dbResolverFn = null;
}

export interface ResolveOptions {
  agentId?: string;
  repoId?: string;
}

export interface ResolveResult {
  /** Final resolved text (header + body, interpolated) */
  text: string;
  /** Which DB template was used (undefined if hardcoded default) */
  templateId?: string;
  /** Which scope level matched */
  scope?: string;
  /** true if skip_event was triggered */
  skipped: boolean;
  /** Any {{var}} tokens that couldn't be resolved */
  unresolved: string[];
}

// ─── HTTP Resolver Mode ─────────────────────────────────────────────────────

interface HttpResolverConfig {
  apiUrl: string;
  apiKey: string;
}

let httpResolverConfig: HttpResolverConfig | null = null;

/**
 * Configure the resolver to use HTTP mode (for Docker workers).
 * Once configured, all resolveTemplate() calls go through the API server
 * instead of direct DB access.
 */
export function configureHttpResolver(apiUrl: string, apiKey: string): void {
  httpResolverConfig = { apiUrl, apiKey };
}

/**
 * Check if HTTP resolver mode is active.
 */
export function isHttpResolverConfigured(): boolean {
  return httpResolverConfig !== null;
}

/**
 * Reset to DB mode (for tests).
 */
export function resetHttpResolver(): void {
  httpResolverConfig = null;
}

async function resolveTemplateViaHttp(
  eventType: string,
  variables: Record<string, unknown>,
  options: ResolveOptions,
): Promise<ResolveResult> {
  const config = httpResolverConfig!;
  const url = `${config.apiUrl}/api/prompt-templates/render`;

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        eventType,
        variables,
        agentId: options.agentId,
        repoId: options.repoId,
      }),
    });

    if (!resp.ok) {
      console.warn(
        `[prompt-resolver] HTTP render failed (${resp.status}), falling back to code defaults`,
      );
      return resolveTemplateFromCode(eventType, variables);
    }

    return (await resp.json()) as ResolveResult;
  } catch (err) {
    console.warn(
      `[prompt-resolver] HTTP render error, falling back to code defaults:`,
      err instanceof Error ? err.message : err,
    );
    return resolveTemplateFromCode(eventType, variables);
  }
}

/**
 * Fallback: resolve from code defaults only (no DB, no HTTP).
 * Used when both DB and HTTP are unavailable.
 */
function resolveTemplateFromCode(
  eventType: string,
  variables: Record<string, unknown>,
): ResolveResult {
  const definition = getTemplateDefinition(eventType);
  const header = definition?.header ?? "";
  const body = definition?.defaultBody ?? "";
  const composed = header ? `${header}\n\n${body}` : body;
  const { result: text, unresolved } = interpolate(composed, variables);
  return { text, skipped: false, unresolved };
}

// ─── Main Resolver ──────────────────────────────────────────────────────────

const MAX_TEMPLATE_REF_DEPTH = 3;
const TEMPLATE_REF_REGEX = /\{\{@template\[([^\]]+)\]\}\}/g;

/**
 * Resolve an event template to its final interpolated text.
 *
 * In HTTP mode (workers): delegates to the API server's /render endpoint.
 * In DB mode (API server): does direct DB resolution.
 */
export function resolveTemplate(
  eventType: string,
  variables: Record<string, unknown>,
  options: ResolveOptions = {},
): ResolveResult {
  // HTTP mode: delegate to API server (workers call this path)
  if (httpResolverConfig) {
    // Return a synchronous fallback immediately, then the caller should use resolveTemplateAsync.
    // For backward compat with sync callers, use code defaults as sync fallback.
    // Callers that need HTTP resolution must use resolveTemplateAsync().
    return resolveTemplateFromCode(eventType, variables);
  }

  return resolveTemplateViaDb(eventType, variables, options);
}

/**
 * Async version of resolveTemplate — required for HTTP mode (workers).
 * Falls back to sync DB mode when HTTP is not configured.
 */
export async function resolveTemplateAsync(
  eventType: string,
  variables: Record<string, unknown>,
  options: ResolveOptions = {},
): Promise<ResolveResult> {
  if (httpResolverConfig) {
    return resolveTemplateViaHttp(eventType, variables, options);
  }

  return resolveTemplateViaDb(eventType, variables, options);
}

/**
 * DB-mode resolution (API server path). Direct DB access.
 */
function resolveTemplateViaDb(
  eventType: string,
  variables: Record<string, unknown>,
  options: ResolveOptions,
): ResolveResult {
  const definition = getTemplateDefinition(eventType);
  const header = definition?.header ?? "";
  const defaultBody = definition?.defaultBody ?? "";

  // DB resolution: scope chain lookup
  const dbResult = dbResolverFn?.(eventType, options.agentId, options.repoId) ?? null;

  // skip_event
  if (dbResult && "skip" in dbResult) {
    return { text: "", skipped: true, unresolved: [] };
  }

  // Determine body and metadata
  let body: string;
  let templateId: string | undefined;
  let scope: string | undefined;

  if (dbResult && "template" in dbResult) {
    body = dbResult.template.body;
    templateId = dbResult.template.id;
    scope = dbResult.template.scope;
  } else {
    body = defaultBody;
  }

  // Expand {{@template[id]}} references in body
  body = expandTemplateRefs(body, variables, options, new Set(), 0);

  // Compose header + body
  const composed = header ? `${header}\n\n${body}` : body;

  // Interpolate variables
  const { result: text, unresolved } = interpolate(composed, variables);

  return {
    text,
    templateId,
    scope,
    skipped: false,
    unresolved,
  };
}

/**
 * Recursively expand {{@template[id]}} references in a string.
 * Only used in DB mode (API server). HTTP mode handles expansion server-side.
 */
function expandTemplateRefs(
  text: string,
  variables: Record<string, unknown>,
  options: ResolveOptions,
  visited: Set<string>,
  depth: number,
): string {
  if (depth > MAX_TEMPLATE_REF_DEPTH) {
    return text;
  }

  return text.replace(TEMPLATE_REF_REGEX, (fullMatch, referencedId: string) => {
    // Cycle detection
    if (visited.has(referencedId)) {
      console.warn(
        `[prompt-resolver] Cycle detected for template reference "${referencedId}", leaving token as-is`,
      );
      return fullMatch;
    }

    // Depth check (we're about to recurse into depth + 1)
    if (depth + 1 > MAX_TEMPLATE_REF_DEPTH) {
      console.warn(
        `[prompt-resolver] Max template reference depth (${MAX_TEMPLATE_REF_DEPTH}) exceeded for "${referencedId}", leaving token as-is`,
      );
      return fullMatch;
    }

    // Resolve the referenced template
    const refDef = getTemplateDefinition(referencedId);
    const refDefaultBody = refDef?.defaultBody ?? "";
    const refDbResult = dbResolverFn?.(referencedId, options.agentId, options.repoId) ?? null;

    // If referenced template is skipped, leave token as-is
    if (refDbResult && "skip" in refDbResult) {
      return fullMatch;
    }

    const refBody =
      refDbResult && "template" in refDbResult ? refDbResult.template.body : refDefaultBody;

    // If we got nothing, leave token as-is
    if (!refBody) {
      return fullMatch;
    }

    // Recursively expand nested refs in the referenced body
    const newVisited = new Set(visited);
    newVisited.add(referencedId);
    return expandTemplateRefs(refBody, variables, options, newVisited, depth + 1);
  });
}
