import { RootProvider } from "fumadocs-ui/provider/next";
import type { ReactNode } from "react";
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Agent Swarm",
    template: "%s | Agent Swarm",
  },
  description:
    "Multi-agent orchestration for Claude Code, Codex, Gemini CLI, and other AI coding assistants.",
  keywords: [
    "agent swarm",
    "documentation",
    "multi-agent orchestration",
    "claude code",
    "codex",
    "gemini cli",
    "AI coding",
    "MCP tools",
    "task lifecycle",
    "developer tools",
  ],
  metadataBase: new URL("https://docs.agent-swarm.dev"),
  openGraph: {
    title: "Agent Swarm Documentation",
    description:
      "Multi-agent orchestration for Claude Code, Codex, Gemini CLI, and other AI coding assistants.",
    url: "https://docs.agent-swarm.dev",
    siteName: "Agent Swarm Docs",
    type: "website",
    locale: "en_US",
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
    title: "Agent Swarm Documentation",
    description:
      "Multi-agent orchestration for Claude Code, Codex, Gemini CLI, and other AI coding assistants.",
    images: ["https://agent-swarm.dev/og-image.png"],
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@graph": [
                {
                  "@type": "Organization",
                  "@id": "https://agent-swarm.dev/#organization",
                  name: "Agent Swarm",
                  url: "https://agent-swarm.dev",
                  logo: {
                    "@type": "ImageObject",
                    url: "https://agent-swarm.dev/logo.png",
                  },
                },
                {
                  "@type": "WebSite",
                  "@id": "https://docs.agent-swarm.dev/#website",
                  url: "https://docs.agent-swarm.dev",
                  name: "Agent Swarm Documentation",
                  publisher: {
                    "@id": "https://agent-swarm.dev/#organization",
                  },
                },
                {
                  "@type": "TechArticle",
                  name: "Agent Swarm Documentation",
                  description:
                    "Multi-agent orchestration for Claude Code, Codex, Gemini CLI, and other AI coding assistants.",
                  url: "https://docs.agent-swarm.dev",
                  mainEntity: {
                    "@type": "SoftwareApplication",
                    name: "Agent Swarm",
                    applicationCategory: "DeveloperApplication",
                    operatingSystem: "Linux, macOS",
                  },
                },
              ],
            }),
          }}
        />
        <script
          async
          src="https://plausible.io/js/pa-N5qqdwlGhd8el6aPC8pJ7.js"
        />
        <script
          dangerouslySetInnerHTML={{
            __html: `window.plausible=window.plausible||function(){(plausible.q=plausible.q||[]).push(arguments)},plausible.init=plausible.init||function(i){plausible.o=i||{}};plausible.init()`,
          }}
        />
      </head>
      <body
        style={{
          display: "flex",
          flexDirection: "column",
          minHeight: "100vh",
        }}
      >
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
