import { AbsoluteFill, Easing, Video, interpolate, staticFile, useCurrentFrame } from "remotion";
import { theme } from "../../theme";
import { Cursor } from "./Cursor";
import type { CursorEvent, CursorTrack } from "../../cursor-track";

const DEMO_FRAME_COUNT = 675; // 22.5s @ 30fps
const FPS = 30;

// Mac-style browser window — floats on the dark composition bg.
// 1920×1080 output; window is 1760×1026 centred with 80px side / 27px top padding.
// Title bar (chrome) is 36px; content area below is 1760×990 (exactly 16:9 = 1920×1080 scale).
const WIN_X = 80;
const WIN_Y = 27;
const WIN_W = 1760;
const WIN_H = 1026;
const CHROME_H = 36;
const CONTENT_W = WIN_W;       // 1760
const CONTENT_H = WIN_H - CHROME_H; // 990

interface SceneDemoProps {
  cursorTrack: CursorTrack;
}

// ---------------------------------------------------------------------------
// Zoom — eased scale keyed to click events from the cursor track.
// Zooms toward the click point, then eases back. Max 8% zoom-in.
// ---------------------------------------------------------------------------

const ZOOM_EASE = Easing.bezier(0.25, 0.1, 0.25, 1.0);

function computeZoom(
  events: CursorEvent[],
  frame: number,
  vpW: number,
  vpH: number,
): { scale: number; originX: string; originY: string } {
  const windowFrames = 18;
  let nearestClick: { ef: number; x: number; y: number } | null = null;
  let minDist = windowFrames + 1;

  for (const e of events) {
    if (e.action !== "click") continue;
    const ef = e.tsMs / (1000 / FPS);
    const dist = Math.abs(frame - ef);
    if (dist < minDist) {
      minDist = dist;
      nearestClick = { ef, x: e.x, y: e.y };
    }
  }

  if (!nearestClick) return { scale: 1, originX: "50%", originY: "50%" };

  const relF = frame - nearestClick.ef;
  let scale: number;

  if (relF < -12) {
    scale = 1;
  } else if (relF <= 0) {
    const t = ZOOM_EASE(Math.max(0, (relF + 12) / 12));
    scale = 1 + 0.08 * t;
  } else if (relF <= 24) {
    const t = ZOOM_EASE(relF / 24);
    scale = 1.08 - 0.08 * t;
  } else {
    scale = 1;
  }

  // Origin: click position mapped into content-area pixel space.
  const ox = (nearestClick.x / vpW) * CONTENT_W;
  const oy = (nearestClick.y / vpH) * CONTENT_H;

  return { scale, originX: `${ox}px`, originY: `${oy}px` };
}

// ---------------------------------------------------------------------------
// Traffic-light dots
// ---------------------------------------------------------------------------

const LIGHTS = [
  { color: "#ff5f57", shadow: "rgba(255,95,87,0.5)" },
  { color: "#febc2e", shadow: "rgba(254,188,46,0.5)" },
  { color: "#28c840", shadow: "rgba(40,200,64,0.5)"  },
];

function TrafficLights() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 7, paddingLeft: 14 }}>
      {LIGHTS.map((l, i) => (
        <div
          key={i}
          style={{
            width: 12,
            height: 12,
            borderRadius: "50%",
            background: l.color,
            boxShadow: `0 0 6px 1px ${l.shadow}`,
          }}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export const SceneDemo: React.FC<SceneDemoProps> = ({ cursorTrack }) => {
  const frame = useCurrentFrame();

  const fadeIn  = interpolate(frame, [0, 12],  [0, 1], { extrapolateRight: "clamp" });
  const fadeOut = interpolate(frame, [660, 675], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const opacity = Math.min(fadeIn, fadeOut);

  const { scale: zoomScale, originX: zoomOriginX, originY: zoomOriginY } = computeZoom(
    cursorTrack.events,
    frame,
    cursorTrack.viewport.width,
    cursorTrack.viewport.height,
  );

  // Version badge — fades in with the scene, stays visible throughout.
  const badgeOpacity = interpolate(frame, [12, 30], [0, 1], { extrapolateRight: "clamp" }) * Math.min(fadeIn, fadeOut);

  return (
    <AbsoluteFill style={{ backgroundColor: "#000", opacity }}>
      {/* Ambient glow */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: "radial-gradient(ellipse 80% 60% at 50% 50%, rgba(180,83,9,0.06) 0%, transparent 70%)",
        }}
      />

      {/* Mac-style browser window */}
      <div
        style={{
          position: "absolute",
          left: WIN_X,
          top: WIN_Y,
          width: WIN_W,
          height: WIN_H,
          borderRadius: 12,
          overflow: "hidden",
          boxShadow: "0 0 0 1px rgba(255,255,255,0.10), 0 40px 100px rgba(0,0,0,0.85)",
          background: theme.zinc800,
        }}
      >
        {/* Chrome / title bar */}
        <div
          style={{
            height: CHROME_H,
            background: "linear-gradient(180deg, #2e2e2e 0%, #262626 100%)",
            borderBottom: "1px solid rgba(255,255,255,0.08)",
            display: "flex",
            alignItems: "center",
            gap: 0,
            position: "relative",
          }}
        >
          <TrafficLights />

          {/* URL bar centred */}
          <div
            style={{
              position: "absolute",
              left: "50%",
              transform: "translateX(-50%)",
              display: "flex",
              alignItems: "center",
            }}
          >
            <div
              style={{
                background: "rgba(255,255,255,0.07)",
                borderRadius: 6,
                padding: "3px 14px",
                fontFamily: theme.mono,
                fontSize: 11,
                color: "rgba(255,255,255,0.35)",
                letterSpacing: "0.01em",
                whiteSpace: "nowrap",
              }}
            >
              agent-swarm.dev/people
            </div>
          </div>

          {/* Version badge — right side of chrome */}
          <div
            style={{
              position: "absolute",
              right: 14,
              display: "flex",
              alignItems: "center",
              gap: 5,
              opacity: badgeOpacity,
            }}
          >
            <div
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: theme.accentMid,
                boxShadow: `0 0 6px 1px ${theme.accentMid}`,
              }}
            />
            <span
              style={{
                fontFamily: theme.mono,
                fontSize: 10,
                color: theme.accentLight,
                letterSpacing: "0.06em",
              }}
            >
              v1.81.0
            </span>
          </div>
        </div>

        {/* Content area — video + cursor */}
        <div
          style={{
            width: CONTENT_W,
            height: CONTENT_H,
            overflow: "hidden",
            position: "relative",
            background: "#fff",
          }}
        >
          {/* Zoom wrapper */}
          <div
            style={{
              width: "100%",
              height: "100%",
              transform: `scale(${zoomScale})`,
              transformOrigin: `${zoomOriginX} ${zoomOriginY}`,
              position: "relative",
            }}
          >
            <Video
              src={staticFile("swarm-demo.mp4")}
              style={{ width: "100%", height: "100%", objectFit: "cover" }}
            />
            <Cursor
              track={cursorTrack}
              demoFrameCount={DEMO_FRAME_COUNT}
              demoStartFrame={90}
              containerW={CONTENT_W}
              containerH={CONTENT_H}
            />
          </div>
        </div>
      </div>

      {/* Lower-thirds — fire AFTER the event lands on screen */}
      <LowerThird frame={frame} />
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------------------
// Lower-thirds (beat captions)
// Timing calibrated to the People-tab recording beats.
// ---------------------------------------------------------------------------

const LOWER_THIRDS: Array<{ start: number; end: number; text: string }> = [
  { start: 30,  end: 130, text: "People tab — humans as first-class users" },
  { start: 160, end: 270, text: "Real identities, not just agent IDs"      },
  { start: 310, end: 420, text: "Linked identities across every system"    },
  { start: 460, end: 575, text: "Full activity timeline"                   },
];

function LowerThird({ frame }: { frame: number }) {
  const active = LOWER_THIRDS.find((l) => frame >= l.start && frame <= l.end);
  if (!active) return null;

  const t    = frame - active.start;
  const dur  = active.end - active.start;
  const fadeIn  = interpolate(t, [0, 10],       [0, 1], { extrapolateRight: "clamp" });
  const fadeOut = interpolate(t, [dur - 12, dur],[1, 0], { extrapolateRight: "clamp" });
  const slideX  = interpolate(t, [0, 12],       [-16, 0], { extrapolateRight: "clamp" });

  return (
    <div
      style={{
        position: "absolute",
        bottom: 58,
        left: WIN_X + 24,
        opacity: Math.min(fadeIn, fadeOut),
        transform: `translateX(${slideX}px)`,
        zIndex: 10,
      }}
    >
      <div
        style={{
          display: "inline-flex",
          flexDirection: "column",
          gap: 4,
          background: "rgba(9,9,11,0.90)",
          border: `1px solid rgba(180,83,9,0.40)`,
          borderRadius: 8,
          padding: "10px 22px",
          backdropFilter: "blur(10px)",
        }}
      >
        <div
          style={{
            fontFamily: theme.mono,
            fontSize: 13,
            fontWeight: 400,
            color: theme.accent,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
          }}
        >
          / step
        </div>
        <div
          style={{
            fontFamily: theme.sans,
            fontSize: 30,
            fontWeight: 600,
            color: "#ffffff",
            letterSpacing: "-0.02em",
            lineHeight: 1.15,
          }}
        >
          {active.text}
        </div>
      </div>
    </div>
  );
}
