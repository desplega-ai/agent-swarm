import { canWriteAssetKey, normalizeAssetKey, parseAssetKey } from "../assets/key";
import { findUserById } from "./users";

export class AssetKeyAuthorizationError extends Error {
  readonly statusCode: 400 | 403;

  constructor(message: string, statusCode: 400 | 403) {
    super(message);
    this.name = "AssetKeyAuthorizationError";
    this.statusCode = statusCode;
  }
}

/**
 * Normalize and authorize a create/move destination.
 *
 * `shared/*` preserves current entity authorization. A `personal/<user>/*`
 * write additionally requires that the path user exists and matches the
 * trusted user resolved from HTTP auth or an ownership-validated source task.
 */
export async function authorizeAssetKeyWrite(
  input: string,
  trustedUserId?: string | null,
): Promise<string> {
  let key: string;
  try {
    key = normalizeAssetKey(input);
  } catch (error) {
    throw new AssetKeyAuthorizationError(
      error instanceof Error ? error.message : "Invalid asset namespace key",
      400,
    );
  }

  const parsed = parseAssetKey(key);
  if (parsed.root === "shared") return key;
  if (!(await findUserById(parsed.userId))) {
    throw new AssetKeyAuthorizationError("Personal namespace user does not exist", 400);
  }
  if (!canWriteAssetKey(key, trustedUserId)) {
    throw new AssetKeyAuthorizationError(
      "Personal namespace writes require the matching trusted user",
      403,
    );
  }
  return key;
}
