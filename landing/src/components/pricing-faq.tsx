"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";

type Faq = { question: string; answer: string };

const FAQS: Faq[] = [
  {
    question: "What's included in the platform fee?",
    answer:
      "The platform fee covers the API server, dashboard UI, lead agent orchestration, task scheduling, persistent memory, Slack and GitHub integrations, and the full MCP tool ecosystem. It's the base infrastructure that coordinates your entire swarm.",
  },
  {
    question: "How do workers scale?",
    answer:
      "Each worker runs in its own Docker container with full workspace isolation. Add workers on demand — each one costs a flat €29 / mo. Workers can use any LLM provider with your own API keys, so you control both capacity and cost.",
  },
  {
    question: "Is there a free trial?",
    answer:
      "Yes. Every new account gets a 7-day free trial with full access to all features, including one worker. No credit card required to start.",
  },
  {
    question: "What happens after the trial?",
    answer:
      "After your trial ends, you can subscribe to continue. If you don't, your swarm pauses — no data is deleted. You can reactivate at any time and pick up right where you left off.",
  },
  {
    question: "Can I self-host instead?",
    answer:
      "Absolutely. Agent Swarm is fully open source under the MIT license. You can self-host on any infrastructure — your own servers, air-gapped environments, or any cloud provider. Cloud is for teams that want managed infrastructure without the ops overhead.",
  },
  {
    question: "What LLMs are supported?",
    answer:
      "Agent Swarm is LLM-agnostic. Workers support Claude (via Anthropic or AWS Bedrock), OpenAI, Gemini, and any OpenRouter-compatible model. Bring your own API keys — there's no vendor lock-in.",
  },
];

function FAQItem({ faq }: { faq: Faq }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-zinc-100 last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((s) => !s)}
        className="flex items-center justify-between w-full py-5 text-left group"
        aria-expanded={open}
      >
        <span className="text-[15px] font-semibold text-zinc-950 group-hover:text-amber-700 transition-colors tracking-[-0.01em]">
          {faq.question}
        </span>
        <ChevronDown
          className={`w-4 h-4 text-zinc-400 transition-transform duration-200 ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>
      <div
        className={`overflow-hidden transition-all duration-200 ${
          open ? "max-h-60 pb-5" : "max-h-0"
        }`}
      >
        <p className="text-[14.5px] text-zinc-500 leading-[1.6]">{faq.answer}</p>
      </div>
    </div>
  );
}

export function PricingFAQ() {
  return (
    <section className="py-24 bg-white border-t border-zinc-100">
      <div className="max-w-[760px] mx-auto px-6 sm:px-7">
        <div className="mb-10 text-center">
          <div className="font-mono text-[11px] tracking-[0.14em] uppercase text-amber-700 mb-4">
            / faq
          </div>
          <h2
            className="text-[36px] sm:text-[44px] leading-[1.05] font-semibold tracking-[-0.025em] text-zinc-950"
            style={{ textWrap: "balance" }}
          >
            The questions we keep
            <br />
            <span className="italic gradient-text">getting asked.</span>
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
