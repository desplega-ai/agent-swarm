import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";

/**
 * Monochrome brand mark from a file in `public/` (harness-logos,
 * provider-logos, integration-logos). A CSS mask tints the mark with
 * `currentColor`, so it follows the theme like a lucide icon. Decorative:
 * every call site renders the brand name as visible text next to it.
 * Multi-color logos do not fit a mask: render them as an `<img>`.
 */
export function BrandLogo({ src, className }: { src: string; className?: string }) {
  const mask: CSSProperties = {
    maskImage: `url(${src})`,
    WebkitMaskImage: `url(${src})`,
    maskSize: "contain",
    WebkitMaskSize: "contain",
    maskRepeat: "no-repeat",
    WebkitMaskRepeat: "no-repeat",
    maskPosition: "center",
    WebkitMaskPosition: "center",
  };
  return (
    <span
      aria-hidden
      className={cn("inline-block size-5 shrink-0 bg-current", className)}
      style={mask}
    />
  );
}
