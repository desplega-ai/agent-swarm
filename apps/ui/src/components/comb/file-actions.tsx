import { Download, ExternalLink } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useAgentFsAccess } from "@/api/hooks/use-agent-fs";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useAgentFs } from "@/contexts/agent-fs-context";
import { drivePathToLiveUrl } from "@/lib/comb/links";
import { baseName, type DrivePath } from "@/lib/comb/paths";

/** Download the file's bytes (raw route, with the human's key) through a temporary blob link. */
export function DownloadButton({ file }: { file: DrivePath }) {
  const { client } = useAgentFsAccess();
  const [pending, setPending] = useState(false);

  const download = async () => {
    if (!client) return;
    setPending(true);
    try {
      const blob = await client.fetchRaw(file.orgId, file.driveId, file.path);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = baseName(file.path) || "download";
      document.body.append(link);
      link.click();
      link.remove();
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
