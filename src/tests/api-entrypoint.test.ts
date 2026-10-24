import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHILD_PROCESS_TEST_BUDGET_MS, expectChildOk, runChild } from "./test-proc";

const ENTRYPOINT = join(import.meta.dir, "../../api-entrypoint.sh");

let work: string | undefined;

afterEach(async () => {
  if (work) await rm(work, { recursive: true, force: true });
  work = undefined;
});

/** Run a copy of the entrypoint as "root" (a stub `id`), without starting the API. */
async function runEntrypoint(databasePath: string): Promise<void> {
  if (!work) throw new Error("work dir not set");
  const bin = join(work, "bin");
  await mkdir(bin);
  await Bun.write(join(bin, "id"), "#!/bin/sh\necho 0\n");
  await chmod(join(bin, "id"), 0o755);
  const source = await Bun.file(ENTRYPOINT).text();
  const script = join(work, "api-entrypoint.sh");
  await Bun.write(script, source.replace("exec /usr/local/bin/agent-swarm-api", "exit 0"));
  expectChildOk(
    await runChild(["sh", script], {
      env: { PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`, DATABASE_PATH: databasePath },
    }),
    "api-entrypoint.sh",
  );
}

async function mode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

describe.skipIf(process.platform === "win32")("api-entrypoint.sh data permissions", () => {
  test(
    "a database in a shared directory locks the database files, not the directory",
    async () => {
      work = await mkdtemp(join(tmpdir(), "api-entrypoint-"));
      const shared = join(work, "shared");
      await mkdir(shared);
      await chmod(shared, 0o755);
      const db = join(shared, "agent-swarm.sqlite");
      const files = [db, `${db}-wal`, `${db}-shm`, join(shared, ".page-session-secret")];
      const unrelated = join(shared, "scripts-runtime.js");
      for (const file of [...files, unrelated]) {
        await Bun.write(file, "x");
        await chmod(file, 0o644);
      }

      await runEntrypoint(db);

      expect(await mode(shared)).toBe(0o755);
      for (const file of files) expect(await mode(file)).toBe(0o600);
      expect(await mode(unrelated)).toBe(0o644);
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );
});
