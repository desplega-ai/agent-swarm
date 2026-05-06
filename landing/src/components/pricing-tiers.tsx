import { ArrowRight, Check, Github } from "lucide-react";

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
    name: "Cloud",
    tagline: "Hosted swarm, billed monthly",
    price: "€9",
    per: "platform / mo",
    rider: "plus €29 / mo per worker",
    features: [
      "Hosted lead + dashboard",
      "Workers billed individually — scale up or down anytime",
      "Slack, GitHub, GitLab, Linear, AgentMail, Sentry",
      "Bring your own model keys (BYOK)",
      "7-day free trial · no card required",
    ],
    cta: "Start 7-day trial",
    ctaIcon: "arrow",
    ctaHref: "https://cloud.agent-swarm.dev",
    highlight: true,
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

export function PricingTiers() {
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
              €9 / month flat for the platform, plus €29 / month per worker you spin up.
            </span>
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-5 lg:gap-6 items-stretch">
          {TIERS.map((t) => (
            <div
              key={t.name}
              className={`relative rounded-2xl p-7 transition border flex flex-col ${
                t.highlight
                  ? "bg-zinc-950 text-white border-zinc-900"
                  : "bg-white border-zinc-100 hover:border-zinc-200 hover:shadow-xl hover:shadow-zinc-200/40"
              }`}
              style={
                t.highlight
                  ? { boxShadow: "0 20px 60px -20px oklch(0.555 0.163 48.998 / 0.5)" }
                  : undefined
              }
            >
              {t.highlight && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-2.5 py-1 rounded-full bg-amber-500 text-zinc-950 text-[10px] font-bold tracking-[0.1em] uppercase">
                  Most popular
                </div>
              )}
              <div
                className={`text-[13px] font-semibold tracking-tight ${
                  t.highlight ? "text-amber-400" : "text-amber-700"
                }`}
              >
                {t.name}
              </div>
              <div
                className={`mt-1 text-[12.5px] ${
                  t.highlight ? "text-zinc-400" : "text-zinc-500"
                }`}
              >
                {t.tagline}
              </div>

              <div className="mt-5 flex items-baseline gap-1.5">
                <span
                  className={`text-[44px] font-bold tracking-[-0.03em] leading-none ${
                    t.highlight ? "text-white" : "text-zinc-950"
                  }`}
                >
                  {t.price}
                </span>
                <span className={`text-[13px] ${t.highlight ? "text-zinc-400" : "text-zinc-500"}`}>
                  {t.per}
                </span>
              </div>
              {t.rider && (
                <div
                  className={`mt-1.5 font-mono text-[11.5px] tracking-[0.02em] ${
                    t.highlight ? "text-amber-300" : "text-amber-700"
                  }`}
                >
                  + {t.rider}
                </div>
              )}

              <div className={`mt-5 h-px ${t.highlight ? "bg-white/[0.08]" : "bg-zinc-100"}`} />

              <ul
                className={`mt-5 space-y-2.5 text-[14px] ${
                  t.highlight ? "text-zinc-300" : "text-zinc-600"
                } flex-1`}
              >
                {t.features.map((f) => (
                  <li key={f} className="flex items-start gap-2.5">
                    <span
                      className={`mt-0.5 flex-shrink-0 ${
                        t.highlight ? "text-amber-400" : "text-amber-700"
                      }`}
                    >
                      <Check className="w-[15px] h-[15px]" />
                    </span>
                    <span>{f}</span>
                  </li>
                ))}
              </ul>

              <a
                href={t.ctaHref}
                className={`mt-7 inline-flex w-full justify-center items-center gap-1.5 px-4 h-11 rounded-xl text-[14px] font-semibold transition ${
                  t.highlight
                    ? "bg-amber-500 hover:bg-amber-400 text-zinc-950"
                    : "bg-zinc-950 hover:bg-zinc-800 text-white"
                }`}
              >
                {t.cta} <TierIcon icon={t.ctaIcon} />
              </a>
            </div>
          ))}
        </div>

        <p className="mt-8 text-center font-mono text-[11.5px] tracking-[0.04em] text-zinc-400">
          All Cloud plans include a <span className="text-amber-700">7-day free trial</span>.
          Cancel from the dashboard at any time.
        </p>
      </div>
    </section>
  );
}
