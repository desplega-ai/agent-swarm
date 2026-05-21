import { interpolate, useCurrentFrame } from "remotion";
import type { CursorEvent, CursorTrack } from "../../cursor-track";

interface CursorProps {
  track: CursorTrack;
  /** Total frames in the demo section — used only for fade in/out. */
  demoFrameCount: number;
  demoStartFrame?: number;
  /** Width of the container this cursor is rendered inside (default: 1920). */
  containerW?: number;
  /** Height of the container this cursor is rendered inside (default: 1080). */
  containerH?: number;
}

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

function cursorAtMs(events: CursorEvent[], ms: number): { x: number; y: number } {
  if (events.length === 0) return { x: 960, y: 540 };
  if (ms <= events[0].tsMs) return { x: events[0].x, y: events[0].y };
  const last = events[events.length - 1];
  if (ms >= last.tsMs) return { x: last.x, y: last.y };

  for (let i = 0; i < events.length - 1; i++) {
    const a = events[i];
    const b = events[i + 1];
    if (ms >= a.tsMs && ms <= b.tsMs) {
      const span = b.tsMs - a.tsMs;
      const t = span > 0 ? (ms - a.tsMs) / span : 1;
      const eased = easeOutCubic(Math.max(0, Math.min(1, t)));
      return {
        x: a.x + (b.x - a.x) * eased,
        y: a.y + (b.y - a.y) * eased,
      };
    }
  }
  return { x: last.x, y: last.y };
}

function nearClick(events: CursorEvent[], ms: number): boolean {
  return events.some((e) => e.action === "click" && Math.abs(e.tsMs - ms) <= 133);
}

export const Cursor: React.FC<CursorProps> = ({
  track,
  demoFrameCount,
  demoStartFrame = 90,
  containerW = 1920,
  containerH = 1080,
}) => {
  const frame = useCurrentFrame();
  const fps = 30;

  // Direct frame→ms at 30fps — matches how <Video> plays back in Remotion.
  // Frame 0 = recording t=0ms, frame 30 = t=1000ms, etc.
  const recordingMs = (frame * 1000) / fps;

  const { x, y } = cursorAtMs(track.events, recordingMs);
  const isNearClick = nearClick(track.events, recordingMs);

  // Scale recording-viewport coords to the container's pixel space.
  const cx = x * (containerW / track.viewport.width);
  const cy = y * (containerH / track.viewport.height);

  const opacity = interpolate(
    frame,
    [0, fps * 0.5, demoFrameCount - fps * 0.5, demoFrameCount],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  const clickPulseProgress = isNearClick
    ? interpolate(
        track.events.find(
          (e) => e.action === "click" && Math.abs(e.tsMs - recordingMs) <= 133
        )?.tsMs ?? recordingMs,
        [recordingMs - 133, recordingMs + 133],
        [0, 1],
        { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
      )
    : 0;
  const pulseOpacity = isNearClick ? interpolate(clickPulseProgress, [0, 0.4, 1], [0, 0.9, 0]) : 0;
  const pulseScale = 1 + clickPulseProgress * 0.6;

  return (
    <div
      style={{
        position: "absolute",
        left: cx - 8,
        top: cy - 4,
        pointerEvents: "none",
        opacity,
        zIndex: 100,
      }}
    >
      {isNearClick && (
        <div
          style={{
            position: "absolute",
            left: -16,
            top: -16,
            width: 48,
            height: 48,
            borderRadius: "50%",
            border: "2px solid #f59e0b",
            opacity: pulseOpacity * 0.8,
            transform: `scale(${pulseScale})`,
          }}
        />
      )}
      <svg
        width={24}
        height={28}
        viewBox="0 0 24 28"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        style={{ filter: "drop-shadow(0 1px 4px rgba(0,0,0,0.6))" }}
      >
        <path
          d="M2 2L2 22L7.5 16.5L11 24L14 22.5L10.5 15L18 15L2 2Z"
          fill="white"
          stroke="#1a1a1a"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
};
