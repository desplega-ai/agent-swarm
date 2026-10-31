// biome-ignore-all lint/suspicious/noExplicitAny: scratch e2e fixtures read untyped JSON
// Shared helpers: boots a throwaway local agent-fs daemon (local storage, temp HOME, no embeddings).
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const AFS_REPO = process.env.AFS_REPO ?? "/workspace/personal/repos/agent-fs";

export async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
}

export type Daemon = {
  url: string;
  port: number;
  home: string;
  log: string;
  stop: () => Promise<void>;
  proc: Bun.Subprocess;
};

export async function startDaemon(
  extraEnv: Record<string, string> = {},
  opts: { expectFail?: boolean } = {},
): Promise<Daemon & { exited?: number }> {
  const home = mkdtempSync(join(tmpdir(), "afs-gap-"));
  const port = await freePort();
  const log = join(home, "daemon.log");
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    AGENT_FS_HOME: home,
    AGENT_FS_STORAGE_PROVIDER: "local",
    AGENT_FS_LOCAL_ROOT: join(home, "storage"),
    EMBEDDING_PROVIDER: "none",
    SERVER_PORT: String(port),
    SERVER_HOST: "127.0.0.1",
    AGENT_FS_RATE_LIMIT: "0",
    AGENT_FS_SHARE_RATE_LIMIT: "0",
    ANONYMIZED_TELEMETRY: "false",
    AGENT_FS_TELEMETRY_DISABLED: "1",
    DO_NOT_TRACK: "1",
    ...extraEnv,
  };
  const proc = Bun.spawn(["bun", "packages/server/src/index.ts"], {
    cwd: AFS_REPO,
    env,
    stdout: Bun.file(log),
    stderr: Bun.file(log),
  });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  let up = false;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) break;
    try {
      if ((await fetch(`${url}/health`)).status === 200) {
        up = true;
        break;
      }
    } catch {}
    await Bun.sleep(250);
  }
  const stop = async () => {
    if (proc.exitCode === null) {
      proc.kill("SIGTERM");
      await Promise.race([proc.exited, Bun.sleep(3000)]);
    }
    if (proc.exitCode === null) proc.kill("SIGKILL");
    rmSync(home, { recursive: true, force: true });
  };
  if (!up && !opts.expectFail) {
    const t = await Bun.file(log).text();
    await stop();
    throw new Error(`daemon did not start:\n${t.slice(-1500)}`);
  }
  return { url, port, home, log, stop, proc, exited: proc.exitCode ?? undefined };
}

export async function http(
  base: string,
  method: string,
  path: string,
  opts: { key?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.key) headers.Authorization = `Bearer ${opts.key}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const r = await fetch(base + path, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await r.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: r.status, json, text };
}

export async function register(base: string, email: string) {
  const r = await http(base, "POST", "/auth/register", { body: { email } });
  if (r.status !== 200) throw new Error(`register ${email} -> ${r.status} ${r.text}`);
  return r.json as { apiKey: string; userId: string; orgId: string };
}

const failures: string[] = [];
let checks = 0;
export function check(name: string, ok: boolean, detail = "") {
  checks++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` :: ${detail}` : ""}`);
  if (!ok) failures.push(name);
}
export function finish(label: string): never {
  console.log(`\n${label}: ${checks - failures.length}/${checks} checks passed`);
  process.exit(failures.length ? 1 : 0);
}
