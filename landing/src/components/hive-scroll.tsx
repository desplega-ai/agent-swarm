"use client";

import { useEffect, useRef, useState } from "react";
import { Hive } from "@/components/hive";

export function HiveScroll() {
  const [progress, setProgress] = useState(0);
  const reduceRef = useRef(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    reduceRef.current = mq.matches;
    const onMotion = () => {
      reduceRef.current = mq.matches;
      if (mq.matches) setProgress(0);
    };
    mq.addEventListener("change", onMotion);

    let raf = 0;
    let queued = false;
    const update = () => {
      queued = false;
      if (reduceRef.current) {
        setProgress(0);
        return;
      }
      const y = window.scrollY;
      const h = window.innerHeight || 1;
      setProgress(Math.max(0, Math.min(1, y / h)));
    };
    const onScroll = () => {
      if (queued) return;
      queued = true;
      raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      mq.removeEventListener("change", onMotion);
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, []);

  // Eased progress: cubic ease-out so it feels heavier near the top, smoother as it grows.
  const eased = 1 - Math.pow(1 - progress, 3);

  const scale = 1 + eased * 1.6; // 1x → 2.6x
  const rotateX = eased * 38; // tilt back into screen
  const rotateZ = progress * -6; // small clockwise yaw to feel alive
  const translateZ = eased * 220;
  const translateY = eased * -40;
  // Fade OUT as it scales up — masks rasterization artifacts at large sizes.
  const opacity = 0.28 * (1 - eased * 0.85);
  // Aggressive blur ramps up with scale to soften any pixel-level edges.
  const blur = eased * 4;

  return (
    <div
      aria-hidden="true"
      className="absolute inset-x-0 top-[6%] flex items-center justify-center pointer-events-none"
      style={{ perspective: "1400px", perspectiveOrigin: "50% 30%" }}
    >
      <div
        style={{
          opacity,
          filter: `drop-shadow(0 0 80px oklch(0.769 0.188 70.08 / 0.45)) blur(${blur}px)`,
          transform: `translateY(${translateY}px) translateZ(${translateZ}px) rotateX(${rotateX}deg) rotateZ(${rotateZ}deg) scale(${scale})`,
          transformStyle: "preserve-3d",
          transformOrigin: "50% 35%",
          willChange: "transform, opacity",
          maskImage:
            "radial-gradient(circle at 50% 50%, black 18%, rgba(0,0,0,0.65) 42%, transparent 78%)",
          WebkitMaskImage:
            "radial-gradient(circle at 50% 50%, black 18%, rgba(0,0,0,0.65) 42%, transparent 78%)",
        }}
      >
        <Hive size={1100} density="dense" labels={false} tone="darkBold" connectors={false} />
      </div>
    </div>
  );
}
