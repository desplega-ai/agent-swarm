import type { PageFilter } from "@desplega/storage";
import { normalizeAssetKey } from "../../assets/key";
import { literalPrefixPattern } from "../db";

/**
 * The repository filter of a page list: an exact `key`, else a `keyPrefix`,
 * and a free-text `q` the title, slug or description contains (wildcards taken
 * literally).
 */
export function pageFilter(
  opts: { key?: string; keyPrefix?: string; q?: string } | undefined,
  agentId?: string,
): PageFilter {
  return {
    agentId,
    key: opts?.key ? normalizeAssetKey(opts.key) : undefined,
    keyPattern:
      !opts?.key && opts?.keyPrefix
        ? literalPrefixPattern(normalizeAssetKey(opts.keyPrefix))
        : undefined,
    searchPattern: opts?.q ? `%${literalPrefixPattern(opts.q)}` : undefined,
  };
}
