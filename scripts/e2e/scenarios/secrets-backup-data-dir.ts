import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { makeSqliteSecretLegacy } from "../db";
import { asRecords, createApiClient, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import { restartSut, startSut, stopSut, stopSutProcess } from "../sut";

// The plaintext backup of the legacy-secret encryption pass goes to the data directory
// (decision D2: SWARM_DATA_DIR, beside the generated key), not beside the SQLite file.
// The API runs on its own SQLite file, so the main SUT's secrets stay untouched.
export const secretsBackupDataDir: Scenario = {
  name: "secrets-backup-data-dir",
  order: 9_020,
  async run(ctx) {
    const sut = await startSut(false, { SLACK_DISABLE: "true" }, {}, undefined, "sqlite");
    const dataDir = mkdtempSync(join(tmpdir(), "e2e-data-dir-"));
    const backupPrefix = `${basename(sut.dbPath)}.backup.secrets-`;
    try {
      const api = createApiClient(sut.baseUrl, sut.apiKey);
      const key = `LEGACY_SECRET_${ctx.nonce}`.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
      const put = await api("PUT", "/api/config", {
        body: { scope: "global", key, value: "stored encrypted", isSecret: true },
      });
      expectStatus(put, [200, 201], "store a secret");

      // Turn the row into a pre-encryption legacy secret, then boot with no key setting:
      // the API generates a key in the data directory and writes the plaintext backup.
      await stopSutProcess(sut);
      makeSqliteSecretLegacy(sut.dbPath, key, "legacy plaintext value");

      await restartSut(sut, { SECRETS_ENCRYPTION_KEY_FILE: "", SWARM_DATA_DIR: dataDir });

      const backups = readdirSync(dataDir).filter((file) => file.startsWith(backupPrefix));
      expect(
        backups.length === 1,
        `expected one secrets backup in SWARM_DATA_DIR ${dataDir}, found [${readdirSync(dataDir).join(", ")}]`,
      );
      expect(
        readFileSync(join(dataDir, backups[0] as string), "utf8").includes(
          "legacy plaintext value",
        ),
        "the backup does not hold the legacy secret",
      );
      const besideDb = readdirSync(dirname(sut.dbPath)).filter((file) =>
        file.startsWith(backupPrefix),
      );
      expect(
        besideDb.length === 0,
        `a secrets backup was written beside the SQLite file: ${besideDb.join(", ")}`,
      );
      expect(
        existsSync(join(dataDir, ".encryption-key")),
        "the generated key is not in SWARM_DATA_DIR",
      );

      const read = await api("GET", `/api/config?scope=global&key=${key}&includeSecrets=true`);
      expectStatus(read, [200], "read the encrypted legacy secret");
      expect(
        asRecords(read.json, "configs")[0]?.value === "legacy plaintext value",
        `the legacy secret reads back as ${read.text.slice(0, 300)}`,
      );
    } finally {
      for (const file of readdirSync(dirname(sut.dbPath)).filter((f) =>
        f.startsWith(backupPrefix),
      )) {
        rmSync(join(dirname(sut.dbPath), file), { force: true });
      }
      await stopSut(sut, false);
      rmSync(dataDir, { recursive: true, force: true });
    }
  },
};
