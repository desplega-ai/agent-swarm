import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useLoadTextToCopy } from "@/api/hooks/use-agent-fs";
import { DownloadButton } from "@/components/comb/file-actions";
import { Button } from "@/components/ui/button";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Spinner } from "@/components/ui/spinner";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import type { StatResult } from "@/lib/agent-fs/types";
import { CLIPBOARD_BLOCKED, copyCheck, writeTextWhenReady } from "@/lib/comb/copy-contents";
import type { DrivePath } from "@/lib/comb/paths";
import { formatBytes } from "@/lib/format-bytes";

const COPIED_MS = 1500;

/**
 * Copy text that is still loading (`writeTextWhenReady`), and toast a failure:
 * the reason the load gave ("Too large to copy"), else the blocked clipboard.
 * Call it before any await in the click handler. Resolves to whether it worked.
 */
export async function copyLoadingText(text: Promise<string>): Promise<boolean> {
  const failure = text.then(
    () => CLIPBOARD_BLOCKED,
    (err: unknown) => (err instanceof Error ? err.message : CLIPBOARD_BLOCKED),
  );
  if (await writeTextWhenReady(text)) return true;
  toast.error(await failure);
  return false;
}

/**
 * The file header's copy button. A click copies the file's contents. Hover or
 * keyboard focus opens a card with Copy path. A file that cannot be copied
 * (`copyCheck`: not text, or above 1 MB) does not copy: a click opens the
 * card, which names the reason and offers Download instead.
 */
export function CopyFileButton({ file, stat }: { file: DrivePath; stat: StatResult }) {
  const loadText = useLoadTextToCopy();
  const path = useCopyToClipboard();
  const check = copyCheck(file.path, stat);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const copyContents = async () => {
    // Touch has no hover: the click shows why it cannot copy.
    if (!check.copyable) {
      setOpen(true);
      return;
    }
    if (pending) return;
    setPending(true);
    const ok = await copyLoadingText(loadText(file, stat));
    setPending(false);
    setCopied(ok);
  };

  // One width: only the icon changes.
  const label = !check.copyable ? check.reason : copied ? "Contents copied" : "Copy contents";
  const note = check.copyable
    ? copied
      ? "Contents copied"
      : "Click to copy the contents"
    : `${check.reason} (${formatBytes(stat.size)})`;

  return (
    <HoverCard open={open} onOpenChange={setOpen} openDelay={300} closeDelay={150}>
      <HoverCardTrigger asChild>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={label}
          onClick={() => void copyContents()}
        >
          {pending ? <Spinner /> : copied ? <Check /> : <Copy />}
        </Button>
      </HoverCardTrigger>
      <HoverCardContent side="bottom" align="end" className="flex w-72 flex-col gap-1 p-1.5">
        <p className="px-2 py-1 text-xs text-muted-foreground">{note}</p>
        {check.copyable ? null : (
          <div className="px-1 pb-1">
            <DownloadButton file={file} label="Download instead" />
          </div>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="w-full justify-start"
          onClick={async () => {
            if (!(await path.copy(file.path))) toast.error(CLIPBOARD_BLOCKED);
          }}
        >
          {path.copied ? <Check /> : <Copy />}
          <span className="shrink-0">{path.copied ? "Path copied" : "Copy path"}</span>
          <span className="min-w-0 flex-1 truncate text-left font-mono text-xs text-muted-foreground">
            {file.path}
          </span>
        </Button>
      </HoverCardContent>
    </HoverCard>
  );
}
