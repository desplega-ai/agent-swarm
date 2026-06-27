import type { EgressSecretEntry } from "./executors/types";

/**
 * Hardcoded allowlist mapping env-var names to the hosts where egress
 * substitution is permitted. Adding a new entry here is a security-boundary
 * decision — it lets scripts authenticate to that host without the caller
 * passing the secret explicitly.
 */
const EGRESS_ALLOWLIST: Record<string, string[]> = {
  GITHUB_TOKEN: ["api.github.com"],
};

export function buildEgressSecrets(): EgressSecretEntry[] {
  const entries: EgressSecretEntry[] = [];
  for (const [envKey, hosts] of Object.entries(EGRESS_ALLOWLIST)) {
    const value = process.env[envKey];
    if (!value) continue;
    entries.push({
      placeholder: `[REDACTED:${envKey}]`,
      hosts,
      value,
    });
  }
  return entries;
}

export function patchFetchWithEgressSubstitution(secrets: EgressSecretEntry[]): void {
  if (secrets.length === 0) return;

  const byPlaceholder = new Map<string, EgressSecretEntry>();
  for (const entry of secrets) {
    byPlaceholder.set(entry.placeholder, entry);
  }

  const originalFetch = globalThis.fetch;

  globalThis.fetch = function patchedFetch(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    let hostname: string;
    try {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
      hostname = new URL(url).hostname;
    } catch {
      return originalFetch(input, init);
    }

    const headers = new Headers(input instanceof Request ? input.headers : init?.headers);

    let modified = false;
    const newHeaders = new Headers();

    for (const [key, rawValue] of headers.entries()) {
      let value = rawValue;
      for (const [placeholder, entry] of byPlaceholder) {
        if (value.includes(placeholder) && entry.hosts.includes(hostname)) {
          value = value.split(placeholder).join(entry.value);
          modified = true;
        }
      }
      newHeaders.set(key, value);
    }

    if (!modified) return originalFetch(input, init);

    const mergedInit: RequestInit = {
      ...(input instanceof Request
        ? {
            method: input.method,
            body: input.body,
            redirect: input.redirect,
            signal: input.signal,
          }
        : {}),
      ...init,
      headers: newHeaders,
    };

    const url = input instanceof Request ? input.url : input;
    return originalFetch(url, mergedInit);
  } as typeof fetch;
}
