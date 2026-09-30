import { Download, ExternalLink } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useAgentFsAccess } from "@/api/hooks/use-agent-fs";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useAgentFs } from "@/contexts/agent-fs-context";
import { drivePathToLiveUrl } from "@/lib/comb/links";
import { baseName, type DrivePath } from "@/lib/comb/paths";

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
export function DownloadButton({ file }: { file: DrivePath }) {
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

  return (
    <Button
      size="sm"
      variant="outline"
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
 */
export function OpenInAgentFsButton({ target }: { target: DrivePath }) {
  const { liveUrl } = useAgentFs();
  const href = liveUrl ? drivePathToLiveUrl(target, liveUrl) : null;
  if (!href) return null;
  return (
    <Button asChild size="sm" variant="outline">
      <a href={href} target="_blank" rel="noreferrer" aria-label="Open in agent-fs">
        <ExternalLink />
        <span className="hidden sm:inline">Open in agent-fs</span>
      </a>
    </Button>
  );
}
