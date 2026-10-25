import { ExternalLink, Link2 } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { useAgentFsAccess } from "@/api/hooks/use-agent-fs";
import { CopyableField } from "@/components/shared/copyable-fields";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAgentFs } from "@/contexts/agent-fs-context";
import { baseName, type DrivePath } from "@/lib/comb/paths";
import {
  DEFAULT_SHARE_EXPIRY_SECONDS,
  describeExpiry,
  SHARE_EXPIRY_CHOICES,
  SHARE_LINKS_FEATURE,
  type ShareExpirySeconds,
  shareDescription,
  shareLinkUrl,
} from "@/lib/comb/share";

const EXPIRY_OPTIONS = SHARE_EXPIRY_CHOICES.map((choice) => ({
  value: String(choice.seconds) as `${ShareExpirySeconds}`,
  label: choice.label,
}));

/**
 * Put `link` on the clipboard. Safari allows the write only inside the click,
 * so where the browser supports it the clipboard item is handed over at once
 * and filled when the link arrives. Resolves to the link and whether the copy
 * worked. A failed `link` rejects.
 */
async function copyWhenReady(link: Promise<string>): Promise<{ link: string; copied: boolean }> {
  let copy: Promise<void>;
  try {
    copy =
      typeof ClipboardItem !== "undefined" && navigator.clipboard?.write
        ? navigator.clipboard.write([
            new ClipboardItem({
              "text/plain": link.then((url) => new Blob([url], { type: "text/plain" })),
            }),
          ])
        : link.then((url) => navigator.clipboard.writeText(url));
  } catch {
    copy = Promise.reject();
  }
  // Observe the copy first: when `link` fails, the copy fails with it.
  const copied = copy.then(
    () => true,
    () => false,
  );
  const url = await link;
  return { link: url, copied: await copied };
}

/** Header icon button for a file: opens the share dialog. Hidden without `share-links`. */
export function ShareButton({ file }: { file: DrivePath }) {
  const { features } = useAgentFs();
  const [open, setOpen] = useState(false);
  if (!features.has(SHARE_LINKS_FEATURE)) return null;
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Share link"
            onClick={() => setOpen(true)}
          >
            <Link2 />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Share link</TooltipContent>
      </Tooltip>
      {/* Mounted only while open, so each opening starts fresh. */}
      {open ? <ShareDialog file={file} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/** Make a share link for `file`, with an expiry. Mount it only while open. */
export function ShareDialog({ file, onClose }: { file: DrivePath; onClose: () => void }) {
  const { client, endpoint } = useAgentFsAccess();
  const [expiresIn, setExpiresIn] = useState<ShareExpirySeconds>(DEFAULT_SHARE_EXPIRY_SECONDS);
  const [share, setShare] = useState<{ link: string; expiresAt: string } | null>(null);
  const [pending, setPending] = useState(false);
  const expiryLabelId = useId();
  const name = baseName(file.path);

  const create = async () => {
    if (!client || pending) return;
    setPending(true);
    let expiresAt = "";
    const link = client
      .createShare(file.orgId, file.driveId, file.path, { expiresIn })
      .then((result) => {
        expiresAt = result.expiresAt;
        return shareLinkUrl(endpoint || client.endpoint, result);
      });
    try {
      const result = await copyWhenReady(link);
      setShare({ link: result.link, expiresAt });
      if (result.copied) {
        toast.success("Link copied", {
          description: `Anyone with the link can open it for ${describeExpiry(expiresIn)}.`,
        });
      }
    } catch (err) {
      toast.error("Could not create a link", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="break-all">Share {name}</DialogTitle>
          <DialogDescription>{shareDescription(file.path)}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <span id={expiryLabelId} className="text-xs font-medium text-muted-foreground">
            Link expires after
          </span>
          <SegmentedControl
            aria-labelledby={expiryLabelId}
            size="sm"
            // A link keeps the expiry it was made with: no change while one is made.
            disabled={pending}
            value={String(expiresIn) as `${ShareExpirySeconds}`}
            onValueChange={(value) => {
              const next = Number(value) as ShareExpirySeconds;
              if (next === expiresIn) return;
              setExpiresIn(next);
              // A link keeps its expiry. A new choice needs a new link.
              setShare(null);
            }}
            options={EXPIRY_OPTIONS}
            className="self-start"
          />
        </div>
        {share ? (
          <div className="flex flex-col gap-1.5">
            <CopyableField
              label="Share link"
              value={share.link}
              onCopyError={() => toast.error("Could not copy. Select the link and copy it.")}
            />
            {share.expiresAt ? (
              <p className="text-xs text-muted-foreground">
                Expires{" "}
                {new Date(share.expiresAt).toLocaleString(undefined, {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
                .
              </p>
            ) : null}
          </div>
        ) : null}
        <DialogFooter>
          {share ? (
            <>
              <Button asChild variant="outline">
                <a href={share.link} target="_blank" rel="noopener noreferrer">
                  <ExternalLink />
                  Open link
                </a>
              </Button>
              <Button onClick={onClose}>Done</Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button onClick={() => void create()} disabled={pending || !client}>
                {pending ? <Spinner /> : <Link2 />}
                {pending ? "Creating…" : "Create and copy link"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
