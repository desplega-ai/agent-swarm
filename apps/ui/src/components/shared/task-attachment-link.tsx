import { Link } from "react-router-dom";

const DEFAULT_AGENT_FS_LIVE_URL = "https://live.agent-fs.dev";

/**
 * The live UI host: the server setting (`status.agent_fs.comb.live_url`) first,
 * then `VITE_AGENT_FS_LIVE_URL` (for an API that predates Comb), then the
 * public host.
 */
function getAgentFsLiveUrl(liveUrl?: string | null): string {
  const raw = liveUrl?.trim() || import.meta.env.VITE_AGENT_FS_LIVE_URL?.trim();
  return (raw || DEFAULT_AGENT_FS_LIVE_URL).replace(/\/+$/, "");
}

export function buildAgentFsLiveUrl(opts: {
  path?: string | null;
  orgId?: string | null;
  driveId?: string | null;
  /** `status.agent_fs.comb.live_url`. */
  liveUrl?: string | null;
  /** The swarm drive (`status.agent_fs.comb`), for rows that carry neither id. */
  defaultOrgId?: string | null;
  defaultDriveId?: string | null;
}): string | null {
  const path = opts.path?.trim();
  if (!path) return null;
  // A live URL must use a matched org/drive pair: both from this attachment
  // row, or (when the row has neither) both from the swarm drive. Falling back
  // per ID can combine metadata from different drives or orgs.
  const rowOrgId = opts.orgId?.trim();
  const rowDriveId = opts.driveId?.trim();
  const hasRowId = Boolean(rowOrgId || rowDriveId);
  const orgId = hasRowId ? rowOrgId : opts.defaultOrgId?.trim();
  const driveId = hasRowId ? rowDriveId : opts.defaultDriveId?.trim();
  if (!orgId || !driveId) return null;
  const normalizedPath = path.replace(/^\/+/, "");
  // Never double-encode an already-encoded segment: preserve existing %HH
  // escapes byte-for-byte, including in segments that also contain raw text.
  const encodedPath = normalizedPath
    .split("/")
    .map((segment) => encodeURIComponent(segment).replace(/%25([0-9a-f]{2})/gi, "%$1"))
    .join("/");
  return `${getAgentFsLiveUrl(opts.liveUrl)}/file/~/${orgId}/${driveId}/${encodedPath}`;
}

/**
 * The attachment name as a link: `to` is an in-app route (Comb, same tab),
 * `href` an external link (new tab). Plain text without either.
 */
export function AttachmentName({
  href,
  to,
  name,
}: {
  href: string | null;
  to?: string | null;
  name: string;
}) {
  const className = "truncate text-sm font-medium text-foreground";
  const linkClassName = `${className} hover:text-primary hover:underline`;
  if (to) {
    return (
      <Link to={to} className={linkClassName}>
        {name}
      </Link>
    );
  }
  if (!href) return <span className={className}>{name}</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={linkClassName}>
      {name}
    </a>
  );
}
