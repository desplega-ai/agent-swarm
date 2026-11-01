import { asRecord, asRecords, asString, expect, expectStatus, pollUntil } from "../http";
import type { Scenario } from "../run";
import {
  callToolErr,
  callToolOk,
  getLead,
  registerAgent,
  structured,
  toolText,
  withMcp,
} from "./script-helpers";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Flow `kv`: the whole KV surface. Header-resolved and explicit-namespace routes (get, put,
 * delete, list, incr), value types, TTL and expiry, targeted views, namespace authorization
 * (other agents, reserved families, pages, the private MCP overflow namespace), size limits,
 * the kv-set / kv-get / kv-incr / kv-list / kv-delete tools, and the 24-hour
 * `mcp:overflow:<agentId>` spill an oversized tool result leaves behind.
 */
export const scriptKv: Scenario = {
  name: "script-kv",
  order: 460,
  async run(ctx) {
    const agentId = await registerAgent(ctx, "kv");
    const otherId = await registerAgent(ctx, "kv-other");
    const leadId = await getLead(ctx);
    const own = `task:agent:${agentId}`;
    const nsName = `e2e-kv-${ctx.nonce}`;

    // ── header-resolved routes: the namespace is the calling agent's ──
    const put = await ctx.api("PUT", "/api/kv/greeting", {
      agentId,
      body: { value: { hello: ctx.nonce } },
    });
    expectStatus(put, [200], "put json");
    const entry = asRecord(put.json);
    expect(
      entry.namespace === own &&
        entry.key === "greeting" &&
        entry.valueType === "json" &&
        entry.expiresAt === null &&
        asRecord(entry.value).hello === ctx.nonce &&
        typeof entry.createdAt === "number" &&
        typeof entry.updatedAt === "number",
      `kv put response is wrong: ${put.text}`,
    );
    const row = ctx.db.get<{ value: string; value_type: string }>(
      "SELECT value, value_type FROM kv_entries WHERE namespace = ? AND key = ?",
      [own, "greeting"],
    );
    expect(row?.value_type === "json" && row.value.includes(ctx.nonce), "kv row not persisted");
    const got = await ctx.api("GET", "/api/kv/greeting", { agentId });
    expectStatus(got, [200], "get");
    expect(
      JSON.stringify(got.json) === JSON.stringify(put.json),
      "get must return what put stored",
    );
    expectStatus(
      await ctx.api("GET", "/api/kv/greeting", { agentId: otherId }),
      [404],
      "another agent's namespace does not hold the key",
    );
    expectStatus(await ctx.api("GET", "/api/kv/greeting"), [400], "get without a namespace");
    expectStatus(
      await ctx.api("GET", "/api/kv/greeting", { apiKey: null, agentId }),
      [401],
      "no key",
    );

    const text = await ctx.api("PUT", "/api/kv/label", {
      agentId,
      body: { value: "plain text", valueType: "string", expiresInSec: 60 },
    });
    expectStatus(text, [200], "put string with ttl");
    const textEntry = asRecord(text.json);
    expect(
      textEntry.valueType === "string" &&
        textEntry.value === "plain text" &&
        Number(textEntry.expiresAt) - Number(textEntry.createdAt) >= 59_000 &&
        Number(textEntry.expiresAt) - Number(textEntry.createdAt) <= 61_000,
      `string put with a 60s ttl is wrong: ${text.text}`,
    );
    expectStatus(
      await ctx.api("PUT", "/api/kv/bad-int", {
        agentId,
        body: { value: 1.5, valueType: "integer" },
      }),
      [400],
      "non-integer value for an integer key",
    );
    expectStatus(
      await ctx.api("PUT", "/api/kv/bad-str", { agentId, body: { value: 5, valueType: "string" } }),
      [400],
      "number for a string key",
    );
    expectStatus(
      await ctx.api("PUT", "/api/kv/bad-ttl", { agentId, body: { value: 1, expiresInSec: -1 } }),
      [400],
      "negative ttl",
    );

    // expiry: an entry past its ttl is gone for get and list
    expectStatus(
      await ctx.api("PUT", "/api/kv/short-lived", {
        agentId,
        body: { value: 1, expiresInSec: 1 },
      }),
      [200],
      "put with a one second ttl",
    );
    const expired = await pollUntil(async () => {
      const response = await ctx.api("GET", "/api/kv/short-lived", { agentId });
      return response.status === 404;
    }, 8_000);
    expect(expired, "an entry never expired after its ttl");
    const afterExpiry = await ctx.api("GET", "/api/kv?prefix=short-lived", { agentId });
    expect(asRecord(afterExpiry.json).total === 0, "expired entries must leave the list");

    // incr: creates, increments, decrements, refuses other value types
    const incr = await ctx.api("POST", "/api/kv/counter/incr", { agentId, body: { by: 5 } });
    expectStatus(incr, [200], "incr");
    expect(
      asRecord(incr.json).value === 5 && asRecord(incr.json).valueType === "integer",
      "incr must create an integer entry",
    );
    const incrDefault = await ctx.api("POST", "/api/kv/counter/incr", { agentId });
    expect(asRecord(incrDefault.json).value === 6, "incr without a body adds one");
    const decr = await ctx.api("POST", "/api/kv/counter/incr", { agentId, body: { by: -10 } });
    expect(asRecord(decr.json).value === -4, "incr with a negative step decrements");
    expectStatus(
      await ctx.api("POST", "/api/kv/greeting/incr", { agentId, body: {} }),
      [409],
      "incr on a json entry",
    );
    expectStatus(
      await ctx.api("POST", "/api/kv/counter/incr", { agentId, body: { by: 1.5 } }),
      [400],
      "incr with a fractional step",
    );

    // targeted view: dot path + offset/limit page
    await ctx.api("PUT", "/api/kv/doc", {
      agentId,
      body: { value: { rows: [10, 20, 30, 40, 50], name: "doc" } },
    });
    const view = await ctx.api("GET", "/api/kv/doc?path=rows&offset=1&limit=2", { agentId });
    expectStatus(view, [200], "get a view");
    const viewBody = asRecord(view.json);
    expect(
      JSON.stringify(viewBody.value) === JSON.stringify([20, 30]) &&
        JSON.stringify(viewBody.view) ===
          JSON.stringify({
            path: "rows",
            type: "array",
            total: 5,
            offset: 1,
            returned: 2,
            nextOffset: 3,
          }),
      `view slice is wrong: ${view.text}`,
    );
    expectStatus(
      await ctx.api("GET", "/api/kv/doc?path=nope.deep", { agentId }),
      [400],
      "bad path",
    );

    // list: prefix, pagination, total
    for (const suffix of ["a", "b", "c"]) {
      await ctx.api("PUT", `/api/kv/page-${suffix}`, { agentId, body: { value: suffix } });
    }
    const listed = await ctx.api("GET", "/api/kv?prefix=page-&limit=2&offset=1", { agentId });
    expectStatus(listed, [200], "list");
    const listedBody = asRecord(listed.json);
    expect(
      listedBody.namespace === own &&
        listedBody.total === 3 &&
        asRecords(listedBody, "entries")
          .map((item) => item.key)
          .join(",") === "page-b,page-c",
      `list pagination is wrong: ${listed.text.slice(0, 300)}`,
    );
    expectStatus(await ctx.api("GET", "/api/kv?limit=0", { agentId }), [400], "list limit 0");
    expectStatus(await ctx.api("GET", "/api/kv?limit=1001", { agentId }), [400], "list limit 1001");

    // delete
    expectStatus(await ctx.api("DELETE", "/api/kv/page-a", { agentId }), [204], "delete");
    expectStatus(await ctx.api("DELETE", "/api/kv/page-a", { agentId }), [404], "delete again");
    expectStatus(await ctx.api("GET", "/api/kv/page-a", { agentId }), [404], "get deleted");
    expectStatus(await ctx.api("DELETE", "/api/kv/page-b"), [400], "delete without a namespace");

    // ── header precedence: X-Page-Id wins, an unknown X-Source-Task-Id falls back to the agent ──
    const page = await ctx.api("PUT", "/api/kv/page-key", {
      agentId,
      headers: { "X-Page-Id": `pg-${ctx.nonce}` },
      body: { value: 1 },
    });
    expectStatus(page, [200], "put through a page header");
    expect(asRecord(page.json).namespace === `task:page:pg-${ctx.nonce}`, "page namespace");
    const pageExplicit = await ctx.api("PUT", `/api/kv/_/${nsName}/elsewhere`, {
      agentId,
      headers: { "X-Page-Id": `pg-${ctx.nonce}` },
      body: { value: 2 },
    });
    expect(
      asRecord(pageExplicit.json).namespace === `task:page:pg-${ctx.nonce}`,
      "a page header must pin the namespace even on the explicit route",
    );
    const fallback = await ctx.api("GET", "/api/kv?prefix=greeting", {
      agentId,
      headers: { "X-Source-Task-Id": "00000000-0000-4000-8000-000000000000" },
    });
    expect(asRecord(fallback.json).namespace === own, "unknown task id falls back to the agent");
    await ctx.api("DELETE", "/api/kv/page-key", {
      agentId,
      headers: { "X-Page-Id": `pg-${ctx.nonce}` },
    });

    // ── explicit-namespace routes ──
    const explicitPut = await ctx.api("PUT", `/api/kv/_/${nsName}/doc`, {
      body: { value: { rows: [1, 2, 3] } },
    });
    expectStatus(explicitPut, [200], "explicit put");
    expect(asRecord(explicitPut.json).namespace === nsName, "explicit namespace");
    const explicitGet = await ctx.api("GET", `/api/kv/_/${nsName}/doc?path=rows&limit=2`);
    expect(
      JSON.stringify(asRecord(explicitGet.json).value) === JSON.stringify([1, 2]),
      "explicit get must support views",
    );
    const explicitIncr = await ctx.api("POST", `/api/kv/_/${nsName}/hits/incr`, {
      body: { by: 2 },
    });
    expect(asRecord(explicitIncr.json).value === 2, "explicit incr");
    const explicitList = await ctx.api("GET", `/api/kv/_/${nsName}`);
    expect(
      asRecord(explicitList.json).total === 2 && asRecord(explicitList.json).namespace === nsName,
      "explicit list",
    );
    const slashKey = encodeURIComponent("folder/item");
    expectStatus(
      await ctx.api("PUT", `/api/kv/_/${nsName}/${slashKey}`, { body: { value: "slash" } }),
      [200],
      "put a key with a slash",
    );
    const slashGet = await ctx.api("GET", `/api/kv/_/${nsName}/${slashKey}`);
    expect(asRecord(slashGet.json).key === "folder/item", "percent-encoded keys decode");
    expectStatus(
      await ctx.api("GET", `/api/kv/_/${nsName}/missing`),
      [404],
      "explicit get missing",
    );
    expectStatus(await ctx.api("DELETE", `/api/kv/_/${nsName}/doc`), [204], "explicit delete");
    expectStatus(
      await ctx.api("DELETE", `/api/kv/_/${nsName}/doc`),
      [404],
      "explicit delete again",
    );
    expectStatus(await ctx.api("GET", "/api/kv/_/bad%20ns/key"), [400], "invalid namespace");

    // ── authorization ──
    expectStatus(
      await ctx.api("PUT", `/api/kv/_/task:agent:${otherId}/x`, { agentId, body: { value: 1 } }),
      [403],
      "a worker may not write another agent's namespace",
    );
    expectStatus(
      await ctx.api("PUT", `/api/kv/_/task:agent:${otherId}/x`, {
        agentId: leadId,
        body: { value: 1 },
      }),
      [200],
      "a lead may write another agent's namespace",
    );
    expectStatus(
      await ctx.api("DELETE", `/api/kv/_/task:agent:${otherId}/x`, { agentId }),
      [403],
      "delete in another agent's namespace",
    );
    expectStatus(
      await ctx.api("POST", `/api/kv/_/task:agent:${otherId}/x/incr`, { agentId }),
      [403],
      "incr in another agent's namespace",
    );
    expectStatus(
      await ctx.api("DELETE", `/api/kv/_/task:agent:${otherId}/x`, { agentId: leadId }),
      [204],
      "lead delete",
    );
    expectStatus(
      await ctx.api("PUT", "/api/kv/_/apps/x", { agentId, body: { value: 1 } }),
      [403],
      "reserved namespace",
    );
    expectStatus(
      await ctx.api("PUT", "/api/kv/_/task:page:someone/x", { agentId, body: { value: 1 } }),
      [403],
      "page namespace without a page session",
    );
    expectStatus(
      await ctx.api("PUT", `/api/kv/_/${nsName}/${encodeURIComponent("_room/state")}`, {
        agentId,
        body: { value: 1 },
      }),
      [403],
      "reserved room snapshot key",
    );
    expectStatus(
      await ctx.api("GET", "/api/kv/_/session-labels/x", { agentId }),
      [403],
      "private reserved namespace read",
    );
    expectStatus(
      await ctx.api("PUT", `/api/kv/_/mcp:overflow:${otherId}/x`, { agentId, body: { value: 1 } }),
      [403],
      "write to another agent's overflow namespace",
    );
    expectStatus(
      await ctx.api("GET", `/api/kv/_/mcp:overflow:${otherId}/x`, { agentId: leadId }),
      [403],
      "even a lead may not read another agent's overflow namespace",
    );
    const big = await ctx.api("PUT", "/api/kv/too-big", {
      agentId,
      body: { value: "x".repeat(2 * 1024 * 1024 + 16) },
    });
    expectStatus(big, [413], "value above 2 MiB");

    // ── MCP tools ──
    await withMcp(ctx, agentId, async (mcp) => {
      const set = await callToolOk(mcp, "kv-set", { key: "tool-key", value: { n: 1 } });
      const setEntry = asRecord(structured(set).entry);
      expect(
        structured(set).namespace === own &&
          setEntry.key === "tool-key" &&
          setEntry.valueType === "json",
        "kv-set must write the caller's namespace",
      );
      const viaHttp = await ctx.api("GET", "/api/kv/tool-key", { agentId });
      expect(
        JSON.stringify(asRecord(viaHttp.json).value) === JSON.stringify({ n: 1 }),
        "the tool and the HTTP surface must share the same store",
      );
      const setString = await callToolOk(mcp, "kv-set", {
        key: "tool-str",
        value: "words",
        valueType: "string",
        expiresInSec: 120,
      });
      const setStringEntry = asRecord(structured(setString).entry);
      expect(
        setStringEntry.valueType === "string" && Number(setStringEntry.expiresAt) > Date.now(),
        "kv-set must honour valueType and expiresInSec",
      );
      await callToolOk(mcp, "kv-set", {
        key: "tool-explicit",
        value: 1,
        namespace: nsName,
      });
      const got = await callToolOk(mcp, "kv-get", { key: "tool-key" });
      expect(
        asRecord(asRecord(structured(got).entry).value).n === 1 && toolText(got).includes("Found"),
        "kv-get must return the entry",
      );
      const missing = await callToolOk(mcp, "kv-get", { key: "no-such-key" });
      expect(structured(missing).entry === null, "kv-get of a missing key returns entry:null");
      await callToolOk(mcp, "kv-set", { key: "tool-doc", value: { rows: [1, 2, 3, 4] } });
      const sliced = await callToolOk(mcp, "kv-get", {
        key: "tool-doc",
        path: "rows",
        offset: 1,
        limit: 2,
      });
      const slicedView = asRecord(structured(sliced).view);
      expect(
        slicedView.total === 4 && slicedView.returned === 2 && slicedView.nextOffset === 3,
        `kv-get view is wrong: ${JSON.stringify(slicedView)}`,
      );
      expect(toolText(sliced).includes("[2,3]"), "kv-get view must render the slice");
      const incr = await callToolOk(mcp, "kv-incr", { key: "tool-ctr", by: 4 });
      expect(asRecord(structured(incr).entry).value === 4, "kv-incr");
      expect(
        asRecord(structured(await callToolOk(mcp, "kv-incr", { key: "tool-ctr" })).entry).value ===
          5,
        "kv-incr default step",
      );
      const incrCollision = await callToolErr(mcp, "kv-incr", { key: "tool-key" });
      expect(toolText(incrCollision).includes("Cannot INCR"), "kv-incr on a json entry");
      const list = await callToolOk(mcp, "kv-list", { prefix: "tool-", limit: 10 });
      const listKeys = asRecords(structured(list), "entries").map((item) => item.key);
      expect(
        ["tool-ctr", "tool-doc", "tool-key", "tool-str"].every((key) => listKeys.includes(key)) &&
          Number(structured(list).total) >= 4,
        `kv-list is missing entries: ${listKeys.join(",")}`,
      );
      const explicitList = await callToolOk(mcp, "kv-list", { namespace: nsName });
      expect(
        asRecords(structured(explicitList), "entries").some((item) => item.key === "tool-explicit"),
        "kv-list with a namespace",
      );
      const deleted = await callToolOk(mcp, "kv-delete", { key: "tool-key" });
      expect(structured(deleted).deleted === true, "kv-delete");
      const deletedAgain = await callToolOk(mcp, "kv-delete", { key: "tool-key" });
      expect(structured(deletedAgain).deleted === false, "kv-delete of a missing key");
      expectStatus(
        await ctx.api("GET", "/api/kv/tool-key", { agentId }),
        [404],
        "tool-deleted key",
      );

      for (const [name, args] of [
        ["kv-set", { key: "x", value: 1, namespace: `task:agent:${otherId}` }],
        ["kv-set", { key: "x", value: 1, namespace: "apps" }],
        ["kv-set", { key: "x", value: 1, namespace: "task:page:abc" }],
        ["kv-set", { key: "_room/x", value: 1, namespace: nsName }],
        ["kv-set", { key: "x", value: 1.5, valueType: "integer" }],
        ["kv-set", { key: "x", value: 1, namespace: `mcp:overflow:${otherId}` }],
        ["kv-delete", { key: "x", namespace: `task:agent:${otherId}` }],
        ["kv-incr", { key: "x", namespace: "apps" }],
        ["kv-get", { key: "x", namespace: `mcp:overflow:${otherId}` }],
        ["kv-get", { key: "x", namespace: "session-labels" }],
        ["kv-list", { namespace: `mcp:overflow:${otherId}` }],
      ] as const) {
        const refused = await callToolErr(mcp, name, { ...args });
        expect(String(structured(refused).message).length > 0, `${name} refusal has no message`);
      }
    });
    // a lead may write into another agent's namespace through the tool too
    await withMcp(ctx, leadId, async (mcp) => {
      await callToolOk(mcp, "kv-set", {
        key: "lead-wrote",
        value: 1,
        namespace: `task:agent:${otherId}`,
      });
    });
    expectStatus(
      await ctx.api("GET", `/api/kv/_/task:agent:${otherId}/lead-wrote`),
      [200],
      "lead tool write",
    );

    // ── the MCP overflow spill: a result above the 10 KB ceiling is kept for 24 hours ──
    await withMcp(ctx, agentId, async (mcp) => {
      const huge = await callToolOk(mcp, "script-run", {
        source: `export default async function () { return { blob: "z".repeat(40000), tag: "${ctx.nonce}" }; }`,
        intent: `e2e overflow ${ctx.nonce}`,
      });
      const truncation = asRecord(structured(huge).truncation);
      expect(truncation.truncated === true, "an oversized tool result must be truncated");
      expect(
        Number(truncation.originalBytes) > 40_000 && truncation.limitBytes === 10_000,
        `truncation sizes are wrong: ${JSON.stringify(truncation).slice(0, 300)}`,
      );
      const pointer = asString(truncation.fullValueAt, "fullValueAt");
      const prefix = `kv://mcp:overflow:${agentId}/`;
      expect(pointer.startsWith(prefix), `the pointer must name the agent's overflow: ${pointer}`);
      const spilledKey = pointer.slice(prefix.length);
      expect(spilledKey.startsWith("v1/script-run/"), `spill key is wrong: ${spilledKey}`);
      expect(toolText(huge).length < 12_000, "the wire result must stay under the ceiling");

      const overflowNs = `mcp:overflow:${agentId}`;
      const spilled = await ctx.api(
        "GET",
        `/api/kv/_/${overflowNs}/${encodeURIComponent(spilledKey)}`,
        { agentId },
      );
      expectStatus(spilled, [200], "the owner reads its spilled result");
      const spilledEntry = asRecord(spilled.json);
      expect(
        spilledEntry.valueType === "string" &&
          Math.abs(Number(spilledEntry.expiresAt) - Number(spilledEntry.createdAt) - DAY_MS) <
            60_000,
        "the spill must expire after 24 hours",
      );
      const payload = asRecord(JSON.parse(String(spilledEntry.value)));
      expect(
        payload.toolName === "script-run" &&
          String(JSON.stringify(payload.outcome)).includes(ctx.nonce) &&
          String(JSON.stringify(payload.outcome)).includes("zzzzzzzzzz"),
        "the spill must hold the complete tool result",
      );
      expectStatus(
        await ctx.api("GET", `/api/kv/_/${overflowNs}/${encodeURIComponent(spilledKey)}`, {
          agentId: otherId,
        }),
        [403],
        "another agent must not read the spill",
      );
      // kv-get is the retrieval path and is exempt from the spill itself
      const page = await callToolOk(mcp, "kv-get", {
        namespace: overflowNs,
        key: spilledKey,
        path: "outcome.data.data.result.tag",
      });
      expect(
        toolText(page).includes(ctx.nonce) && asRecord(structured(page).view).type === "string",
        "kv-get must page into a spilled result by path",
      );
    });
  },
};
