export type RuntimeFetchOptions = RequestInit & {
  retries?: number;
  timeoutMs?: number;
};

export async function runtimeFetch(
  input: string | URL | Request,
  options: RuntimeFetchOptions = {},
): Promise<unknown> {
  const { retries = 3, timeoutMs = 30_000, signal, ...init } = options;
  let lastError: unknown;

  for (let attempt = 0; attempt < retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const res = await fetch(input, { ...init, signal: controller.signal });
      if (!res.ok && attempt < retries - 1 && res.status >= 500) {
        lastError = new Error(`fetch failed with ${res.status}`);
        continue;
      }
      const contentType = res.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) return await res.json();
      return await res.text();
    } catch (error) {
      lastError = error;
      if (attempt === retries - 1) break;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
