import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, stat, unlink } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { assertAllowedTarget, readTarget } from "./boot/policy";

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

export default async function globalSetup(): Promise<() => Promise<void>> {
  const cleanups: (() => Promise<void>)[] = [];
  const teardown = async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
  };
  const target = readTarget(process.env);
  if (target.mode === "remote") {
    assertAllowedTarget(target.apiUrl);
    // Read by the clean fixture: a prestarted remote API cannot list the random
    // static UI origin in its CSP frame-ancestors.
    if (!target.uiUrl) process.env.E2E_REMOTE_STATIC_UI = "1";
    if (target.seed) {
      const manifestPath = join(tmpdir(), `agent-swarm-ui-e2e-${randomUUID()}.json`);
      const result = spawnSync(
        "bun",
        ["boot/seed-cli.ts", target.apiUrl, target.apiKey, manifestPath],
        {
          cwd: resolve(import.meta.dirname),
          stdio: "inherit",
        },
      );
      if (result.error) throw result.error;
      if (result.status !== 0) {
        throw new Error(`Remote seed failed with exit code ${result.status ?? "unknown"}`);
      }
      process.env.E2E_REMOTE_MANIFEST = manifestPath;
      cleanups.push(() => unlink(manifestPath).catch(() => undefined));
    }
  }

  if (process.env.E2E_UI_URL) return teardown;

  const distDir = resolve(import.meta.dirname, "../../apps/ui/dist");
  const indexPath = resolve(distDir, "index.html");
  try {
    await stat(indexPath);
  } catch {
    throw new Error("run `bun run e2e:ui` or build apps/ui first");
  }

  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
      const requestedPath = resolve(distDir, pathname.replace(/^\/+/, ""));
      const isInsideDist =
        requestedPath === distDir || requestedPath.startsWith(`${distDir}${sep}`);
      let filePath = isInsideDist ? requestedPath : indexPath;

      try {
        if (!(await stat(filePath)).isFile()) filePath = indexPath;
      } catch {
        filePath = indexPath;
      }

      const body = await readFile(filePath);
      response.writeHead(200, {
        "Content-Type": contentTypes[extname(filePath)] ?? "application/octet-stream",
      });
      response.end(body);
    } catch (error) {
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(error instanceof Error ? error.message : "Static server error");
    }
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Failed to allocate the UI server port");
  }
  process.env.E2E_UI_URL = `http://127.0.0.1:${address.port}`;

  cleanups.push(
    () =>
      new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
      }),
  );
  return teardown;
}
