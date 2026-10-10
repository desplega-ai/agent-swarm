import { Download, ExternalLink } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useAgentFsAccess } from "@/api/hooks/use-agent-fs";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAgentFs } from "@/contexts/agent-fs-context";
import { drivePathToLiveUrl } from "@/lib/comb/links";
import { baseName, type DrivePath } from "@/lib/comb/paths";
import { formatBytes } from "@/lib/format-bytes";

function clickLink(href: string, download?: string) {
  const link = document.createElement("a");
  link.href = href;
  if (download) link.download = download;
  document.body.append(link);
  link.click();
  link.remove();
}

/**
 * Download the file. A server with presigned URLs (S3) answers with an
 * `attachment` URL, so the browser streams the file itself. Otherwise (local
 * storage answers an `app` link) the raw bytes load with the human's key into
 * a temporary blob link.
 */
export function DownloadButton({
  file,
  variant = "outline",
  iconOnly = false,
  bytes,
}: {
  file: DrivePath;
  /** `default` where Download is the state's one next action (no preview). */
  variant?: "outline" | "default";
  /** An icon button with a tooltip (the file header). */
  iconOnly?: boolean;
  /** The file size, for the tooltip. */
  bytes?: number;
}) {
  const { client } = useAgentFsAccess();
  const [pending, setPending] = useState(false);

  const download = async () => {
    if (!client) return;
    setPending(true);
    try {
      const signed = await client
        .getSignedUrl(file.orgId, file.driveId, file.path, { disposition: "attachment" })
        .catch(() => null);
      if (signed?.kind === "presigned") {
        clickLink(signed.url);
        return;
      }
      const blob = await client.fetchRaw(file.orgId, file.driveId, file.path);
      const url = URL.createObjectURL(blob);
      clickLink(url, baseName(file.path) || "download");
      // Some browsers read the blob after `click()` returns.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Download failed");
    } finally {
      setPending(false);
    }
  };

  if (iconOnly) {
    const label = bytes === undefined ? "Download" : `Download (${formatBytes(bytes)})`;
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={() => {
              if (!pending) void download();
            }}
            // Not `disabled` while it downloads: the tooltip keeps its pointer events.
            aria-disabled={pending || !client}
            className="aria-disabled:opacity-50"
            aria-label={label}
          >
            {pending ? <Spinner /> : <Download />}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Button
      size="sm"
      variant={variant}
      onClick={() => void download()}
      disabled={pending || !client}
      aria-label="Download"
    >
      {pending ? <Spinner /> : <Download />}
      <span className="hidden sm:inline">Download</span>
    </Button>
  );
}

/**
 * Open the same file or folder in the agent-fs live UI (new tab). Hidden
 * without a live URL, and for a path that would leave the drive (step-13).
 * `labeled`: keep the text on phones (the button stands alone).
 * `iconOnly`: an icon button with a tooltip (headers).
 */
export function OpenInAgentFsButton({
  target,
  labeled = false,
  iconOnly = false,
}: {
  target: DrivePath;
  labeled?: boolean;
  iconOnly?: boolean;
}) {
  const { liveUrl } = useAgentFs();
  const href = liveUrl ? drivePathToLiveUrl(target, liveUrl) : null;
  if (!href) return null;
  if (iconOnly) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button asChild size="icon-sm" variant="ghost">
            <a href={href} target="_blank" rel="noreferrer" aria-label="Open in agent-fs">
              <ExternalLink />
            </a>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Open in agent-fs</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <Button asChild size="sm" variant="outline">
      <a href={href} target="_blank" rel="noreferrer" aria-label="Open in agent-fs">
        <ExternalLink />
        <span className={labeled ? undefined : "hidden sm:inline"}>Open in agent-fs</span>
      </a>
    </Button>
  );
}
