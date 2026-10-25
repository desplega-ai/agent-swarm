/**
 * Network helpers shared by every test that binds a port.
 *
 * The root suite runs under `bun test --parallel` (one worker process per
 * file), so a fixed port literal in one file collides with another file.
 * Always bind an OS-assigned port: `listenOnFreePort(server)` for an
 * in-process `node:http` server, `getFreePort()` for a port that must be known
 * before the server exists (spawned `src/http.ts` children take it via `PORT`).
 * A spawned child can lose that port before it binds; `startOnFreePort` retries
 * it on a new one.
 */
import { createServer, type Server } from "node:net";

/** Reserve and release an OS-assigned TCP port, returning its number. */
export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, () => {
      const address = srv.address();
      if (address === null || typeof address === "string") {
        srv.close();
        reject(new Error("could not determine free port"));
        return;
      }
      const port = address.port;
      srv.close(() => resolve(port));
    });
  });
}

/** Matches the boot error a server prints when its port is already bound. */
export const PORT_IN_USE_LOG = /EADDRINUSE|Is port \d+ in use\?/;

/** Thrown by a `startOnFreePort` callback when the server lost its port to another process. */
export class PortInUseError extends Error {}

/**
 * Start a server on a getFreePort() port, and on a new port when `start`
 * throws PortInUseError. getFreePort() releases the port before the spawned
 * server binds it, and under `bun test --parallel` another process can take
 * it during the server's boot. Any other error, or the last attempt's
 * PortInUseError, propagates unchanged.
 */
export async function startOnFreePort<T>(
  start: (port: number) => Promise<T>,
  opts: { attempts?: number; getPort?: () => Promise<number> } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const getPort = opts.getPort ?? getFreePort;
  for (let attempt = 1; ; attempt++) {
    const port = await getPort();
    try {
      return await start(port);
    } catch (error) {
      if (!(error instanceof PortInUseError) || attempt >= attempts) throw error;
    }
  }
}

/**
 * Bind `server` to port 0 and return the assigned port. Binds all interfaces
 * unless `host` is given, matching a bare `server.listen(0)`, so
 * `http://localhost:<port>` resolves whichever address family the OS prefers.
 */
export function listenOnFreePort(server: Server, host?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onListening = () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("could not determine listening port"));
        return;
      }
      resolve(address.port);
    };
    server.once("error", reject);
    if (host === undefined) server.listen(0, onListening);
    else server.listen(0, host, onListening);
  });
}

/**
 * Poll `url` until it answers 2xx. The deadline is a ceiling: a healthy
 * `src/http.ts` boot takes ~1 s, but under `--parallel` load on a shared
 * runner it can take much longer, so callers' hook timeouts must exceed it.
 */
export async function waitForServer(url: string, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      // not ready yet
    }
    await Bun.sleep(50);
  }
  throw new Error(`Server did not start within ${timeoutMs}ms`);
}

/** Hook timeout for `beforeAll` blocks that spawn `src/http.ts` and await `waitForServer`. */
export const SERVER_BOOT_HOOK_TIMEOUT_MS = 90_000;
