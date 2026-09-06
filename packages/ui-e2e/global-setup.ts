import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";

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

export default async function globalSetup(): Promise<(() => Promise<void>) | undefined> {
  if (process.env.E2E_UI_URL) return;

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

  return async () => {
    await new Promise<void>((resolveClose, reject) => {
      server.close((error) => (error ? reject(error) : resolveClose()));
    });
  };
}
