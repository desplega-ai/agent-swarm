import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agent Swarm — Coordination intelligence for AI coding agents.",
  description:
    "A lead delegates, workers ship in Docker, memory compounds across sessions. Run Devin, Claude Code, or any coding agent as a coordinated team. Start your 7-day free trial, or self-host for free.",
  keywords: [
    "agent swarm",
    "agent swarm cloud",
    "coordination intelligence",
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
    title: "Agent Swarm — Coordination intelligence for AI coding agents.",
    description:
      "A lead delegates, workers ship in Docker, memory compounds across sessions. Run Devin, Claude Code, or any coding agent as a coordinated team.",
    url: "https://agent-swarm.dev",
    siteName: "Agent Swarm",
    type: "website",
    locale: "en_US",
    images: [
      {
        url: "https://agent-swarm.dev/api/og?title=Agent+Swarm+%E2%80%94+Coordination+intelligence+for+AI+coding+agents.&subtitle=A+lead+delegates%2C+workers+ship+in+Docker%2C+memory+compounds+across+sessions.",
        width: 1200,
        height: 630,
        alt: "Agent Swarm — Coordination intelligence for AI coding agents.",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    site: "@desplegalabs",
    creator: "@desplegalabs",
    title: "Agent Swarm — Coordination intelligence for AI coding agents.",
    description:
      "A lead delegates, workers ship in Docker, memory compounds across sessions. Run Devin, Claude Code, or any coding agent as a coordinated team.",
    images: [
      "https://agent-swarm.dev/api/og?title=Agent+Swarm+%E2%80%94+Coordination+intelligence+for+AI+coding+agents.&subtitle=A+lead+delegates%2C+workers+ship+in+Docker%2C+memory+compounds+across+sessions.",
    ],
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
                  name: "Desplega Labs",
                  alternateName: "Agent Swarm",
                  url: "https://agent-swarm.dev",
                  logo: {
                    "@type": "ImageObject",
                    url: "https://agent-swarm.dev/logo.png",
                    width: 512,
                    height: 512,
                  },
                  sameAs: [
                    "https://github.com/desplega-ai",
                    "https://twitter.com/desplegalabs",
                    "https://www.linkedin.com/company/desplega-labs",
                  ],
                  description:
                    "Coordination intelligence for AI coding agents. Open source, self-hostable, MIT-licensed.",
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
                    "Open-source coordination intelligence for AI coding agents. A lead agent delegates tasks to Docker-isolated workers with persistent memory.",
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
                      name: "Agent Swarm Cloud — 4 workers",
                      price: "30",
                      priceCurrency: "EUR",
                      priceValidUntil: "2027-12-31",
                      availability: "https://schema.org/InStock",
                    },
                    {
                      "@type": "Offer",
                      name: "Agent Swarm Cloud — 16 workers",
                      price: "100",
                      priceCurrency: "EUR",
                      priceValidUntil: "2027-12-31",
                      availability: "https://schema.org/InStock",
                    },
                  ],
                  license: "https://opensource.org/licenses/MIT",
                  codeRepository: "https://github.com/desplega-ai/agent-swarm",
                },
                {
                  "@type": "Product",
                  "@id": "https://agent-swarm.dev/#product",
                  name: "Agent Swarm",
                  description:
                    "Coordination intelligence for AI coding agents. A lead delegates, workers ship in Docker, memory compounds across sessions.",
                  brand: { "@id": "https://agent-swarm.dev/#organization" },
                  category: "DeveloperTools",
                  image: "https://agent-swarm.dev/og.png",
                  offers: [
                    {
                      "@type": "Offer",
                      name: "Self-hosted (MIT)",
                      price: "0",
                      priceCurrency: "EUR",
                      availability: "https://schema.org/InStock",
                      url: "https://github.com/desplega-ai/agent-swarm",
                    },
                    {
                      "@type": "Offer",
                      name: "Cloud — 4 workers (Monthly)",
                      price: "30",
                      priceCurrency: "EUR",
                      priceSpecification: {
                        "@type": "UnitPriceSpecification",
                        price: "30",
                        priceCurrency: "EUR",
                        billingDuration: "P1M",
                      },
                      availability: "https://schema.org/InStock",
                      url: "https://cloud.agent-swarm.dev",
                    },
                    {
                      "@type": "Offer",
                      name: "Cloud — 16 workers (Monthly)",
                      price: "100",
                      priceCurrency: "EUR",
                      priceSpecification: {
                        "@type": "UnitPriceSpecification",
                        price: "100",
                        priceCurrency: "EUR",
                        billingDuration: "P1M",
                      },
                      availability: "https://schema.org/InStock",
                      url: "https://cloud.agent-swarm.dev",
                    },
                    {
                      "@type": "Offer",
                      name: "Enterprise",
                      url: "https://calendar.app.google/49DmjEXTPAv5NsRq6",
                      availability: "https://schema.org/InStock",
                    },
                  ],
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
