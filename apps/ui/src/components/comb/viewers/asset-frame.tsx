import { Download, type LucideIcon, Maximize2, MessageSquarePlus, Minimize2 } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { toast } from "sonner";
import { useAgentFsAccess } from "@/api/hooks/use-agent-fs";
import { downloadBlob, downloadDriveFile } from "@/components/comb/file-actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ASSET_COMMENT_EVENT, type AssetCommentDetail } from "@/lib/comb/assets";
import { baseName } from "@/lib/comb/paths";
import { cn } from "@/lib/utils";
import type { AssetFrameProps, AssetSource } from "./comb-markdown";

/** What the toolbar, the modal, and the composer call the asset. */
function assetLabel(asset: AssetSource): string {
  if (asset.kind === "diagram") return "Mermaid diagram";
  const name = asset.alt || (asset.file ? baseName(asset.file.path) : "");
  return name ? `Image: ${name}` : "Image";
}

function ToolButton({
  label,
  icon: Icon,
  onClick,
}: {
  label: string;
  icon: LucideIcon;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon-sm"
          variant="outline"
          aria-label={label}
          onClick={(event) => {
            // A linked image puts the frame inside an <a>: the click must not follow it.
            event.preventDefault();
            event.stopPropagation();
            onClick();
          }}
          // Readable over any image: the outline variant's dark fill is see-through.
          className="bg-background/90 shadow-sm backdrop-blur-sm hover:bg-accent dark:bg-background/90 dark:hover:bg-accent"
        >
          <Icon />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * An image or a mermaid diagram in the markdown, with a toolbar on hover:
 * Maximize (a modal with the asset as large as the screen) and Comment (a
 * comment on the asset's source lines, through `ASSET_COMMENT_EVENT`). The
 * comment layer outlines the frame while a comment points at it
 * (`data-comb-asset-comment`). The toolbar is not document text.
 */
export function AssetFrame({ asset, block = false, lines, children }: AssetFrameProps) {
  const frameRef = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  const label = assetLabel(asset);
  const comment = () => {
    const detail: AssetCommentDetail = { label };
    frameRef.current?.dispatchEvent(
      new CustomEvent(ASSET_COMMENT_EVENT, { bubbles: true, detail }),
    );
  };
  const toolbar = (
    <span
      data-comb-skip
      className="absolute top-2 right-2 z-10 flex gap-1 opacity-0 transition-opacity duration-150 group-focus-within/asset:opacity-100 group-hover/asset:opacity-100 [@media(hover:none)]:opacity-100"
    >
      <ToolButton label="Maximize" icon={Maximize2} onClick={() => setOpen(true)} />
      <ToolButton label="Comment" icon={MessageSquarePlus} onClick={comment} />
    </span>
  );
  const lightbox = open ? (
    <AssetLightbox
      asset={asset}
      label={label}
      onClose={() => setOpen(false)}
      onComment={() => {
        setOpen(false);
        // The composer opens next to the asset once the modal has closed.
        requestAnimationFrame(comment);
      }}
    />
  ) : null;
  // The frame takes the image's margin, so the toolbar sits on the image's corner.
  const frameClass = "group/asset relative max-w-full rounded-lg";
  // The frame is a block of the text space: a comment on the asset finds it by these lines.
  const stamps = lines ? { "data-line-start": lines.start, "data-line-end": lines.end } : {};
  return block ? (
    <div
      ref={frameRef as React.RefObject<HTMLDivElement>}
      data-comb-asset
      {...stamps}
      className={cn(frameClass, "block")}
    >
      {children}
      {toolbar}
      {lightbox}
    </div>
  ) : (
    <span
      ref={frameRef as React.RefObject<HTMLSpanElement>}
      data-comb-asset
      {...stamps}
      className={cn(frameClass, "my-4 inline-block align-top [&>img]:my-0")}
    >
      {children}
      {toolbar}
      {lightbox}
    </span>
  );
}

/** A diagram's SVG with its own id, so the copy in the modal never clashes with the page's. */
function svgCopy(svg: string, id: string): string {
  return svg.replaceAll(id, `${id}-max`);
}

function downloadSvg(svg: string) {
  downloadBlob(new Blob([svg], { type: "image/svg+xml" }), "diagram.svg");
}

/**
 * The asset as large as the screen. It starts fitted to the window. "Actual
 * size" shows it at its own size, and the modal scrolls.
 */
function AssetLightbox({
  asset,
  label,
  onClose,
  onComment,
}: {
  asset: AssetSource;
  label: string;
  onClose: () => void;
  onComment: () => void;
}) {
  const { client } = useAgentFsAccess();
  const [actual, setActual] = useState(false);
  const download = () => {
    if (asset.kind === "diagram") {
      downloadSvg(asset.svg);
      return;
    }
    if (asset.file && client) {
      void downloadDriveFile(client, asset.file).catch((err: unknown) =>
        toast.error(err instanceof Error ? err.message : "Download failed"),
      );
      return;
    }
    window.open(asset.src, "_blank", "noopener,noreferrer");
  };

  let body: ReactNode;
  if (asset.kind === "image") {
    body = (
      <img
        src={asset.src}
        alt={asset.alt}
        className={cn(
          "mx-auto rounded-md",
          // Fit: as large as the modal allows, scaled up when the image is small.
          actual ? "max-w-none" : "h-[calc(90vh-6rem)] w-full object-contain",
        )}
      />
    );
  } else {
    body = (
      <div
        role="img"
        aria-label={label}
        className={cn(
          "mx-auto [&_svg]:mx-auto [&_svg]:block",
          actual
            ? "[&_svg]:max-w-none"
            : "flex h-[calc(90vh-6rem)] items-center [&_svg]:h-full [&_svg]:max-h-full [&_svg]:w-full [&_svg]:max-w-full",
        )}
        // The SVG comes from mermaid with `securityLevel: "strict"`, the same
        // markup the page already shows.
        // biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid's sanitized SVG
        dangerouslySetInnerHTML={{ __html: svgCopy(asset.svg, asset.svgId) }}
      />
    );
  }

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="flex max-h-[95vh] w-[95vw] max-w-[95vw] flex-col gap-3 p-4 sm:max-w-[95vw]">
        <div className="flex items-center gap-2 pr-8">
          <DialogTitle className="min-w-0 flex-1 truncate text-sm font-medium">{label}</DialogTitle>
          <DialogDescription className="sr-only">
            The asset at full size. Escape closes it.
          </DialogDescription>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setActual(!actual)}
            aria-pressed={actual}
          >
            {actual ? <Minimize2 /> : <Maximize2 />}
            {actual ? "Fit to screen" : "Actual size"}
          </Button>
          <Button size="sm" variant="ghost" onClick={download}>
            <Download />
            {asset.kind === "diagram" ? "Download SVG" : "Download"}
          </Button>
          <Button size="sm" variant="outline" onClick={onComment}>
            <MessageSquarePlus />
            Comment
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto rounded-md bg-muted/30 p-2">{body}</div>
      </DialogContent>
    </Dialog>
  );
}
