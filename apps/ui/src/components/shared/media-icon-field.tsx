/**
 * Edits a `MediaIcon`: a lucide glyph, an https image link, or an image
 * uploaded to the swarm's agent-fs drive. Generic over the owner: the caller
 * saves through `onSave` and picks where uploads land (`uploadPrefix`, e.g.
 * `/apps/<appId>/icon`). Each tab saves on its own button; nothing stores on
 * view.
 */

import type { LucideIcon } from "lucide-react";
import { ImageUp, Palette } from "lucide-react";
import { type DragEvent, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import type { MediaIcon } from "@/api/types";
import { AgentAppearancePicker } from "@/components/shared/agent-appearance-picker";
import { MediaIconGlyph } from "@/components/shared/media-icon-glyph";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useOptionalAgentFs } from "@/contexts/agent-fs-context";
import {
  MEDIA_ICON_ACCEPT,
  mediaIconFileError,
  parseMediaIconUrl,
  uploadMediaIcon,
} from "@/lib/upload-media-icon";
import { cn } from "@/lib/utils";

type Tab = "glyph" | "link" | "upload";

function tabFor(icon: MediaIcon | null | undefined): Tab {
  if (icon?.type === "url") return "link";
  if (icon?.type === "agent-fs") return "upload";
  return "glyph";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A local preview of a picked file. Revoked when the file changes or the field unmounts. */
function useObjectUrl(file: File | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file) {
      setUrl(null);
      return;
    }
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return url;
}

export interface MediaIconFieldProps {
  /** The stored icon. `null` / `undefined` shows the fallback glyph. */
  value: MediaIcon | null | undefined;
  /** Store the icon (`null` resets to the default). Throws on failure. */
  onSave: (icon: MediaIcon | null) => Promise<void>;
  /** agent-fs path prefix for uploads; the file lands at `<prefix>-<epochMs>.<ext>`. */
  uploadPrefix: string;
  /** Lucide glyph for an empty icon or an image that cannot show. */
  fallback: LucideIcon;
}

export function MediaIconField({ value, onSave, uploadPrefix, fallback }: MediaIconFieldProps) {
  const agentFs = useOptionalAgentFs();
  const client = agentFs?.state === "ready" ? agentFs.client : null;
  const drive =
    agentFs?.orgId && agentFs.driveId ? { orgId: agentFs.orgId, driveId: agentFs.driveId } : null;
  const canUpload = client !== null && drive !== null;

  const initialTab = tabFor(value);
  const [tab, setTab] = useState<Tab>(initialTab === "upload" && !canUpload ? "glyph" : initialTab);
  const [saving, setSaving] = useState(false);
  const [linkDraft, setLinkDraft] = useState(value?.type === "url" ? value.url : "");
  const [linkError, setLinkError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const filePreview = useObjectUrl(file);
  const linkId = useId();
  // The link last sent to onSave; cleared once the stored icon changes.
  const lastCommittedLink = useRef<string | undefined>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset whenever the stored icon changes
  useEffect(() => {
    lastCommittedLink.current = undefined;
  }, [value]);

  const storedLucide = value?.type === "lucide" ? value : undefined;

  // Every choice saves at once; while an upload runs, the preview shows the picked file.
  const preview: MediaIcon | null | undefined =
    tab === "upload" && filePreview ? { type: "url", url: filePreview } : value;

  /** Returns whether the save landed; failures are reported with a toast. */
  async function save(icon: MediaIcon | null): Promise<boolean> {
    setSaving(true);
    try {
      await onSave(icon);
      toast.success(icon ? "Icon saved" : "Icon reset");
      return true;
    } catch (error) {
      toast.error(errorMessage(error));
      return false;
    } finally {
      setSaving(false);
    }
  }

  /** Saves the link on Enter or blur; an empty or unchanged link saves nothing. */
  function commitLink() {
    const trimmed = linkDraft.trim();
    const stored = value?.type === "url" ? value.url : undefined;
    // Enter then blur would save twice before the stored value refetches.
    if (saving || trimmed === "" || trimmed === stored || trimmed === lastCommittedLink.current) {
      return;
    }
    const parsed = parseMediaIconUrl(trimmed);
    if (!parsed.ok) {
      setLinkError(parsed.error);
      return;
    }
    lastCommittedLink.current = trimmed;
    void save(parsed.icon).then((saved) => {
      // A failed save must not block retrying the same link.
      if (!saved && lastCommittedLink.current === trimmed) lastCommittedLink.current = undefined;
    });
  }

  async function pickFile(next: File | null | undefined) {
    if (!next || !client || !drive) return;
    const error = mediaIconFileError(next);
    setFileError(error);
    if (error) return;
    setFile(next);
    setSaving(true);
    try {
      const icon = await uploadMediaIcon(client, drive, uploadPrefix, next);
      await onSave(icon);
      toast.success("Icon saved");
    } catch (uploadError) {
      toast.error(errorMessage(uploadError));
    } finally {
      setFile(null);
      setSaving(false);
    }
  }

  function onDrop(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    setDragging(false);
    if (!canUpload || saving) return;
    void pickFile(event.dataTransfer.files[0]);
  }

  return (
    <div className="space-y-3" data-testid="media-icon-field">
      <div className="flex items-center gap-3">
        <div
          className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-muted"
          data-testid="media-icon-preview"
        >
          <MediaIconGlyph
            icon={preview}
            fallback={fallback}
            className="size-5 text-muted-foreground"
            imageClassName="size-full rounded-none"
          />
        </div>
        <SegmentedControl<Tab>
          size="sm"
          aria-label="Icon source"
          value={tab}
          onValueChange={setTab}
          options={[
            { value: "glyph", label: "Glyph" },
            { value: "link", label: "Link" },
            {
              value: "upload",
              label: "Upload",
              disabled: !canUpload,
              tooltip: canUpload ? undefined : "Connect agent-fs to upload",
            },
          ]}
        />
      </div>

      {tab === "glyph" && (
        <div className="flex flex-wrap items-center gap-2">
          <AgentAppearancePicker
            avatar={storedLucide}
            onChange={(next) => void save(next ?? null)}
            trigger={
              <Button variant="outline" size="sm" disabled={saving}>
                <Palette className="size-3.5" />
                Choose icon and color
              </Button>
            }
          />
          {saving && <span className="text-xs text-muted-foreground">Saving…</span>}
        </div>
      )}

      {tab === "link" && (
        <div className="space-y-1.5">
          <Input
            id={linkId}
            type="url"
            inputMode="url"
            aria-label="Image URL"
            placeholder="https://example.com/icon.png"
            value={linkDraft}
            disabled={saving}
            aria-invalid={linkError ? true : undefined}
            onChange={(event) => {
              setLinkDraft(event.target.value);
              setLinkError(null);
            }}
            onBlur={commitLink}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                commitLink();
              }
            }}
            data-testid="media-icon-link-input"
          />
          {linkError ? (
            <p className="text-xs text-status-error-strong" role="alert">
              {linkError}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              {saving
                ? "Saving…"
                : "An https image. Saves on Enter. The glyph shows if it cannot load."}
            </p>
          )}
        </div>
      )}

      {tab === "upload" && canUpload && (
        <div className="space-y-1.5">
          <input
            ref={fileInput}
            type="file"
            accept={MEDIA_ICON_ACCEPT}
            hidden
            aria-hidden
            tabIndex={-1}
            onChange={(event) => {
              void pickFile(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
          <button
            type="button"
            disabled={saving}
            onClick={() => fileInput.current?.click()}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={cn(
              "flex w-full flex-col items-center gap-1 rounded-md border border-dashed border-input px-3 py-4 text-xs text-muted-foreground hover-linger transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              dragging && "border-primary bg-accent",
            )}
            data-testid="media-icon-dropzone"
          >
            <ImageUp className="size-4" aria-hidden />
            {file ? (
              <span className="text-foreground">Uploading {file.name}…</span>
            ) : (
              <span>Drop an image or choose a file</span>
            )}
          </button>
          {fileError ? (
            <p className="text-xs text-status-error-strong" role="alert">
              {fileError}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">PNG, JPEG, WebP, GIF, or SVG. 1 MB max.</p>
          )}
        </div>
      )}

      {!canUpload && (
        <p className="text-xs text-muted-foreground" data-testid="media-icon-upload-hint">
          Connect agent-fs to upload an image.
        </p>
      )}
    </div>
  );
}
