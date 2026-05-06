"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";

type Faq = { question: string; answer: string };

const FAQS: Faq[] = [
  {
    question: "Do you compete with Devin, Cursor, or Claude Code?",
    answer:
      "We run them. Devin, Claude Code, Codex, OpenCode — agent-swarm uses any of them as the brain inside a worker. You bring the model and the agent you trust; we coordinate a team of them in parallel, each in its own container, with shared memory and a lead that delegates. We sit one layer above coding agents — they ship the code, we run the team that ships the codebase.",
  },
  {
    question: "How is this different from CrewAI, Lindy, or an Agent OS?",
    answer:
      "Their bet is that you'll build your AI team on their stack — pre-built employees, their orchestration, their lock-in. Ours is the opposite: bring the agents and models you already trust, run them on infrastructure you control, keep your memory and identity files in your DB and filesystem as portable artifacts. The category bet is structurally different — AI work is coordinated across heterogeneous, owned components, not built top-down by a single vendor. You can fork the entire stack and keep going.",
  },
  {
    question: "Are you Glean, Onyx, or another enterprise-knowledge tool for agents?",
    answer:
      "Inverse, actually. Glean, Onyx, and the rest of that shelf retrieve what your org said by indexing every app into one graph. agent-swarm coordinates what your org does — your data stays in its source of truth (Linear, GitHub, Notion); the swarm stores derived knowledge (decisions, gotchas, capability gaps, what worked last sprint). Two opposite jobs; happy to live next to a search layer.",
  },
  {
    question: "Why not just write this with LangGraph or AutoGen?",
    answer:
      "You can. We did, and then kept going. LangGraph and AutoGen are SDKs — you write the graph, host the runtime, persist the memory, build the Slack and GitHub integrations, build the dashboard. agent-swarm is the running system: docker compose up, integrations pre-wired, memory built in, dashboard included. SDK if you're building a tool; agent-swarm if you want to use one.",
  },
  {
    question:
      "How much can I customize what the swarm does — and stop it doing what I don't want?",
    answer:
      "As much as you need. You control the tools each worker can call, the integrations it can reach, and the boundaries it operates within — your infra, your policies. Hooks let you wire approvals, gates, or any custom check before an action takes effect. Whether the swarm is shipping code, drafting a campaign, running a UX research synthesis, or triaging support, the same governance surface applies: scoped permissions, reviewable outputs, and stop-buttons in the dashboard. The defaults are conservative; the surface area is yours to shape.",
  },
  {
    question: "Can I run this air-gapped?",
    answer:
      "Yes. MIT-licensed source, runs anywhere Docker runs, BYOK / BYOM. The Cloud version exists for convenience, not as a hostage. Air-gapped customers run the same binaries.",
  },
];

const FAQ_JSON_LD = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: FAQS.map((f) => ({
    "@type": "Question",
    name: f.question,
    acceptedAnswer: {
      "@type": "Answer",
      text: f.answer,
    },
  })),
};

function FAQItem({ faq }: { faq: Faq }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-zinc-100 last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((s) => !s)}
        className="flex items-center justify-between w-full py-5 text-left group gap-6"
        aria-expanded={open}
      >
        <span className="text-[15px] font-semibold text-zinc-950 group-hover:text-amber-700 transition-colors tracking-[-0.01em]">
          {faq.question}
        </span>
        <ChevronDown
          className={`w-4 h-4 flex-shrink-0 text-zinc-400 transition-transform duration-200 ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>
      <div
        className={`overflow-hidden transition-all duration-200 ${
          open ? "max-h-[400px] pb-5" : "max-h-0"
        }`}
      >
        <p className="text-[14.5px] text-zinc-500 leading-[1.6]">{faq.answer}</p>
      </div>
    </div>
  );
}

export function DifferentiationFAQ() {
  return (
    <section className="py-32 bg-white border-t border-zinc-100">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: required to emit FAQPage JSON-LD
        dangerouslySetInnerHTML={{ __html: JSON.stringify(FAQ_JSON_LD) }}
      />
      <div className="max-w-[1180px] mx-auto px-6 sm:px-7">
        <div className="mb-14 max-w-2xl">
          <div className="font-mono text-[11px] tracking-[0.14em] uppercase text-amber-700 mb-4">
            / how this is different
          </div>
          <h2
            className="text-[36px] sm:text-[44px] leading-[1.05] font-semibold tracking-[-0.025em] text-zinc-950"
            style={{ textWrap: "balance" }}
          >
            Coordination,
            <br />
            <span className="italic gradient-text">end to end.</span>
          </h2>
        </div>

        <div className="rounded-2xl border border-zinc-100 px-6">
          {FAQS.map((f) => (
            <FAQItem key={f.question} faq={f} />
          ))}
        </div>
      </div>
    </section>
  );
}
