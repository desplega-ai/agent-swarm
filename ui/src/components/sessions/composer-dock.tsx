/**
 * Sessions surface — shared floating composer dock.
 *
 * A rounded card-shaped input area inset from the panel edges with a slim
 * action row at the bottom: routing hint on the left, ⌘↵ hint + circular
 * primary send button on the right. Used by both the new-session view and
 * the in-session composer so the bottom of the right pane is identical
 * regardless of state.
 */

import { ArrowUp, Paperclip, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

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
  /** "Send" / "Start session" / etc. Used as button aria-label and tooltip. */
  sendLabel?: string;
  /** Focus the textarea on mount. */
  autoFocus?: boolean;
  attachments?: File[];
  onFilesSelected?: (files: File[]) => void;
  onRemoveFile?: (index: number) => void;
  className?: string;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
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
  sendLabel = "Send",
  autoFocus,
  attachments,
  onFilesSelected,
  onRemoveFile,
  className,
}: ComposerDockProps) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  const selectedFiles = attachments ?? [];
  const allowAttachments = !!onFilesSelected;
  const canSubmit =
    !disabled && !isPending && (value.trim().length > 0 || selectedFiles.length > 0);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (canSubmit) onSubmit();
    }
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
          "max-w-3xl mx-auto rounded-2xl border border-border bg-card shadow-sm transition",
          "focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-primary/15",
          disabled && "opacity-60",
        )}
      >
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
        {selectedFiles.length > 0 ? (
          <div className="mx-3 mb-2 flex flex-wrap gap-1.5 border-t border-border/40 pt-2">
            {selectedFiles.map((file, index) => (
              <span
                key={`${file.name}-${file.size}-${index}`}
                className={cn(
                  "inline-flex max-w-full items-center gap-1.5 rounded-md border border-border",
                  "bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground",
                )}
              >
                <Paperclip className="h-3 w-3 shrink-0" aria-hidden="true" />
                <span className="max-w-[180px] truncate text-foreground/90">{file.name}</span>
                <span className="font-mono text-muted-foreground/70">
                  {formatFileSize(file.size)}
                </span>
                {onRemoveFile ? (
                  <button
                    type="button"
                    className="ml-0.5 inline-flex h-4 w-4 items-center justify-center rounded-sm text-muted-foreground hover:bg-background hover:text-foreground"
                    aria-label={`Remove ${file.name}`}
                    disabled={disabled || isPending}
                    onClick={() => onRemoveFile(index)}
                  >
                    <X className="h-3 w-3" />
                  </button>
                ) : null}
              </span>
            ))}
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-2 px-2.5 pb-2 pt-0.5">
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground pl-1.5">
            <span
              aria-hidden="true"
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                isPending ? "bg-primary animate-pulse" : "bg-primary/70",
              )}
            />
            <span>{isPending ? "Sending…" : routeLabel}</span>
          </div>
          <div className="flex items-center gap-2">
            {allowAttachments ? (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  disabled={disabled || isPending}
                  onChange={(e) => {
                    const files = Array.from(e.currentTarget.files ?? []);
                    if (files.length > 0) onFilesSelected(files);
                    e.currentTarget.value = "";
                  }}
                />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      disabled={disabled || isPending}
                      aria-label="Attach files"
                      className="h-8 w-8 rounded-full"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <Paperclip className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Attach files</TooltipContent>
                </Tooltip>
              </>
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
    </form>
  );
}
