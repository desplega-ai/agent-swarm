const DEFAULT_AGENT_FS_LIVE_URL = "https://live.agent-fs.dev";

function getAgentFsLiveUrl(): string {
  const raw = import.meta.env.VITE_AGENT_FS_LIVE_URL?.trim();
  return (raw || DEFAULT_AGENT_FS_LIVE_URL).replace(/\/+$/, "");
}

export function buildAgentFsLiveUrl(opts: {
  path?: string | null;
  orgId?: string | null;
  driveId?: string | null;
}): string | null {
  const path = opts.path?.trim();
  if (!path) return null;
  // A live URL must use a matched org/drive pair from this attachment row.
  // Falling back per ID can combine metadata from different drives or orgs.
  const orgId = opts.orgId?.trim();
  const driveId = opts.driveId?.trim();
  if (!orgId || !driveId) return null;
  const normalizedPath = path.replace(/^\/+/, "");
  // Never double-encode an already-encoded segment: preserve existing %HH
  // escapes byte-for-byte, including in segments that also contain raw text.
  const encodedPath = normalizedPath
    .split("/")
    .map((segment) => encodeURIComponent(segment).replace(/%25([0-9a-f]{2})/gi, "%$1"))
    .join("/");
  return `${getAgentFsLiveUrl()}/file/~/${orgId}/${driveId}/${encodedPath}`;
}

export function AttachmentName({ href, name }: { href: string | null; name: string }) {
  const className = "truncate text-sm font-medium text-foreground";
  if (!href) return <span className={className}>{name}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`${className} hover:text-primary hover:underline`}
    >
      {name}
    </a>
  );
}
