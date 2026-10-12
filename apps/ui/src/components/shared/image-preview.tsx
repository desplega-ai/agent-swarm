import { ImageOff } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

/** Live preview of an image URL as it is typed, before it is saved. */
export function ImagePreview({ src, label }: { src: string; label: string }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const url = src.trim();
  const failed = url !== "" && failedSrc === url;
  return (
    <span
      data-testid="image-preview"
      title={failed ? "This URL did not load as an image" : undefined}
      className={cn(
        "flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded border bg-muted/40",
        !url && "border-dashed",
      )}
    >
      {url && !failed ? (
        <img
          key={url}
          src={url}
          alt={`${label} preview`}
          className="h-full w-full object-contain"
          onError={() => setFailedSrc(url)}
        />
      ) : failed ? (
        <ImageOff
          className="h-3.5 w-3.5 text-status-error-strong"
          aria-label="Image did not load"
        />
      ) : null}
    </span>
  );
}
