import { ImageOff } from "lucide-react";
import { type ComponentProps, useState } from "react";
import { type Components, defaultRehypePlugins } from "streamdown";
import { useAgentFsMediaUrl } from "@/api/hooks/use-agent-fs";
import { useOptionalAgentFs } from "@/contexts/agent-fs-context";
import type { DrivePath } from "@/lib/comb/paths";
import { linkPreviewTarget } from "@/lib/link-preview";
import { type MarkdownMediaKind, markdownMediaKind, rehypeMediaLinks } from "@/lib/markdown-images";
import { useSwarmLinkOrigins } from "./markdown-link-chip";

type Pluggable = (typeof defaultRehypePlugins)[string];

interface MediaProps {
  kind: MarkdownMediaKind;
  /** The link as written: what "open" goes to. */
  href: string;
  alt: string;
}

/**
 * Markdown image or video ({@link markdownMediaKind}). An image fits to width
 * (capped in height) and opens the full-size file in a new tab; a video plays
 * inline with the browser's controls. A dashboard or agent-fs live file link
 * loads through the connected drive (a `/file/~/` URL is the viewer page, not
 * the bytes). When the media fails to load (an expired presigned link, a 404),
 * it shows the alt text and the link instead of a broken element.
 */
export function MarkdownImage({ src, alt }: ComponentProps<"img"> & { node?: unknown }) {
  const origins = useSwarmLinkOrigins();
  const agentFs = useOptionalAgentFs();
  const href = typeof src === "string" ? src : undefined;
  if (!href) return null;
  const label = alt ?? "";
  const kind = markdownMediaKind(href, label) ?? "image";
  const target = linkPreviewTarget(href, origins);
  if (target?.kind === "file") {
    // Without a connected drive the bytes cannot load: keep the plain link.
    if (agentFs?.state !== "ready") return <MediaLink href={href} alt={label} />;
    return <DriveMedia file={target.file} kind={kind} href={href} alt={label} />;
  }
  return <MediaView url={href} kind={kind} href={href} alt={label} />;
}

function DriveMedia({ file, ...props }: MediaProps & { file: DrivePath }) {
  const media = useAgentFsMediaUrl(file, props.kind);
  if (media.url) return <MediaView url={media.url} {...props} />;
  if (media.error || media.tooLarge) return <MediaLink href={props.href} alt={props.alt} />;
  return (
    <span
      className="my-2 block aspect-video w-full max-w-md animate-pulse rounded-md bg-muted"
      data-markdown-image="loading"
    />
  );
}

function MediaLink({ href, alt }: { href: string; alt: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="underline">
      {alt || href}
    </a>
  );
}

function MediaView({ url, kind, href, alt }: MediaProps & { url: string }) {
  // Keyed by URL, so a new src gets a fresh load attempt.
  const [failedSrc, setFailedSrc] = useState<string>();

  if (failedSrc === url) {
    return (
      <span
        className="my-2 flex items-start gap-2 rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground"
        data-markdown-image="fallback"
      >
        <ImageOff className="mt-px size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0">
          {alt ? <span className="font-medium text-foreground">{alt}: </span> : null}
          {kind} could not load, the link may have expired.{" "}
          <a href={href} target="_blank" rel="noopener noreferrer" className="underline">
            Open link
          </a>
        </span>
      </span>
    );
  }

  if (kind === "video") {
    return (
      <span className="my-2 flex w-fit max-w-full flex-col gap-1" data-markdown-image="video">
        <video
          src={url}
          controls
          preload="metadata"
          playsInline
          aria-label={alt || "Video"}
          onError={() => setFailedSrc(url)}
          className="block max-h-[32rem] max-w-full rounded-md border border-border bg-black"
        >
          <track kind="captions" />
        </video>
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="w-fit text-xs underline"
        >
          {alt || "Open video"}
        </a>
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
        src={url}
        alt={alt}
        loading="lazy"
        onError={() => setFailedSrc(url)}
        className="block h-auto max-h-[32rem] w-auto max-w-full"
      />
    </a>
  );
}

export const MARKDOWN_IMAGE_COMPONENTS = { img: MarkdownImage } satisfies Components;

/**
 * Streamdown's `rehypePlugins` prop replaces its defaults (raw → sanitize →
 * harden), so the list names them again. The media-link pass runs before
 * sanitize, so the `<img>` it creates is still checked like any other.
 */
export const MARKDOWN_IMAGE_REHYPE_PLUGINS = [
  defaultRehypePlugins.raw,
  rehypeMediaLinks as Pluggable,
  defaultRehypePlugins.sanitize,
  defaultRehypePlugins.harden,
];
