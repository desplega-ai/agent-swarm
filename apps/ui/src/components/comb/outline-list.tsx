import { useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { activeHeadingIndex, type OutlineHeading } from "@/lib/comb/outline";
import { DIFF_PARAM } from "@/lib/comb/review";
import { cn } from "@/lib/utils";
import { useCombLayout } from "./comb-layout";

const HEADING_SELECTOR = ":is(h1,h2,h3,h4,h5,h6)[data-line-start]";
const NO_HEADINGS: readonly OutlineHeading[] = [];

/** The rendered headings of the viewer, by source line. */
function headingElements(viewer: HTMLElement | null): Map<number, HTMLElement> {
  const byLine = new Map<number, HTMLElement>();
  for (const element of viewer?.querySelectorAll<HTMLElement>(HEADING_SELECTOR) ?? []) {
    const line = Number(element.dataset.lineStart);
    if (!byLine.has(line)) byLine.set(line, element);
  }
  return byLine;
}

/** The nearest ancestor that scrolls: the viewer pane from `lg` up, the page below it. */
function scrollParent(element: HTMLElement): HTMLElement {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) {
      return node;
    }
  }
  return document.scrollingElement as HTMLElement;
}

/**
 * Scroll spy: the heading the reader is in. Measures on scroll (any scroll
 * container, one frame at a time), on resize, and when the viewer's DOM
 * changes (the file renders, a new version loads).
 */
function useActiveHeading(viewer: HTMLElement | null, headings: readonly OutlineHeading[]) {
  const [active, setActive] = useState(-1);
  useEffect(() => {
    if (!viewer || headings.length === 0) return;
    let elements = headingElements(viewer);
    let frame = 0;
    const measure = () => {
      frame = 0;
      const first = elements.values().next().value;
      if (!first) {
        setActive(-1);
        return;
      }
      const container = scrollParent(first);
      const box = container.getBoundingClientRect();
      const top = Math.max(box.top, 0);
      const height = Math.min(box.bottom, window.innerHeight) - top;
      const tops = headings.map((heading) => {
        const element = elements.get(heading.line);
        return element ? element.getBoundingClientRect().top - top : null;
      });
      const atEnd = container.scrollTop + container.clientHeight >= container.scrollHeight - 2;
      setActive(activeHeadingIndex(tops, { threshold: Math.min(96, height / 4), height, atEnd }));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    const observer = new MutationObserver(() => {
      elements = headingElements(viewer);
      schedule();
    });
    observer.observe(viewer, { childList: true, subtree: true });
    document.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      observer.disconnect();
      document.removeEventListener("scroll", schedule, { capture: true });
      window.removeEventListener("resize", schedule);
      cancelAnimationFrame(frame);
    };
  }, [viewer, headings]);
  return active;
}

/**
 * The Outline tab: the file's h1 to h4 headings, indented by level. A click
 * scrolls the viewer to the heading (smooth unless reduced motion). During a
 * review (`?diff=`), a click closes the review first.
 */
export function OutlineList({ onNavigate }: { onNavigate?: () => void }) {
  const layout = useCombLayout();
  const viewer = layout?.viewer ?? null;
  const headings = layout?.headings ?? NO_HEADINGS;
  const active = useActiveHeading(viewer, headings);
  const reduceMotion = useReducedMotion() ?? false;
  const [searchParams, setSearchParams] = useSearchParams();
  // A heading to scroll to once the file shows again (after the review closes).
  const [pendingLine, setPendingLine] = useState<number | null>(null);
  // The clicked heading stays active until the person scrolls by hand: a
  // heading near the end of the file cannot reach the top of the pane.
  const [picked, setPicked] = useState<number | null>(null);
  useEffect(() => {
    if (picked === null || !viewer) return;
    const clear = () => setPicked(null);
    const userEvents = ["wheel", "touchstart", "keydown", "pointerdown"] as const;
    for (const type of userEvents) viewer.addEventListener(type, clear, { passive: true });
    return () => {
      for (const type of userEvents) viewer.removeEventListener(type, clear);
    };
  }, [picked, viewer]);
  // A new version can move the headings.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on a new outline
  useEffect(() => setPicked(null), [headings]);

  const scrollTo = (line: number) => {
    headingElements(viewer)
      .get(line)
      ?.scrollIntoView({ block: "start", behavior: reduceMotion ? "auto" : "smooth" });
  };

  // After the review closes, the file renders again: scroll to the heading as
  // soon as it exists, and keep it in place while images above it load. The
  // person's own scroll (wheel, touch, a key) or 2 s end it.
  useEffect(() => {
    if (pendingLine === null || !viewer) return;
    const place = () => {
      headingElements(viewer).get(pendingLine)?.scrollIntoView({ block: "start" });
    };
    const stop = () => setPendingLine(null);
    const observer = new MutationObserver(place);
    observer.observe(viewer, { childList: true, subtree: true });
    // An image load does not bubble, so listen in the capture phase.
    viewer.addEventListener("load", place, true);
    const userEvents = ["wheel", "touchstart", "keydown"] as const;
    for (const type of userEvents) viewer.addEventListener(type, stop, { passive: true });
    const timeout = setTimeout(stop, 2000);
    place();
    return () => {
      observer.disconnect();
      viewer.removeEventListener("load", place, true);
      for (const type of userEvents) viewer.removeEventListener(type, stop);
      clearTimeout(timeout);
    };
  }, [pendingLine, viewer]);

  const go = (heading: OutlineHeading, index: number) => {
    setPicked(index);
    if (searchParams.has(DIFF_PARAM)) {
      setSearchParams((params) => {
        const next = new URLSearchParams(params);
        next.delete(DIFF_PARAM);
        return next;
      });
      setPendingLine(heading.line);
    } else {
      scrollTo(heading.line);
    }
    onNavigate?.();
  };

  if (headings.length === 0) return null;
  const minLevel = Math.min(...headings.map((heading) => heading.level));
  const current = picked ?? active;

  return (
    <nav aria-label="Outline" className="p-1.5">
      <ul className="flex flex-col gap-px text-sm">
        {headings.map((heading, index) => (
          <li key={heading.line}>
            <button
              type="button"
              onClick={() => go(heading, index)}
              aria-current={index === current ? "location" : undefined}
              // No color transition: the scroll spy moves the highlight, and a
              // data change never animates. One weight, so no row rewraps.
              className={cn(
                "flex w-full rounded-md py-1 pr-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                index === current
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
              style={{ paddingLeft: `${0.5 + (heading.level - minLevel) * 0.75}rem` }}
            >
              <span className="line-clamp-2">{heading.text}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
