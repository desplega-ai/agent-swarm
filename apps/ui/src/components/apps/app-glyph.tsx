import { LayoutGrid } from "lucide-react";
import type { AppIcon } from "@/api/types";
import { MediaIconGlyph } from "@/components/shared/media-icon-glyph";

/** An app's icon (glyph, link, or agent-fs image), falling back to the generic app glyph. */
export function AppGlyph({
  icon,
  className,
  imageClassName,
}: {
  icon: AppIcon | null | undefined;
  className?: string;
  imageClassName?: string;
}) {
  return (
    <MediaIconGlyph
      icon={icon}
      fallback={LayoutGrid}
      className={className}
      imageClassName={imageClassName}
    />
  );
}
