import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const migration = (name: string) =>
  readFileSync(new URL(`../be/migrations/${name}`, import.meta.url), "utf8");

test("SVG migration preserves existing rows, history, indexes and asset key triggers", () => {
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE users (id TEXT PRIMARY KEY)");
    db.exec(migration("059_pages.sql"));
    db.exec(migration("060_page_versions.sql"));
    db.exec("ALTER TABLE pages ADD COLUMN view_count INTEGER NOT NULL DEFAULT 0");
    db.exec("ALTER TABLE pages ADD COLUMN created_by TEXT REFERENCES users(id)");
    db.exec("ALTER TABLE pages ADD COLUMN updated_by TEXT REFERENCES users(id)");
    db.exec(migration("086_pages_default_authed.sql"));
    db.exec("ALTER TABLE pages ADD COLUMN \"key\" TEXT NOT NULL DEFAULT 'shared/'");
    db.exec("INSERT INTO users VALUES ('user')");
    db.exec(`INSERT INTO pages (id,agentId,slug,title,contentType,body,authMode,passwordHash,view_count,created_by,updated_by,"key")
      VALUES ('page','agent','stars','Stars','text/html','original','password','hash',42,'user','user','personal/user/stars/')`);
    db.exec("INSERT INTO page_versions (pageId,version,snapshot) VALUES ('page',1,'{}')");
    const before = db.query("SELECT * FROM pages").get();
    db.transaction(() => db.exec(migration("148_pages_svg.sql")))();
    db.exec("PRAGMA foreign_keys=ON");
    expect(db.query("SELECT * FROM pages").get()).toEqual(before);
    expect(db.query("SELECT * FROM page_versions").all()).toHaveLength(1);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    db.exec("UPDATE pages SET contentType='image/svg+xml'");
    expect(() => db.exec("UPDATE pages SET contentType='text/plain'")).toThrow();
    expect(() => db.exec("UPDATE pages SET \"key\"='INVALID'")).toThrow(
      "invalid asset namespace key",
    );
    expect(
      db.query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='pages'").all(),
    ).toHaveLength(6);
    db.exec("DELETE FROM pages");
    expect(db.query("SELECT * FROM page_versions").all()).toHaveLength(0);
  } finally {
    db.close();
  }
});
