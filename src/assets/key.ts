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
