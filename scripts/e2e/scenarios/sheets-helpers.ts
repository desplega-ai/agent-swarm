// Shared by the knowledge-sheets* scenarios: a local agent-fs stub and the agent's own-key config.
// Not a scenario: listed in NON_SCENARIO_FILES.
import { asRecord, asString, expect, expectStatus } from "../http";
import type { ScenarioContext } from "../run";
import { startStub } from "./script-helpers";

export type StoredFile = { body: string; version: number };

export type AgentFsStub = {
  origin: string;
  org: string;
  drive: string;
  ownKey: string;
  files: Map<string, StoredFile>;
  /** PUTs that reached the stub, including ones it answered 409. */
  writes: () => number;
  /** Runs inside every PUT before the version check, so a test can play the other writer. */
  beforeWrite: (hook: ((path: string) => void) | undefined) => void;
  /** Every request carried the agent's own key. */
  authorizedOnlyAsOwner: () => boolean;
  seen: ReturnType<typeof startStub>["seen"];
  stop: () => void;
};

/** The agent-fs raw GET/PUT (If-Match, If-None-Match) and glob contract the objects provider uses. */
export function startAgentFsStub(ctx: ScenarioContext, label: string): AgentFsStub {
  const ownKey = `af_own_${label}_${ctx.nonce}`;
  const org = `org-${label}-${ctx.nonce}`;
  const drive = `drive-${label}-${ctx.nonce}`;
  const files = new Map<string, StoredFile>();
  let writes = 0;
  let hook: ((path: string) => void) | undefined;
  const stub = startStub((request, body) => {
    const url = new URL(request.url);
    if (request.headers.get("authorization") !== `Bearer ${ownKey}`) {
      return new Response("unauthorized", { status: 401 });
    }
    const raw = url.pathname.match(/^\/orgs\/[^/]+\/drives\/[^/]+\/files\/(.+)\/raw$/);
    if (raw) {
      const path = decodeURIComponent(raw[1] ?? "");
      if (request.method === "GET") {
        const current = files.get(path);
        return current
          ? new Response(current.body, {
              headers: { "x-agent-fs-version": String(current.version) },
            })
          : new Response("not found", { status: 404 });
      }
      writes += 1;
      hook?.(path);
      const current = files.get(path);
      if (request.headers.get("if-none-match") === "*" && current) {
        return new Response("exists", { status: 409 });
      }
      const ifMatch = request.headers.get("if-match");
      if (ifMatch && String(current?.version) !== ifMatch) {
        return new Response("version mismatch", { status: 409 });
      }
      const version = (current?.version ?? 0) + 1;
      files.set(path, { body, version });
      return Response.json({ path, version });
    }
    if (url.pathname === `/orgs/${org}/ops`) {
      const matches = [...files.keys()]
        .filter((path) => path.endsWith(".sheet.json"))
        .map((path) => ({ path: `/${path}`, size: 1 }));
      return Response.json({ matches });
    }
    return new Response("not found", { status: 404 });
  });
  return {
    origin: stub.origin,
    org,
    drive,
    ownKey,
    files,
    writes: () => writes,
    beforeWrite: (next) => {
      hook = next;
    },
    authorizedOnlyAsOwner: () =>
      stub.seen.length > 0 &&
      stub.seen.every((entry) => entry.headers.authorization === `Bearer ${ownKey}`),
    seen: stub.seen,
    stop: stub.stop,
  };
}

/** Give `agentId` its own agent-fs identity on the stub. Returns the config ids to delete afterwards. */
export async function configureAgentFs(
  ctx: ScenarioContext,
  agentId: string,
  fake: AgentFsStub,
): Promise<string[]> {
  const ids: string[] = [];
  for (const [key, value] of [
    ["AGENT_FS_API_KEY", fake.ownKey],
    ["AGENT_FS_API_URL", fake.origin],
    ["AGENT_FS_DEFAULT_ORG_ID", fake.org],
    ["AGENT_FS_DEFAULT_DRIVE_ID", fake.drive],
  ] as const) {
    const response = await ctx.api("PUT", "/api/config", {
      body: { scope: "agent", scopeId: agentId, key, value, isSecret: key === "AGENT_FS_API_KEY" },
    });
    expectStatus(response, [200], `set agent config ${key}`);
    ids.push(asString(asRecord(response.json).id, `config ${key} id`));
  }
  return ids;
}

export async function removeConfigs(ctx: ScenarioContext, ids: string[]): Promise<void> {
  for (const id of ids) await ctx.api("DELETE", `/api/config/${id}`);
}

/** The stored workbook at `path`, parsed. */
export function storedSheet(fake: AgentFsStub, path: string): Record<string, unknown> {
  const file = fake.files.get(path);
  expect(file, `no file at ${path}`);
  return asRecord(JSON.parse(file.body));
}
