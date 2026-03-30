"use client";

import dynamic from "next/dynamic";

const MermaidRenderer = dynamic(
  () => import("./mermaid-renderer").then((mod) => mod.MermaidRenderer),
  { ssr: false }
);

export function MermaidDiagram({ chart }: { chart: string }) {
  return <MermaidRenderer chart={chart} />;
}
