import { Check, Copy, ExternalLink, Paperclip, Star } from "lucide-react";
import { useState } from "react";
import type { TaskAttachment, TaskAttachmentKind } from "@/api/types";
import { CollapsibleSection } from "@/components/shared/collapsible-section";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Default agent-fs live host used when the dashboard's runtime config has
 * not been told otherwise. Kept in sync with `DEFAULT_AGENT_FS_LIVE_URL` in
 * `src/utils/constants.ts`.
 */
const DEFAULT_AGENT_FS_LIVE_URL = "https://live.agent-fs.dev";

/**
 * `import.meta.env.VITE_AGENT_FS_LIVE_URL` lets self-hosted deployments point
 * the dashboard at a different agent-fs live host. Falls back to the public
 * production host so the default install keeps rendering working links.
 */
function getAgentFsLiveUrl(): string {
  const raw = import.meta.env.VITE_AGENT_FS_LIVE_URL?.trim();
  return (raw || DEFAULT_AGENT_FS_LIVE_URL).replace(/\/+$/, "");
}

/**
 * Per-row resolution mirrors `resolveAttachmentDisplay` in `src/slack/blocks.ts`.
 * For `agent-fs` we can't build a public URL yet (the attachment row only
 * stores `path`, not the agent-fs `<org_id>/<drive_id>` tuple); display the
 * raw path until Phase 2b adds the lookup.
 */
function resolveHref(a: TaskAttachment): string | null {
  switch (a.kind) {
    case "url":
      return a.url ?? null;
    case "page":
      // SPA-relative — react-router handles `/pages/:id`. We still render as
      // an anchor with target="_blank" so the link survives copy/paste.
      return a.pageId ? `/pages/${a.pageId}` : null;
    case "agent-fs":
      // TODO(phase-2b): once org_id / drive_id land on the attachment row,
      // build `${getAgentFsLiveUrl()}/file/~/<org_id>/<drive_id>/<path>`.
      void getAgentFsLiveUrl;
      return null;
    case "shared-fs":
      return null;
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function KindBadge({ kind }: { kind: TaskAttachmentKind }) {
  return (
    <Badge variant="outline" size="tag" className="text-muted-foreground">
      {kind}
    </Badge>
  );
}

function CopyPathButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={copied ? "Copied" : "Copy path"}
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
      className={cn(
        "inline-flex h-5 w-5 items-center justify-center rounded-md",
        "border border-border bg-popover/60 text-muted-foreground",
        "opacity-70 transition-opacity hover:opacity-100 hover:text-foreground",
        copied && "opacity-100 text-status-success-strong",
      )}
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

function AttachmentRow({ attachment }: { attachment: TaskAttachment }) {
  const href = resolveHref(attachment);
  const descriptor = attachment.intent || attachment.description;
  // For agent-fs / shared-fs we show the raw path so users can at least copy
  // it; for `page` and `url` the anchor itself communicates the target.
  const pathDisplay =
    attachment.kind === "shared-fs"
      ? `shared-fs:${attachment.path ?? ""}`
      : attachment.kind === "agent-fs"
        ? `agent-fs:${attachment.path ?? ""}`
        : null;

  return (
    <div className="flex items-start gap-3 py-2 border-b border-border/40 last:border-b-0">
      <Paperclip className="h-3.5 w-3.5 text-muted-foreground mt-1 shrink-0" />
      <div className="flex-1 min-w-0 space-y-0.5">
        <div className="flex items-center gap-2 flex-wrap">
          {attachment.isPrimary && (
            <Star
              className="h-3 w-3 text-status-active-strong shrink-0"
              aria-label="Primary attachment"
            />
          )}
          {href ? (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium text-primary hover:underline truncate"
            >
              {attachment.name}
              <ExternalLink className="h-3 w-3 inline-block ml-1 -mt-0.5 text-muted-foreground" />
            </a>
          ) : (
            <span className="text-sm font-medium text-foreground truncate">{attachment.name}</span>
          )}
          <KindBadge kind={attachment.kind} />
        </div>
        {descriptor && (
          <p className="text-xs italic text-muted-foreground line-clamp-2">{descriptor}</p>
        )}
        {pathDisplay && (
          <div className="flex items-center gap-1.5">
            <code className="text-[11px] font-mono text-muted-foreground bg-muted/40 px-1.5 py-0.5 rounded truncate">
              {pathDisplay}
            </code>
            <CopyPathButton value={attachment.path ?? ""} />
          </div>
        )}
        {(attachment.mimeType || attachment.sizeBytes != null) && (
          <p className="text-[10px] text-muted-foreground/70 font-mono">
            {[
              attachment.mimeType,
              attachment.sizeBytes != null ? formatSize(attachment.sizeBytes) : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Renders the `Attachments` card on a task detail page. Returns `null` when
 * the task has no attachments so the surrounding layout collapses cleanly —
 * mirroring how `Failure Reason` / `Output` hide themselves when absent.
 */
export function TaskAttachmentsSection({
  attachments,
}: {
  attachments: TaskAttachment[] | undefined;
}) {
  if (!attachments || attachments.length === 0) return null;
  return (
    <CollapsibleSection
      variant="card"
      title={`Attachments (${attachments.length})`}
      icon={Paperclip}
      iconColor="text-muted-foreground"
      borderColor="border-border"
      bgColor="bg-muted/20"
      defaultOpen
    >
      <div className="max-h-72 overflow-auto">
        {attachments.map((a) => (
          <AttachmentRow key={a.id} attachment={a} />
        ))}
      </div>
    </CollapsibleSection>
  );
}
