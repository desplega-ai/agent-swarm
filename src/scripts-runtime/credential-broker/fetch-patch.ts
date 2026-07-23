import type { FailedCredentialBinding, ResolvedCredentialBinding } from "./types";

function hostnameForFetchInput(input: string | URL | Request): string | null {
  try {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function urlForFetchInput(input: string | URL | Request): URL | null {
  try {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    return new URL(url);
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

function applyQueryTemplates(url: URL, bindings: ResolvedCredentialBinding[]): boolean {
  let modified = false;

  for (const binding of bindings) {
    if (!binding.allowedHosts.includes(url.hostname) || !binding.queryTemplate) continue;
    const separator = binding.queryTemplate.indexOf("=");
    if (separator <= 0) continue;

    const paramName = binding.queryTemplate.slice(0, separator);
    const paramTemplate = binding.queryTemplate.slice(separator + 1);
    if (!paramTemplate.includes(binding.placeholder)) continue;

    const values = url.searchParams.getAll(paramName);
    if (values.length === 0) continue;

    url.searchParams.delete(paramName);
    for (const value of values) {
      const nextValue = value.includes(binding.placeholder)
        ? value.split(binding.placeholder).join(binding.value)
        : value;
      if (nextValue !== value) modified = true;
      url.searchParams.append(paramName, nextValue);
    }
  }

  return modified;
}

function assertNoFailedBinding(
  failedBindings: FailedCredentialBinding[],
  hostname: string,
  url: URL,
  headers: Headers,
): void {
  if (failedBindings.length === 0) return;
  for (const failed of failedBindings) {
    if (!failed.allowedHosts.includes(hostname)) continue;
    const inUrl = url.href.includes(failed.placeholder);
    const inHeaders = [...headers.values()].some((value) => value.includes(failed.placeholder));
    if (inUrl || inHeaders) {
      throw new Error(
        `OAuth authorization '${failed.authorizationLabel ?? "unknown"}' is in refresh-failed state: ${failed.reason}`,
      );
    }
  }
}

export function patchFetchWithCredentialBroker(
  bindings: ResolvedCredentialBinding[],
  failedBindings: FailedCredentialBinding[] = [],
): void {
  if (bindings.length === 0 && failedBindings.length === 0) return;

  const originalFetch = globalThis.fetch;

  globalThis.fetch = function patchedFetch(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    const url = urlForFetchInput(input);
    const hostname = url?.hostname ?? hostnameForFetchInput(input);
    if (!hostname || !url) return originalFetch(input, init);

    const headers = new Headers(input instanceof Request ? input.headers : init?.headers);

    // Fail closed: a request that would carry a broken binding's placeholder to
    // its host throws a typed error instead of leaking the placeholder.
    assertNoFailedBinding(failedBindings, hostname, url, headers);

    let headersModified = false;
    const newHeaders = new Headers();

    for (const [key, rawValue] of headers.entries()) {
      let value = rawValue;
      for (const binding of bindings) {
        if (binding.allowedHosts.includes(hostname) && value.includes(binding.placeholder)) {
          value = value.split(binding.placeholder).join(binding.value);
          headersModified = true;
        }
      }
      newHeaders.set(key, value);
    }

    const urlModified = applyQueryTemplates(url, bindings);

    if (!headersModified && !urlModified) return originalFetch(input, init);

    const mergedInit: RequestInit = {
      ...cloneRequestInit(input, init),
      headers: headersModified || input instanceof Request ? newHeaders : init?.headers,
    };
    const nextUrl = urlModified ? url.href : input instanceof Request ? input.url : input;
    return originalFetch(nextUrl, mergedInit);
  } as typeof fetch;
}
