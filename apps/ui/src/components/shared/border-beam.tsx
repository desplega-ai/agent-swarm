import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";

/**
 * Border beam: a short amber highlight that travels along a rounded border.
 * Vendored in the spirit of the Libraries.dev "Border beam" (no dependency).
 *
 * How it works: a 1px padding ring sits over the container's border, cut
 * out with a mask (content box excluded from the padding box). Inside the
 * ring, a large conic gradient rotates. Only `transform` animates, so the compositor runs
 * it. Place it inside a `relative` container with a border; it inherits the
 * container's corner radius.
 *
 * Amber marks liveness here (DESIGN.md, One Voice): use it only while the
 * surface is ready to act. Under `prefers-reduced-motion` it does not render.
 */
const RING_MASK: CSSProperties = {
  mask: "linear-gradient(black 0 0) content-box, linear-gradient(black 0 0)",
  maskComposite: "exclude",
  WebkitMask: "linear-gradient(black 0 0) content-box, linear-gradient(black 0 0)",
  WebkitMaskComposite: "xor",
};

const BEAM: CSSProperties = {
  background:
    "conic-gradient(from 0deg, transparent 0turn, transparent 0.5turn, color-mix(in oklch, var(--color-primary) 30%, transparent) 0.8turn, var(--color-primary) 0.97turn, transparent 1turn)",
};

export function BorderBeam({
  className,
  durationSeconds = 6,
}: {
  className?: string;
  /** One lap. Slow on purpose: the beam signals "ready", it does not demand attention. */
  durationSeconds?: number;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none absolute -inset-px z-10 overflow-hidden rounded-[inherit] p-px motion-reduce:hidden",
        className,
      )}
      style={RING_MASK}
    >
      <span
        className="absolute top-1/2 left-1/2 aspect-square w-[150%] -translate-x-1/2 -translate-y-1/2 animate-spin"
        style={{ ...BEAM, animationDuration: `${durationSeconds}s` }}
      />
    </span>
  );
}
