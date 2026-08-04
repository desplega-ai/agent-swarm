/**
 * Dreaming's workflow-facing JSON schemas and its stricter runtime guards.
 *
 * The workflow validator deliberately supports only a small JSON Schema
 * subset. These schemas therefore describe the common envelope; the tagged
 * union's per-kind requirements live in `validateReflectionDelta` below.
 */

export type JsonSchema = Record<string, unknown>;

export const PROFILE_FILES = ["SOUL", "IDENTITY", "CLAUDE", "TOOLS", "HEARTBEAT"] as const;
export const PROFILE_OPS = ["append-under", "replace-section", "remove-section"] as const;

export type ProfileFile = (typeof PROFILE_FILES)[number];
export type ProfileOp = (typeof PROFILE_OPS)[number];
export type ReflectionDeltaKind = "profile-op" | "memory" | "skill" | "hygiene";

/**
 * A deliberately broad JSON-schema envelope. `oneOf` would be ignored by the
 * workflow validator, so `validateReflectionDelta` is the authoritative
 * tagged-union validator for `dream-apply`.
 */
export const ReflectionDeltaSchema: JsonSchema = {
  type: "object",
  required: ["kind"],
  properties: {
    kind: { type: "string", enum: ["profile-op", "memory", "skill", "hygiene"] },
    agentId: { type: "string" },
    file: { type: "string", enum: PROFILE_FILES },
    op: { type: "string", enum: PROFILE_OPS },
    anchor: { type: "string" },
    content: { type: "string" },
    action: { type: "string", enum: ["write", "delete", "create", "update"] },
    id: { type: "string" },
    memoryId: { type: "string" },
    key: { type: "string" },
    name: { type: "string" },
    scope: { type: "string", enum: ["agent", "swarm"] },
    tags: { type: "array", items: { type: "string" } },
    skillId: { type: "string" },
    rotationCursorKey: { type: "string" },
    rotationCursorNamespace: { type: "string" },
    rotationCursorBy: { type: "number" },
    reason: { type: "string" },
  },
};

export const ApprovedDeltaSetSchema: JsonSchema = {
  type: "object",
  required: ["deltas"],
  properties: {
    deltas: { type: "array", items: ReflectionDeltaSchema },
  },
};

export type ProfileOpDelta = {
  kind: "profile-op";
  agentId: string;
  file: ProfileFile;
  op: ProfileOp;
  anchor: string;
  content?: string;
  reason?: string;
};

export type MemoryDelta = {
  kind: "memory";
  agentId: string;
  action: "write" | "delete";
  content?: string;
  id?: string;
  memoryId?: string;
  name?: string;
  key?: string;
  scope?: "agent" | "swarm";
  tags?: string[];
  reason?: string;
};

export type SkillDelta = {
  kind: "skill";
  action: "create" | "update";
  content: string;
  skillId?: string;
  scope?: "agent" | "swarm";
  reason?: string;
};

export type HygieneDelta = {
  kind: "hygiene";
  agentId: string;
  op: ProfileOp;
  anchor: string;
  content?: string;
  rotationCursorKey?: string;
  rotationCursorNamespace?: string;
  rotationCursorBy?: number;
  reason?: string;
};

export type ReflectionDelta = ProfileOpDelta | MemoryDelta | SkillDelta | HygieneDelta;
export type ApprovedDeltaSet = { deltas: ReflectionDelta[] };

const SUBSET_KEYWORDS = new Set(["type", "required", "properties", "enum", "const", "items"]);

/** Throw if a schema drifts outside the subset enforced by the workflow runtime. */
export function assertSubsetSafe(schema: unknown, path = "root"): void {
  if (!isRecord(schema)) throw new Error(`${path}: schema must be an object`);
  for (const [key, value] of Object.entries(schema)) {
    if (!SUBSET_KEYWORDS.has(key))
      throw new Error(`${path}: unsupported JSON Schema keyword "${key}"`);
    if (key === "properties") {
      if (!isRecord(value)) throw new Error(`${path}.properties: must be an object`);
      for (const [property, propertySchema] of Object.entries(value)) {
        assertSubsetSafe(propertySchema, `${path}.properties.${property}`);
      }
    } else if (key === "items") {
      assertSubsetSafe(value, `${path}.items`);
    }
  }
}

/** Return an error string for an invalid delta, otherwise null. */
export function validateReflectionDelta(value: unknown): string | null {
  if (!isRecord(value)) return "delta must be an object";
  const kind = value.kind;
  if (kind === "profile-op") return validateProfileOp(value);
  if (kind === "memory") return validateMemory(value);
  if (kind === "skill") return validateSkill(value);
  if (kind === "hygiene") return validateHygiene(value);
  return "kind must be one of profile-op, memory, skill, hygiene";
}

export function validateApprovedDeltaSet(value: unknown): string[] {
  if (!isRecord(value)) return ["approved delta set must be an object"];
  if (!Array.isArray(value.deltas)) return ["approved delta set requires a deltas array"];
  return value.deltas.flatMap((delta, index) => {
    const error = validateReflectionDelta(delta);
    return error ? [`deltas[${index}]: ${error}`] : [];
  });
}

export type AnchoredOpResult = { applied: true; text: string } | { applied: false; reason: string };

/** Return the exact H2 headings used as safe profile-edit anchors. */
export function getH2Anchors(text: string): string[] {
  return maskFencedRegions(text)
    .split(/\r?\n/)
    .filter((line) => /^## (?!#)/.test(line));
}

/**
 * Apply one anchored section operation without touching the database. The
 * caller turns failures into held deltas and persists successful whole-field
 * replacements through `profile_update`.
 */
export function applyAnchoredProfileOp(
  text: string,
  delta:
    | Pick<ProfileOpDelta, "file" | "op" | "anchor" | "content">
    | (Pick<HygieneDelta, "op" | "anchor" | "content"> & {
        file: ProfileFile;
      }),
): AnchoredOpResult {
  const anchor = delta.anchor.trim();
  if (!/^## (?!#)/.test(anchor))
    return { applied: false, reason: "anchor must be an exact H2 heading" };
  const headings = h2HeadingRanges(text);
  const matches = headings.filter((heading) => heading.heading.trim() === anchor);
  if (matches.length !== 1) {
    return {
      applied: false,
      reason:
        matches.length === 0 ? `anchor not found: ${anchor}` : `anchor is ambiguous: ${anchor}`,
    };
  }
  if (
    (delta.op === "append-under" || delta.op === "replace-section") &&
    !nonEmptyString(delta.content)
  ) {
    return { applied: false, reason: `${delta.op} requires content` };
  }

  const match = matches[0]!;
  const nextStart = match.nextStart;
  const sectionBodyStart = match.lineEnd;
  const content = delta.content?.trim() ?? "";
  if (/^## /m.test(content)) {
    return { applied: false, reason: "content must not introduce H2 headings" };
  }
  let next: string;
  switch (delta.op) {
    case "append-under": {
      const sectionHasContent = text.slice(sectionBodyStart, nextStart).trim().length > 0;
      const before = text.slice(0, nextStart).replace(/[ \t]*(?:\r?\n)+$/, "");
      const after = text.slice(nextStart);
      const beforeSeparator = sectionHasContent ? "\n\n" : "\n";
      const afterSeparator = after.length > 0 ? "\n\n" : text.endsWith("\n") ? "\n" : "";
      next = `${before}${beforeSeparator}${content}${afterSeparator}${after}`;
      break;
    }
    case "replace-section": {
      const after = text.slice(nextStart);
      const afterSeparator = after.length > 0 ? "\n\n" : text.endsWith("\n") ? "\n" : "";
      next = `${text.slice(0, sectionBodyStart)}\n${content}${afterSeparator}${after}`;
      break;
    }
    case "remove-section":
      next = `${text.slice(0, match.start)}${text.slice(nextStart)}`;
      break;
    default:
      return { applied: false, reason: `unsupported profile op: ${String(delta.op)}` };
  }

  if ((delta.file === "SOUL" || delta.file === "IDENTITY") && next.length < 200) {
    return { applied: false, reason: `${delta.file} would be shorter than 200 characters` };
  }
  return { applied: true, text: next };
}

function h2HeadingRanges(
  text: string,
): Array<{ heading: string; start: number; lineEnd: number; nextStart: number }> {
  const matches = [...maskFencedRegions(text).matchAll(/^## (?!#).*$/gm)];
  return matches.map((match, index) => {
    const matched = match!;
    const start = matched.index ?? 0;
    const lineEnd = start + matched[0].length;
    return {
      heading: text.slice(start, lineEnd),
      start,
      lineEnd,
      nextStart: matches[index + 1]?.index ?? text.length,
    };
  });
}

/** Replace fenced code-block lines with spaces while preserving every source index. */
function maskFencedRegions(text: string): string {
  const lines = text.split(/(?<=\n)/);
  const masked = [...lines];

  for (let index = 0; index < lines.length; index++) {
    const body = lines[index]!.replace(/\r?\n$/, "");
    const candidate = body.match(/^ {0,3}(`{3,}|~{3,})/);
    if (!candidate) continue;

    const fenceChar = candidate[1]![0] as "`" | "~";
    const fenceLength = candidate[1]!.length;
    let closingIndex = -1;
    for (let next = index + 1; next < lines.length; next++) {
      const trimmed = lines[next]!.replace(/\r?\n$/, "").trim();
      if (trimmed.length >= fenceLength && [...trimmed].every((char) => char === fenceChar)) {
        closingIndex = next;
        break;
      }
    }

    // An unmatched opener may be ordinary prose; do not hide the rest of the profile.
    if (closingIndex === -1) continue;
    for (let fencedIndex = index; fencedIndex <= closingIndex; fencedIndex++) {
      masked[fencedIndex] = lines[fencedIndex]!.replace(/[^\r\n]/g, " ");
    }
    index = closingIndex;
  }

  return masked.join("");
}

function validateProfileOp(value: Record<string, unknown>): string | null {
  const unexpected = unexpectedKeys(value, [
    "kind",
    "agentId",
    "file",
    "op",
    "anchor",
    "content",
    "reason",
  ]);
  if (unexpected) return unexpected;
  if (!nonEmptyString(value.agentId)) return "profile-op requires agentId";
  if (!PROFILE_FILES.includes(value.file as ProfileFile))
    return "profile-op requires a supported file";
  return validateSectionFields(value, "profile-op");
}

function validateMemory(value: Record<string, unknown>): string | null {
  const unexpected = unexpectedKeys(value, [
    "kind",
    "agentId",
    "action",
    "content",
    "id",
    "memoryId",
    "name",
    "key",
    "scope",
    "tags",
    "reason",
  ]);
  if (unexpected) return unexpected;
  if (!nonEmptyString(value.agentId)) return "memory requires agentId";
  if (value.action !== "write" && value.action !== "delete")
    return "memory action must be write or delete";
  if (value.action === "write" && !nonEmptyString(value.content))
    return "memory write requires content";
  if (value.action === "delete" && !nonEmptyString(value.id) && !nonEmptyString(value.memoryId)) {
    return "memory delete requires id or memoryId";
  }
  if (value.scope !== undefined && value.scope !== "agent" && value.scope !== "swarm")
    return "memory scope must be agent or swarm";
  if (value.tags !== undefined && (!Array.isArray(value.tags) || !value.tags.every(nonEmptyString)))
    return "memory tags must be strings";
  return null;
}

function validateSkill(value: Record<string, unknown>): string | null {
  const unexpected = unexpectedKeys(value, [
    "kind",
    "action",
    "content",
    "skillId",
    "scope",
    "reason",
  ]);
  if (unexpected) return unexpected;
  if (value.action !== "create" && value.action !== "update")
    return "skill action must be create or update";
  if (!nonEmptyString(value.content)) return "skill requires content";
  if (value.action === "update" && !nonEmptyString(value.skillId))
    return "skill update requires skillId";
  if (value.scope !== undefined && value.scope !== "agent" && value.scope !== "swarm")
    return "skill scope must be agent or swarm";
  return null;
}

function validateHygiene(value: Record<string, unknown>): string | null {
  const unexpected = unexpectedKeys(value, [
    "kind",
    "agentId",
    "op",
    "anchor",
    "content",
    "rotationCursorKey",
    "rotationCursorNamespace",
    "rotationCursorBy",
    "reason",
  ]);
  if (unexpected) return unexpected;
  if (!nonEmptyString(value.agentId)) return "hygiene requires agentId";
  if (value.rotationCursorKey !== undefined && !nonEmptyString(value.rotationCursorKey))
    return "rotationCursorKey must be a string";
  if (value.rotationCursorNamespace !== undefined && !nonEmptyString(value.rotationCursorNamespace))
    return "rotationCursorNamespace must be a string";
  if (
    value.rotationCursorBy !== undefined &&
    (typeof value.rotationCursorBy !== "number" || !Number.isFinite(value.rotationCursorBy))
  )
    return "rotationCursorBy must be a finite number";
  return validateSectionFields(value, "hygiene");
}

function validateSectionFields(value: Record<string, unknown>, label: string): string | null {
  if (!PROFILE_OPS.includes(value.op as ProfileOp)) return `${label} requires a supported op`;
  if (!nonEmptyString(value.anchor)) return `${label} requires anchor`;
  if (
    (value.op === "append-under" || value.op === "replace-section") &&
    !nonEmptyString(value.content)
  ) {
    return `${label} ${value.op} requires content`;
  }
  return null;
}

function unexpectedKeys(value: Record<string, unknown>, allowed: string[]): string | null {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  return unexpected.length
    ? `unexpected field(s) for ${String(value.kind)}: ${unexpected.join(", ")}`
    : null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
