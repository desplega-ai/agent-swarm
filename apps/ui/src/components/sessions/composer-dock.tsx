/**
 * Sessions surface — shared floating composer dock.
 *
 * A rounded card-shaped input area inset from the panel edges with a slim
 * action row at the bottom: routing hint on the left, ⌘↵ hint + circular
 * primary send button on the right. Used by both the new-session view and
 * the in-session composer so the bottom of the right pane is identical
 * regardless of state.
 */

import { ArrowUp, FileText, Paperclip, X } from "lucide-react";
import { type ChangeEvent, type DragEvent, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

// Matches MAX_UPLOAD_BYTES in src/http/fs.ts — reject client-side before a
// doomed upload round trip instead of after a 413.
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

const ALLOWED_ATTACHMENT_EXTENSIONS = [
  ".pdf",
  ".txt",
  ".md",
  ".csv",
  ".json",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
] as const;

function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}

/** Splits a dropped/selected file batch into what's safe to attach and a
 * human-readable reason for anything rejected. Returns at most one message —
 * multiple bad files still name only the first, to keep the row short. */
function partitionAttachmentFiles(files: File[]): { valid: File[]; error: string | null } {
  const valid: File[] = [];
  let error: string | null = null;
  for (const file of files) {
    if (!ALLOWED_ATTACHMENT_EXTENSIONS.includes(fileExtension(file.name) as never)) {
      error ??= `"${file.name}" isn't an allowed file type (${ALLOWED_ATTACHMENT_EXTENSIONS.join(", ")}).`;
      continue;
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      error ??= `"${file.name}" exceeds the 50 MB attachment limit.`;
      continue;
    }
    valid.push(file);
  }
  return { valid, error };
}

export interface ComposerDockProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  isPending: boolean;
  isError?: boolean;
  errorMessage?: string;
  placeholder?: string;
  /** Disabled when true (e.g. no identity picked yet). */
  disabled?: boolean;
  /** Routing label shown on the left of the action row. Defaults to "Routes to Lead". */
  routeLabel?: string;
  /**
   * Optional control rendered at the far left of the action row, before the
   * routing hint. Used by the steering composer for its Queue/Interrupt
   * segmented toggle so both surfaces get an identical dock.
   */
  modeControl?: React.ReactNode;
  /** Status label shown while submit/create/upload is pending. */
  pendingLabel?: string;
  /** "Send" / "Start session" / etc. Used as button aria-label and tooltip. */
  sendLabel?: string;
  attachments?: File[];
  onAttachmentsChange?: (files: File[]) => void;
  attachmentErrorMessage?: string | null;
  /** Focus the textarea on mount. */
  autoFocus?: boolean;
  /**
   * Let the card span the full available width instead of the chat-style
   * centered `max-w-3xl` column. Used by the task-detail steering dock, where
   * the composer sits under a full-width log viewer.
   */
  fullWidth?: boolean;
  className?: string;
}

export function ComposerDock({
  value,
  onChange,
  onSubmit,
  isPending,
  isError,
  errorMessage,
  placeholder,
  disabled,
  routeLabel = "Routes to Lead",
  modeControl,
  pendingLabel = "Sending…",
  sendLabel = "Send",
  attachments = [],
  onAttachmentsChange,
  attachmentErrorMessage,
  autoFocus,
  fullWidth,
  className,
}: ComposerDockProps) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dragCounterRef = useRef(0);
  const [isDragActive, setIsDragActive] = useState(false);
  const [dropErrorMessage, setDropErrorMessage] = useState<string | null>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);
  // Clears a stale rejection message once the parent resets attachments
  // (e.g. after a successful send) rather than leaving it stuck on screen.
  useEffect(() => {
    if (attachments.length === 0) setDropErrorMessage(null);
  }, [attachments.length]);

  const canSubmit = !disabled && !isPending && value.trim().length > 0;
  const canAttach = !disabled && !isPending && !!onAttachmentsChange;

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (canSubmit) onSubmit();
    }
  };

  const handleIncomingFiles = (incoming: File[]) => {
    if (incoming.length === 0 || !onAttachmentsChange) return;
    const { valid, error } = partitionAttachmentFiles(incoming);
    setDropErrorMessage(error);
    if (valid.length > 0) onAttachmentsChange([...attachments, ...valid]);
  };

  const onFilesSelected = (event: ChangeEvent<HTMLInputElement>) => {
    handleIncomingFiles(Array.from(event.target.files ?? []));
    event.target.value = "";
  };

  const removeAttachment = (index: number) => {
    if (!onAttachmentsChange) return;
    onAttachmentsChange(attachments.filter((_, i) => i !== index));
  };

  const onDragEnter = (e: DragEvent<HTMLDivElement>) => {
    if (!canAttach) return;
    e.preventDefault();
    dragCounterRef.current += 1;
    if (e.dataTransfer.types.includes("Files")) setIsDragActive(true);
  };

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!canAttach) return;
    e.preventDefault();
  };

  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (!canAttach) return;
    e.preventDefault();
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
    if (dragCounterRef.current === 0) setIsDragActive(false);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!canAttach) return;
    e.preventDefault();
    dragCounterRef.current = 0;
    setIsDragActive(false);
    handleIncomingFiles(Array.from(e.dataTransfer.files ?? []));
  };

  return (
    <form
      className={cn("shrink-0 px-4 pt-2 pb-4 bg-background w-full", className)}
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit) onSubmit();
      }}
    >
      <div
        className={cn(
          "relative",
          !fullWidth && "max-w-3xl mx-auto",
          "rounded-2xl border border-border bg-card shadow-sm transition",
          "focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-primary/15",
          disabled && "opacity-60",
        )}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {isDragActive ? (
          <div
            className={cn(
              "pointer-events-none absolute inset-0 z-10 flex items-center justify-center",
              "rounded-2xl border-2 border-dashed border-primary/60 bg-primary/5",
            )}
          >
            <span className="text-xs font-medium text-primary">Drop files to attach</span>
          </div>
        ) : null}
        <Textarea
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          disabled={disabled || isPending}
          rows={1}
          className={cn(
            "field-sizing-content border-0 shadow-none bg-transparent",
            "focus-visible:ring-0 focus-visible:border-0",
            "min-h-14 max-h-[220px] resize-none px-4 pt-3.5 pb-1.5 text-base md:text-[15px]",
            "leading-snug",
          )}
        />
        {onAttachmentsChange ? (
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ALLOWED_ATTACHMENT_EXTENSIONS.join(",")}
            className="sr-only"
            onChange={onFilesSelected}
            disabled={!canAttach}
            aria-label="Attach files"
          />
        ) : null}
        {attachments.length > 0 ? (
          <div className="flex flex-wrap gap-1.5 px-3 pb-2">
            {attachments.map((file, index) => (
              <span
                key={`${file.name}-${file.size}-${file.lastModified}-${index}`}
                className={cn(
                  "inline-flex max-w-full items-center gap-1.5 rounded-md border border-border",
                  "bg-muted/55 px-2 py-1 text-xs text-foreground",
                )}
              >
                <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />
                <span className="truncate max-w-[12rem] sm:max-w-[18rem]">{file.name}</span>
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {formatFileSize(file.size)}
                </span>
                <button
                  type="button"
                  onClick={() => removeAttachment(index)}
                  disabled={isPending}
                  className={cn(
                    "ml-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm",
                    "text-muted-foreground hover:bg-background hover:text-foreground",
                    "disabled:pointer-events-none disabled:opacity-50",
                  )}
                  aria-label={`Remove ${file.name}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-2 px-2.5 pb-2 pt-0.5">
          <div className="flex items-center gap-2 min-w-0">
            {modeControl}
            <div
              className={cn(
                "flex items-center gap-1.5 text-[11px] text-muted-foreground min-w-0",
                modeControl ? null : "pl-1.5",
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "h-1.5 w-1.5 shrink-0 rounded-full",
                  isPending ? "bg-primary animate-pulse" : "bg-primary/70",
                )}
              />
              <span className="truncate">{isPending ? pendingLabel : routeLabel}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {onAttachmentsChange ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    disabled={!canAttach}
                    aria-label="Attach files"
                    className="h-8 w-8 rounded-full text-muted-foreground hover:text-foreground"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Paperclip className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Attach files</TooltipContent>
              </Tooltip>
            ) : null}
            <span className="text-[10px] font-mono text-muted-foreground tracking-wider hidden sm:inline">
              ⌘↵
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="submit"
                  size="icon"
                  disabled={!canSubmit}
                  aria-label={sendLabel}
                  className="h-8 w-8 rounded-full shadow-sm"
                >
                  <ArrowUp className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{sendLabel}</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>
      {isError && errorMessage ? (
        <p className="mt-2 text-xs text-status-error-strong px-1">{errorMessage}</p>
      ) : null}
      {dropErrorMessage ? (
        <p className="mt-2 text-xs text-status-error-strong px-1">{dropErrorMessage}</p>
      ) : null}
      {attachmentErrorMessage ? (
        <p className="mt-2 text-xs text-status-error-strong px-1">{attachmentErrorMessage}</p>
      ) : null}
    </form>
  );
}
