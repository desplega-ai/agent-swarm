// No `@/` imports: unit tests render this from the repo root.
import type { AgentFsState } from "../../lib/agent-fs/state";
import { encodedPathToCombPath, isCombNavigable } from "../../lib/comb/links";
import { InAppOrExternalLink } from "./in-app-or-external-link";

const DEFAULT_AGENT_FS_LIVE_URL = "https://live.agent-fs.dev";
/** A "." or ".." segment, raw or encoded (`%2e`). It would leave the drive. */
const DOT_SEGMENT_RE = /^(?:\.|%2e){1,2}$/i;

/**
 * The live UI host: the server setting (`status.agent_fs.comb.live_url`) first,
 * then `VITE_AGENT_FS_LIVE_URL` (for an API that predates Comb), then the
 * public host.
 */
function getAgentFsLiveUrl(liveUrl?: string | null): string {
  const raw = liveUrl?.trim() || import.meta.env.VITE_AGENT_FS_LIVE_URL?.trim();
  return (raw || DEFAULT_AGENT_FS_LIVE_URL).replace(/\/+$/, "");
}

/** An agent-fs attachment row: its path plus an optional org/drive pair. */
interface AgentFsRow {
  path?: string | null;
  orgId?: string | null;
  driveId?: string | null;
}

interface AgentFsFile {
  orgId: string;
  driveId: string;
  /** The drive path without its leading "/", URL-encoded. */
  encodedPath: string;
}

/**
 * The drive file an attachment row names. Same rules as the server
 * (`agentFsFileRoute` in `src/utils/constants.ts`). Null without a matched
 * org/drive pair, or when a path segment is "." or "..".
 */
function agentFsFile(
  opts: AgentFsRow & {
    /** The swarm drive (`status.agent_fs.comb`), for rows that carry neither id. */
    defaultOrgId?: string | null;
    defaultDriveId?: string | null;
  },
): AgentFsFile | null {
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
  const segments = path.replace(/^\/+/, "").split("/");
  if (segments.some((segment) => DOT_SEGMENT_RE.test(segment))) return null;
  // Never double-encode an already-encoded segment: preserve existing %HH
  // escapes byte-for-byte, including in segments that also contain raw text.
  const encodedPath = segments
    .map((segment) => encodeURIComponent(segment).replace(/%25([0-9a-f]{2})/gi, "%$1"))
    .join("/");
  return { orgId, driveId, encodedPath };
}

function liveFileUrl(file: AgentFsFile, liveUrl: string | null | undefined): string {
  return `${getAgentFsLiveUrl(liveUrl)}/file/~/${file.orgId}/${file.driveId}/${file.encodedPath}`;
}

export function buildAgentFsLiveUrl(
  opts: Parameters<typeof agentFsFile>[0] & {
    /** `status.agent_fs.comb.live_url`. */
    liveUrl?: string | null;
  },
): string | null {
  const file = agentFsFile(opts);
  return file ? liveFileUrl(file, opts.liveUrl) : null;
}

/** The parts of `useAgentFs()` that decide an attachment's links. */
export interface AgentFsLinkContext {
  state: AgentFsState;
  /** Set while Comb is on (`status.agent_fs.comb.enabled`). */
  endpoint: string | null;
  /** The swarm drive. */
  orgId: string | null;
  driveId: string | null;
  liveUrl: string | null;
}

/**
 * The links of an agent-fs attachment row. `href` opens the agent-fs live UI
 * (new tab). `combTo` opens the file in Comb (same tab) while Comb is
 * connected. A row without ids uses the swarm drive only while Comb is on.
 * With Comb off such a row has no link, the same as before Comb. `agentFs` is
 * null outside the provider (`/setup`).
 */
export function agentFsAttachmentLinks(
  row: AgentFsRow,
  agentFs: AgentFsLinkContext | null,
): { href: string | null; combTo: string | null } {
  const combOn = Boolean(agentFs?.endpoint);
  const file = agentFsFile({
    ...row,
    defaultOrgId: combOn ? agentFs?.orgId : null,
    defaultDriveId: combOn ? agentFs?.driveId : null,
  });
  if (!file) return { href: null, combTo: null };
  const navigable = agentFs !== null && isCombNavigable(agentFs.state);
  return {
    href: liveFileUrl(file, agentFs?.liveUrl),
    combTo: navigable ? encodedPathToCombPath(file) : null,
  };
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
  if (!to && !href) return <span className={className}>{name}</span>;
  return (
    <InAppOrExternalLink
      to={to}
      href={href}
      className={`${className} hover:text-primary hover:underline`}
    >
      {name}
    </InAppOrExternalLink>
  );
}
