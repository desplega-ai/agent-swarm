import { useReducedMotion } from "motion/react";
import { useId } from "react";
import "./hive-mark.css";

type HiveMarkProps = {
  /** Rendered width in px; the viewBox keeps the aspect ratio at 5:4. */
  size?: number;
  /** Rings radiating out of the lead cell. */
  pulses?: boolean;
  /** Dots travelling lead → worker along the connectors, lighting each cell on arrival. */
  dataFlow?: boolean;
};

// Flat-top hexagon, 72 units across the flats. The ring coordinates below are
// derived from it — changing one without the other breaks the tessellation.
const HEX_POINTS = "36,0 18,-31.18 -18,-31.18 -36,0 -18,31.18 18,31.18";

const RING = [
  { x: 54, y: -31.18 },
  { x: 54, y: 31.18 },
  { x: 0, y: 62.35 },
  { x: -54, y: 31.18 },
  { x: -54, y: -31.18 },
  { x: 0, y: -62.35 },
];

const FLOW_DUR = "2.4s";
const FLOW_STAGGER = 0.32;

/**
 * The swarm mark: a lead cell surrounded by six workers. Every color resolves
 * from `currentColor` (`text-primary`) or `--color-background`, so the mark
 * follows the active theme preset and light/dark without a prop.
 */
export function HiveMark({ size = 320, pulses = false, dataFlow = false }: HiveMarkProps) {
  // SMIL <animate> can't be reached by a CSS media query, so the movement-
  // bearing variants are gated here; the opacity-only CSS fallbacks stay on.
  const reduced = useReducedMotion();
  const flow = dataFlow && !reduced;
  const rings = pulses && !reduced;

  // React's useId output contains characters that aren't valid in a fragment
  // identifier, so strip everything outside [A-Za-z0-9].
  const gradientId = `hive-lead-glow-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;

  return (
    <svg
      viewBox="-100 -80 200 160"
      width={size}
      className="block text-primary"
      style={{ overflow: "visible" }}
      aria-hidden="true"
    >
      <defs>
        <radialGradient id={gradientId} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.25" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </radialGradient>
      </defs>

      {RING.map((cell, i) => (
        <line
          key={`line-${cell.x},${cell.y}`}
          x1="0"
          y1="0"
          x2={cell.x}
          y2={cell.y}
          stroke="currentColor"
          strokeWidth="0.8"
          strokeOpacity={flow ? 0.06 : 0.5}
          strokeDasharray="2 4"
          className={flow ? undefined : "hive-line"}
          style={flow ? undefined : { animationDelay: `${i * 0.3}s` }}
        >
          {flow && (
            <animate
              attributeName="stroke-opacity"
              values="0.06;0.55;0.06"
              keyTimes="0;0.5;1"
              dur={FLOW_DUR}
              begin={`${i * FLOW_STAGGER}s`}
              repeatCount="indefinite"
            />
          )}
        </line>
      ))}

      {rings &&
        [0, 1, 2].map((delay) => (
          <circle
            key={`ring-${delay}`}
            cx="0"
            cy="0"
            r="0"
            fill="none"
            stroke="currentColor"
            strokeWidth="0.6"
            className="hive-ring"
            style={{ animationDelay: `${delay}s` }}
          />
        ))}

      {flow &&
        RING.map((cell, i) => (
          <circle key={`dot-${cell.x},${cell.y}`} r="2.2" fill="currentColor">
            {/* Travel is a transform, not cx/cy — animating geometry repaints
                the whole surface every frame for the entire loading interval
                (the motion doctrine's transform/opacity-only rule). */}
            <animateTransform
              attributeName="transform"
              type="translate"
              from="0 0"
              to={`${cell.x} ${cell.y}`}
              dur={FLOW_DUR}
              begin={`${i * FLOW_STAGGER}s`}
              repeatCount="indefinite"
            />
            <animate
              attributeName="opacity"
              values="0;1;1;0"
              keyTimes="0;0.12;0.85;1"
              dur={FLOW_DUR}
              begin={`${i * FLOW_STAGGER}s`}
              repeatCount="indefinite"
            />
          </circle>
        ))}

      {RING.map((cell, i) => (
        <polygon
          key={`cell-${cell.x},${cell.y}`}
          points={HEX_POINTS}
          transform={`translate(${cell.x}, ${cell.y})`}
          fill="var(--color-background)"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeOpacity={flow ? 0.18 : undefined}
          fillOpacity={flow ? 0 : undefined}
          className={flow ? undefined : "hive-cell"}
          style={
            flow
              ? undefined
              : {
                  animationDuration: `${3 + (i % 3) * 0.4}s`,
                  animationDelay: `${i * 0.35}s`,
                }
          }
        >
          {flow && (
            <>
              <animate
                attributeName="stroke-opacity"
                values="0.18;0.18;1;0.55;0.18"
                keyTimes="0;0.7;0.9;0.96;1"
                dur={FLOW_DUR}
                begin={`${i * FLOW_STAGGER}s`}
                repeatCount="indefinite"
              />
              <animate
                attributeName="fill-opacity"
                values="0;0;0.22;0.08;0"
                keyTimes="0;0.7;0.9;0.96;1"
                dur={FLOW_DUR}
                begin={`${i * FLOW_STAGGER}s`}
                repeatCount="indefinite"
              />
            </>
          )}
        </polygon>
      ))}

      {/* Opaque backdrop so the flow dots emerge from behind the lead cell. */}
      {flow && <polygon points={HEX_POINTS} fill="var(--color-background)" stroke="none" />}

      <circle r="58" fill={`url(#${gradientId})`} className="hive-lead" />
      <polygon
        points={HEX_POINTS}
        fill="currentColor"
        fillOpacity="0.10"
        stroke="currentColor"
        strokeWidth="2.2"
        className="hive-lead"
      />
    </svg>
  );
}
