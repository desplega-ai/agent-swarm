// Trigger group: asset namespace keys.
// Covers (each table: a canonical key under shared/ or personal/<existing user>/, else refused):
//   validate_agent_tasks_asset_key_insert, validate_agent_tasks_asset_key_update,
//   validate_pages_asset_key_insert, validate_pages_asset_key_update,
//   validate_apps_asset_key_insert, validate_apps_asset_key_update,
//   validate_scripts_asset_key_insert, validate_scripts_asset_key_update,
//   validate_scheduled_tasks_asset_key_insert, validate_scheduled_tasks_asset_key_update,
//   validate_workflows_asset_key_insert, validate_workflows_asset_key_update,
//   validate_asset_key_mappings_insert, validate_asset_key_mappings_update,
//   detach_asset_key_mapping_before_attachment_delete (deleting a task attachment turns its
//   provider mapping into an external one).
// Apps and scripts take no key on create: their insert gets the default shared key, which the
// scenario reads back.
import { sql, sqlIdent } from "../db";
import { asRecord, asRecords, asString, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";

type Created = { status: number; id?: string };

type Kind = "task" | "page" | "app" | "script" | "schedule" | "workflow" | "file";

const TABLE: Record<Kind, string> = {
  task: "agent_tasks",
  page: "pages",
  app: "apps",
  script: "scripts",
  schedule: "scheduled_tasks",
  workflow: "workflows",
  file: "asset_key_mappings",
};

const CANONICAL = /^(shared\/|personal\/[^/]+\/)([^/]+\/)*$/;

function keyOf(ctx: ScenarioContext, kind: Kind, id: string): string | undefined {
  const rows = ctx.db.query<{ id: string; key: string }>(
    sql`SELECT id, "key" AS key FROM ${sqlIdent(TABLE[kind])} WHERE id = ${id}`,
  );
  return rows[0]?.key;
}

async function registerAgent(ctx: ScenarioContext, label: string): Promise<string> {
  const response = await ctx.api("POST", "/api/agents", {
    body: { name: `trg-ak-${label}-${ctx.nonce}`, role: "worker", status: "online" },
  });
  expectStatus(response, [201], `register ${label}`);
  return asString(asRecord(response.json).id, `${label} id`);
}

async function callTool(
  ctx: ScenarioContext,
  agentId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string }> {
  const conn = await ctx.connectMcp(agentId);
  try {
    const result = asRecord(await conn.callTool(name, args));
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content.map((block) => String(asRecord(block).text ?? "")).join("\n");
    return { isError: result.isError === true, text };
  } finally {
    await conn.close();
  }
}

export const triggerAssetKeys: Scenario = {
  name: "trigger-asset-keys",
  order: 9_310,
  async run(ctx) {
    const base = `shared/trg-ak-${ctx.nonce}`;
    const unknownUser = `personal/${crypto.randomUUID()}/x/`;
    const badKeys = [
      ["an unknown root", `elsewhere/${ctx.nonce}/`],
      ["a traversal segment", `${base}/../x/`],
      ["an unknown user's personal namespace", unknownUser],
    ] as const;
    const agent = await registerAgent(ctx, "owner");
    const userResponse = await ctx.api("POST", "/api/users", {
      body: { name: `Trigger asset ${ctx.nonce}`, status: "active" },
    });
    expectStatus(userResponse, [200], "create a user");
    const userId = asString(asRecord(asRecord(userResponse.json).user).id, "user id");
    const asUser = { "X-Swarm-User-Id": userId };
    const personal = `personal/${userId}/trg-ak-${ctx.nonce}/`;

    const cleanup: Array<() => Promise<unknown>> = [];
    const configIds: string[] = [];
    const stub = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        const url = new URL(request.url);
        if (request.method === "GET" && url.pathname.endsWith("/raw")) {
          return new Response("attached bytes", {
            headers: { "Content-Type": "text/plain", "Content-Length": "14" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

    try {
      // ── inserts: a canonical key is stored, a bad key writes nothing ───────
      const created: Partial<Record<Kind, string>> = {};
      const creators: Record<
        "task" | "page" | "schedule" | "workflow" | "file",
        (key: string | undefined, label: string) => Promise<Created>
      > = {
        task: async (key, label) => {
          const res = await ctx.api("POST", "/api/tasks", {
            body: {
              task: `asset key ${label} ${ctx.nonce}`,
              agentId: agent,
              routingReason: "human_pinned",
              source: "api",
              ...(key === undefined ? {} : { key }),
            },
          });
          const id = res.status === 201 ? asString(asRecord(res.json).id, "task id") : undefined;
          if (id) cleanup.push(() => ctx.api("POST", `/api/tasks/${id}/cancel`, { body: {} }));
          return { status: res.status, id };
        },
        page: async (key, label) => {
          const res = await ctx.api("POST", "/api/pages", {
            agentId: agent,
            body: {
              slug: `trg-ak-${label.replaceAll(" ", "-")}-${ctx.nonce}`,
              title: "Asset key page",
              contentType: "text/html",
              authMode: "public",
              body: "<p>key</p>",
              ...(key === undefined ? {} : { key }),
            },
          });
          const id = res.status === 201 ? asString(asRecord(res.json).id, "page id") : undefined;
          if (id) cleanup.push(() => ctx.api("DELETE", `/api/pages/${id}`));
          return { status: res.status, id };
        },
        schedule: async (key, label) => {
          const res = await ctx.api("POST", "/api/schedules", {
            body: {
              name: `trg-ak-${label.replaceAll(" ", "-")}-${ctx.nonce}`,
              taskTemplate: `asset key schedule ${ctx.nonce}`,
              intervalMs: 3_600_000,
              targetAgentId: agent,
              ...(key === undefined ? {} : { key }),
            },
          });
          const id =
            res.status === 201 ? asString(asRecord(res.json).id, "schedule id") : undefined;
          if (id) cleanup.push(() => ctx.api("DELETE", `/api/schedules/${id}`));
          return { status: res.status, id };
        },
        workflow: async (key, label) => {
          const res = await ctx.api("POST", "/api/workflows", {
            body: {
              name: `trg-ak-${label.replaceAll(" ", "-")}-${ctx.nonce}`,
              definition: {
                nodes: [{ id: "a", type: "script", config: { runtime: "bash", script: "true" } }],
              },
              ...(key === undefined ? {} : { key }),
            },
          });
          const id =
            res.status === 201 ? asString(asRecord(res.json).id, "workflow id") : undefined;
          if (id) cleanup.push(() => ctx.api("DELETE", `/api/workflows/${id}`));
          return { status: res.status, id };
        },
        file: async (key, label) => {
          const res = await ctx.api("POST", "/api/assets/mappings", {
            body: {
              providerId: "trg-provider",
              providerKey: `/trg/${ctx.nonce}/${label.replaceAll(" ", "-")}.md`,
              ...(key === undefined ? {} : { key }),
            },
          });
          const id = res.status === 200 ? asString(asRecord(res.json).id, "mapping id") : undefined;
          return { status: res.status, id };
        },
      };
      const okStatus = { task: 201, page: 201, schedule: 201, workflow: 201, file: 200 } as const;

      for (const kind of ["task", "page", "schedule", "workflow", "file"] as const) {
        for (const [label, key] of badKeys) {
          const res = await creators[kind](key, `bad ${label}`);
          expect(res.status === 400, `create a ${kind} with ${label}: ${res.status}, expected 400`);
        }
        const res = await creators[kind](`${base.toUpperCase()}/${kind}`, "mixed case");
        expect(res.status === okStatus[kind] && res.id, `create a ${kind} with a shared key`);
        created[kind] = res.id;
        expect(
          keyOf(ctx, kind, res.id) === `${base}/${kind}/`,
          `a ${kind} stores the canonical lowercase key with a trailing slash, got ${keyOf(ctx, kind, res.id)}`,
        );
      }
      for (const table of Object.values(TABLE)) {
        const leaked = ctx.db.get<{ n: number }>(
          sql`SELECT count(*) AS n FROM ${sqlIdent(table)}
              WHERE "key" = ${unknownUser} OR "key" LIKE ${`elsewhere/${ctx.nonce}/%`}`,
        );
        expect(leaked?.n === 0, `a refused write left a bad key in ${table}`);
      }

      // Apps and scripts: the insert takes the default shared key.
      let response = await ctx.api("POST", "/api/apps", {
        agentId: agent,
        body: {
          name: `Trigger asset app ${ctx.nonce}`,
          definition: {
            models: {},
            pages: { main: { root: "root", elements: { root: { type: "Container", props: {} } } } },
            defaultPage: "main",
          },
        },
      });
      expectStatus(response, [201], "create an app");
      created.app = asString(asRecord(asRecord(response.json).app).id, "app id");
      const appId = created.app;
      cleanup.push(() => ctx.api("DELETE", `/api/apps/${appId}`));
      const scriptName = `trg-ak-script-${ctx.nonce}`;
      response = await ctx.api("POST", "/api/scripts/upsert", {
        agentId: agent,
        body: {
          name: scriptName,
          scope: "agent",
          description: "Asset key fixture",
          intent: "Exercise asset key validation",
          source: "export default async function main() { return { ok: true }; }\n",
        },
      });
      expectStatus(response, [200], "upsert a script");
      cleanup.push(() => ctx.api("DELETE", `/api/scripts/${scriptName}`));
      response = await ctx.api("GET", "/api/scripts?scope=agent&includeScratch=true");
      const script = asRecords(response.json, "scripts").find(
        (row) => row.name === scriptName && row.scopeId === agent,
      );
      expect(script, "the script is listed");
      created.script = asString(script.id, "script id");
      for (const kind of ["app", "script"] as const) {
        const key = keyOf(ctx, kind, created[kind] as string);
        expect(
          typeof key === "string" && key.startsWith("shared/") && CANONICAL.test(key),
          `a new ${kind} gets a canonical default key, got ${key}`,
        );
      }

      // ── updates: a move to a bad key changes nothing, a good move lands ────
      for (const kind of Object.keys(TABLE) as Kind[]) {
        const id = created[kind] as string;
        const before = keyOf(ctx, kind, id);
        for (const [label, key] of badKeys) {
          response = await ctx.api("PATCH", `/api/assets/${kind}/${id}/key`, { body: { key } });
          expectStatus(response, [400], `move a ${kind} to ${label}`);
        }
        expect(keyOf(ctx, kind, id) === before, `a refused move keeps the ${kind} key`);
        response = await ctx.api("PATCH", `/api/assets/${kind}/${id}/key`, {
          headers: asUser,
          body: { key: personal },
        });
        expectStatus(response, [200], `move a ${kind} into an existing user's namespace`);
        expect(keyOf(ctx, kind, id) === personal, `the ${kind} moved to the personal key`);
        response = await ctx.api("PATCH", `/api/assets/${kind}/${id}/key`, {
          body: { key: `${base}/moved/` },
        });
        expectStatus(response, [200], `move a ${kind} back to shared`);
        expect(keyOf(ctx, kind, id) === `${base}/moved/`, `the ${kind} moved back`);
      }

      // ── an attachment's mapping detaches when the attachment is deleted ────
      // A second agent with no other open task, so its first poll claims this one.
      const attacher = await registerAgent(ctx, "attacher");
      cleanup.push(() => ctx.api("POST", "/close", { agentId: attacher, body: {} }));
      const org = `org-${ctx.nonce}`;
      const drive = `drive-${ctx.nonce}`;
      for (const [key, value] of [
        ["AGENT_FS_API_URL", `http://127.0.0.1:${stub.port}`],
        ["AGENT_FS_API_KEY", `af_${crypto.randomUUID().replaceAll("-", "")}`],
      ] as const) {
        const res = await ctx.api("PUT", "/api/config", {
          body: {
            scope: "agent",
            scopeId: attacher,
            key,
            value,
            isSecret: key === "AGENT_FS_API_KEY",
          },
        });
        expectStatus(res, [200], `set agent config ${key}`);
        configIds.push(asString(asRecord(res.json).id, `${key} id`));
      }
      response = await ctx.api("POST", "/api/tasks", {
        body: {
          task: `asset key attachment ${ctx.nonce}`,
          agentId: attacher,
          routingReason: "human_pinned",
          source: "api",
          key: `${base}/attach/`,
        },
      });
      expectStatus(response, [201], "create the attachment task");
      const taskId = asString(asRecord(response.json).id, "attachment task id");
      cleanup.push(() => ctx.api("POST", `/api/tasks/${taskId}/cancel`, { body: {} }));
      const claimed = await pollUntil(async () => {
        await ctx.api("GET", "/api/poll", { agentId: attacher });
        const task = await ctx.api("GET", `/api/tasks/${taskId}`);
        return asRecord(task.json).status === "in_progress";
      }, 15_000);
      expect(claimed, "the agent never claimed the attachment task");
      const stored = await callTool(ctx, attacher, "store-progress", {
        taskId,
        progress: "attaching a file",
        attachments: [
          {
            kind: "agent-fs",
            name: `report-${ctx.nonce}.md`,
            path: `/reports/report-${ctx.nonce}.md`,
            orgId: org,
            driveId: drive,
          },
        ],
      });
      expect(!stored.isError, `store-progress with an agent-fs attachment: ${stored.text}`);
      response = await ctx.api("GET", `/api/fs/tasks/${taskId}/files`);
      expectStatus(response, [200], "list task attachments");
      const attachment = asRecords(response.json, "attachments")[0];
      expect(attachment, "the attachment is listed");
      const attachmentId = asString(attachment.id, "attachment id");
      type MappingRow = {
        id: string;
        key: string;
        source_entity_type: string | null;
        source_entity_id: string | null;
      };
      const mapping = () =>
        ctx.db.get<MappingRow>(
          sql`SELECT id, "key" AS key, source_entity_type, source_entity_id FROM asset_key_mappings
              WHERE provider_key = ${`/reports/report-${ctx.nonce}.md`}`,
        );
      const attached = mapping();
      expect(
        attached?.source_entity_type === "task-attachment" &&
          attached.source_entity_id === attachmentId &&
          attached.key === `${base}/attach/`,
        `the attachment registers a task-attachment mapping: ${JSON.stringify(attached)}`,
      );
      response = await ctx.api("PATCH", `/api/assets/file/${attached.id}/key`, {
        body: { key: `${base}/elsewhere/` },
      });
      expectStatus(response, [400], "an attached file moves only with its task");
      response = await ctx.api("DELETE", `/api/fs/tasks/${taskId}/files/${attachmentId}`);
      expectStatus(response, [204], "delete the attachment");
      const detached = mapping();
      expect(
        detached?.id === attached.id &&
          detached.source_entity_type === "external" &&
          detached.source_entity_id === null &&
          detached.key === `${base}/attach/`,
        `the mapping detaches and keeps its key: ${JSON.stringify(detached)}`,
      );
      response = await ctx.api("PATCH", `/api/assets/file/${attached.id}/key`, {
        body: { key: `${base}/elsewhere/` },
      });
      expectStatus(response, [200], "a detached file moves on its own");
    } finally {
      for (const step of cleanup.reverse()) await step();
      for (const id of configIds) await ctx.api("DELETE", `/api/config/${id}`);
      await ctx.api("POST", "/close", { agentId: agent, body: {} });
      await stub.stop(true);
    }
  },
};
