"use client";

import { useEffect, useRef, useState } from "react";

export function MermaidRenderer({ chart }: { chart: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string>("");

  useEffect(() => {
    let cancelled = false;

    async function render() {
      const mermaid = (await import("mermaid")).default;
      mermaid.initialize({
        startOnLoad: false,
        theme: "neutral",
        fontFamily: "ui-monospace, monospace",
        flowchart: { curve: "basis" },
      });

      const id = `mermaid-${Math.random().toString(36).slice(2, 9)}`;
      const { svg: renderedSvg } = await mermaid.render(id, chart);
      if (!cancelled) {
        setSvg(renderedSvg);
      }
    }

    render();
    return () => {
      cancelled = true;
    };
  }, [chart]);

  return (
    <div
      ref={containerRef}
      className="my-6 rounded-xl bg-zinc-50 border border-zinc-200 p-5 overflow-x-auto flex justify-center [&_svg]:max-w-full"
      dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
    />
  );
}
