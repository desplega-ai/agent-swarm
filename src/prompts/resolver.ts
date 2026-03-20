/**
 * Template resolver — combines the in-memory code registry with DB overrides
 * to produce the final interpolated prompt text for a given event.
 */

import { resolvePromptTemplate } from "../be/db";
import { interpolate } from "../workflows/template";
import { getTemplateDefinition } from "./registry";

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

const MAX_TEMPLATE_REF_DEPTH = 3;
const TEMPLATE_REF_REGEX = /\{\{@template\[([^\]]+)\]\}\}/g;

/**
 * Resolve an event template to its final interpolated text.
 *
 * 1. Look up EventTemplateDefinition from in-memory registry (header + defaultBody)
 * 2. Call resolvePromptTemplate() from DB to check for overrides / skip / fallback
 * 3. If skipped, return { skipped: true }
 * 4. Determine body: DB override body or code defaultBody
 * 5. Expand {{@template[id]}} references (recursive, max depth 3, cycle detection)
 * 6. Compose: header + "\n\n" + body (skip join if header is empty)
 * 7. Interpolate the composed string with the variables context
 * 8. Return ResolveResult
 */
export function resolveTemplate(
  eventType: string,
  variables: Record<string, unknown>,
  options: ResolveOptions = {},
): ResolveResult {
  const definition = getTemplateDefinition(eventType);

  // If no code-level definition exists, we still attempt DB resolution
  // so that user-created templates (without code definitions) can work.
  const header = definition?.header ?? "";
  const defaultBody = definition?.defaultBody ?? "";

  // DB resolution: scope chain lookup
  const dbResult = resolvePromptTemplate(eventType, options.agentId, options.repoId);

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
 *
 * - Max depth: 3
 * - Cycle detection: tracks visited eventType IDs
 * - On cycle or depth exceeded, leaves the token as-is
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

    // Resolve the referenced template (non-recursive call to get body)
    const refDef = getTemplateDefinition(referencedId);
    const refDefaultBody = refDef?.defaultBody ?? "";

    const refDbResult = resolvePromptTemplate(referencedId, options.agentId, options.repoId);

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
