import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { resolve } from "node:path";
import { test as base, expect as baseExpect } from "@playwright/test";

interface SwarmHandle {
  apiUrl: string;
  apiKey: string;
  dbPath: string;
}

interface ApiFixture {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
}

interface CleanFixture {
  assertClean(): Promise<void>;
}

interface TestFixtures {
  api: ApiFixture;
  clean: CleanFixture;
}

interface WorkerFixtures {
  swarm: SwarmHandle;
}

const packageRoot = resolve(import.meta.dirname, "..");

function requireUiUrl(): string {
  const uiUrl = process.env.E2E_UI_URL;
  if (!uiUrl) throw new Error("E2E_UI_URL was not set by global setup");
  return uiUrl;
}

async function readBootHandle(child: ChildProcessWithoutNullStreams): Promise<SwarmHandle> {
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  return new Promise((resolveHandle, reject) => {
    let stdout = "";
    const finish = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    const fail = (message: string) => {
      finish();
      reject(new Error(`${message}${stderr ? `\n${stderr}` : ""}`));
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      fail(`SUT boot exited before the handshake: code=${code} signal=${signal}`);
    };
    const onError = (error: Error) => {
      fail(`SUT boot could not be spawned: ${error.message}`);
    };
    const onData = (chunk: Buffer | string) => {
      stdout += chunk.toString();
      const newline = stdout.indexOf("\n");
      if (newline === -1) return;
      const line = stdout.slice(0, newline);
      try {
        const handle = JSON.parse(line) as Partial<SwarmHandle>;
        if (!handle.apiUrl || !handle.apiKey || !handle.dbPath) {
          fail(`Invalid SUT boot handshake: ${line}`);
          return;
        }
        finish();
        resolveHandle(handle as SwarmHandle);
      } catch {
        fail(`Invalid SUT boot handshake: ${line}`);
      }
    };
    const timeout = setTimeout(() => fail("SUT boot timed out after 90 seconds"), 90_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", onData);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

async function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolveExit) => {
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      resolveExit(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timeout);
      resolveExit(true);
    };
    child.once("exit", onExit);
  });
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  swarm: [
    async ({ browserName }, use, workerInfo) => {
      if (browserName !== "chromium") throw new Error(`Unsupported browser: ${browserName}`);
      const child = spawn("bun", ["boot/sut.ts"], {
        cwd: packageRoot,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let handle: SwarmHandle;
      try {
        handle = await readBootHandle(child);
      } catch (error) {
        child.kill("SIGKILL");
        throw error;
      }

      if (process.env.E2E_DEBUG) {
        console.error(`[ui-e2e] worker ${workerInfo.parallelIndex} api=${handle.apiUrl}`);
      }

      await use(handle);

      child.stdin.end();
      // stopSut waits up to 5 s for the API's SIGTERM shutdown before it SIGKILLs it.
      // The outer budget must outlast that window, or the boot child dies mid-stop
      // and leaves the API process behind.
      if (!(await waitForExit(child, 12_000))) {
        child.kill("SIGKILL");
        await waitForExit(child, 5_000);
      }
    },
    { scope: "worker" },
  ],
  // biome-ignore lint/correctness/noEmptyPattern: Playwright parses the destructuring pattern to resolve fixture dependencies
  baseURL: async ({}, use) => {
    await use(requireUiUrl());
  },
  storageState: async ({ swarm }, use) => {
    const uiUrl = requireUiUrl();
    await use({
      cookies: [],
      origins: [
        {
          // The origin must match the static UI server before the first page loads.
          origin: uiUrl,
          localStorage: [
            {
              name: "agent-swarm-connections",
              value: JSON.stringify({
                connections: [
                  {
                    id: "conn_e2e",
                    name: "e2e",
                    apiUrl: swarm.apiUrl,
                    apiKey: swarm.apiKey,
                  },
                ],
                activeId: "conn_e2e",
              }),
            },
          ],
        },
      ],
    });
  },
  clean: [
    async ({ page }, use) => {
      const consoleErrors: string[] = [];
      const failedApiResponses: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
      });
      page.on("response", (response) => {
        const url = new URL(response.url());
        if (!url.pathname.startsWith("/api")) return;
        if (process.env.E2E_DEBUG) {
          console.error(`[ui-e2e] ${response.status()} ${response.url()}`);
        }
        if (response.status() >= 400) {
          failedApiResponses.push(`${response.status()} ${response.url()}`);
        }
      });

      await use({
        assertClean: async () => {
          baseExpect(
            { consoleErrors, failedApiResponses },
            "Expected no browser console errors or failed API responses",
          ).toEqual({ consoleErrors: [], failedApiResponses: [] });
        },
      });
    },
    { auto: true },
  ],
  api: async ({ swarm }, use) => {
    const request = async <T>(method: "GET" | "POST", path: string, body?: unknown) => {
      const response = await fetch(`${swarm.apiUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${swarm.apiKey}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`${method} ${path} failed: ${response.status}`);
      return response.json() as Promise<T>;
    };
    await use({
      get: <T>(path: string) => request<T>("GET", path),
      post: <T>(path: string, body: unknown) => request<T>("POST", path, body),
    });
  },
});

export { expect } from "@playwright/test";
