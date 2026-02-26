import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agent Swarm — Multi-Agent Orchestration for AI Coding Assistants",
  description:
    "Run a team of AI coding agents that coordinate autonomously. A lead agent delegates tasks to Docker-isolated workers with persistent memory. Open source, MCP-powered.",
  icons: {
    icon: "/favicon.ico",
    apple: "/apple-touch-icon.png",
  },
  openGraph: {
    title: "Agent Swarm — Multi-Agent Orchestration for AI Coding Assistants",
    description:
      "Run a team of AI coding agents that coordinate autonomously. A lead agent delegates tasks to Docker-isolated workers with persistent memory.",
    url: "https://agent-swarm.dev",
    siteName: "Agent Swarm",
    type: "website",
    images: [
      {
        url: "https://agent-swarm.dev/og-image.png",
        width: 1200,
        height: 630,
        alt: "Agent Swarm",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Agent Swarm — Multi-Agent Orchestration for AI Coding Assistants",
    description:
      "Run a team of AI coding agents that coordinate autonomously. A lead agent delegates tasks to Docker-isolated workers with persistent memory.",
    images: ["https://agent-swarm.dev/og-image.png"],
  },
  metadataBase: new URL("https://agent-swarm.dev"),
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
