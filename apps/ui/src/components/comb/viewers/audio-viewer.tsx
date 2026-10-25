import { AudioLines } from "lucide-react";
import { baseName } from "@/lib/comb/paths";
import type { ViewerProps } from "./file-viewer";
import { MediaGate } from "./media-gate";

/**
 * Audio plays with the browser's controls. From a presigned URL only the
 * metadata loads before play. In blob mode the whole file loads first (up to
 * `COMB_MEDIA_MAX_BYTES`).
 */
export default function AudioViewer({ file, stat }: ViewerProps) {
  return (
    <MediaGate file={file} stat={stat} kind="audio">
      {(url, onError) => (
        <div className="flex min-h-full p-6">
          <figure className="m-auto flex w-full max-w-xl flex-col items-center gap-4 rounded-xl border border-border bg-card p-6">
            <AudioLines className="size-8 text-muted-foreground" aria-hidden />
            <figcaption className="max-w-full truncate text-sm font-medium">
              {baseName(file.path)}
            </figcaption>
            <audio src={url} controls preload="metadata" onError={onError} className="w-full">
              <track kind="captions" />
            </audio>
          </figure>
        </div>
      )}
    </MediaGate>
  );
}
