import { useEffect, useState } from "react";
import { useMediaQuery } from "@/hooks/use-media-query";
import {
  nextRevealLength,
  REVEAL_MAX_LAG_MS,
  REVEAL_STEP_MS,
  revealStart,
} from "@/lib/reveal-text";

interface Reveal {
  text: string;
  animate: boolean;
  /** How many characters of `text` show. */
  shown: number;
  /** The `performance.now()` time by which all of `text` shows. */
  until: number;
}

/**
 * Fake streaming for polled text. While `live`, text that grows shows its
 * new part a few words at a time (a step every 30 ms), and it catches up
 * within about one poll (`REVEAL_MAX_LAG_MS`). Replaced text reveals after
 * the words it shares with the old text. `fresh` text (a message that a
 * poll brought in) reveals from the start.
 *
 * Text that is there when the hook mounts or when `live` turns on shows in
 * full at once. So does all text when `live` turns off (the task ended) and
 * under `prefers-reduced-motion`. Each step re-renders only the component
 * that calls the hook.
 */
export function useRevealText(text: string, live: boolean, fresh = false): string {
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)");
  const animate = live && !reduced;
  const [reveal, setReveal] = useState<Reveal>(() => ({
    text,
    animate,
    shown: fresh && animate ? 0 : text.length,
    until: performance.now() + REVEAL_MAX_LAG_MS,
  }));
  let current = reveal;
  if (reveal.text !== text || reveal.animate !== animate) {
    // Updated during render (React's pattern for state that follows a prop),
    // so the old text never paints for a frame. Only a change while the
    // reveal already runs animates.
    current = {
      text,
      animate,
      shown:
        animate && reveal.animate
          ? revealStart(reveal.text.slice(0, reveal.shown), text)
          : text.length,
      until: performance.now() + REVEAL_MAX_LAG_MS,
    };
    setReveal(current);
  }
  useEffect(() => {
    if (!reveal.animate || reveal.shown >= reveal.text.length) return;
    const timer = window.setTimeout(() => {
      setReveal((r) => ({
        ...r,
        shown: nextRevealLength(r.text, r.shown, r.until - performance.now()),
      }));
    }, REVEAL_STEP_MS);
    return () => window.clearTimeout(timer);
  }, [reveal]);
  return current.text.slice(0, current.shown);
}
