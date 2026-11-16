import { useState } from "react";
import { baseName } from "@/lib/comb/paths";
import { cn } from "@/lib/utils";
import type { ViewerProps } from "./file-viewer";
import { MediaGate } from "./media-gate";

/**
 * Images fit the pane width, and a click toggles the actual size. SVG loads
 * through `<img>` only, where its scripts never run.
 *
 * An SVG with a `viewBox` and no width or height has no size of its own: in
 * the shrink-to-fit button it gets zero width and shows nothing. Such an
 * image fills the pane width instead, and its actual size is the browser's
 * default box for it.
 */
export default function ImageViewer({ file, stat }: ViewerProps) {
  const [actualSize, setActualSize] = useState(false);
  // The default box width of an image with no size of its own, else null.
  const [sizeless, setSizeless] = useState<number | null>(null);
  const name = baseName(file.path);
  return (
    <MediaGate file={file} stat={stat} kind="image">
      {(url, onError) => (
        <div className="flex min-h-full p-6">
          <button
            type="button"
            aria-label={`${name}, ${actualSize ? "fit to width" : "show actual size"}`}
            onClick={() => setActualSize((value) => !value)}
            className={cn(
              "m-auto rounded-md",
              !actualSize && "max-w-full",
              !actualSize && sizeless && "w-full",
            )}
          >
            <img
              src={url}
              alt={name}
              onError={onError}
              onLoad={(event) => {
                const image = event.currentTarget;
                if (image.naturalWidth > 0 && image.offsetWidth === 0) {
                  setSizeless(image.naturalWidth);
                }
              }}
              width={actualSize && sizeless ? sizeless : undefined}
              className={cn(
                "block rounded-md",
                actualSize ? "max-w-none cursor-zoom-out" : "h-auto max-w-full cursor-zoom-in",
                !actualSize && sizeless && "w-full",
              )}
            />
          </button>
        </div>
      )}
    </MediaGate>
  );
}
