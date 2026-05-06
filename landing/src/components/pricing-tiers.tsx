import { ArrowRight, Check, Github } from "lucide-react";
import { PricingCloudCalculator } from "@/components/pricing-cloud-calculator";

type Tier = {
  name: string;
  tagline: string;
  price: string;
  per: string;
  rider?: string;
  features: string[];
  cta: string;
  ctaIcon: "github" | "arrow";
  ctaHref: string;
  highlight?: boolean;
};

const TIERS: Tier[] = [
  {
    name: "Self-hosted",
    tagline: "Forever free, your infra",
    price: "€0",
    per: "forever",
    features: [
      "Full source on GitHub (MIT)",
      "Run anywhere Docker runs",
      "BYO model keys, BYO models",
      "Air-gapped if you need it",
      "Community support on Discord",
    ],
    cta: "Self-host",
    ctaIcon: "github",
    ctaHref: "https://github.com/desplega-ai/agent-swarm",
  },
  {
    name: "Enterprise",
    tagline: "Self-host with a pager",
    price: "Talk",
    per: "to us",
    features: [
      "Single-tenant, VPC or on-prem",
      "SSO / SAML, audit log export",
      "Custom integrations & MCP servers",
      "Onboarding workshop for ICs + leads",
      "Priority response, dedicated channel",
    ],
    cta: "Book a call",
    ctaIcon: "arrow",
    ctaHref: "https://calendar.app.google/49DmjEXTPAv5NsRq6",
  },
];

function TierIcon({ icon }: { icon: Tier["ctaIcon"] }) {
  if (icon === "github") return <Github className="w-[14px] h-[14px]" />;
  return <ArrowRight className="w-[14px] h-[14px]" />;
}

function StaticTierCard({ tier }: { tier: Tier }) {
  return (
    <div className="relative rounded-2xl p-7 transition border bg-white border-zinc-100 hover:border-zinc-200 hover:shadow-xl hover:shadow-zinc-200/40 flex flex-col">
      <div className="text-[13px] font-semibold tracking-tight text-amber-700">{tier.name}</div>
      <div className="mt-1 text-[12.5px] text-zinc-500">{tier.tagline}</div>

      <div className="mt-5 flex items-baseline gap-1.5">
        <span className="text-[44px] font-bold tracking-[-0.03em] leading-none text-zinc-950">
          {tier.price}
        </span>
        <span className="text-[13px] text-zinc-500">{tier.per}</span>
      </div>

      <div className="mt-5 h-px bg-zinc-100" />

      <ul className="mt-5 space-y-2.5 text-[14px] text-zinc-600 flex-1">
        {tier.features.map((f) => (
          <li key={f} className="flex items-start gap-2.5">
            <span className="mt-0.5 flex-shrink-0 text-amber-700">
              <Check className="w-[15px] h-[15px]" />
            </span>
            <span>{f}</span>
          </li>
        ))}
      </ul>

      <a
        href={tier.ctaHref}
        className="mt-7 inline-flex w-full justify-center items-center gap-1.5 px-4 h-11 rounded-xl text-[14px] font-semibold transition bg-zinc-950 hover:bg-zinc-800 text-white"
      >
        {tier.cta} <TierIcon icon={tier.ctaIcon} />
      </a>
    </div>
  );
}

export function PricingTiers() {
  const [selfHosted, enterprise] = TIERS;
  return (
    <section id="pricing" className="py-32 bg-white">
      <div className="max-w-[1180px] mx-auto px-6 sm:px-7">
        <div className="mb-14 grid lg:grid-cols-[1.1fr_1fr] gap-10 items-end">
          <div>
            <div className="font-mono text-[11px] tracking-[0.14em] uppercase text-amber-700 mb-4">
              / pricing
            </div>
            <h2
              className="text-[40px] sm:text-[52px] leading-[1.02] font-semibold tracking-[-0.025em] text-zinc-950"
              style={{ textWrap: "balance" }}
            >
              Pay for the workers.
              <br />
              <span className="text-zinc-400">Not the seats.</span>
            </h2>
          </div>
          <p className="text-[16px] text-zinc-500 leading-[1.6] max-w-md">
            Self-host the whole thing for free, forever. Or skip the ops and run it on Cloud —{" "}
            <span className="text-zinc-800">
              pick how many workers you need, see the total.
            </span>
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-5 lg:gap-6 items-stretch">
          <StaticTierCard tier={selfHosted} />
          <div
            className="relative rounded-2xl p-7 transition border bg-zinc-950 text-white border-zinc-900"
            style={{ boxShadow: "0 20px 60px -20px oklch(0.555 0.163 48.998 / 0.5)" }}
          >
            <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-2.5 py-1 rounded-full bg-amber-500 text-zinc-950 text-[10px] font-bold tracking-[0.1em] uppercase">
              Most popular
            </div>
            <PricingCloudCalculator />
          </div>
          <StaticTierCard tier={enterprise} />
        </div>

        <p className="mt-8 text-center font-mono text-[11.5px] tracking-[0.04em] text-zinc-400">
          All Cloud plans include a <span className="text-amber-700">7-day free trial</span>.
          Cancel from the dashboard at any time.
        </p>
      </div>
    </section>
  );
}
