import { randomBytes } from "node:crypto";
import { createServer } from "node:net";

export const repoRoot = `${import.meta.dir}/../..`;

export type Sut = {
  port: number;
  baseUrl: string;
  apiKey: string;
  dbPath: string;
  logPath: string;
  logPaths: string[];
  tempPaths: string[];
  process: Bun.Subprocess<"ignore", "pipe", "pipe">;
  flushLog: () => void;
  drains: Promise<void>;
  env: Record<string, string>;
};

export function minimalEnv(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "USER", "SHELL", "LANG"]) {
    const value = process.env[key];
    if (value) result[key] = value;
  }
  return result;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate a TCP port"));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function drain(stream: ReadableStream<Uint8Array>, writer: Bun.FileSink) {
  return (async () => {
    for await (const chunk of stream) writer.write(chunk);
  })();
}

function spawnSutProcess(logPath: string, env: Record<string, string>) {
  const writer = Bun.file(logPath).writer();
  const child = Bun.spawn(["bun", "run", "src/http.ts"], {
    cwd: repoRoot,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const drains = Promise.all([drain(child.stdout, writer), drain(child.stderr, writer)])
    .then(() => undefined)
    .finally(() => writer.end());
  return { child, drains, flushLog: () => writer.flush() };
}

async function waitForHealth(sut: Sut, keep: boolean): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (sut.process.exitCode !== null) break;
    try {
      const response = await fetch(`${sut.baseUrl}/health`);
      if (response.status === 200) return;
    } catch {}
    await Bun.sleep(250);
  }
  sut.flushLog();
  const tail = await tailLog(sut.logPath, 40);
  sut.process.kill("SIGKILL");
  await sut.process.exited.catch(() => {});
  await sut.drains.catch(() => {});
  if (keep) {
    console.log(`KEEP db: ${sut.dbPath}`);
    for (const path of sut.logPaths) console.log(`KEEP API log: ${path}`);
    for (const path of sut.tempPaths) console.log(`KEEP temp: ${path}`);
  } else {
    await deleteSutState(sut);
  }
  throw new Error(`API server did not become healthy within 60 seconds\n${tail}`);
}

async function stopSutProcess(sut: Sut): Promise<void> {
  if (sut.process.exitCode === null) {
    sut.process.kill("SIGTERM");
    await Promise.race([sut.process.exited, Bun.sleep(5_000)]);
  }
  if (sut.process.exitCode === null) {
    sut.process.kill("SIGKILL");
    await sut.process.exited.catch(() => {});
  }
  await sut.drains.catch(() => {});
}

async function deleteSutState(sut: Sut): Promise<void> {
  for (const path of [sut.dbPath, `${sut.dbPath}-wal`, `${sut.dbPath}-shm`, ...sut.logPaths]) {
    await Bun.file(path)
      .delete()
      .catch(() => {});
  }
  for (const path of sut.tempPaths) await Bun.$`rm -rf ${path}`.quiet().catch(() => {});
}

export async function tailLog(path: string, lines: number): Promise<string> {
  const text = await Bun.file(path)
    .text()
    .catch(() => "");
  return text.split("\n").slice(-lines).join("\n");
}

export async function startSut(
  keep: boolean,
  slackEnv: Record<string, string>,
  extraEnv: Record<string, string> = {},
): Promise<Sut> {
  const stamp = `${Date.now()}-${randomBytes(4).toString("hex")}`;
  const port = await freePort();
  const apiKey = randomBytes(16).toString("hex");
  const dbPath = `/tmp/e2e-${stamp}.sqlite`;
  const logPath = `/tmp/e2e-api-${stamp}.log`;
  const fsDir = `/tmp/e2e-fs-${stamp}`;
  const secretsDir = `/tmp/e2e-secrets-${stamp}`;
  const secretsPath = `${secretsDir}/key`;
  await Bun.$`mkdir -p ${fsDir} ${secretsDir}`.quiet();
  await Bun.write(secretsPath, randomBytes(32).toString("base64"));

  const env = {
    ...minimalEnv(),
    PORT: String(port),
    API_KEY: apiKey,
    AGENT_SWARM_API_KEY: apiKey,
    DATABASE_PATH: dbPath,
    // test, not development: the Slack socket-mode guard refuses to connect
    // under development, and every run drives Slack through the mock.
    NODE_ENV: "test",
    AGENT_FS_LOCAL_DIR: fsDir,
    SECRETS_ENCRYPTION_KEY_FILE: secretsPath,
    ...slackEnv,
    OAUTH_KEEPALIVE_DISABLE: "true",
    GITHUB_DISABLE: "true",
    GITHUB_WEBHOOK_SECRET: "",
    LINEAR_DISABLE: "true",
    JIRA_DISABLE: "true",
    AGENTMAIL_DISABLE: "true",
    AGENTMAIL_API_KEY: "",
    ANONYMIZED_TELEMETRY: "false",
    ...extraEnv,
  };
  const spawned = spawnSutProcess(logPath, env);
  const sut: Sut = {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey,
    dbPath,
    logPath,
    logPaths: [logPath],
    tempPaths: [fsDir, secretsDir],
    process: spawned.child,
    flushLog: spawned.flushLog,
    drains: spawned.drains,
    env,
  };
  await waitForHealth(sut, keep);
  return sut;
}

/** Restart only the API process while preserving every externalized SUT resource. */
export async function restartSut(sut: Sut): Promise<void> {
  await stopSutProcess(sut);
  sut.logPath = `${sut.logPaths[0]}.restart-${sut.logPaths.length}`;
  sut.logPaths.push(sut.logPath);
  const spawned = spawnSutProcess(sut.logPath, sut.env);
  sut.process = spawned.child;
  sut.flushLog = spawned.flushLog;
  sut.drains = spawned.drains;
  await waitForHealth(sut, true);
}

export async function stopSut(sut: Sut, keep: boolean): Promise<void> {
  await stopSutProcess(sut);
  if (keep) {
    console.log(`KEEP db: ${sut.dbPath}`);
    for (const path of sut.logPaths) console.log(`KEEP API log: ${path}`);
    for (const path of sut.tempPaths) console.log(`KEEP temp: ${path}`);
    return;
  }
  await deleteSutState(sut);
}
