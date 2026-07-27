import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from "remotion";
import { color, font, motion } from "../theme";

export type BrandCardProps = {
  eyebrow: string;
  title: string;
  body: string;
};

// Minimal, on-brand example. Every visual choice traces back to a token in
// theme.ts: navy surface, cyan eyebrow signal, IBM Plex type, and a staggered
// eased entrance. Duplicate this file and swap the content to make a new video.
const ease = Easing.bezier(...motion.easing);

// Staggered slide-up + fade. Element `index` starts `index * motion.stagger`
// frames after the one before it, then eases in over 20 frames.
const entrance = (frame: number, index: number) => {
  const start = index * motion.stagger;
  const progress = interpolate(frame, [start, start + 20], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: ease,
  });
  return {
    opacity: progress,
    transform: `translateY(${(1 - progress) * motion.rise}px)`,
  };
};

export const BrandCard: React.FC<BrandCardProps> = ({ eyebrow, title, body }) => {
  const frame = useCurrentFrame();

  return (
    <AbsoluteFill
      style={{
        backgroundColor: color.navy,
        justifyContent: "center",
        padding: "0 160px",
      }}
    >
      <div style={{ maxWidth: 1200 }}>
        {/* Eyebrow — IBM Plex Mono, SemiBold, ALL CAPS, looser tracking, cyan. */}
        <div
          style={{
            ...entrance(frame, 0),
            fontFamily: font.mono,
            fontWeight: font.weight.semibold,
            fontSize: 28,
            letterSpacing: 28 * font.tracking.eyebrow,
            textTransform: "uppercase",
            color: color.cyan,
            marginBottom: 28,
          }}
        >
          {eyebrow}
        </div>

        {/* Cyan signal rule — a single hairline, never a fill. */}
        <div
          style={{
            ...entrance(frame, 1),
            width: 96,
            height: 3,
            backgroundColor: color.cyan,
            marginBottom: 40,
          }}
        />

        {/* Title — IBM Plex Sans Light, slightly tighter kerning, white on navy. */}
        <div
          style={{
            ...entrance(frame, 2),
            fontFamily: font.sans,
            fontWeight: font.weight.light,
            fontSize: 96,
            lineHeight: 1.05,
            letterSpacing: 96 * font.tracking.title,
            color: color.white,
            marginBottom: 36,
          }}
        >
          {title}
        </div>

        {/* Body — IBM Plex Sans Regular, default tracking, white-on-navy at 85%. */}
        {(() => {
          const anim = entrance(frame, 3);
          return (
            <div
              style={{
                ...anim,
                // Fade in, but settle at 85% for a muted-on-dark body tone.
                opacity: anim.opacity * 0.85,
                fontFamily: font.sans,
                fontWeight: font.weight.regular,
                fontSize: 36,
                lineHeight: 1.4,
                color: color.white,
              }}
            >
              {body}
            </div>
          );
        })()}
      </div>
    </AbsoluteFill>
  );
};
