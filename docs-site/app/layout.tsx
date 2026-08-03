import { RootProvider } from "fumadocs-ui/provider/next";
import type { ReactNode } from "react";
import type { Metadata } from "next";
import "./globals.css";

const docsOgImage =
  "https://www.agent-swarm.dev/api/og?title=agent-swarm.dev+Documentation&subtitle=Reference+guides%2C+architecture%2C+and+operating+manuals+for+multi-agent+AI+coding+agent+swarms.";

export const metadata: Metadata = {
  title: {
    default: "agent-swarm.dev Documentation",
    template: "%s | agent-swarm.dev",
  },
  description:
    "agent-swarm.dev documentation for multi-agent orchestration, Claude Code, Codex, Gemini CLI, MCP tools, workflows, memory, and AI coding agent teams.",
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
  manifest: "/manifest.json",
  icons: {
    icon: "/favicon.ico",
    apple: "/apple-touch-icon.png",
  },
  metadataBase: new URL("https://docs.agent-swarm.dev"),
  alternates: {
    canonical: "https://docs.agent-swarm.dev/docs",
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
    },
  },
  openGraph: {
    title: "agent-swarm.dev Documentation",
    description:
      "agent-swarm.dev docs for multi-agent orchestration, harness configuration, workflows, memory, MCP tools, and AI coding agent teams.",
    url: "https://docs.agent-swarm.dev/docs",
    siteName: "agent-swarm.dev Docs",
    type: "website",
    locale: "en_US",
    images: [
      {
        url: docsOgImage,
        width: 1200,
        height: 630,
        alt: "agent-swarm.dev Documentation",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    site: "@desplegalabs",
    creator: "@desplegalabs",
    title: "agent-swarm.dev Documentation",
    description:
      "agent-swarm.dev docs for multi-agent orchestration, harness configuration, workflows, memory, MCP tools, and AI coding agent teams.",
    images: [docsOgImage],
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
                  "@id": "https://www.agent-swarm.dev/#organization",
                  name: "Desplega Labs",
                  alternateName: "agent-swarm.dev",
                  url: "https://www.agent-swarm.dev",
                  logo: {
                    "@type": "ImageObject",
                    url: "https://agent-swarm.dev/logo.png",
                  },
                },
                {
                  "@type": "WebSite",
                  "@id": "https://docs.agent-swarm.dev/#website",
                  url: "https://docs.agent-swarm.dev/docs",
                  name: "agent-swarm.dev Documentation",
                  publisher: {
                    "@id": "https://www.agent-swarm.dev/#organization",
                  },
                },
                {
                  "@type": "TechArticle",
                  name: "agent-swarm.dev Documentation",
                  description:
                    "agent-swarm.dev documentation for multi-agent orchestration, harness configuration, workflows, memory, MCP tools, and AI coding agent teams.",
                  url: "https://docs.agent-swarm.dev",
                  image: docsOgImage,
                  mainEntity: {
                    "@type": "SoftwareApplication",
                    "@id": "https://www.agent-swarm.dev/#software",
                    name: "agent-swarm.dev",
                    applicationCategory: "DeveloperApplication",
                    operatingSystem: "Linux, macOS",
                  },
                },
              ],
            }),
          }}
        />
        <script async src="https://plausible.io/js/pa-N5qqdwlGhd8el6aPC8pJ7.js" />
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
