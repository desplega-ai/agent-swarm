import { ImageOff } from "lucide-react";
import { type ComponentProps, useState } from "react";
import { type Components, defaultRehypePlugins } from "streamdown";
import { rehypeBareImageLinks } from "@/lib/markdown-images";

type Pluggable = (typeof defaultRehypePlugins)[string];

/**
 * Markdown image: fit to width (capped in height), click opens the full-size file in a new tab.
 * When the file fails to load (an expired presigned link, a 404), it shows the
 * alt text and the link instead of a broken-image icon.
 */
export function MarkdownImage({ src, alt }: ComponentProps<"img"> & { node?: unknown }) {
  const href = typeof src === "string" ? src : undefined;
  // Keyed by URL, so a new src gets a fresh load attempt.
  const [failedSrc, setFailedSrc] = useState<string>();
  if (!href) return null;

  if (failedSrc === href) {
    return (
      <span
        className="my-2 flex items-start gap-2 rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground"
        data-markdown-image="fallback"
      >
        <ImageOff className="mt-px size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0">
          {alt ? <span className="font-medium text-foreground">{alt}: </span> : null}
          image could not load, the link may have expired.{" "}
          <a href={href} target="_blank" rel="noopener noreferrer" className="underline">
            Open link
          </a>
        </span>
      </span>
    );
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title="Open full size"
      className="my-2 block w-fit max-w-full overflow-hidden rounded-md border border-border"
      data-markdown-image="image"
    >
      <img
        src={href}
        alt={alt ?? ""}
        loading="lazy"
        onError={() => setFailedSrc(href)}
        className="block h-auto max-h-[32rem] w-auto max-w-full"
      />
    </a>
  );
}

export const MARKDOWN_IMAGE_COMPONENTS = { img: MarkdownImage } satisfies Components;

/**
 * Streamdown's `rehypePlugins` prop replaces its defaults (raw → sanitize →
 * harden), so the list names them again. The bare-URL pass runs before
 * sanitize, so the `<img>` it creates is still checked like any other.
 */
export const MARKDOWN_IMAGE_REHYPE_PLUGINS = [
  defaultRehypePlugins.raw,
  rehypeBareImageLinks as Pluggable,
  defaultRehypePlugins.sanitize,
  defaultRehypePlugins.harden,
];
