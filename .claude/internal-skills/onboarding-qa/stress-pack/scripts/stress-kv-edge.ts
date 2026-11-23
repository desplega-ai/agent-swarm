// KV churn with edge values: every value must come back unchanged, and a
// prefix list must come back in byte order (the database uses the C collation).
type EdgeArgs = { big?: boolean };

/** JSON text with sorted object keys, so two values compare by content. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function nested(depth: number): unknown {
  let value: unknown = "bottom";
  for (let i = 0; i < depth; i++) value = i % 2 === 0 ? { d: value } : [value];
  return value;
}

/** Byte order of two ASCII keys. */
function byteOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export default async function (args: EdgeArgs | undefined, ctx: ScriptContext) {
  return stressRun(ctx, "kv-edge", async (t, env) => {
    const base = `stress/edge/${env.id}`;
    const set = (key: string, value: unknown, valueType?: "json" | "string" | "integer") =>
      ctx.swarm.kv_set({
        namespace: NS,
        key: `${base}/${key}`,
        value: value as never,
        valueType: valueType as never,
      }) as Promise<Sdk>;
    const get = (key: string) =>
      ctx.swarm.kv_get({ namespace: NS, key: `${base}/${key}` }) as Promise<Sdk>;

    // 1. Round trips. Each case is [key, value, valueType].
    const cases: [string, unknown, ("json" | "string" | "integer")?][] = [
      ["emoji", "😀 👩‍👩‍👧‍👦 🏳️‍🌈 𝄞 𠜎 🇪🇸", "string"],
      ["emoji-json", { face: "😀", clef: "𝄞", han: "𠜎", "key🔑": "emoji key" }],
      ["rtl", "שלום עולם ‮ مرحبا بالعالم ‬ end", "string"],
      ["combining", "é is not é, and ạ̈ keeps both marks", "string"],
      ["empty-string", "", "string"],
      ["empty-json-string", ""],
      ["empty-object", {}],
      ["empty-array", []],
      ["json-null", null],
      ["json-false", false],
      ["json-zero", 0],
      ["whitespace", " \t\n\r leading and trailing \n", "string"],
      ["quotes", `she said "hi" and 'bye' \\ back\\slash /slash`, "string"],
      ["control-chars", "bell\u0007 esc\u001b del\u007f nbsp  zwj‍ bom﻿", "string"],
      ["deep-json", nested(64 * 4 ** (env.level - 1))],
      [
        "numbers",
        {
          big: "9007199254740993",
          huge: "18446744073709551615",
          maxSafe: 9007199254740991,
          minSafe: -9007199254740991,
          float: 1.7976931348623157e308,
          tiny: 5e-324,
          frac: 0.1,
          exp: 1e21,
        },
      ],
      ["int-zero", 0, "integer"],
      ["int-negative", -1, "integer"],
      ["int-max-safe", 9007199254740991, "integer"],
      ["int-min-safe", -9007199254740991, "integer"],
      ["sql-shape", "'; DROP TABLE kv_entries; -- %_\\ $1 ?", "string"],
      ["Case", "upper C"],
      ["case", "lower c"],
      ["CASE", "all upper"],
      ["a.b_c:d-e/f", "special characters in the key"],
      ["trailing/", "trailing slash"],
      ["double//slash", "double slash"],
      ["dots/../..", "dot segments"],
      // The 512 limit applies to the key as it is sent, where each "/" is 3 characters.
      [`long-${"k".repeat(512 - encodeURIComponent(`${base}/long-`).length)}`, "longest key"],
    ];
    const written = await pooled(cases, 8, async ([key, value, valueType]) => {
      const res = await set(key, value, valueType);
      return { key, status: res.status, error: res.success ? undefined : res.data?.error };
    });
    const refused = written.filter((w) => w.status !== 200);
    t.ok("every-edge-value-is-accepted", refused.length === 0, refused.slice(0, 5));

    const mismatches: unknown[] = [];
    await pooled(cases, 8, async ([key, value, valueType]) => {
      const res = await get(key);
      const got = res.data?.value;
      const same =
        valueType === "string" || valueType === "integer"
          ? got === value
          : canonical(got) === canonical(value);
      if (!res.success || !same) {
        mismatches.push({
          key: key.slice(0, 40),
          status: res.status,
          want: canonical(value).slice(0, 80),
          got: canonical(got ?? null).slice(0, 80),
        });
      }
    });
    t.ok("every-edge-value-round-trips", mismatches.length === 0, mismatches.slice(0, 5));

    // JSON object key order. SQLite stores the text as written. A jsonb column
    // would sort the keys. The pack records which one this engine does.
    await set("key-order", { zebra: 1, apple: 2, Mango: 3, "10": 4, "9": 5 });
    const order = Object.keys((await get("key-order")).data?.value ?? {}).join(",");
    t.ok("json-key-order-is-kept", order === "9,10,zebra,apple,Mango", { order });

    // 2. A value near the 2 MiB limit. Every fifth minute, or on request.
    let bigBytes = 0;
    if (args?.big === true || Math.floor(Date.now() / 60_000) % 5 === 0) {
      bigBytes = 2 * 1024 * 1024 - 512;
      const unit = "stress pack filler. ";
      const big = unit.repeat(Math.ceil(bigBytes / unit.length)).slice(0, bigBytes);
      const saved = await set("near-limit", big, "string");
      t.ok("near-limit-value-is-accepted", saved.status === 200, {
        status: saved.status,
        error: saved.data?.error,
      });
      const back = (await get("near-limit")).data?.value;
      t.ok("near-limit-value-round-trips", back === big, {
        wantLength: big.length,
        gotLength: typeof back === "string" ? back.length : typeof back,
      });
    }

    // 3. Type change on one key, and many writers on one key.
    await set("retype", { was: "json" });
    await set("retype", "now a string", "string");
    const retyped = (await get("retype")).data;
    t.ok(
      "type-change-overwrites",
      retyped?.value === "now a string" && retyped?.valueType === "string",
      retyped,
    );
    const writers = Array.from({ length: 10 * env.level }, (_, i) => `writer-${i}`);
    await Promise.all(writers.map((value) => set("contended", value, "string")));
    const contended = (await get("contended")).data;
    t.ok(
      "concurrent-upserts-leave-one-winner",
      writers.includes(contended?.value) && contended?.createdAt <= contended?.updatedAt,
      contended,
    );

    // 4. Expiry: a key with a 1 second TTL is gone after 2 seconds.
    await ctx.swarm.kv_set({ namespace: NS, key: `${base}/ttl`, value: "short", expiresInSec: 1 });
    const beforeExpiry = (await get("ttl")).status;
    await sleep(2100);
    const afterExpiry = (await get("ttl")).status;
    t.ok("ttl-key-expires", beforeExpiry === 200 && afterExpiry === 404, {
      beforeExpiry,
      afterExpiry,
    });

    // 5. Prefix list: exact prefix match (no LIKE wildcards) and byte order.
    const ordKeys = ["B", "a", "A", "b", "_", "-", ".", ":", "0", "9", "Z", "z", "a/b", "a.b"];
    ordKeys.push("a-b", "aB", "ab", "a_b", "axb", "zz", "AB", "Ab");
    await pooled(ordKeys, 8, (key) => set(`ord/${key}`, key));
    const listed = (await ctx.swarm.kv_list({
      namespace: NS,
      prefix: `${base}/ord/`,
      limit: 100,
    })) as Sdk;
    const gotKeys: string[] = (listed.data?.entries ?? []).map((entry: Any) =>
      String(entry.key).slice(`${base}/ord/`.length),
    );
    const wantKeys = [...ordKeys].sort(byteOrder);
    t.ok("prefix-list-is-in-byte-order", gotKeys.join(" ") === wantKeys.join(" "), {
      want: wantKeys.join(" "),
      got: gotKeys.join(" "),
    });
    t.ok("prefix-list-total-matches", listed.data?.total === ordKeys.length, {
      total: listed.data?.total,
      want: ordKeys.length,
    });
    const underscore = (await ctx.swarm.kv_list({
      namespace: NS,
      prefix: `${base}/ord/a_`,
      limit: 100,
    })) as Sdk;
    const underscoreKeys = (underscore.data?.entries ?? []).map((entry: Any) => entry.key);
    t.ok(
      "prefix-wildcard-chars-match-literally",
      underscoreKeys.length === 1 && underscoreKeys[0] === `${base}/ord/a_b`,
      underscoreKeys,
    );
    // Paging: two pages of a list must not overlap and must cover the prefix.
    const page1 = (await ctx.swarm.kv_list({
      namespace: NS,
      prefix: `${base}/ord/`,
      limit: 10,
      offset: 0,
    })) as Sdk;
    const page2 = (await ctx.swarm.kv_list({
      namespace: NS,
      prefix: `${base}/ord/`,
      limit: 100,
      offset: 10,
    })) as Sdk;
    const paged = [...(page1.data?.entries ?? []), ...(page2.data?.entries ?? [])].map(
      (entry: Any) => String(entry.key).slice(`${base}/ord/`.length),
    );
    t.ok("paged-list-equals-full-list", paged.join(" ") === wantKeys.join(" "), {
      paged: paged.join(" "),
    });

    // 6. Clean up: delete every key of this run, then the prefix must be empty.
    let deleted = 0;
    for (let round = 0; round < 5; round++) {
      const rest = (await ctx.swarm.kv_list({
        namespace: NS,
        prefix: `${base}/`,
        limit: 1000,
      })) as Sdk;
      const entries: Any[] = rest.data?.entries ?? [];
      if (entries.length === 0) break;
      const gone = await pooled(
        entries,
        8,
        (entry) => ctx.swarm.kv_delete({ namespace: NS, key: String(entry.key) }) as Promise<Sdk>,
      );
      deleted += gone.filter((r) => r.status === 204).length;
    }
    const left = (await ctx.swarm.kv_list({ namespace: NS, prefix: `${base}/`, limit: 10 })) as Sdk;
    t.ok("cleanup-leaves-nothing", left.data?.total === 0, { total: left.data?.total });

    return { values: cases.length, bigBytes, deleted, keyOrder: order };
  });
}
