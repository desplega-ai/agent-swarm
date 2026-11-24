// Rejections: values the database cannot store, or that the API must refuse.
// Every one must end as a clean 4xx with a message, never a 5xx. A value the
// API does accept must come back unchanged. Every status code is recorded.
type Expect = "4xx" | "4xx-or-round-trip" | "not-5xx";
type Outcome = { name: string; status: number; message: string; expect: Expect; ok: boolean };

export default async function (_args: unknown, ctx: ScriptContext) {
  return stressRun(ctx, "rejections", async (t, env) => {
    const base = ctx.stdlib.Redacted.value(ctx.swarm.config.mcpBaseUrl).replace(/\/$/, "");
    const auth = {
      Authorization: `Bearer ${ctx.stdlib.Redacted.value(ctx.swarm.config.apiKey)}`,
      "X-Agent-ID": ctx.stdlib.Redacted.value(ctx.swarm.config.agentId),
      "Content-Type": "application/json",
    };
    /** One hand-built request. The body is sent as written, so it can be invalid. */
    const raw = async (method: string, path: string, body?: string) => {
      let res: Response;
      try {
        res = await ctx.stdlib.fetch(`${base}${path}`, {
          method,
          headers: auth,
          body,
          retry: false,
        });
      } catch (err) {
        return { status: 0, text: `request failed: ${errText(err)}`, json: undefined as Any };
      }
      const text = await res.text();
      let json: Any;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      return { status: res.status, text, json };
    };
    const kv = (key: string) => `/api/kv/_/${NS}/${encodeURIComponent(key)}`;
    const dir = `stress/reject/${env.id}`;
    const outcomes: Outcome[] = [];
    /** Refusals with an empty body, and values stored with a replacement character. */
    const emptyBodies: string[] = [];
    const lossy: string[] = [];
    const note = (name: string, expect: Expect, status: number, message: unknown, ok: boolean) => {
      outcomes.push({ name, status, expect, ok, message: String(message ?? "").slice(0, 200) });
    };
    const errorOf = (res: { json: Any; text: string }) =>
      typeof res.json?.error === "string" ? res.json.error : res.text.slice(0, 200);
    const is4xx = (status: number) => status >= 400 && status < 500;

    /** A request the API must refuse with a 4xx and a message. */
    const mustRefuse = async (name: string, method: string, path: string, body?: string) => {
      const res = await raw(method, path, body);
      // A 4xx with an empty body is recorded, and still counts as a refusal.
      if (is4xx(res.status) && errorOf(res).length === 0) emptyBodies.push(name);
      note(name, "4xx", res.status, errorOf(res), is4xx(res.status));
      return res;
    };
    /**
     * A KV write that may be refused (4xx) or stored. A stored value must read
     * back as the same JSON value. The key is deleted afterwards.
     */
    const refuseOrKeep = async (name: string, bodyText: string) => {
      const key = `${dir}/${name}`;
      const put = await raw("PUT", kv(key), bodyText);
      if (put.status !== 200) {
        note(name, "4xx-or-round-trip", put.status, errorOf(put), is4xx(put.status));
        return;
      }
      const got = await raw("GET", kv(key));
      const sent = JSON.parse(bodyText).value;
      let same = got.status === 200 && JSON.stringify(got.json?.value) === JSON.stringify(sent);
      // UTF-8 cannot hold a lone surrogate. A plain string comes back with
      // U+FFFD in its place. That loss is recorded, and it is not a failure.
      if (
        !same &&
        typeof sent === "string" &&
        got.json?.value === sent.replace(/[\ud800-\udfff]/g, "\ufffd")
      ) {
        lossy.push(name);
        same = true;
      }
      note(
        name,
        "4xx-or-round-trip",
        put.status,
        same
          ? "stored and read back unchanged"
          : `stored, but read back as ${got.text.slice(0, 120)}`,
        same,
      );
      await raw("DELETE", kv(key));
    };

    // --- Values PostgreSQL cannot hold in a text or jsonb column ---
    await refuseOrKeep("nul-in-json-string", '{"value":"a\\u0000b"}');
    await refuseOrKeep("nul-in-string-type", '{"value":"a\\u0000b","valueType":"string"}');
    await refuseOrKeep("nul-in-json-key", '{"value":{"k\\u0000":1}}');
    await refuseOrKeep("nul-nested", '{"value":{"a":[1,{"b":"x\\u0000y"}]}}');
    await refuseOrKeep("lone-high-surrogate", '{"value":"a\\ud800b"}');
    await refuseOrKeep("lone-low-surrogate", '{"value":"a\\udc00b","valueType":"string"}');
    await refuseOrKeep("reversed-surrogates", '{"value":{"s":"\\udc00\\ud800"}}');
    const depth = [3000, 6000, 10000][env.level - 1] ?? 3000;
    await refuseOrKeep("very-deep-json", `{"value":${"[".repeat(depth)}${"]".repeat(depth)}}`);

    // --- Keys and namespaces the API must refuse ---
    await mustRefuse("key-too-long", "PUT", kv(`${dir}/${"k".repeat(513)}`), '{"value":1}');
    await mustRefuse("key-with-percent", "PUT", kv(`${dir}/pct%41`), '{"value":1}');
    await mustRefuse("key-with-space", "PUT", kv(`${dir}/has space`), '{"value":1}');
    await mustRefuse("key-with-emoji", "PUT", kv(`${dir}/😀`), '{"value":1}');
    await mustRefuse(
      "key-with-nul",
      "PUT",
      `/api/kv/_/${NS}/${dir.replaceAll("/", "%2F")}%00x`,
      '{"value":1}',
    );
    await mustRefuse("key-bad-percent", "PUT", `/api/kv/_/${NS}/%E0%A4%A`, '{"value":1}');
    await mustRefuse(
      "namespace-with-hash",
      "PUT",
      `/api/kv/_/${encodeURIComponent("stress#x")}/k`,
      '{"value":1}',
    );
    await mustRefuse(
      "reserved-namespace",
      "PUT",
      `/api/kv/_/${encodeURIComponent("durable:stress")}/k`,
      '{"value":1}',
    );
    await mustRefuse("room-snapshot-key", "PUT", kv("_room/stress"), '{"value":1}');

    // --- Bodies the API must refuse ---
    await mustRefuse("malformed-json", "PUT", kv(`${dir}/malformed`), '{"value":');
    await mustRefuse(
      "body-too-large",
      "PUT",
      kv(`${dir}/too-large`),
      JSON.stringify({ value: "x".repeat(2 * 1024 * 1024 + 1024) }),
    );
    await mustRefuse(
      "integer-not-safe",
      "PUT",
      kv(`${dir}/unsafe`),
      '{"value":9007199254740993,"valueType":"integer"}',
    );
    await mustRefuse(
      "integer-from-text",
      "PUT",
      kv(`${dir}/text-int`),
      '{"value":"12abc","valueType":"integer"}',
    );
    await mustRefuse(
      "string-type-with-object",
      "PUT",
      kv(`${dir}/str-obj`),
      '{"value":{"a":1},"valueType":"string"}',
    );
    await mustRefuse(
      "unknown-value-type",
      "PUT",
      kv(`${dir}/bad-type`),
      '{"value":1,"valueType":"blob"}',
    );

    // --- Increments that cannot work ---
    await raw("PUT", kv(`${dir}/text`), '{"value":"not a number","valueType":"string"}');
    await mustRefuse("incr-on-string", "POST", `${kv(`${dir}/text`)}/incr`, '{"by":1}');
    await mustRefuse("incr-by-fraction", "POST", `${kv(`${dir}/n`)}/incr`, '{"by":1.5}');
    await mustRefuse("incr-by-text", "POST", `${kv(`${dir}/n`)}/incr`, '{"by":"one"}');
    await mustRefuse("incr-by-unsafe", "POST", `${kv(`${dir}/n`)}/incr`, '{"by":9007199254740993}');
    await raw("PUT", kv(`${dir}/max`), '{"value":9007199254740991,"valueType":"integer"}');
    await mustRefuse("incr-past-max-safe", "POST", `${kv(`${dir}/max`)}/incr`, '{"by":1}');
    const stillMax = await raw("GET", kv(`${dir}/max`));
    t.ok(
      "refused-incr-leaves-value",
      stillMax.json?.value === 9007199254740991,
      stillMax.text.slice(0, 120),
    );

    // --- Expiry values at the edge. Any answer below 500 is accepted. ---
    for (const [name, body] of [
      ["ttl-negative", '{"value":1,"expiresInSec":-5}'],
      ["ttl-huge", '{"value":1,"expiresInSec":1e300}'],
      ["ttl-max-safe", '{"value":1,"expiresInSec":9007199254740991}'],
    ] as const) {
      const res = await raw("PUT", kv(`${dir}/${name}`), body);
      note(name, "not-5xx", res.status, errorOf(res), res.status > 0 && res.status < 500);
    }

    // --- List and view arguments ---
    await mustRefuse("list-limit-too-high", "GET", `/api/kv/_/${NS}?limit=1001`);
    await mustRefuse("list-limit-zero", "GET", `/api/kv/_/${NS}?limit=0`);
    await mustRefuse("list-offset-negative", "GET", `/api/kv/_/${NS}?offset=-1`);
    await mustRefuse("get-missing-key", "GET", kv(`${dir}/does-not-exist`));
    await mustRefuse("delete-missing-key", "DELETE", kv(`${dir}/does-not-exist`));

    // --- Other routes ---
    await mustRefuse(
      "script-run-unknown-name",
      "POST",
      "/api/scripts/run",
      '{"name":"stress-no-such-script","scope":"global"}',
    );
    await mustRefuse(
      "script-run-name-and-source",
      "POST",
      "/api/scripts/run",
      '{"name":"stress-probe","source":"export default () => 1"}',
    );
    await mustRefuse(
      "workflow-trigger-unknown-id",
      "POST",
      "/api/workflows/00000000-0000-4000-8000-000000000000/trigger",
      "{}",
    );
    await mustRefuse(
      "workflow-run-unknown-id",
      "GET",
      "/api/workflow-runs/00000000-0000-4000-8000-000000000000",
    );
    await mustRefuse(
      "schedule-unknown-id",
      "GET",
      "/api/schedules/00000000-0000-4000-8000-000000000000",
    );
    const cron = await mustRefuse(
      "schedule-bad-cron",
      "POST",
      "/api/schedules",
      JSON.stringify({
        name: `stress-reject-cron-${env.id}`,
        cronExpression: "61 25 * * *",
        targetType: "script",
        scriptName: "stress-kv-counter",
        enabled: false,
      }),
    );
    // A schedule the API did accept must not stay behind.
    if (cron.status < 300 && cron.json?.id) await raw("DELETE", `/api/schedules/${cron.json.id}`);
    await mustRefuse(
      "db-query-two-statements",
      "POST",
      "/api/db-query",
      '{"sql":"select 1; select 2"}',
    );
    await mustRefuse("db-query-syntax-error", "POST", "/api/db-query", '{"sql":"selec 1 frm"}');
    await mustRefuse(
      "db-query-unknown-table",
      "POST",
      "/api/db-query",
      '{"sql":"select * from stress_no_such_table"}',
    );
    // SQLite answers NULL for 1/0 and PostgreSQL raises an error. Both are fine.
    const div = await raw("POST", "/api/db-query", '{"sql":"select 1/0 as boom"}');
    note(
      "db-query-division-by-zero",
      "not-5xx",
      div.status,
      errorOf(div),
      div.status > 0 && div.status < 500,
    );
    await mustRefuse(
      "memory-get-unknown-id",
      "GET",
      "/api/memory/00000000-0000-4000-8000-000000000000?intent=stress",
    );
    await mustRefuse("memory-search-empty-query", "POST", "/api/memory/search", '{"query":""}');

    // --- Memory content with a NUL character, through the tool bridge ---
    const stored = (await ctx.swarm.memory_store({
      name: `stress-mem-reject-${env.id}`,
      content: "Stress pack synthetic record with a NUL \u0000 inside. Not a real memory.",
      scope: "agent",
      tags: ["stress-pack"],
    })) as Sdk;
    const ids: string[] = stored.data?.memoryIds ?? [];
    note(
      "memory-nul-in-content",
      "not-5xx",
      stored.status,
      stored.data?.message ?? stored.data?.error,
      stored.status < 500,
    );
    for (const id of ids) await ctx.swarm.memory_delete({ id });

    // Clean up the keys the cases above did create. An expired key is not in a
    // list, so the keys with a TTL are deleted by name.
    for (const name of ["ttl-negative", "ttl-huge", "ttl-max-safe", "text", "n", "max"]) {
      await raw("DELETE", kv(`${dir}/${name}`));
    }
    const rest = (await ctx.swarm.kv_list({ namespace: NS, prefix: `${dir}/`, limit: 100 })) as Sdk;
    for (const entry of (rest.data?.entries ?? []) as Any[]) {
      await ctx.swarm.kv_delete({ namespace: NS, key: String(entry.key) });
    }
    const left = (await ctx.swarm.kv_list({ namespace: NS, prefix: `${dir}/`, limit: 10 })) as Sdk;
    t.ok("cleanup-leaves-nothing", left.data?.total === 0, { total: left.data?.total });

    for (const outcome of outcomes) {
      t.ok(`${outcome.name}`, outcome.ok, {
        status: outcome.status,
        expect: outcome.expect,
        message: outcome.message,
      });
    }
    const statuses = Object.fromEntries(outcomes.map((o) => [o.name, o.status]));
    const fiveHundreds = outcomes.filter((o) => o.status >= 500).map((o) => o.name);
    return { cases: outcomes.length, fiveHundreds, emptyBodies, lossy, statuses };
  });
}
