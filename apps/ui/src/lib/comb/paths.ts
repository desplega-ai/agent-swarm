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
 * the splat decoded. An empty splat or a trailing "/" means a folder. "." and
 * ".." segments are dropped: they are not names in a drive.
 */
export function parseCombSplat(params: {
  orgId: string;
  driveId: string;
  splat: string | undefined;
}): CombLocation {
  const splat = params.splat ?? "";
  const segments = splat.split("/").filter((s) => s !== "" && s !== "." && s !== "..");
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
 * The dashboard route for a drive path. Folders keep their trailing "/". Each
 * segment is a decoded name, so it is encoded once ("a%20b.md" stays that name).
 */
export function combPath({ orgId, driveId, path }: DrivePath): string {
  const encoded = path
    .replace(/^\/+/, "")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
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

/** True for an href that leaves the dashboard: a scheme or a protocol-relative `//host`. */
export function isAbsoluteUrl(href: string): boolean {
  return ABSOLUTE_URL_RE.test(href.trim());
}

/**
 * Resolve a markdown link against the file that contains it. Returns the drive
 * path plus the untouched `?query` / `#hash` suffix, or null when the link does
 * not point into the drive (an absolute URL, an in-page `#anchor`, an empty
 * href). A leading "/" means the drive root, like the agent-fs live UI.
 *
 * A literal "." or ".." moves inside the drive and stops at its root. A segment
 * that decodes to "." or "..", or to a name with "/" or "\" (`%2e%2e`,
 * `..%2F..`), is not a drive name: the link resolves to null, so it can never
 * leave the drive route.
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
    if (part === "..") {
      segments.pop();
      continue;
    }
    const name = safeDecode(part);
    if (name === "." || name === ".." || /[/\\]/.test(name)) return null;
    segments.push(name);
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

/**
 * The label of a pin: its last segment. A folder drops its trailing "/", as
 * every pin list shows a folder icon. The drive root stays "/".
 */
export function pinLabel(path: string): string {
  return path === "/" ? "/" : baseName(path);
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

/** The pins the global sidebar lists before its "Show all" row. */
export const SIDEBAR_PIN_PREVIEW = 5;

/**
 * The pins of one drive that the global sidebar lists. Folded, it lists the
 * newest `SIDEBAR_PIN_PREVIEW` pins, so a new pin shows at once. It folds only
 * when that hides 2 pins or more: the "Show all" row takes one row itself.
 */
export function sidebarPins(
  ids: readonly string[],
  drive: { orgId: string; driveId: string },
  showAll: boolean,
): { pins: DrivePath[]; total: number; foldable: boolean } {
  const all = drivePins(ids, drive);
  const foldable = all.length > SIDEBAR_PIN_PREVIEW + 1;
  const pins = foldable && !showAll ? drivePins(ids, drive, SIDEBAR_PIN_PREVIEW) : all;
  return { pins, total: all.length, foldable };
}
