"use client";

import { Suspense, use, useEffect, useId, useState } from "react";
import { useTheme } from "next-themes";

/**
 * `title` is the text alternative for the diagram: one sentence that says what the
 * flow shows, since screen readers cannot read the rendered SVG.
 */
export function Mermaid({ chart, title }: { chart: string; title: string }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const minHeight = placeholderHeight(chart);
  if (!mounted) return <DiagramFrame title={title} loading minHeight={minHeight} />;
  return (
    <Suspense fallback={<DiagramFrame title={title} loading minHeight={minHeight} />}>
      <MermaidContent chart={chart} title={title} />
    </Suspense>
  );
}

/**
 * Height to reserve while a diagram loads. The 15 diagrams on the site render 60-270px
 * tall (median ~190px) when laid out left to right, and much taller top to bottom, so a
 * rough per-direction guess keeps the page below from jumping far.
 */
function placeholderHeight(chart: string): string {
  return /^\s*(flowchart|graph)\s+(TB|TD)\b/.test(chart) ? "min-h-[40rem]" : "min-h-48";
}

/** Text alternative on the wrapper, diagram inside. Shows a pulsing box while loading. */
function DiagramFrame({
  title,
  loading,
  svg,
  bindFunctions,
  minHeight,
}: {
  title: string;
  loading?: boolean;
  minHeight?: string;
  svg?: string;
  bindFunctions?: (element: Element) => void;
}) {
  return (
    <div
      role="img"
      aria-label={title}
      aria-busy={loading || undefined}
      className={
        loading ? `my-6 ${minHeight} animate-pulse rounded-xl bg-fd-secondary/60` : undefined
      }
      ref={(container) => {
        if (container) bindFunctions?.(container);
      }}
      dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
    />
  );
}

const cache = new Map<string, Promise<unknown>>();

function cachePromise<T>(key: string, setPromise: () => Promise<T>): Promise<T> {
  const cached = cache.get(key);
  if (cached) return cached as Promise<T>;

  const promise = setPromise();
  cache.set(key, promise);
  return promise;
}

function MermaidContent({ chart, title }: { chart: string; title: string }) {
  const id = useId();
  const { resolvedTheme } = useTheme();
  const { default: mermaid } = use(cachePromise("mermaid", () => import("mermaid")));

  // `initialize` is global and the theme is part of it, so it runs once per (chart, theme)
  // render instead of on every React render.
  const { svg, bindFunctions } = use(
    cachePromise(`${chart}-${resolvedTheme}`, () => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "loose",
        fontFamily: "inherit",
        themeCSS: "margin: 1.5rem auto 0;",
        theme: resolvedTheme === "dark" ? "dark" : "default",
      });
      return mermaid.render(id, chart.replaceAll("\\n", "\n"));
    }),
  );

  return <DiagramFrame title={title} svg={svg} bindFunctions={bindFunctions} />;
}
