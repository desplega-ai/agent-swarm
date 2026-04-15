import type { Metadata } from "next";
import { Navbar } from "@/components/navbar";
import { PricingSection } from "@/components/pricing-section";
import { Footer } from "@/components/footer";

export const metadata: Metadata = {
  title: "Pricing — Agent Swarm Cloud",
  description:
    "Simple, predictable pricing for Agent Swarm Cloud. Platform base at \u20AC9/mo plus \u20AC29/mo per worker. 7-day free trial included.",
  keywords: [
    "agent swarm pricing",
    "AI agent cloud pricing",
    "multi-agent orchestration cost",
    "Claude Code agent pricing",
    "AI coding agents subscription",
    "autonomous agents SaaS",
    "agent swarm cloud",
    "free trial AI agents",
  ],
  openGraph: {
    title: "Pricing — Agent Swarm Cloud",
    description:
      "Simple, predictable pricing for Agent Swarm Cloud. Platform base at \u20AC9/mo plus \u20AC29/mo per worker. 7-day free trial included.",
    url: "https://agent-swarm.dev/pricing",
    siteName: "Agent Swarm",
    type: "website",
    images: [
      {
        url: "https://agent-swarm.dev/api/og?title=Pricing+%E2%80%94+Agent+Swarm+Cloud&subtitle=%E2%82%AC9%2Fmo+platform+%2B+%E2%82%AC29%2Fmo+per+worker.+7-day+free+trial.+Self-host+for+free.",
        width: 1200,
        height: 630,
        alt: "Agent Swarm — Pricing",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Pricing — Agent Swarm Cloud",
    description:
      "Simple, predictable pricing for Agent Swarm Cloud. Platform base at \u20AC9/mo plus \u20AC29/mo per worker. 7-day free trial included.",
    images: [
      "https://agent-swarm.dev/api/og?title=Pricing+%E2%80%94+Agent+Swarm+Cloud&subtitle=%E2%82%AC9%2Fmo+platform+%2B+%E2%82%AC29%2Fmo+per+worker.+7-day+free+trial.+Self-host+for+free.",
    ],
  },
  alternates: {
    canonical: "/pricing",
  },
};

export default function PricingPage() {
  return (
    <main>
      <Navbar />
      {/* Spacer for fixed navbar */}
      <div className="h-20" />
      <h1 className="sr-only">Pricing — Agent Swarm Cloud</h1>
      <PricingSection />
      <Footer />

      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "Product",
            name: "Agent Swarm Cloud",
            description:
              "Managed multi-agent orchestration platform. Run a team of AI coding agents that coordinate autonomously with Docker-isolated workers and persistent memory.",
            url: "https://agent-swarm.dev/pricing",
            brand: {
              "@type": "Organization",
              name: "Agent Swarm",
              url: "https://agent-swarm.dev",
            },
            offers: [
              {
                "@type": "Offer",
                name: "Platform",
                description: "Base infrastructure: dashboard, orchestration, integrations, memory",
                price: "9.00",
                priceCurrency: "EUR",
                priceValidUntil: "2027-12-31",
                availability: "https://schema.org/InStock",
                url: "https://cloud.agent-swarm.dev",
              },
              {
                "@type": "Offer",
                name: "Worker Compute",
                description:
                  "Docker-isolated agent worker with managed infrastructure, per worker",
                price: "29.00",
                priceCurrency: "EUR",
                priceValidUntil: "2027-12-31",
                availability: "https://schema.org/InStock",
                url: "https://cloud.agent-swarm.dev",
              },
            ],
          }),
        }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "FAQPage",
            mainEntity: [
              {
                "@type": "Question",
                name: "What's included in the platform fee?",
                acceptedAnswer: {
                  "@type": "Answer",
                  text: "The platform fee covers the API server, dashboard UI, lead agent orchestration, task scheduling, persistent memory, Slack and GitHub integrations, and the full MCP tool ecosystem. It's the base infrastructure that coordinates your entire swarm.",
                },
              },
              {
                "@type": "Question",
                name: "How do workers scale?",
                acceptedAnswer: {
                  "@type": "Answer",
                  text: "Each worker runs in its own Docker container with full workspace isolation. Add workers on demand -- each one costs a flat \u20AC29/mo. Workers can use any LLM provider with your own API keys, so you control both capacity and cost.",
                },
              },
              {
                "@type": "Question",
                name: "Is there a free trial?",
                acceptedAnswer: {
                  "@type": "Answer",
                  text: "Yes. Every new account gets a 7-day free trial with full access to all features, including one worker. No credit card required to start.",
                },
              },
              {
                "@type": "Question",
                name: "What happens after the trial?",
                acceptedAnswer: {
                  "@type": "Answer",
                  text: "After your trial ends, you can subscribe to continue. If you don't, your swarm pauses -- no data is deleted. You can reactivate at any time and pick up right where you left off.",
                },
              },
              {
                "@type": "Question",
                name: "Can I self-host instead?",
                acceptedAnswer: {
                  "@type": "Answer",
                  text: "Absolutely. Agent Swarm is fully open source under the MIT license. You can self-host on any infrastructure -- your own servers, air-gapped environments, or any cloud provider. Cloud is for teams that want managed infrastructure without the ops overhead.",
                },
              },
              {
                "@type": "Question",
                name: "What LLMs are supported?",
                acceptedAnswer: {
                  "@type": "Answer",
                  text: "Agent Swarm is LLM-agnostic. Workers support Claude (via Anthropic or AWS Bedrock), OpenAI, Gemini, and any OpenRouter-compatible model. Bring your own API keys -- there's no vendor lock-in.",
                },
              },
            ],
          }),
        }}
      />
    </main>
  );
}
