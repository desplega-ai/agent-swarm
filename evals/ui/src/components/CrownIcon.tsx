import type { ReactNode } from "react";

/**
 * Lead-member crown (round-10 item 2). Reproduces the main dashboard's
 * lucide-react `Crown` glyph (ui/src/lib/agent-icon.ts + agent-node.tsx,
 * lucide-react v0.575.0) as an inline SVG — the evals UI has no lucide
 * dependency and ports icons inline (HarnessIcon.tsx convention).
 * Decorative: the adjacent text/tooltip is the accessible name.
 */
export function CrownIcon(props: { size?: number; className?: string }): ReactNode {
  const size = props.size ?? 12;
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative icon, tooltip/label carries the name
    <svg
      aria-hidden
      focusable={false}
      className={props.className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z" />
      <path d="M5 21h14" />
    </svg>
  );
}
