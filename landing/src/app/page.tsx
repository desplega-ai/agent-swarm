import type { Metadata } from "next";
import { Navbar } from "@/components/navbar";
import { Hero } from "@/components/hero";
import { Features } from "@/components/features";
import { HowItWorks } from "@/components/how-it-works";
import { Workshops } from "@/components/workshops";
import { PricingSection } from "@/components/pricing-section";
import { CTA } from "@/components/cta";
import { Footer } from "@/components/footer";

export const metadata: Metadata = {
  keywords: [
    "agent swarm",
    "agent swarm cloud",
    "multi-agent AI",
    "AI agent orchestration",
    "Claude Code agents",
    "autonomous AI agents",
    "MCP orchestration platform",
    "multi-agent framework",
    "AI coding assistant orchestration",
    "agent swarm open source",
    "AI coding automation",
    "multi-agent system",
  ],
  alternates: {
    canonical: "/",
  },
};

export default function Home() {
  return (
    <main>
      <Navbar />
      <Hero />
      <Features />
      <HowItWorks />
      <Workshops />
      <PricingSection compact />
      <CTA />
      <Footer />
    </main>
  );
}
