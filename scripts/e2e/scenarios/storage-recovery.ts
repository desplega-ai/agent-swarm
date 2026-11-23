import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createPostgresDatabase,
  dropPostgresDatabase,
  openReadOnlyDb,
  preparePostgresQueryReader,
  sql,
} from "../db";
import {
  type ApiClient,
  asRecord,
  asRecords,
  asString,
  createApiClient,
  expect,
  expectStatus,
  pollUntil,
} from "../http";
import { knownSecrets, redactSecrets } from "../redact";
import type { Scenario } from "../run";
import { minimalEnv, restartSut, type Sut, startFixtureSut, startSut, stopSut } from "../sut";

async function createTask(api: ApiClient, text: string) {
  const response = await api("POST", "/api/tasks", {
    body: { task: text, followUpConfig: { disabled: true } },
  });
  expectStatus(response, [201], "create recovery fixture task");
  return { id: asString(asRecord(response.json).id, "created task id"), text };
}

async function readTask(api: ApiClient, task: { id: string; text: string }) {
  const response = await api("GET", `/api/tasks/${task.id}`);
  expectStatus(response, [200], "read recovered task");
  const row = asRecord(response.json);
  expect(row.id === task.id && row.task === task.text, `Recovered task ${task.id} differs`);
}

async function killApi(sut: Sut) {
  sut.process.kill("SIGKILL");
  await sut.process.exited;
  expect(sut.process.signalCode === "SIGKILL", "The API did not exit from SIGKILL");
}

async function sqliteRecovery(nonce: string) {
  const { sut, fixture } = await startFixtureSut(false, "base-db", {}, "sqlite");
  const api = createApiClient(sut.baseUrl, sut.apiKey);
  const snapshot = openReadOnlyDb(sut.dbPath);
  try {
    // Pin a reader before the write so SQLite cannot checkpoint that write into the main file.
    snapshot.get("BEGIN");
    const oldId = asString(fixture.meta.taskId, "historical task id");
    expect(
      snapshot.get(sql`SELECT id FROM agent_tasks WHERE id = ${oldId}`),
      "Missing historical task",
    );
    const acknowledged = await createTask(api, `WAL recovery ${nonce}`);
    await killApi(sut);

    const dir = await mkdtemp(join(tmpdir(), "e2e-recover-sqlite-"));
    sut.tempPaths.push(dir);
    const restored = join(dir, "recovered.sqlite");
    await Bun.write(restored, Bun.file(sut.dbPath));
    // This copy has no WAL sidecars. Read its checkpoint without creating any.
    const mainOnly = openReadOnlyDb(`${pathToFileURL(restored).href}?immutable=1`);
    try {
      expect(
        mainOnly.get(sql`SELECT id FROM agent_tasks WHERE id = ${oldId}`),
        "Missing historical task in the checkpoint",
      );
      expect(
        mainOnly.get(sql`SELECT id FROM agent_tasks WHERE id = ${acknowledged.id}`) === null,
        "The acknowledged task was already checkpointed, so this fixture cannot prove WAL recovery",
      );
    } finally {
      mainOnly.close();
    }
    await Bun.write(`${restored}-wal`, Bun.file(`${sut.dbPath}-wal`));
    await restartSut(sut, { DATABASE_PATH: restored });
    await readTask(api, { id: oldId, text: "base fixture task" });
    await readTask(api, acknowledged);
    await readTask(api, await createTask(api, `after SQLite recovery ${nonce}`));
  } finally {
    snapshot.close();
    await stopSut(sut, false);
  }
}

async function pgArchive(tool: "pg_dump" | "pg_restore", databaseUrl: string, archive: string) {
  const url = new URL(databaseUrl);
  const password = url.searchParams.get("password") ?? decodeURIComponent(url.password);
  url.password = "";
  url.searchParams.delete("password");
  const args =
    tool === "pg_dump"
      ? ["--format=custom", "--file", archive]
      : ["--single-transaction", "--no-owner", "--no-privileges", archive];
  const client = Bun.which(tool);
  expect(client, `Install the PostgreSQL client tools for the server version: missing ${tool}`);
  const child = Bun.spawn([client, "--no-password", "--dbname", url.toString(), ...args], {
    env: { ...minimalEnv(), PGPASSWORD: password },
    stdout: "ignore",
    stderr: "pipe",
  });
  const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (exit !== 0) {
    const diagnostic = redactSecrets(stderr, knownSecrets([databaseUrl, password]));
    throw new Error(`${tool} exited ${exit}: ${diagnostic.split("\n")[0]}`);
  }
}

async function postgresRecovery(nonce: string) {
  const sut = await startSut(false, { SLACK_DISABLE: "true" }, {}, undefined, "postgres");
  const api = createApiClient(sut.baseUrl, sut.apiKey);
  let target: string | undefined;
  try {
    expect(sut.databaseUrl, "The source must use PostgreSQL");
    const before = await createTask(api, `before PostgreSQL backup ${nonce}`);
    const key = "E2E_NATIVE_RESTORE_SECRET";
    const value = crypto.randomUUID();
    const put = await api("PUT", "/api/config", {
      body: { scope: "global", key, value, isSecret: true },
    });
    expectStatus(put, [200, 201], "store an encrypted fixture value");
    const dir = await mkdtemp(join(tmpdir(), "e2e-recover-postgres-"));
    sut.tempPaths.push(dir);
    const savedKey = join(dir, "encryption-key");
    await Bun.write(
      savedKey,
      Bun.file(asString(sut.env.SECRETS_ENCRYPTION_KEY_FILE, "encryption key file")),
      { mode: 0o600 },
    );
    const archive = join(dir, "swarm.dump");
    await pgArchive("pg_dump", sut.databaseUrl, archive);
    const after = await createTask(api, `after PostgreSQL backup ${nonce}`);
    await killApi(sut);
    await restartSut(sut);
    await readTask(api, before);
    await readTask(api, after);

    target = await createPostgresDatabase(`restore-${crypto.randomUUID()}`);
    await pgArchive("pg_restore", target, archive);
    const restoredDb = openReadOnlyDb({ engine: "postgres", url: target });
    try {
      expect(
        restoredDb.get(
          sql`SELECT id FROM swarm_config WHERE key = ${key} AND encrypted AND value <> ${value}`,
        ),
        "The database archive must contain the encrypted fixture value",
      );
    } finally {
      restoredDb.close();
    }
    const reader = await preparePostgresQueryReader(target);
    const maintenanceUrl = process.env.E2E_POSTGRES_URL;
    expect(maintenanceUrl, "The recovery test needs its PostgreSQL maintenance connection");
    const originalName = decodeURIComponent(new URL(sut.databaseUrl).pathname.slice(1));
    const observer = openReadOnlyDb({ engine: "postgres", url: maintenanceUrl });
    try {
      const connections = () =>
        observer.get<{ n: number }>(sql`SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = ${originalName} AND backend_type = 'client backend'`)?.n;
      expect(
        (connections() ?? 0) >= 2,
        "The original API must hold its lock and application connections",
      );
      await restartSut(sut, {
        DATABASE_URL: target,
        DATABASE_QUERY_URL: reader,
        SECRETS_ENCRYPTION_KEY_FILE: savedKey,
      });
      expect(
        await pollUntil(() => connections() === 0, 5_000),
        `The API left ${connections()} connections to its original database`,
      );
    } finally {
      observer.close();
    }
    await readTask(api, before);
    const config = await api("GET", `/api/config?scope=global&key=${key}&includeSecrets=true`);
    expectStatus(config, [200], "read the restored configuration");
    expect(
      asRecords(config.json, "configs").some((row) => row.key === key && row.value === value),
      "The restored key could not decrypt the fixture value",
    );
    expectStatus(
      await api("GET", `/api/tasks/${after.id}`),
      [404],
      "task created after the backup",
    );
    await readTask(api, await createTask(api, `after PostgreSQL restore ${nonce}`));
    const query = await api("POST", "/api/db-query", {
      body: { sql: "SELECT id FROM agent_tasks WHERE id = $1", params: [before.id] },
    });
    expectStatus(query, [200], "query restored task through the restricted reader");
    expect(
      Bun.deepEquals(asRecord(query.json).rows, [[before.id]]),
      "Reader missed the restored task",
    );
  } finally {
    try {
      await stopSut(sut, false);
    } finally {
      if (target) await dropPostgresDatabase(target);
    }
  }
}

export const storageRecovery: Scenario = {
  name: "storage-recovery",
  order: 9_070,
  async run(ctx) {
    if (ctx.db.engine === "sqlite") await sqliteRecovery(ctx.nonce);
    else await postgresRecovery(ctx.nonce);
  },
};
