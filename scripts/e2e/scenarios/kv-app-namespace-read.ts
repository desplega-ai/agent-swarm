import { asRecord, asString, expect, expectStatus } from "../http";
import type { Scenario } from "../run";

/** App rows in `apps:<appId>` read through /api/kv need `app.use`, as on the app row routes. */
export const kvAppNamespaceRead: Scenario = {
  name: "kv-app-namespace-read",
  order: 559,
  async run(ctx) {
    let response = await ctx.api("POST", "/api/apps", {
      body: {
        name: `E2E kv app read ${ctx.nonce}`,
        definition: {
          models: { note: { columns: { title: { kind: "string" } } } },
          queries: { notes: { model: "note" } },
          defaultPage: "home",
          pages: { home: { root: "root", elements: { root: { type: "Container", props: {} } } } },
        },
      },
    });
    expectStatus(response, [201], "create the app");
    const appId = String(asRecord(asRecord(response.json).app).id);
    try {
      response = await ctx.api("POST", `/api/apps/${appId}/models/note/rows`, {
        body: { values: { title: `kv row ${ctx.nonce}` } },
      });
      expectStatus(response, [201], "create a row");
      const rowId = asString(asRecord(asRecord(response.json).row).id, "row id");
      const ns = encodeURIComponent(`apps:${appId}`);
      const listPath = `/api/kv/_/${ns}?prefix=${encodeURIComponent("note/row/")}`;
      const getPath = `/api/kv/_/${ns}/${encodeURIComponent(`note/row/${rowId}`)}`;

      // The operator still reads app rows through KV.
      response = await ctx.api("GET", listPath);
      expectStatus(response, [200], "operator lists the app namespace");
      expect(response.text.includes(`kv row ${ctx.nonce}`), "operator sees the row");
      expectStatus(await ctx.api("GET", getPath), [200], "operator gets the row");

      // The first user is the last admin: create one to keep, then the viewer.
      await ctx.api("POST", "/api/users", {
        body: { name: `kv admin ${ctx.nonce}`, status: "active" },
      });
      const created = await ctx.api("POST", "/api/users", {
        body: { name: `kv viewer ${ctx.nonce}`, status: "active" },
      });
      expectStatus(created, [200], "create the viewer");
      const userId = asString(asRecord(asRecord(created.json).user).id, "user id");
      response = await ctx.api("PUT", `/api/users/${userId}/roles`, { body: { roles: ["viewer"] } });
      expectStatus(response, [200], "make the user a viewer");
      response = await ctx.api("POST", `/api/users/${userId}/mcp-tokens`, { body: { label: "kv" } });
      expectStatus(response, [200], "mint the viewer token");
      const token = asString(asRecord(response.json).plaintext, "token");

      expectStatus(
        await ctx.api("GET", `/api/apps/${appId}/models/note/rows`, { apiKey: token }),
        [403],
        "a viewer cannot list rows on the app route",
      );
      response = await ctx.api("GET", listPath, { apiKey: token });
      expectStatus(response, [403], "a viewer cannot list the app namespace");
      expect(!response.text.includes(`kv row ${ctx.nonce}`), "the denial carries no row");
      expectStatus(
        await ctx.api("GET", getPath, { apiKey: token }),
        [403],
        "a viewer cannot get an app row",
      );
    } finally {
      await ctx.api("DELETE", `/api/apps/${appId}`);
    }
  },
};
