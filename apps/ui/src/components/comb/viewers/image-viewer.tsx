import { useState } from "react";
import { baseName } from "@/lib/comb/paths";
import { cn } from "@/lib/utils";
import type { ViewerProps } from "./file-viewer";
import { MediaGate } from "./media-gate";

/**
 * Images fit the pane width, and a click toggles the actual size. SVG loads
 * through `<img>` only, where its scripts never run.
 */
export default function ImageViewer({ file, stat }: ViewerProps) {
  const [actualSize, setActualSize] = useState(false);
  const name = baseName(file.path);
  return (
    <MediaGate file={file} stat={stat} kind="image">
      {(url, onError) => (
        <div className="flex min-h-full p-6">
          <button
            type="button"
            aria-label={`${name}, ${actualSize ? "fit to width" : "show actual size"}`}
            onClick={() => setActualSize((value) => !value)}
            className={cn("m-auto rounded-md", !actualSize && "max-w-full")}
          >
            <img
              src={url}
              alt={name}
              onError={onError}
              className={cn(
                "block rounded-md",
                actualSize ? "max-w-none cursor-zoom-out" : "h-auto max-w-full cursor-zoom-in",
              )}
            />
          </button>
        </div>
      )}
    </MediaGate>
  );
}
