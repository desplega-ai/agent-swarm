import type { ScopedFetch } from "./types.ts";

export class ScopedFetchError extends Error {
  override name = "ScopedFetchError";
}

/** True when `path` names its own origin ("https://x", "//x") instead of a path. */
function isAbsolute(path: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("//");
}

/**
 * fetch bound to one origin. Relative paths are appended to `baseUrl`, keeping
 * its path prefix (`https://openrouter.ai/api` + `/v1/models` →
 * `https://openrouter.ai/api/v1/models`). A URL on any other origin throws
 * before the network is touched, and redirects are never followed, so a route's
 * credential cannot reach a host other than its own.
 */
export function createScopedFetch(baseUrl: string, impl?: typeof fetch): ScopedFetch {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new ScopedFetchError(`Invalid route base URL: ${baseUrl}`);
  }
  const prefix = base.href.replace(/\/+$/, "");
  return (path, init) => {
    let target: URL;
    try {
      target = isAbsolute(path)
        ? new URL(path, base)
        : new URL(`${prefix}/${path.replace(/^\/+/, "")}`);
    } catch {
      return Promise.reject(new ScopedFetchError(`Invalid route path: ${path}`));
    }
    if (target.origin !== base.origin) {
      return Promise.reject(
        new ScopedFetchError(
          `Refusing request to ${target.origin}: route is scoped to ${base.origin}`,
        ),
      );
    }
    // Read globalThis.fetch per call so test doubles installed later still apply.
    const doFetch = impl ?? globalThis.fetch;
    return doFetch(target.href, { ...init, redirect: "manual" });
  };
}
