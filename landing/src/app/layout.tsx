import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agent Swarm — Autonomous Multi-Agent Orchestration",
  description:
    "Coordinate autonomous AI agents that learn, remember, and compound intelligence across sessions. Built by desplega.sh.",
  openGraph: {
    title: "Agent Swarm — Autonomous Multi-Agent Orchestration",
    description:
      "Coordinate autonomous AI agents that learn, remember, and compound intelligence across sessions.",
    url: "https://agent-swarm.dev",
    siteName: "Agent Swarm",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Agent Swarm — Autonomous Multi-Agent Orchestration",
    description:
      "Coordinate autonomous AI agents that learn, remember, and compound intelligence across sessions.",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300..700&family=Space+Mono:ital,wght@0,400;0,700;1,400;1,700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="antialiased">{children}</body>
    </html>
  );
}
