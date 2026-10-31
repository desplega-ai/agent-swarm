import { asRecord, asRecords, asString, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import { cancelTask, registerAgent } from "./knowledge-helpers";

const EMPTY_APP = {
  models: {},
  pages: { main: { root: "root", elements: { root: { type: "Container", props: {} } } } },
  defaultPage: "main",
};

export const knowledgeAssets: Scenario = {
  name: "knowledge-assets",
  order: 560,
  async run(ctx) {
    const agent = await registerAgent(ctx, "assets");
    const base = `shared/e2e-${ctx.nonce}`;
    const cleanupPages: string[] = [];
    const cleanupApps: string[] = [];
    const cleanupScripts: string[] = [];
    const cleanupTasks: string[] = [];
    try {
      // Fixtures: a page, an app, a script and two chained tasks, all in one namespace.
      let response = await ctx.api("POST", "/api/pages", {
        agentId: agent,
        body: {
          slug: `e2e-asset-${ctx.nonce}`,
          title: "Asset page",
          contentType: "text/html",
          authMode: "public",
          body: "<p>asset</p>",
          key: `${base}/pages/`,
        },
      });
      expectStatus(response, [201], "create the page fixture");
      const pageId = asString(asRecord(response.json).id, "page id");
      cleanupPages.push(pageId);

      response = await ctx.api("POST", "/api/apps", {
        agentId: agent,
        body: { name: `E2E asset app ${ctx.nonce}`, definition: EMPTY_APP },
      });
      expectStatus(response, [201], "create the app fixture");
      const appId = asString(asRecord(asRecord(response.json).app).id, "app id");
      cleanupApps.push(appId);

      const scriptName = `e2e-asset-script-${ctx.nonce}`;
      response = await ctx.api("POST", "/api/scripts/upsert", {
        agentId: agent,
        body: {
          name: scriptName,
          scope: "agent",
          description: "Asset namespace fixture",
          intent: "Exercise the asset move routes",
          source: "export default async function main() { return { ok: true }; }\n",
        },
      });
      expectStatus(response, [200], "upsert the script fixture");
      response = await ctx.api("GET", "/api/scripts?scope=agent&includeScratch=true");
      const script = asRecords(response.json, "scripts").find(
        (row) => row.name === scriptName && row.scopeId === agent,
      );
      expect(script, "the script fixture is not listed");
      const scriptId = asString(script.id, "script id");
      cleanupScripts.push(scriptName);

      const parent = await ctx.api("POST", "/api/tasks", {
        body: {
          task: `asset parent ${ctx.nonce}`,
          agentId: agent,
          routingReason: "human_pinned",
          source: "api",
          key: `${base}/tasks/`,
        },
      });
      expectStatus(parent, [201], "create the parent task");
      const parentId = asString(asRecord(parent.json).id, "parent task id");
      const child = await ctx.api("POST", "/api/tasks", {
        body: {
          task: `asset child ${ctx.nonce}`,
          agentId: agent,
          routingReason: "human_pinned",
          source: "api",
          parentTaskId: parentId,
          key: `${base}/tasks/`,
        },
      });
      expectStatus(child, [201], "create the child task");
      const childId = asString(asRecord(child.json).id, "child task id");
      cleanupTasks.push(parentId, childId);

      // ── Provider mappings ───────────────────────────────────────────────────────────────────
      const mappingBody = {
        providerId: "e2e-provider",
        orgId: `org-${ctx.nonce}`,
        driveId: `drive-${ctx.nonce}`,
        providerKey: `/docs/${ctx.nonce}/readme.md`,
        key: `${base}/docs/`,
      };
      response = await ctx.api("POST", "/api/assets/mappings", { body: mappingBody });
      expectStatus(response, [200], "register a provider mapping");
      const mapping = asRecord(response.json);
      const mappingId = asString(mapping.id, "mapping id");
      expect(
        mapping.providerId === "e2e-provider" &&
          mapping.providerOrgId === mappingBody.orgId &&
          mapping.providerDriveId === mappingBody.driveId &&
          mapping.providerKey === mappingBody.providerKey &&
          mapping.key === `${base}/docs/`,
        `mapping fields: ${JSON.stringify(mapping)}`,
      );
      response = await ctx.api("POST", "/api/assets/mappings", { body: mappingBody });
      expectStatus(response, [200], "register the same mapping again");
      expect(asRecord(response.json).id === mappingId, "mapping registration is idempotent");
      response = await ctx.api("POST", "/api/assets/mappings", {
        body: { ...mappingBody, providerKey: `/docs/${ctx.nonce}/other.md`, key: undefined },
      });
      expectStatus(response, [200], "register a mapping without a key");
      expect(
        String(asRecord(response.json).key).startsWith("shared/"),
        "a mapping without a key gets a default shared namespace",
      );
      for (const [label, body] of [
        ["without providerKey", { providerId: "p" }],
        ["with an empty providerId", { providerId: "", providerKey: "k" }],
        ["with a non-canonical key", { providerId: "p", providerKey: "k", key: "elsewhere/x/" }],
        [
          "in the personal namespace of an unknown user",
          { providerId: "p", providerKey: "k", key: `personal/${crypto.randomUUID()}/x/` },
        ],
      ] as const) {
        response = await ctx.api("POST", "/api/assets/mappings", { body });
        expectStatus(response, [400], `register a mapping ${label}`);
      }

      // ── Move: page, app, script, task (cascade), file ───────────────────────────────────────
      response = await ctx.api("PATCH", `/api/assets/page/${pageId}/key`, {
        agentId: agent,
        body: { key: `${base}/moved-pages` },
      });
      expectStatus(response, [200], "move a page namespace");
      let moved = asRecord(response.json);
      expect(
        moved.entityType === "page" && moved.id === pageId && moved.key === `${base}/moved-pages/`,
        `a move normalizes the key to its directory form: ${JSON.stringify(moved)}`,
      );
      expect(
        ctx.db.get<{ key: string }>('SELECT "key" AS key FROM pages WHERE id = ?', [pageId])
          ?.key === `${base}/moved-pages/`,
        "pages.key was not updated",
      );

      response = await ctx.api("PATCH", `/api/assets/app/${appId}/key`, {
        body: { key: `${base}/apps/` },
      });
      expectStatus(response, [200], "move an app namespace");
      moved = asRecord(response.json);
      expect(moved.entityType === "app" && moved.key === `${base}/apps/`, "app move");
      expect(
        ctx.db.get<{ key: string }>('SELECT "key" AS key FROM apps WHERE id = ?', [appId])?.key ===
          `${base}/apps/`,
        "apps.key was not updated",
      );
      response = await ctx.api("PATCH", `/api/assets/app/${crypto.randomUUID()}/key`, {
        body: { key: `${base}/apps/` },
      });
      expectStatus(response, [404], "move an unknown app");

      response = await ctx.api("PATCH", `/api/assets/script/${scriptId}/key`, {
        agentId: agent,
        body: { key: `${base}/scripts/` },
      });
      expectStatus(response, [200], "move a script namespace");
      expect(asRecord(response.json).entityType === "script", "script move");
      expect(
        ctx.db.get<{ key: string }>('SELECT "key" AS key FROM scripts WHERE id = ?', [scriptId])
          ?.key === `${base}/scripts/`,
        "scripts.key was not updated",
      );
      response = await ctx.api("PATCH", `/api/assets/script/${crypto.randomUUID()}/key`, {
        body: { key: `${base}/scripts/` },
      });
      expectStatus(response, [404], "move an unknown script");

      response = await ctx.api("PATCH", `/api/assets/task/${parentId}/key`, {
        body: { key: `${base}/moved-tasks/`, cascade: true },
      });
      expectStatus(response, [200], "move a task chain");
      moved = asRecord(response.json);
      expect(
        Array.isArray(moved.movedTaskIds) &&
          (moved.movedTaskIds as string[]).includes(parentId) &&
          (moved.movedTaskIds as string[]).includes(childId),
        `cascade moves the descendants: ${JSON.stringify(moved)}`,
      );
      expect(
        ctx.db.get<{ key: string }>('SELECT "key" AS key FROM agent_tasks WHERE id = ?', [childId])
          ?.key === `${base}/moved-tasks/`,
        "the child task key follows the cascade",
      );
      response = await ctx.api("PATCH", `/api/assets/task/${parentId}/key`, {
        body: { key: `${base}/moved-again/` },
      });
      expectStatus(response, [200], "move a task without cascade");
      expect(
        ctx.db.get<{ key: string }>('SELECT "key" AS key FROM agent_tasks WHERE id = ?', [childId])
          ?.key === `${base}/moved-tasks/`,
        "without cascade the child stays put",
      );
      response = await ctx.api("PATCH", `/api/assets/task/${crypto.randomUUID()}/key`, {
        body: { key: `${base}/x/` },
      });
      expectStatus(response, [404], "move an unknown task");

      response = await ctx.api("PATCH", `/api/assets/file/${mappingId}/key`, {
        body: { key: `${base}/moved-docs/` },
      });
      expectStatus(response, [200], "move a provider file namespace");
      expect(asRecord(response.json).entityType === "file", "file move");
      response = await ctx.api("PATCH", `/api/assets/file/${mappingId}/key`, {
        body: { key: `${base}/moved-docs/` },
        apiKey: null,
      });
      expectStatus(response, [401], "move without credentials");

      for (const [label, path, body, status] of [
        ["an invalid key root", `/api/assets/page/${pageId}/key`, { key: "elsewhere/x/" }, 400],
        ["a traversal key", `/api/assets/page/${pageId}/key`, { key: "shared/../x/" }, 400],
        [
          "a personal namespace of an unknown user",
          `/api/assets/page/${pageId}/key`,
          { key: `personal/${crypto.randomUUID()}/x/` },
          400,
        ],
        ["a missing key", `/api/assets/page/${pageId}/key`, {}, 400],
        ["an unknown entity type", `/api/assets/banana/${pageId}/key`, { key: `${base}/x/` }, 400],
        [
          "cascade on a page",
          `/api/assets/page/${pageId}/key`,
          { key: `${base}/x/`, cascade: true },
          400,
        ],
        [
          "an unknown page",
          `/api/assets/page/${crypto.randomUUID()}/key`,
          { key: `${base}/x/` },
          404,
        ],
      ] as const) {
        response = await ctx.api("PATCH", path, { body });
        expectStatus(response, [status], `move with ${label}`);
      }

      // ── List and audit ──────────────────────────────────────────────────────────────────────
      response = await ctx.api("GET", `/api/assets?keyPrefix=${encodeURIComponent(`${base}/`)}`);
      expectStatus(response, [200], "list assets by key prefix");
      const listing = asRecord(response.json);
      const assets = asRecords(listing, "assets");
      expect(listing.count === assets.length, "asset count");
      const byType = new Map(assets.map((asset) => [`${asset.entityType}:${asset.id}`, asset]));
      for (const [type, id, key] of [
        ["page", pageId, `${base}/moved-pages/`],
        ["app", appId, `${base}/apps/`],
        ["script", scriptId, `${base}/scripts/`],
        ["task", parentId, `${base}/moved-again/`],
        ["task", childId, `${base}/moved-tasks/`],
      ] as const) {
        const asset = byType.get(`${type}:${id}`);
        expect(asset?.key === key, `${type} ${id} is missing from the asset list at ${key}`);
        expect(
          typeof asset.label === "string" && typeof asset.updatedAt === "string",
          "asset summary fields",
        );
      }
      response = await ctx.api(
        "GET",
        `/api/assets?keyPrefix=${encodeURIComponent(`${base}/`)}&types=page,app`,
      );
      expect(
        asRecords(response.json, "assets").every(
          (asset) => asset.entityType === "page" || asset.entityType === "app",
        ) && asRecords(response.json, "assets").length === 2,
        "types filter",
      );
      response = await ctx.api(
        "GET",
        `/api/assets?keyPrefix=${encodeURIComponent(`${base}/`)}&limit=1`,
      );
      expect(asRecords(response.json, "assets").length === 1, "limit");
      response = await ctx.api("GET", "/api/assets?types=banana");
      expectStatus(response, [400], "list assets with an invalid type");
      response = await ctx.api("GET", "/api/assets?keyPrefix=elsewhere");
      expectStatus(response, [400], "list assets with an invalid key prefix");

      response = await ctx.api("GET", "/api/assets/key-audit");
      expectStatus(response, [200], "asset key audit");
      const audit = asRecord(response.json);
      expect(
        typeof audit.ok === "boolean" &&
          typeof audit.structuralValid === "boolean" &&
          typeof audit.checked === "number" &&
          audit.checked >= 5 &&
          typeof audit.fatalCount === "number" &&
          typeof audit.warningCount === "number" &&
          Array.isArray(audit.issues),
        `audit shape: ${response.text.slice(0, 200)}`,
      );
      expect(
        audit.ok === (audit.fatalCount === 0) && audit.structuralValid === true,
        "the audit is ok when no fatal issue exists, and the namespaces written here are structurally valid",
      );
      response = await ctx.api("GET", "/api/assets/key-audit", { apiKey: null });
      expectStatus(response, [401], "key audit without credentials");
    } finally {
      for (const id of cleanupPages) await ctx.api("DELETE", `/api/pages/${id}`);
      for (const id of cleanupApps) await ctx.api("DELETE", `/api/apps/${id}`);
      for (const name of cleanupScripts) await ctx.api("DELETE", `/api/scripts/${name}`);
      for (const id of cleanupTasks) await cancelTask(ctx, id).catch(() => {});
    }
  },
};
