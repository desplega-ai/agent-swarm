/** Worker boot step; deliberately standalone so both worker images can run it before setup. */
export interface ApiReadinessDependencies {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (message: string) => void;
}

const defaults: ApiReadinessDependencies = {
  fetch: (url, init) => fetch(url, init),
  now: () => performance.now(),
  sleep: (ms) => Bun.sleep(ms),
  log: (message) => console.log(message),
};

/** Poll the unauthenticated health endpoint before any provider reads configuration. */
export async function waitForApiReady(
  baseUrl: string,
  timeoutValue = "90",
  dependencies: Partial<ApiReadinessDependencies> = {},
): Promise<boolean> {
  const { fetch: probe, now, sleep, log } = { ...defaults, ...dependencies };
  const raw = timeoutValue || "90";
  const seconds = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(seconds) || seconds <= 0) {
    log(
      `[entrypoint] FATAL: WORKER_API_READY_TIMEOUT_SECONDS must be a positive integer, got '${raw}'; exiting.`,
    );
    return false;
  }

  const url = `${baseUrl.replace(/\/$/, "")}/health`;
  const deadline = now() + seconds * 1000;
  log(`[entrypoint] Waiting for API readiness at ${url} (timeout ${raw}s)...`);
  while (true) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.min(3000, Math.max(1, deadline - now())),
    );
    try {
      const response = await probe(url, { redirect: "manual", signal: controller.signal });
      // curl -o /dev/null waited for the whole response, without retaining its body.
      if (response.body) {
        for await (const _chunk of response.body) {
          // Discard health output, including error bodies, within the request timeout.
        }
      }
      // Match curl -f without -L: redirects are successful and are not followed.
      if (response.status > 0 && response.status < 400 && now() <= deadline) {
        log(`[entrypoint] API ready at ${url}`);
        return true;
      }
    } catch {
      // The API can still be booting; retry connection, HTTP and timeout failures alike.
    } finally {
      clearTimeout(timer);
    }
    if (now() >= deadline) {
      log(`[entrypoint] FATAL: API readiness timed out after ${raw}s waiting for ${url}; exiting.`);
      return false;
    }
    await sleep(Math.min(1000, deadline - now()));
  }
}

if (import.meta.main) {
  process.exitCode = (await waitForApiReady(
    Bun.argv[2] ?? "http://host.docker.internal:3013",
    Bun.argv[3],
  ))
    ? 0
    : 1;
}
