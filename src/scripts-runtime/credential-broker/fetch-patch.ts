import type { ResolvedCredentialBinding } from "./types";

function hostnameForFetchInput(input: string | URL | Request): string | null {
  try {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function cloneRequestInit(input: string | URL | Request, init?: RequestInit): RequestInit {
  return {
    ...(input instanceof Request
      ? {
          method: input.method,
          body: input.body,
          redirect: input.redirect,
          signal: input.signal,
        }
      : {}),
    ...init,
  };
}

export function patchFetchWithCredentialBroker(bindings: ResolvedCredentialBinding[]): void {
  if (bindings.length === 0) return;

  const originalFetch = globalThis.fetch;

  globalThis.fetch = function patchedFetch(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    const hostname = hostnameForFetchInput(input);
    if (!hostname) return originalFetch(input, init);

    const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
    let modified = false;
    const newHeaders = new Headers();

    for (const [key, rawValue] of headers.entries()) {
      let value = rawValue;
      for (const binding of bindings) {
        if (binding.allowedHosts.includes(hostname) && value.includes(binding.placeholder)) {
          value = value.split(binding.placeholder).join(binding.value);
          modified = true;
        }
      }
      newHeaders.set(key, value);
    }

    if (!modified) return originalFetch(input, init);

    const mergedInit: RequestInit = {
      ...cloneRequestInit(input, init),
      headers: newHeaders,
    };
    const url = input instanceof Request ? input.url : input;
    return originalFetch(url, mergedInit);
  } as typeof fetch;
}
