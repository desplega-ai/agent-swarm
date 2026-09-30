import { useState } from "react";
import { baseName } from "@/lib/comb/paths";
import { cn } from "@/lib/utils";
import type { ViewerProps } from "./file-viewer";
import { MediaGate } from "./media-gate";

/**
 * Images fit the pane width, and a click toggles the actual size. SVG loads
 * through `<img>` only, where its scripts never run.
 */
export default function ImageViewer({ file }: ViewerProps) {
  const [actualSize, setActualSize] = useState(false);
  return (
    <MediaGate file={file} noun="image">
      {(url, onError) => (
        <div className="flex min-h-full p-6">
          <button
            type="button"
            aria-label={actualSize ? "Fit to width" : "Show actual size"}
            onClick={() => setActualSize((value) => !value)}
            className={cn("m-auto rounded-md", !actualSize && "max-w-full")}
          >
            <img
              src={url}
              alt={baseName(file.path)}
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
