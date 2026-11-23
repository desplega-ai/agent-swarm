// M0 driver spike for D14: Bun.SQL against Postgres 16 + pgvector.
// Run: PG_URL=postgres://postgres@127.0.0.1:55432/postgres bun thoughts/taras/research/spikes/bun-sql-spike.ts
// Compiled: bun build --compile <this file> --outfile /tmp/spike && PG_URL=... /tmp/spike
const url = process.env.PG_URL;
if (!url) throw new Error("PG_URL required");
const results: Array<[string, boolean, string]> = [];
const check = async (name: string, fn: () => Promise<string>) => {
  try {
    results.push([name, true, await fn()]);
  } catch (e) {
    results.push([name, false, String((e as Error)?.message ?? e)]);
  }
};
const admin = new Bun.SQL(url);
const dbName = `spike_${Date.now()}`;
await admin.unsafe(`CREATE DATABASE ${dbName}`);
const dbUrl = url.replace(/\/[^/]*$/, `/${dbName}`);
const sql = new Bun.SQL({
  url: dbUrl,
  max: 8,
  connection: { default_transaction_isolation: "serializable", TimeZone: "UTC" },
});
try {
  await sql.unsafe(`CREATE EXTENSION IF NOT EXISTS vector`);
  await sql.unsafe(
    `CREATE TABLE t ("id" bigserial primary key, "camelCol" text, "flag" boolean, "doc" jsonb, "at" timestamptz, "blob" bytea, "big" bigint, "num" numeric, "emb" vector(3))`,
  );

  await check("pool: 8 concurrent pg_sleep in parallel", async () => {
    const t0 = performance.now();
    await Promise.all(Array.from({ length: 8 }, () => sql.unsafe(`SELECT pg_sleep(0.3)`)));
    const ms = performance.now() - t0;
    if (ms > 1500) throw new Error(`took ${ms}ms, not parallel`);
    return `${Math.round(ms)}ms`;
  });
  await check("session setting default_transaction_isolation", async () => {
    const [r] = await sql.unsafe(`SHOW default_transaction_isolation`);
    if (r.default_transaction_isolation !== "serializable") throw new Error(JSON.stringify(r));
    return r.default_transaction_isolation;
  });
  await check("transaction pins one connection", async () => {
    const pids = await sql.begin(async (tx) => {
      const a = await tx.unsafe(`SELECT pg_backend_pid() AS p`);
      await Promise.all([tx.unsafe(`SELECT 1`), sql.unsafe(`SELECT 1`)]);
      const b = await tx.unsafe(`SELECT pg_backend_pid() AS p`);
      return [a[0].p, b[0].p];
    });
    if (pids[0] !== pids[1]) throw new Error(`pids differ ${pids}`);
    return `pid ${pids[0]}`;
  });
  await check("unsafe with $n params + camelCase quoted key preserved", async () => {
    const r = await sql.unsafe(
      `INSERT INTO t ("camelCol","flag") VALUES ($1,$2) RETURNING "id","camelCol","flag"`,
      ["x", true],
    );
    return JSON.stringify(r[0]) + ` id type=${typeof r[0].id}`;
  });
  await check("savepoint rollback keeps outer tx usable (unique violation)", async () => {
    await sql.unsafe(`CREATE TABLE u (k text primary key)`);
    const out = await sql.begin(async (tx) => {
      await tx.unsafe(`INSERT INTO u VALUES ('a')`);
      try {
        await tx.savepoint(async (sp) => {
          await sp.unsafe(`INSERT INTO u VALUES ('a')`);
        });
      } catch (e) {
        const err = e as { errno?: string; code?: string };
        await tx.unsafe(`INSERT INTO u VALUES ('b')`);
        return `caught errno=${err.errno} code=${err.code}`;
      }
      return "no error";
    });
    const [{ c }] = await sql.unsafe(`SELECT count(*)::int AS c FROM u`);
    if (c !== 2) throw new Error(`count ${c}`);
    return out;
  });
  await check("aborted tx without savepoint fails (25P02)", async () => {
    try {
      await sql.begin(async (tx) => {
        try {
          await tx.unsafe(`INSERT INTO u VALUES ('a')`);
        } catch {}
        await tx.unsafe(`SELECT 1`);
      });
      throw new Error("no error");
    } catch (e) {
      return `errno=${(e as { errno?: string }).errno}`;
    }
  });
  await check("bytea round trip", async () => {
    const bytes = new Uint8Array([0, 1, 2, 255]);
    const r = await sql.unsafe(`INSERT INTO t ("blob") VALUES ($1) RETURNING "blob"`, [bytes]);
    const b = r[0].blob;
    return `${b?.constructor?.name} ${Array.from(b as Uint8Array).join(",")}`;
  });
  await check("jsonb returned parsed; string param needs ::text::jsonb", async () => {
    const text = JSON.stringify({ b: 1, a: [1, 2] });
    // Hazard: a JS string bound straight to a jsonb parameter becomes a jsonb *string* value.
    const [bad] = await sql.unsafe(`SELECT jsonb_typeof($1::jsonb) AS k`, [text]);
    if (bad.k !== "string") throw new Error(`expected double-encode hazard, got ${bad.k}`);
    const r = await sql.unsafe(`INSERT INTO t ("doc") VALUES ($1::text::jsonb) RETURNING "doc"`, [
      text,
    ]);
    if (typeof r[0].doc !== "object") throw new Error(`doc is ${typeof r[0].doc}`);
    return `$1::jsonb on string => jsonb string; $1::text::jsonb => ${typeof r[0].doc} ${JSON.stringify(r[0].doc)} (key order lost)`;
  });
  await check("timestamptz returned as Date", async () => {
    const r = await sql.unsafe(`INSERT INTO t ("at") VALUES ($1) RETURNING "at"`, [
      "2026-11-20T10:00:00.123Z",
    ]);
    const d = r[0].at;
    return `${d?.constructor?.name} ${d instanceof Date ? d.toISOString() : d}`;
  });
  await check("bigint/numeric types", async () => {
    const r = await sql.unsafe(`INSERT INTO t ("big","num") VALUES ($1,$2) RETURNING "big","num"`, [
      "9007199254740993",
      "1.5",
    ]);
    return `big=${typeof r[0].big}:${r[0].big} num=${typeof r[0].num}:${r[0].num}`;
  });
  await check("NUL byte in text rejected", async () => {
    try {
      await sql.unsafe(`INSERT INTO t ("camelCol") VALUES ($1)`, ["a\u0000b"]);
      return "accepted (unexpected)";
    } catch (e) {
      return `rejected errno=${(e as { errno?: string }).errno}`;
    }
  });
  await check("pgvector order", async () => {
    await sql.unsafe(`INSERT INTO t ("emb") VALUES ('[1,0,0]'),('[0,1,0]'),('[0.9,0.1,0]')`);
    const r = await sql.unsafe(
      `SELECT "emb"::text AS e FROM t WHERE "emb" IS NOT NULL ORDER BY "emb" <=> $1::vector LIMIT 3`,
      ["[1,0,0]"],
    );
    return r.map((x: { e: string }) => x.e).join(" ");
  });
  await check("error codes: FK 23503, check 23514, not-null 23502", async () => {
    await sql.unsafe(
      `CREATE TABLE p (id int primary key); CREATE TABLE ch (pid int references p(id), v int check (v > 0) not null)`,
    );
    const codes: string[] = [];
    for (const q of [
      `INSERT INTO ch VALUES (1, 1)`,
      `INSERT INTO p VALUES (1); INSERT INTO ch VALUES (1, -1)`,
      `INSERT INTO ch VALUES (1, NULL)`,
    ]) {
      try {
        await sql.unsafe(q);
      } catch (e) {
        codes.push(String((e as { errno?: string }).errno));
      }
    }
    return codes.join(",");
  });
  await check("serialization failure 40001 surfaces with errno", async () => {
    await sql.unsafe(`CREATE TABLE ctr (id int primary key, n int); INSERT INTO ctr VALUES (1,0)`);
    let errno = "none";
    const run = () =>
      sql
        .begin(async (tx) => {
          const [{ n }] = await tx.unsafe(`SELECT n FROM ctr WHERE id=1`);
          await Bun.sleep(100);
          await tx.unsafe(`UPDATE ctr SET n=$1 WHERE id=1`, [n + 1]);
        })
        .catch((e) => {
          errno = String((e as { errno?: string }).errno);
        });
    await Promise.all([run(), run()]);
    return `errno=${errno}`;
  });
  await check("advisory lock session-level on reserved conn", async () => {
    const r1 = await sql.reserve();
    const [{ ok }] = await r1.unsafe(`SELECT pg_try_advisory_lock(42) AS ok`);
    const r2 = await sql.reserve();
    const [{ ok: ok2 }] = await r2.unsafe(`SELECT pg_try_advisory_lock(42) AS ok`);
    r1.release();
    r2.release();
    return `first=${ok} second=${ok2}`;
  });
  await check("tsvector search", async () => {
    const r = await sql.unsafe(
      `SELECT to_tsvector('simple', 'hello postgres world') @@ plainto_tsquery('simple','postgres') AS m`,
    );
    return String(r[0].m);
  });
} finally {
  await sql.close();
  await admin.unsafe(`DROP DATABASE ${dbName} WITH (FORCE)`);
  await admin.close();
}
let failed = 0;
for (const [n, ok, d] of results) {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${n} :: ${d}`);
}
console.log(`bun ${Bun.version} ${failed} failed of ${results.length}`);
process.exit(failed ? 1 : 0);
