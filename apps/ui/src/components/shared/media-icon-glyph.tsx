/**
 * Renders a `MediaIcon`: a lucide glyph, an https image link, or an image file
 * in agent-fs. Any image that cannot show (loading, broken, too large, or
 * agent-fs not connected in this browser) renders the lucide fallback at the
 * same size, so the layout never shifts.
 */

import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useAgentFsMediaUrl } from "@/api/hooks/use-agent-fs";
import type { MediaIcon } from "@/api/types";
import { ImageWithFallback } from "@/components/shared/image-with-fallback";
import { useOptionalAgentFs } from "@/contexts/agent-fs-context";
import { AVATAR_ICON_CATALOG } from "@/lib/agent-icon";
import type { DrivePath } from "@/lib/comb/paths";
import { cn } from "@/lib/utils";

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/**
 * Catalog icon wins; a missing or unrecognized name falls back to `fallback`
 * (a valid color still applies). The name comes from stored data, so it is
 * looked up as an own key only, and the color must be a `#RRGGBB` hex before
 * it reaches `style`.
 */
function resolveLucide(
  icon: MediaIcon | null | undefined,
  fallback: LucideIcon,
): { Icon: LucideIcon; color: string | undefined } {
  if (icon?.type !== "lucide") return { Icon: fallback, color: undefined };
  const Icon = Object.hasOwn(AVATAR_ICON_CATALOG, icon.icon)
    ? AVATAR_ICON_CATALOG[icon.icon]
    : undefined;
  const color = icon.color && HEX_COLOR.test(icon.color) ? icon.color : undefined;
  return { Icon: Icon ?? fallback, color };
}

/** Image classes: the caller's image size (or the glyph size), cropped to a square. */
const imageClass = (className: string | undefined) => cn("rounded-sm object-cover", className);

export function MediaIconGlyph({
  icon,
  fallback,
  className,
  imageClassName,
  alt = "",
}: {
  icon: MediaIcon | null | undefined;
  /** The lucide icon shown when there is no icon, an unknown glyph, or an image that cannot show. */
  fallback: LucideIcon;
  /** Size and color classes for the glyph; the image takes the same size unless `imageClassName` is set. */
  className?: string;
  /** Size and rounding for an image icon, e.g. to fill a tile while the glyph stays small. */
  imageClassName?: string;
  /** Alt text for an image icon. Empty by default: the icon sits next to its name. */
  alt?: string;
}) {
  const { Icon, color } = resolveLucide(icon, fallback);
  const imageClasses = imageClassName ?? className;
  const glyph = <Icon aria-hidden className={className} style={color ? { color } : undefined} />;
  if (icon?.type === "url") {
    return (
      <ImageWithFallback
        src={icon.url}
        alt={alt}
        className={imageClass(imageClasses)}
        fallback={glyph}
      />
    );
  }
  if (icon?.type === "agent-fs") {
    return <AgentFsIconImage icon={icon} alt={alt} className={imageClasses} glyph={glyph} />;
  }
  return glyph;
}

/**
 * The drive an agent-fs icon names, or the swarm drive when it names neither
 * ID. A single ID is never mixed with the swarm drive's.
 */
function useIconTarget(icon: Extract<MediaIcon, { type: "agent-fs" }>): {
  target: DrivePath | null;
  connected: boolean;
} {
  const agentFs = useOptionalAgentFs();
  const connected = agentFs?.state === "ready" && agentFs.client !== null;
  if (icon.orgId && icon.driveId) {
    return { target: { orgId: icon.orgId, driveId: icon.driveId, path: icon.path }, connected };
  }
  if (!icon.orgId && !icon.driveId && agentFs?.orgId && agentFs.driveId) {
    return {
      target: { orgId: agentFs.orgId, driveId: agentFs.driveId, path: icon.path },
      connected,
    };
  }
  return { target: null, connected };
}

function AgentFsIconImage({
  icon,
  alt,
  className,
  glyph,
}: {
  icon: Extract<MediaIcon, { type: "agent-fs" }>;
  alt: string;
  className: string | undefined;
  glyph: ReactNode;
}) {
  const { target, connected } = useIconTarget(icon);
  // The media hook needs a connected client and a drive, so it mounts only then.
  if (!connected || !target) return <>{glyph}</>;
  return <ConnectedAgentFsImage target={target} alt={alt} className={className} glyph={glyph} />;
}

function ConnectedAgentFsImage({
  target,
  alt,
  className,
  glyph,
}: {
  target: DrivePath;
  alt: string;
  className: string | undefined;
  glyph: ReactNode;
}) {
  const { url } = useAgentFsMediaUrl(target, "image");
  // Null while loading, on error, and when the file is too large: the glyph holds the slot.
  return (
    <ImageWithFallback src={url} alt={alt} className={imageClass(className)} fallback={glyph} />
  );
}
