// Comb routes and drive paths.
//
// A drive path is absolute ("/notes.md"). A folder path ends with "/" and the
// drive root is "/". The route is `/file/~/<org>/<drive>/<path>`, the same
// scheme as the agent-fs live UI, so a live URL becomes a dashboard URL by
// swapping the origin.

/** A file or folder in one agent-fs drive. */
export interface DrivePath {
  orgId: string;
  driveId: string;
  path: string;
}

export interface CombLocation extends DrivePath {
  isFolder: boolean;
}

/**
 * Parse the route params of `/file/~/:orgId/:driveId/*`. react-router passes
 * the splat decoded. An empty splat or a trailing "/" means a folder.
 */
export function parseCombSplat(params: {
  orgId: string;
  driveId: string;
  splat: string | undefined;
}): CombLocation {
  const splat = params.splat ?? "";
  const segments = splat.split("/").filter(Boolean);
  const isFolder = segments.length === 0 || splat.endsWith("/");
  const body = segments.join("/");
  const path = segments.length === 0 ? "/" : isFolder ? `/${body}/` : `/${body}`;
  return { orgId: params.orgId, driveId: params.driveId, path, isFolder };
}

/** True for a folder path ("/", "/docs/"). */
export function isFolderPath(path: string): boolean {
  return path.endsWith("/");
}

/**
 * Encode one path segment. Existing `%HH` escapes stay as they are, the same
 * rule as `buildAgentFsLiveUrl` (`src/utils/constants.ts`).
 */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/%25([0-9a-f]{2})/gi, "%$1");
}

/** The dashboard route for a drive path. Folders keep their trailing "/". */
export function combPath({ orgId, driveId, path }: DrivePath): string {
  const encoded = path
    .replace(/^\/+/, "")
    .split("/")
    .map((segment) => encodeSegment(segment))
    .join("/");
  return `/file/~/${orgId}/${driveId}/${encoded}`;
}

/** Last segment of a path, without a trailing "/". The root has no name (""). */
export function baseName(path: string): string {
  const segments = path.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? "";
}

/** The folder that holds `path` ("/" for a top-level entry and for the root). */
export function parentFolder(path: string): string {
  const segments = path.split("/").filter(Boolean);
  if (segments.length <= 1) return "/";
  return `/${segments.slice(0, -1).join("/")}/`;
}

/** Every folder from the root down to the folder that holds `path`. */
export function ancestorFolders(path: string): string[] {
  const segments = path.split("/").filter(Boolean);
  const count = isFolderPath(path) ? segments.length : segments.length - 1;
  const folders = ["/"];
  for (let i = 1; i <= count; i++) folders.push(`/${segments.slice(0, i).join("/")}/`);
  return folders;
}

/** The path of an entry listed in `folder`. */
export function childPath(folder: string, name: string, isFolder: boolean): string {
  const base = folder.endsWith("/") ? folder : `${folder}/`;
  return `${base}${name}${isFolder ? "/" : ""}`;
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** A URL with a scheme (`https:`, `mailto:`) or a protocol-relative `//host`. */
const ABSOLUTE_URL_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/**
 * Resolve a markdown link against the file that contains it. Returns the drive
 * path plus the untouched `?query` / `#hash` suffix, or null when the link does
 * not point into the drive (an absolute URL, an in-page `#anchor`, an empty
 * href). A leading "/" means the drive root, like the agent-fs live UI.
 */
export function resolveRelative(
  fromFilePath: string,
  href: string,
): { path: string; suffix: string } | null {
  const trimmed = href.trim();
  if (!trimmed || ABSOLUTE_URL_RE.test(trimmed)) return null;
  const cut = trimmed.search(/[?#]/);
  const pathPart = cut === -1 ? trimmed : trimmed.slice(0, cut);
  const suffix = cut === -1 ? "" : trimmed.slice(cut);
  if (!pathPart) return null;

  const segments = pathPart.startsWith("/")
    ? []
    : parentFolder(fromFilePath).split("/").filter(Boolean);
  const parts = pathPart.split("/");
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") segments.pop();
    else segments.push(safeDecode(part));
  }
  const last = parts[parts.length - 1];
  const isFolder = last === "" || last === "." || last === "..";
  if (segments.length === 0) return { path: "/", suffix };
  const body = `/${segments.join("/")}`;
  return { path: isFolder ? `${body}/` : body, suffix };
}

// Pins (step-12): a favorite with item type `agent-fs-path` and the item id
// `<orgId>/<driveId>/<path>`. The path is raw (not URL-encoded) and has no
// leading "/". A folder keeps its trailing "/", so the drive root is
// `<orgId>/<driveId>/`.

/** The favorite item id of a drive path. */
export function pinIdFor({ orgId, driveId, path }: DrivePath): string {
  return `${orgId}/${driveId}/${path.replace(/^\/+/, "")}`;
}

/** The drive path of a pin id. Null without an org and a drive, or with a "." or ".." segment. */
export function parsePinId(id: string): DrivePath | null {
  const [orgId, driveId, ...rest] = id.split("/");
  if (!orgId || !driveId || rest.length === 0) return null;
  // Reject dot segments and separators that only appear after decoding.
  for (const segment of rest) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      decoded = segment;
    }
    if (decoded === "." || decoded === ".." || /[/\\]/.test(decoded)) return null;
  }
  return { orgId, driveId, path: `/${rest.join("/")}` };
}

/** The label of a pin: its last segment, plus "/" for a folder. */
export function pinLabel(path: string): string {
  if (path === "/") return "/";
  return isFolderPath(path) ? `${baseName(path)}/` : baseName(path);
}

/**
 * The pins of one drive, sorted by label (then by path). `ids` come newest
 * first, as `GET /api/favorites` lists them, so `limit` keeps the newest pins.
 */
export function drivePins(
  ids: readonly string[],
  drive: { orgId: string; driveId: string },
  limit = Number.POSITIVE_INFINITY,
): DrivePath[] {
  const pins: DrivePath[] = [];
  for (const id of ids) {
    if (pins.length >= limit) break;
    const pin = parsePinId(id);
    if (pin && pin.orgId === drive.orgId && pin.driveId === drive.driveId) pins.push(pin);
  }
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  return pins.sort(
    (a, b) =>
      collator.compare(pinLabel(a.path), pinLabel(b.path)) || collator.compare(a.path, b.path),
  );
}
