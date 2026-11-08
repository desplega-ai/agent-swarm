export const DEFAULT_ASSET_KEY = "shared/" as const;
export const ASSET_KEY_MAX_LENGTH = 255;

export type AssetKeyResource =
  | "task"
  | "workflow"
  | "schedule"
  | "page"
  | "app"
  | "script"
  | `fs:${string}`;

export type SharedAssetNamespace = {
  root: "shared";
  key: string;
  segments: string[];
  relativeSegments: string[];
};

export type PersonalAssetNamespace = {
  root: "personal";
  key: string;
  segments: string[];
  userId: string;
  relativeSegments: string[];
};

export type AssetNamespace = SharedAssetNamespace | PersonalAssetNamespace;

export class AssetKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssetKeyError";
  }
}

/**
 * Normalize a v1 asset namespace into its canonical directory form.
 *
 * Keys are grouping metadata, not identity: repeated values are valid and
 * expected. The supported roots are `shared/` and
 * `personal/<canonical-user-id>/`. Existing-user validation is deliberately
 * performed at the database/authorization boundary so this parser stays pure.
 */
export function normalizeAssetKey(input: string): string {
  if (typeof input !== "string") throw new AssetKeyError("Asset key must be a string");
  if (input.includes("\0")) throw new AssetKeyError("Asset key cannot contain NUL bytes");
  if (input.includes("\\")) throw new AssetKeyError("Asset key must use forward slashes");

  const normalized = input.trim().normalize("NFKC").toLowerCase();
  if (!normalized) throw new AssetKeyError("Asset key cannot be empty");
  if (normalized.startsWith("/")) throw new AssetKeyError("Asset key must be relative");

  const withTrailingSlash = normalized.endsWith("/") ? normalized : `${normalized}/`;
  if (withTrailingSlash.length > ASSET_KEY_MAX_LENGTH) {
    throw new AssetKeyError(`Asset key cannot exceed ${ASSET_KEY_MAX_LENGTH} characters`);
  }

  const segments = withTrailingSlash.slice(0, -1).split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new AssetKeyError("Asset key contains an empty or traversal segment");
  }

  const root = segments[0];
  if (root !== "shared" && root !== "personal") {
    throw new AssetKeyError("Asset key root must be shared or personal");
  }
  if (root === "personal" && !segments[1]) {
    throw new AssetKeyError("Personal asset keys require a canonical user ID");
  }

  return withTrailingSlash;
}

/**
 * Build the deterministic default namespace for a newly created resource.
 * The shared/personal prefix remains the ownership/grouping boundary; the
 * resource-specific leaf prevents unrelated assets from collapsing into the
 * same catch-all key when callers omit `key`.
 */
export function defaultAssetKey(resource: AssetKeyResource, id: string): string {
  if (!id.trim()) throw new AssetKeyError("Asset key resource ID cannot be empty");
  return normalizeAssetKey(`shared/${resource}:${id}/`);
}

/** Bounds for an indexed, literal prefix lookup on canonical asset keys. */
export function keyPrefixRange(prefix: string): { lo: string; hi: string } {
  const lo = normalizeAssetKey(prefix);
  return { lo, hi: `${lo.slice(0, -1)}${String.fromCharCode(lo.charCodeAt(lo.length - 1) + 1)}` };
}

/**
 * Resource kinds whose default key (`defaultAssetKey`) names a session group
 * of its own. At a namespace root (`shared/<kind>:<id>/`,
 * `personal/<me>/<kind>:<id>/`) the leaf is the group, shown under a section
 * per kind (Pages, Workflows, ...). Below a user group it is a plain leaf.
 */
export const SESSION_RESOURCE_KINDS = [
  "page",
  "workflow",
  "schedule",
  "app",
  "script",
  "fs",
] as const;
export type SessionResourceKind = (typeof SESSION_RESOURCE_KINDS)[number];

/** Leaves that file a session into the group above them. */
export const SESSION_LEAF_KINDS = ["task", "thread", ...SESSION_RESOURCE_KINDS] as const;
/** The leaves a namespace root (`shared/`, `personal/<me>/`) holds as No group. */
export const NO_GROUP_LEAF_KINDS = ["task", "thread"] as const;
const sessionLeafPattern = new RegExp(`/(${SESSION_LEAF_KINDS.join("|")}):[^/]+/$`);

/** A user group key excludes namespace roots and resource leaves. */
export function isGroupKey(key: string): boolean {
  const parsed = parseAssetKey(key);
  return parsed.relativeSegments.length > 0 && !sessionLeafPattern.test(parsed.key);
}
const resourceGroupPattern = new RegExp(
  `^(shared/|personal/[^/]+/)((${SESSION_RESOURCE_KINDS.join("|")}):([^/]+))/(?:(action:[^/]+)/)?`,
);

const resourcePrefixPattern = new RegExp(
  `^(?:shared/|personal/[^/]+/)(?:${SESSION_RESOURCE_KINDS.join("|")}):`,
);

/** Whether a key sits under a resource group (`shared/<kind>:...`), which is read-only. */
export function isResourceGroupPrefix(key: string): boolean {
  return resourcePrefixPattern.test(key);
}

export const RESOURCE_GROUPS_READ_ONLY = "Resource groups are read-only.";

/** The resource a session group belongs to, from `sessionGroupKey`. */
export interface SessionResourceGroup {
  kind: SessionResourceKind;
  /** The resource id (`fs` ids keep their provider: `agent-fs:<id>`). */
  id: string;
  /** The namespace root: `shared/` or `personal/<user>/`. */
  base: string;
  /** The group of the resource itself: `<base><kind>:<id>/`. */
  resourceKey: string;
  /** An app action below the app (`shared/app:<id>/action:<name>/`). */
  action?: string;
}

/**
 * The resource of a session group key, or null. Only exact resource groups
 * match: `<base><kind>:<id>/`, or `<base>app:<id>/action:<name>/`. The UI
 * mirrors this in `apps/ui/src/lib/session-groups.ts` (pinned by a test).
 */
export function sessionResourceGroupOf(groupKey: string): SessionResourceGroup | null {
  const match = resourceGroupPattern.exec(groupKey);
  if (!match || match[0] !== groupKey) return null;
  const kind = match[3] as SessionResourceKind;
  if (match[5] && kind !== "app") return null;
  return {
    kind,
    id: match[4]!,
    base: match[1]!,
    resourceKey: `${match[1]}${match[2]}/`,
    ...(match[5] ? { action: match[5].slice("action:".length) } : {}),
  };
}

/**
 * A root key's session group: the key without its trailing `<kind>:<id>/`
 * leaf, preserving user groups that contain a colon. A resource leaf right at
 * a namespace root stays: it is the resource's group (`shared/page:<id>/`).
 */
export function sessionGroupKey(key: string): string {
  const normalized = normalizeAssetKey(key);
  const namespace = parseAssetKey(normalized);
  if (namespace.relativeSegments.length === 0) return normalized;
  const leaf = sessionLeafPattern.exec(normalized);
  if (!leaf) return normalized;
  const group = normalized.slice(0, leaf.index + 1);
  const resource = (SESSION_RESOURCE_KINDS as readonly string[]).includes(leaf[1]!);
  return resource && parseAssetKey(group).relativeSegments.length === 0 ? normalized : group;
}

export function parseAssetKey(input: string): AssetNamespace {
  const key = normalizeAssetKey(input);
  const segments = key.slice(0, -1).split("/");
  if (segments[0] === "personal") {
    return {
      root: "personal",
      key,
      segments,
      userId: segments[1]!,
      relativeSegments: segments.slice(2),
    };
  }
  return {
    root: "shared",
    key,
    segments,
    relativeSegments: segments.slice(1),
  };
}

export function isCanonicalAssetKey(input: string): boolean {
  try {
    return normalizeAssetKey(input) === input;
  } catch {
    return false;
  }
}

/**
 * Personal namespaces are write-scoped to the trusted resolved user. This is
 * intentionally only a write rule: v1 personal keys are labels, not a privacy
 * or read-visibility guarantee.
 */
export function canWriteAssetKey(input: string, trustedUserId?: string | null): boolean {
  const parsed = parseAssetKey(input);
  return parsed.root === "shared" || (!!trustedUserId && parsed.userId === trustedUserId);
}
