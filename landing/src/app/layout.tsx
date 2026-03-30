import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agent Swarm — Multi-Agent Orchestration for AI Coding Assistants",
  description:
    "Run a team of AI coding agents that coordinate autonomously. Start your 7-day free trial on Agent Swarm Cloud, or self-host for free. Open source, MCP-powered.",
  keywords: [
    "agent swarm",
    "agent swarm cloud",
    "multi-agent",
    "AI coding assistants",
    "claude code",
    "MCP",
    "orchestration",
    "autonomous agents",
    "AI agents",
    "open source",
    "developer tools",
    "free trial",
    "pricing",
    "managed agents",
  ],
  icons: {
    icon: "/favicon.ico",
    apple: "/apple-touch-icon.png",
  },
  openGraph: {
    title: "Agent Swarm — Multi-Agent Orchestration for AI Coding Assistants",
    description:
      "Run a team of AI coding agents that coordinate autonomously. Start your 7-day free trial on Agent Swarm Cloud, or self-host for free. Open source, MCP-powered.",
    url: "https://agent-swarm.dev",
    siteName: "Agent Swarm",
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
    site: "@desplegalabs",
    creator: "@desplegalabs",
    title: "Agent Swarm — Multi-Agent Orchestration for AI Coding Assistants",
    description:
      "Run a team of AI coding agents that coordinate autonomously. Start your 7-day free trial on Agent Swarm Cloud, or self-host for free. Open source, MCP-powered.",
    images: ["https://agent-swarm.dev/og-image.png"],
  },
  metadataBase: new URL("https://agent-swarm.dev"),
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
    },
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300..700&family=Space+Mono:ital,wght@0,400;0,700;1,400;1,700&display=swap"
          rel="stylesheet"
        />
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
                  sameAs: ["https://github.com/desplega-ai/agent-swarm"],
                },
                {
                  "@type": "WebSite",
                  "@id": "https://agent-swarm.dev/#website",
                  url: "https://agent-swarm.dev",
                  name: "Agent Swarm",
                  publisher: {
                    "@id": "https://agent-swarm.dev/#organization",
                  },
                },
                {
                  "@type": "SoftwareApplication",
                  name: "Agent Swarm",
                  applicationCategory: "DeveloperApplication",
                  operatingSystem: "Linux, macOS",
                  description:
                    "Open-source multi-agent orchestration for AI coding assistants. A lead agent delegates tasks to Docker-isolated workers with persistent memory.",
                  url: "https://cloud.agent-swarm.dev",
                  offers: [
                    {
                      "@type": "Offer",
                      name: "Open Source (Self-Hosted)",
                      price: "0",
                      priceCurrency: "EUR",
                    },
                    {
                      "@type": "Offer",
                      name: "Agent Swarm Cloud - Platform",
                      price: "9",
                      priceCurrency: "EUR",
                      priceValidUntil: "2027-12-31",
                      availability: "https://schema.org/InStock",
                    },
                    {
                      "@type": "Offer",
                      name: "Agent Swarm Cloud - Worker",
                      price: "29",
                      priceCurrency: "EUR",
                      priceValidUntil: "2027-12-31",
                      availability: "https://schema.org/InStock",
                    },
                  ],
                  license: "https://opensource.org/licenses/MIT",
                  codeRepository: "https://github.com/desplega-ai/agent-swarm",
                },
              ],
            }),
          }}
        />
        <script async src="https://plausible.io/js/pa-TeCPVGp2RFHbVWD8FlfFb.js" />
        <script
          dangerouslySetInnerHTML={{
            __html: `window.plausible=window.plausible||function(){(plausible.q=plausible.q||[]).push(arguments)},plausible.init=plausible.init||function(i){plausible.o=i||{}};plausible.init()`,
          }}
        />
      </head>
      <body className="antialiased">{children}</body>
    </html>
  );
}
