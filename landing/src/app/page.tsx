import type { Metadata } from "next";
import { Navbar } from "@/components/navbar";
import { Hero } from "@/components/hero";
import { Pillars } from "@/components/pillars";
import { SocialProof } from "@/components/social-proof";
import { Features } from "@/components/features";
import { HowItWorks } from "@/components/how-it-works";
import { PricingTiers } from "@/components/pricing-tiers";
import { CTA } from "@/components/cta";
import { Footer } from "@/components/footer";
import { getStarCount } from "@/lib/stars";

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

export default async function Home() {
  const stars = await getStarCount();

  return (
    <main>
      <Navbar darkAboveFold />
      <Hero />
      <Pillars />
      <SocialProof stars={stars} />
      <Features />
      <HowItWorks />
      <PricingTiers />
      <CTA />
      <Footer />
    </main>
  );
}
