import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

test("migration 384 revokes legacy runner credentials and preserves prior revocation dates", async () => {
  using db = new Database(":memory:");
  const migrations = `${import.meta.dir}/../be/migrations`;
  db.exec("CREATE TABLE users (id TEXT PRIMARY KEY)");
  db.exec(await Bun.file(`${migrations}/378_script_runner_credentials.sql`).text());
  const originalDate = "2026-01-01T00:00:00.000Z";
  const insert = db.query(`INSERT INTO script_runner_credentials
    (id, name, token_hash, created_at, updated_at, expires_at, revoked_at)
    VALUES (?1, ?1, ?1, ?2, ?2, '2999-01-01T00:00:00.000Z', ?3)`);
  insert.run("legacy", originalDate, null);
  insert.run("revoked", originalDate, originalDate);

  db.exec(await Bun.file(`${migrations}/384_script_runner_issuer.sql`).text());
  const read = db.query<{ issuer: string; revoked: string; updated: string }, [string]>(
    "SELECT issuer_user_id AS issuer, revoked_at AS revoked, updated_at AS updated FROM script_runner_credentials WHERE id = ?",
  );
  const legacy = read.get("legacy");
  expect(legacy?.revoked).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  expect(legacy?.updated).toBe(legacy?.revoked);
  expect(legacy?.issuer).toBe("");
  expect(read.get("revoked")).toEqual({
    issuer: "",
    revoked: originalDate,
    updated: originalDate,
  });
});
