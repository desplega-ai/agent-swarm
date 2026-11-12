import { FilesError } from "@/fs/provider";
import { buildAgentFsLiveUrl } from "@/utils/constants";
import { agentFsClientFor } from "../agent-fs-identity";
import { getDbClient, getSwarmConfigs } from "../db";
import { parseScene } from "./boards/elements";
import {
  ObjectsError,
  PRIMITIVE_KINDS,
  type PrimitiveObject,
  recordObjectVersion,
} from "./objects";
import { appendSheetRows, type CellInput, clearSheetRange, setSheetRange } from "./sheets/service";
import { MAX_OBJECT_BYTES } from "./write-object";

/**
 * Objects for people: the embed routes (src/http/objects.ts) read and save a
 * board or sheet on behalf of a dashboard or page viewer. Swarm RBAC is the
 * gate; agent-fs sees the object's owner agent as the writer, with its own
 * key. Only objects on the swarm's shared drive are reachable, where agents
 * are already editors, so a viewer cannot reach an agent's private drive.
 */

type Json = Record<string, unknown>;
type Row = Omit<PrimitiveObject, "link">;

/** A refusal with the HTTP status the route returns. */
export class ObjectEmbedError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 413 | 503,
    message: string,
    /** The file's current agent-fs version, on a 409. */
    readonly version?: number | null,
  ) {
    super(message);
  }
}

/** Who saves through an embed: the agent-fs commit message and `updated_by`. */
export type EmbedActor = { via: "app" | "page"; userId: string | null; name: string | null };

const versionOf = (value: string | null | undefined): number | null =>
  value && Number.isFinite(Number(value)) ? Number(value) : null;

/** The swarm's shared drive, resolved like agent-fs provisioning does: global config, then env. */
async function sharedDrive(): Promise<{ orgId: string; driveId: string } | null> {
  const value = async (key: string) =>
    (await getSwarmConfigs({ scope: "global", key }))[0]?.value?.trim() || process.env[key]?.trim();
  const orgId = (await value("AGENT_FS_DEFAULT_ORG_ID")) || (await value("AGENT_FS_SHARED_ORG_ID"));
  const driveId = await value("AGENT_FS_DEFAULT_DRIVE_ID");
  return orgId && driveId ? { orgId, driveId } : null;
}

/** Look up the object, check its drive, and open an agent-fs client as its owner agent. */
async function open(id: string) {
  const row = await getDbClient().get<Row>("SELECT * FROM primitive_objects WHERE id = ?", [id]);
  if (!row) throw new ObjectEmbedError(404, `no object with id '${id}'`);
  const shared = await sharedDrive();
  if (!shared || shared.orgId !== row.orgId || shared.driveId !== row.driveId) {
    throw new ObjectEmbedError(403, "this object is not on the swarm's shared agent-fs drive");
  }
  if (row.deletedAt) throw new ObjectEmbedError(404, `object '${id}' was deleted on agent-fs`);
  const client = row.ownerAgentId ? await agentFsClientFor(row.ownerAgentId) : undefined;
  if (!client || !row.ownerAgentId) {
    throw new ObjectEmbedError(503, "owner agent has no agent-fs key");
  }
  if (client.identity.orgId !== row.orgId || client.identity.driveId !== row.driveId) {
    throw new ObjectEmbedError(
      503,
      "owner agent's default agent-fs drive is not the object's drive",
    );
  }
  const scope = { taskId: "", name: "", key: row.path, orgId: row.orgId, driveId: row.driveId };
  return { row, owner: row.ownerAgentId, provider: client.provider, scope };
}

const withLink = (row: Row): PrimitiveObject => ({ ...row, link: buildAgentFsLiveUrl(row) });

/** agent-fs keeps this drive's rows fresh through `file.changed` (object-webhooks.ts). */
async function driveWatched(orgId: string, driveId: string): Promise<boolean> {
  const hook = await getDbClient().get<{ status: string }>(
    "SELECT status FROM agent_fs_object_webhooks WHERE orgId = ? AND driveId = ?",
    [orgId, driveId],
  );
  return hook?.status === "active";
}

/** The row records the person behind the last save; a save with no person clears it. */
async function recordEditor(id: string, userId: string | null): Promise<void> {
  await getDbClient().run("UPDATE primitive_objects SET updated_by = ? WHERE id = ?", [userId, id]);
}

/** Service refusals become 400, except the CAS give-up, which is a 409 the caller retries. */
function asEmbedError(error: unknown): unknown {
  if (!(error instanceof ObjectsError)) return error;
  // The sheet and object services raise this one refusal after their last 409 retry.
  const status = error.message.startsWith("concurrent writers") ? 409 : 400;
  return new ObjectEmbedError(status, error.message);
}

export type ObjectRead =
  | { object: PrimitiveObject; version: number | null; unchanged: true }
  | { object: PrimitiveObject; version: number | null; unchanged: false; content: unknown };

/**
 * Read an object with its content. With `knownVersion`, answer `unchanged`
 * without a download when the file is still at that version: from the row
 * alone when webhooks keep it fresh, else from one agent-fs `stat`.
 */
export async function readObject(id: string, knownVersion?: number): Promise<ObjectRead> {
  const { row, provider, scope } = await open(id);
  if (knownVersion !== undefined) {
    if (row.fileVersion === knownVersion && (await driveWatched(row.orgId, row.driveId))) {
      return { object: withLink(row), version: knownVersion, unchanged: true };
    }
    let current: number | null = null;
    try {
      current = await provider.currentVersion(scope);
    } catch (error) {
      if (error instanceof FilesError && error.code === "Unauthorized") throw error;
      // No stat (older agent-fs, a flaky call): fall through to a full read.
    }
    if (current !== null && current === knownVersion) {
      return { object: withLink(row), version: current, unchanged: true };
    }
  }
  let response: Response;
  try {
    response = await provider.download(scope);
  } catch (error) {
    if (error instanceof FilesError && error.code === "NotFound") {
      throw new ObjectEmbedError(404, `the file for object '${id}' is missing on agent-fs`);
    }
    throw error;
  }
  const version = versionOf(response.headers.get("x-agent-fs-version")) ?? row.fileVersion;
  const text = await response.text();
  let content: unknown = text;
  try {
    content = JSON.parse(text);
  } catch {
    // Not JSON (a hand-edited file): return the raw text.
  }
  return { object: withLink({ ...row, fileVersion: version }), version, unchanged: false, content };
}

/**
 * Replace a board's scene, guarded by `ifMatch`. No re-read and re-apply: a
 * full scene from an editor cannot merge, so a 409 hands back the current
 * version and the editor decides. The write keeps `swarm.id` and the title.
 */
export async function saveBoardContent(input: {
  id: string;
  content: unknown;
  ifMatch: number;
  actor: EmbedActor;
}): Promise<{ object: PrimitiveObject; version: number | null }> {
  const { row, provider, scope } = await open(input.id);
  if (row.kind !== "board") {
    throw new ObjectEmbedError(
      400,
      `object ${row.id} is a ${row.kind}; only a board takes a full save`,
    );
  }
  let scene: Json;
  try {
    scene = parseScene(input.content, row.path);
  } catch (error) {
    throw asEmbedError(error);
  }
  if (scene.type !== undefined && scene.type !== "excalidraw") {
    throw new ObjectEmbedError(
      400,
      "content is not an Excalidraw scene (type must be 'excalidraw')",
    );
  }
  const doc = PRIMITIVE_KINDS.board?.withId(scene, row.id) ?? scene;
  const swarm = doc.swarm as Json;
  if (swarm.title === undefined && row.title) swarm.title = row.title;
  const body = JSON.stringify(doc, null, 2);
  if (Buffer.byteLength(body) > MAX_OBJECT_BYTES) {
    throw new ObjectEmbedError(
      413,
      `the board would exceed ${MAX_OBJECT_BYTES} bytes; nothing written`,
    );
  }
  let written: { version?: string };
  try {
    written = await provider.upload(scope, body, {
      contentType: "application/json",
      ifMatch: String(input.ifMatch),
      message: `edit via ${input.actor.via} by ${input.actor.name ?? "operator"}`,
    });
  } catch (error) {
    if (!(error instanceof FilesError && error.code === "Conflict")) throw error;
    const current = await provider.currentVersion(scope).catch(() => null);
    throw new ObjectEmbedError(
      409,
      `the board changed on agent-fs since version ${input.ifMatch}; reload it`,
      current,
    );
  }
  const version = versionOf(written.version);
  await recordObjectVersion(row.id, version);
  await recordEditor(row.id, input.actor.userId);
  return { object: withLink({ ...row, fileVersion: version }), version };
}

export type SheetOp =
  | { op: "setRange"; range: string; values: CellInput[][] }
  | { op: "clearRange"; range: string }
  | { op: "appendRows"; tab: string; rows: CellInput[][] };

export type SheetOpResult = {
  op: SheetOp["op"];
  range: string;
  version: number;
  changed?: number;
  recalculated?: number;
  cleared?: number;
};

/** Run one cell patch through the sheet service (server-side recalc, CAS retry) as the owner. */
export async function applySheetOp(input: {
  id: string;
  op: SheetOp;
  actor: EmbedActor;
}): Promise<SheetOpResult> {
  const { row, owner } = await open(input.id);
  if (row.kind !== "sheet") {
    throw new ObjectEmbedError(400, `object ${row.id} is a ${row.kind}, not a sheet`);
  }
  const target = { agentId: owner, id: row.id };
  const { op } = input;
  let result: Omit<SheetOpResult, "op">;
  try {
    if (op.op === "setRange") {
      result = await setSheetRange({ ...target, range: op.range, values: op.values });
    } else if (op.op === "clearRange") {
      result = await clearSheetRange({ ...target, range: op.range });
    } else {
      result = await appendSheetRows({ ...target, tab: op.tab, rows: op.rows });
    }
  } catch (error) {
    throw asEmbedError(error);
  }
  // shortcut: the agent-fs commit message stays the sheet service's `sheet <op>`; pass the
  // actor through mutate() when the history view needs who edited a sheet.
  await recordEditor(row.id, input.actor.userId);
  return { op: op.op, ...result };
}
