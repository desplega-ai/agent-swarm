import { type FileScope, FilesError, normalizeStoredKey } from "@/fs/provider";
import { buildAgentFsLiveUrl } from "@/utils/constants";
import { scrubSecrets } from "@/utils/secret-scrubber";
import { agentFsClientFor } from "../agent-fs-identity";
import { getDbClient } from "../db";
import { emptySheet } from "./sheets/format";

/**
 * Primitive objects: agent-fs files that back a primitive, each with a stable
 * id. The file is the source of truth and embeds the id; `primitive_objects`
 * is a cache that `reindexObjects` rebuilds from the drive.
 */

type Json = Record<string, unknown>;

type PrimitiveKind = {
  suffix: string;
  glob: string;
  contentType: string;
  empty: (id: string, title?: string) => Json;
  readId: (json: Json) => string | undefined;
  withId: (json: Json, id: string) => Json;
};

const swarmBlock = (json: Json): Json =>
  json.swarm && typeof json.swarm === "object" ? (json.swarm as Json) : {};

export const PRIMITIVE_KINDS: Readonly<Record<string, PrimitiveKind>> = {
  // An Excalidraw scene. A stock Excalidraw save drops `swarm`; reindex then
  // recovers the id from the row at the same path and writes it back.
  board: {
    suffix: ".excalidraw",
    glob: "**/*.excalidraw",
    contentType: "application/json",
    empty: (id, title) => ({
      type: "excalidraw",
      version: 2,
      source: "agent-swarm",
      elements: [],
      appState: {},
      files: {},
      swarm: { id, kind: "board", ...(title ? { title } : {}) },
    }),
    readId: (json) => {
      const id = swarmBlock(json).id;
      return typeof id === "string" && id.length > 0 ? id : undefined;
    },
    withId: (json, id) => ({ ...json, swarm: { ...swarmBlock(json), id, kind: "board" } }),
  },
  // A `swarm-sheet/1` workbook (src/be/primitives/sheets/format.ts).
  sheet: {
    suffix: ".sheet.json",
    glob: "**/*.sheet.json",
    contentType: "application/json",
    empty: (id, title) => emptySheet(id, title),
    readId: (json) => {
      const id = swarmBlock(json).id;
      return typeof id === "string" && id.length > 0 ? id : undefined;
    },
    withId: (json, id) => ({ ...json, swarm: { ...swarmBlock(json), id, kind: "sheet" } }),
  },
};

export const PRIMITIVE_KIND_NAMES = Object.keys(PRIMITIVE_KINDS) as [string, ...string[]];

/** A refusal the tool layer returns as `toolErr`, not a server error. */
export class ObjectsError extends Error {}

export const NO_AGENT_FS_IDENTITY =
  "agent-fs is not configured for this agent: objects need the agent's own AGENT_FS_API_KEY (agent-scoped config) plus AGENT_FS_API_URL, AGENT_FS_DEFAULT_ORG_ID and AGENT_FS_DEFAULT_DRIVE_ID";

type ObjectRow = {
  id: string;
  kind: string;
  orgId: string;
  driveId: string;
  path: string;
  title: string | null;
  fileVersion: number | null;
  ownerAgentId: string | null;
  /** Set when agent-fs reported the file deleted; object-list hides the row. */
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PrimitiveObject = ObjectRow & { link: string | null };

const MAX_LIST_LIMIT = 200;
// shortcut: one reindex call considers at most this many files; page by kind or add a cursor when a drive outgrows it.
const MAX_REINDEX_FILES = 500;
// Full downloads per reindex call. Unchanged files cost one `stat` and no read,
// so repeated calls converge: each one reads at most this many changed files.
const MAX_REINDEX_READS = 50;
// Wall-clock and downloaded-byte budget per reindex call, so one call stays bounded
// even when every file is large or agent-fs is slow. The byte check runs before each
// read, so a call can overshoot by at most one file.
const MAX_REINDEX_MS = 20_000;
const MAX_REINDEX_BYTES = 16 * 1024 * 1024;

export type ReindexLimits = { reads: number; ms: number; bytes: number };
const REINDEX_LIMITS: ReindexLimits = {
  reads: MAX_REINDEX_READS,
  ms: MAX_REINDEX_MS,
  bytes: MAX_REINDEX_BYTES,
};
// shortcut: in-process only; two API replicas can still reindex one drive at once (each pass is safe, just duplicated work).
const reindexing = new Set<string>();

const withLink = (row: ObjectRow): PrimitiveObject => ({ ...row, link: buildAgentFsLiveUrl(row) });

export async function clientFor(agentId: string | undefined) {
  const client = agentId ? await agentFsClientFor(agentId) : undefined;
  if (!client) throw new ObjectsError(NO_AGENT_FS_IDENTITY);
  const { orgId, driveId } = client.identity;
  const scope = (path: string): FileScope => ({ taskId: "", name: "", key: path, orgId, driveId });
  return { provider: client.provider, orgId, driveId, scope };
}

function kindFor(kind: string): PrimitiveKind {
  const def = Object.hasOwn(PRIMITIVE_KINDS, kind) ? PRIMITIVE_KINDS[kind] : undefined;
  if (!def)
    throw new ObjectsError(`unknown kind '${kind}' (known: ${PRIMITIVE_KIND_NAMES.join(", ")})`);
  return def;
}

export function normalizePath(path: string): string {
  try {
    return normalizeStoredKey(path);
  } catch (error) {
    throw new ObjectsError(`invalid path '${path}': ${(error as Error).message}`);
  }
}

const versionOf = (value: string | null | undefined): number | null =>
  value && Number.isFinite(Number(value)) ? Number(value) : null;

/**
 * Point the row with `id` at `path`. A row at the same path with another id is
 * replaced: the file there now carries `id`, and the file wins.
 */
async function saveRow(
  row: Omit<ObjectRow, "createdAt" | "updatedAt" | "deletedAt">,
  opts: { onlyNewer?: boolean } = {},
): Promise<ObjectRow> {
  const now = new Date().toISOString();
  return getDbClient().transaction(async (tx) => {
    await tx.run(
      "DELETE FROM primitive_objects WHERE orgId = ? AND driveId = ? AND path = ? AND id <> ?",
      [row.orgId, row.driveId, row.path, row.id],
    );
    await tx.run(
      `INSERT INTO primitive_objects
         (id, kind, orgId, driveId, path, title, fileVersion, ownerAgentId, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         kind = excluded.kind, orgId = excluded.orgId, driveId = excluded.driveId,
         path = excluded.path, title = COALESCE(excluded.title, primitive_objects.title),
         fileVersion = excluded.fileVersion, deletedAt = NULL, updatedAt = excluded.updatedAt
       WHERE ? = 0 OR primitive_objects.path <> excluded.path
         OR primitive_objects.fileVersion IS NULL
         OR primitive_objects.fileVersion < excluded.fileVersion`,
      [
        row.id,
        row.kind,
        row.orgId,
        row.driveId,
        row.path,
        // The only writer of `title` (.text-columns.json: scrubbed).
        row.title === null ? null : scrubSecrets(row.title),
        row.fileVersion,
        row.ownerAgentId,
        now,
        now,
        // Concurrent events for one path: an older read must not overwrite a newer one.
        opts.onlyNewer ? 1 : 0,
      ],
    );
    const saved = await tx.get<ObjectRow>("SELECT * FROM primitive_objects WHERE id = ?", [row.id]);
    if (!saved) throw new Error(`primitive object ${row.id} vanished after save`);
    return saved;
  });
}

export async function createObject(input: {
  agentId: string | undefined;
  kind: string;
  path: string;
  title?: string;
  /** Fill the new file (for example a board with shapes). Runs before the upload. */
  build?: (empty: Json) => Json;
}): Promise<PrimitiveObject> {
  const kind = kindFor(input.kind);
  const path = normalizePath(input.path);
  if (!path.endsWith(kind.suffix)) {
    throw new ObjectsError(`a ${input.kind} path must end with '${kind.suffix}'`);
  }
  const { provider, orgId, driveId, scope } = await clientFor(input.agentId);
  const id = crypto.randomUUID();
  const empty = kind.empty(id, input.title);
  const content = input.build ? input.build(empty) : empty;
  let version: string | undefined;
  try {
    ({ version } = await provider.upload(scope(path), JSON.stringify(content, null, 2), {
      contentType: kind.contentType,
      ifNoneMatch: "*",
      message: `create ${input.kind}`,
    }));
  } catch (error) {
    if (error instanceof FilesError && error.code === "Conflict") {
      throw new ObjectsError(`a file already exists at '${path}'; run object-reindex to adopt it`);
    }
    throw error;
  }
  // After the upload, never inside a transaction around it.
  const row = await saveRow({
    id,
    kind: input.kind,
    orgId,
    driveId,
    path,
    title: input.title ?? null,
    fileVersion: versionOf(version),
    ownerAgentId: input.agentId ?? null,
  });
  watchDrive(orgId, driveId);
  return withLink(row);
}

/**
 * Best-effort: make sure agent-fs tells the swarm about changes on this drive
 * (object-webhooks.ts). Not awaited, never throws: object tools work without it.
 */
function watchDrive(orgId: string, driveId: string): void {
  void import("./object-webhooks")
    .then(({ ensureObjectWebhook }) => ensureObjectWebhook(orgId, driveId))
    .catch(() => undefined);
}

export async function getObject(input: {
  agentId: string | undefined;
  id?: string;
  path?: string;
  includeContent?: boolean;
}): Promise<{ object: PrimitiveObject; missing: boolean; content?: unknown }> {
  if (!input.id && !input.path) throw new ObjectsError("pass `id` or `path`");
  const { provider, orgId, driveId, scope } = await clientFor(input.agentId);
  const row = input.id
    ? await getDbClient().get<ObjectRow>(
        "SELECT * FROM primitive_objects WHERE id = ? AND orgId = ? AND driveId = ?",
        [input.id, orgId, driveId],
      )
    : await getDbClient().get<ObjectRow>(
        "SELECT * FROM primitive_objects WHERE path = ? AND orgId = ? AND driveId = ?",
        [normalizePath(input.path ?? ""), orgId, driveId],
      );
  if (!row) {
    throw new ObjectsError(
      `no object ${input.id ? `with id '${input.id}'` : `at '${input.path}'`} on this drive; run object-reindex if the file exists`,
    );
  }
  let response: Response;
  try {
    response = await provider.download(scope(row.path));
  } catch (error) {
    // Keep the row: the file may come back, and reindex reports it as missing.
    if (error instanceof FilesError && error.code === "NotFound") {
      return { object: withLink(row), missing: true };
    }
    throw error;
  }
  const object = withLink({
    ...row,
    fileVersion: versionOf(response.headers.get("x-agent-fs-version")) ?? row.fileVersion,
  });
  if (!input.includeContent) {
    await response.body?.cancel();
    return { object, missing: false };
  }
  const text = await response.text();
  let content: unknown = text;
  try {
    content = JSON.parse(text);
  } catch {
    // Not JSON (a hand-edited file): return the raw text.
  }
  return { object, missing: false, content };
}

/** Record the file version a content write produced (board and sheet services). */
export async function recordObjectVersion(id: string, fileVersion: number | null): Promise<void> {
  await getDbClient().run(
    "UPDATE primitive_objects SET fileVersion = ?, updatedAt = ? WHERE id = ?",
    [fileVersion, new Date().toISOString(), id],
  );
}

export async function listObjects(input: {
  agentId: string | undefined;
  kind?: string;
  prefix?: string;
  limit?: number;
  offset?: number;
}): Promise<{ objects: PrimitiveObject[]; total: number }> {
  if (input.kind) kindFor(input.kind);
  const { orgId, driveId } = await clientFor(input.agentId);
  const where = ["orgId = ?", "driveId = ?", "deletedAt IS NULL"];
  const params: string[] = [orgId, driveId];
  if (input.kind) {
    where.push("kind = ?");
    params.push(input.kind);
  }
  if (input.prefix) {
    // instr, not LIKE: a path may hold % or _.
    where.push("instr(path, ?) = 1");
    params.push(input.prefix.replace(/^\/+/, ""));
  }
  const limit = Math.min(Math.max(input.limit ?? 50, 1), MAX_LIST_LIMIT);
  const offset = Math.max(input.offset ?? 0, 0);
  const db = getDbClient();
  const rows = await db.query<ObjectRow>(
    `SELECT * FROM primitive_objects WHERE ${where.join(" AND ")} ORDER BY updatedAt DESC, id LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  const count = await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM primitive_objects WHERE ${where.join(" AND ")}`,
    params,
  );
  return { objects: rows.map(withLink), total: count?.n ?? 0 };
}

export type ReindexReport = {
  scanned: number;
  /** Files whose version matches the row's: checked with `stat`, not read. */
  unchanged: number;
  /** Files with no embedded id that got one written back. */
  adopted: string[];
  /** Files whose embedded id had no row on this drive. */
  restored: string[];
  /** Rows whose file is gone. Reported, never deleted. */
  missing: string[];
  /** Files skipped: changed during write-back, or not valid JSON. */
  conflicts: Array<{ path: string; reason: string }>;
  /** More files remain: a cap or budget cut this call short. Run again to continue. */
  truncated: boolean;
  /** Which limit cut this call short; null when the pass finished. */
  cutBy: "files" | "reads" | "time" | "bytes" | null;
};

export async function reindexObjects(input: {
  agentId: string | undefined;
  kind?: string;
  /** Override the per-call budget (tests). */
  limits?: Partial<ReindexLimits>;
}): Promise<ReindexReport> {
  const kinds = input.kind ? [input.kind] : PRIMITIVE_KIND_NAMES;
  for (const kind of kinds) kindFor(kind);
  const client = await clientFor(input.agentId);
  const lock = `${client.orgId}\u0000${client.driveId}`;
  if (reindexing.has(lock)) {
    throw new ObjectsError(
      "object-reindex is already running on this drive; run it again when it finishes",
    );
  }
  reindexing.add(lock);
  try {
    const report = await reindexDrive(client, kinds, input.agentId, {
      ...REINDEX_LIMITS,
      ...input.limits,
    });
    watchDrive(client.orgId, client.driveId);
    return report;
  } finally {
    reindexing.delete(lock);
  }
}

async function reindexDrive(
  { provider, orgId, driveId, scope }: Awaited<ReturnType<typeof clientFor>>,
  kinds: string[],
  agentId: string | undefined,
  limits: ReindexLimits,
): Promise<ReindexReport> {
  const db = getDbClient();
  const report: ReindexReport = {
    scanned: 0,
    unchanged: 0,
    adopted: [],
    restored: [],
    missing: [],
    conflicts: [],
    truncated: false,
    cutBy: null,
  };
  const startedAt = Date.now();
  let reads = 0;
  let bytes = 0;
  const cut = (by: NonNullable<ReindexReport["cutBy"]>) => {
    report.truncated = true;
    report.cutBy = by;
  };

  for (const kindName of kinds) {
    if (report.truncated) break;
    const kind = kindFor(kindName);
    const all = (await provider.glob(kind.glob)).map((p) => p.replace(/^\/+/, ""));
    const paths = all.slice(0, MAX_REINDEX_FILES - report.scanned);
    if (paths.length < all.length) cut("files");
    const onDrive = new Set(all);
    // Ids already given to a file in this pass: a copied file must not steal one.
    const claimed = new Map<string, string>();

    for (const path of paths) {
      if (Date.now() - startedAt >= limits.ms) {
        cut("time");
        break;
      }
      const atPath = await db.get<ObjectRow>(
        "SELECT * FROM primitive_objects WHERE orgId = ? AND driveId = ? AND path = ?",
        [orgId, driveId, path],
      );
      if (atPath && !atPath.deletedAt && atPath.fileVersion !== null) {
        let current: number | null = null;
        try {
          current = await provider.currentVersion(scope(path));
        } catch (error) {
          if (error instanceof FilesError && error.code === "Unauthorized") throw error;
          // No stat (older agent-fs, a flaky call): fall through to a full read.
        }
        if (current === atPath.fileVersion) {
          report.scanned += 1;
          report.unchanged += 1;
          claimed.set(atPath.id, path);
          continue;
        }
      }
      if (reads >= limits.reads || bytes >= limits.bytes) {
        cut(reads >= limits.reads ? "reads" : "bytes");
        break;
      }
      reads += 1;
      report.scanned += 1;

      let json: Json;
      let version: string | null;
      try {
        const response = await provider.download(scope(path));
        version = response.headers.get("x-agent-fs-version");
        const text = await response.text();
        bytes += Buffer.byteLength(text);
        const parsed = JSON.parse(text) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          throw new Error("not an object");
        json = parsed as Json;
      } catch (error) {
        // A bad key fails the whole pass; a vanished or broken file skips this one.
        if (error instanceof FilesError && error.code === "Unauthorized") throw error;
        report.conflicts.push({ path, reason: `unreadable: ${(error as Error).message}` });
        continue;
      }

      let id = kind.readId(json);
      if (id) {
        const byId = await db.get<ObjectRow>("SELECT * FROM primitive_objects WHERE id = ?", [id]);
        const otherDrive = byId && (byId.orgId !== orgId || byId.driveId !== driveId);
        const copied = byId && byId.path !== path && onDrive.has(byId.path);
        const claimedElsewhere = claimed.has(id) && claimed.get(id) !== path;
        if (otherDrive || copied || claimedElsewhere) id = undefined;
        else if (!byId) report.restored.push(path);
      }

      if (!id) {
        // Stock Excalidraw save (id dropped) or a copy: keep the path's id, else a new one.
        const embedded = kind.readId(json);
        id = atPath && atPath.id !== embedded ? atPath.id : crypto.randomUUID();
        try {
          ({ version = null } = await provider.upload(
            scope(path),
            JSON.stringify(kind.withId(json, id), null, 2),
            {
              contentType: kind.contentType,
              ...(version ? { ifMatch: version } : {}),
              message: `adopt ${kindName} id`,
            },
          ));
        } catch (error) {
          if (error instanceof FilesError && error.code === "Conflict") {
            report.conflicts.push({ path, reason: "file changed during write-back; run again" });
            continue;
          }
          throw error;
        }
        report.adopted.push(path);
      }

      claimed.set(id, path);
      const title = swarmBlock(json).title;
      await saveRow({
        id,
        kind: kindName,
        orgId,
        driveId,
        path,
        title: typeof title === "string" ? title : (atPath?.title ?? null),
        fileVersion: versionOf(version),
        ownerAgentId: atPath?.ownerAgentId ?? agentId ?? null,
      });
    }

    if (!report.truncated) {
      const rows = await db.query<{ path: string }>(
        "SELECT path FROM primitive_objects WHERE orgId = ? AND driveId = ? AND kind = ? ORDER BY path",
        [orgId, driveId, kindName],
      );
      report.missing.push(...rows.map((r) => r.path).filter((p) => !onDrive.has(p)));
    }
  }
  return report;
}

/** One `file.changed` event from agent-fs: metadata only, never content. */
export type FileChange = {
  orgId: string;
  driveId: string;
  path: string;
  version: number;
  operation: string;
};

/** Reads the changed file's drive. The webhook path never writes to agent-fs. */
export type FileChangeReader = {
  download(path: string): Promise<Response>;
  exists(path: string): Promise<boolean>;
};

export type FileChangeResult = {
  action: "updated" | "tombstoned" | "restored" | "moved" | "ignored";
  path: string;
  id?: string;
  reason?: string;
};

/** Read the file an event names; a gone or non-JSON file yields the reason to ignore it. */
async function readChangedFile(
  reader: FileChangeReader,
  path: string,
): Promise<{ json: Json; fileVersion: number | null } | { reason: string }> {
  try {
    const response = await reader.download(path);
    const fileVersion = versionOf(response.headers.get("x-agent-fs-version"));
    const parsed = JSON.parse(await response.text()) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("not an object");
    return { json: parsed as Json, fileVersion };
  } catch (error) {
    if (error instanceof FilesError && error.code === "NotFound") {
      return { reason: "file is already gone" };
    }
    if (error instanceof FilesError) throw error;
    return { reason: "not a JSON object; object-reindex reports it" };
  }
}

/**
 * Apply one agent-fs `file.changed` event to the pointer rows. Idempotent and
 * order-safe: an event at or below the row's `fileVersion` is a no-op, so a
 * replayed or late delivery changes nothing. Never writes to agent-fs (that
 * would emit another event); a file with no id, or a copy, is left for
 * object-reindex, and its event does not move `fileVersion` so reindex reads it.
 */
export async function applyFileChange(
  change: FileChange,
  reader: FileChangeReader,
): Promise<FileChangeResult> {
  const path = change.path.replace(/^\/+/, "");
  const [kindName, kind] =
    Object.entries(PRIMITIVE_KINDS).find(([, k]) => path.endsWith(k.suffix)) ?? [];
  if (!kindName || !kind) return { action: "ignored", path, reason: "not an object path" };
  const db = getDbClient();
  const { orgId, driveId, version } = change;
  const now = new Date().toISOString();
  const atPath = await db.get<ObjectRow>(
    "SELECT * FROM primitive_objects WHERE orgId = ? AND driveId = ? AND path = ?",
    [orgId, driveId, path],
  );
  const stale = (row: ObjectRow) => row.fileVersion !== null && version <= row.fileVersion;

  if (change.operation === "delete") {
    if (!atPath) return { action: "ignored", path, reason: "no object at this path" };
    if (stale(atPath)) return { action: "ignored", path, id: atPath.id, reason: "stale event" };
    // agent-fs delivers a batch concurrently, so the version check lives in the UPDATE.
    // Versions count per path: a row that moved meanwhile is not this event's.
    const { changes } = await db.run(
      `UPDATE primitive_objects SET deletedAt = ?, fileVersion = ?, updatedAt = ?
       WHERE id = ? AND path = ? AND (fileVersion IS NULL OR fileVersion < ?)`,
      [now, version, now, atPath.id, path, version],
    );
    if (changes === 0) return { action: "ignored", path, id: atPath.id, reason: "stale event" };
    return { action: "tombstoned", path, id: atPath.id };
  }

  if (atPath) {
    if (stale(atPath)) return { action: "ignored", path, id: atPath.id, reason: "stale event" };
    const file = await readChangedFile(reader, path);
    if ("reason" in file) return { action: "ignored", path, id: atPath.id, reason: file.reason };
    // object-reindex skips a file whose stat version equals fileVersion, so only a file that
    // still carries this row's id moves it. An id-less save (stock Excalidraw) stays visible.
    const embedded = kind.readId(file.json);
    const read = file.fileVersion ?? version;
    // A read older than the event is not the content the event announced.
    const owned = embedded === atPath.id && read >= version;
    const { changes } = await db.run(
      `UPDATE primitive_objects
         SET deletedAt = NULL, updatedAt = ?, fileVersion = CASE WHEN ? THEN ? ELSE fileVersion END
       WHERE id = ? AND path = ? AND (fileVersion IS NULL OR fileVersion < ?)`,
      [now, owned ? 1 : 0, read, atPath.id, path, version],
    );
    if (changes === 0) return { action: "ignored", path, id: atPath.id, reason: "stale event" };
    if (owned) return { action: "updated", path, id: atPath.id };
    return {
      action: "updated",
      path,
      id: atPath.id,
      reason: !embedded
        ? "no embedded id; object-reindex adopts it"
        : embedded === atPath.id
          ? "read an older version than the event; object-reindex reads it again"
          : "the file carries another id; object-reindex reconciles it",
    };
  }

  // A file with no row: a move target, a restored file, or a new or copied one.
  const file = await readChangedFile(reader, path);
  if ("reason" in file) return { action: "ignored", path, reason: file.reason };
  const { json, fileVersion } = file;
  const id = kind.readId(json);
  if (!id) return { action: "ignored", path, reason: "no embedded id; object-reindex adopts it" };
  const byId = await db.get<ObjectRow>("SELECT * FROM primitive_objects WHERE id = ?", [id]);
  if (byId && (byId.orgId !== orgId || byId.driveId !== driveId)) {
    return { action: "ignored", path, id, reason: "the id belongs to another drive" };
  }
  if (byId && !byId.deletedAt && (await reader.exists(byId.path))) {
    return {
      action: "ignored",
      path,
      id,
      reason: `copy of ${byId.path}; object-reindex gives it a new id`,
    };
  }
  const title = swarmBlock(json).title;
  const savedVersion = fileVersion ?? version;
  const saved = await saveRow(
    {
      id,
      kind: kindName,
      orgId,
      driveId,
      path,
      title: typeof title === "string" ? title : (byId?.title ?? null),
      fileVersion: savedVersion,
      ownerAgentId: byId?.ownerAgentId ?? null,
    },
    { onlyNewer: true },
  );
  const action = byId ? "moved" : "restored";
  if (saved.path !== path || saved.fileVersion !== savedVersion || saved.deletedAt) {
    return { action, path, id };
  }
  // A delete event for this path that ran before the save found no row and was dropped.
  // agent-fs sends events after the change, so a file gone now was deleted in that window.
  let present = true;
  try {
    present = await reader.exists(path);
  } catch {
    // shortcut: a failed check keeps the row live (a retry would see a stale event);
    // add a per-path delete marker if agent-fs read failures show up here.
  }
  if (present) return { action, path, id };
  const { changes } = await db.run(
    `UPDATE primitive_objects SET deletedAt = ?, updatedAt = ?
     WHERE id = ? AND path = ? AND fileVersion = ? AND deletedAt IS NULL`,
    [now, now, id, path, savedVersion],
  );
  if (changes === 0) return { action, path, id };
  return { action: "tombstoned", path, id, reason: "the file was deleted while it was saved" };
}
