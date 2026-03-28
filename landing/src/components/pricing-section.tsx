"use client";

import { motion } from "framer-motion";
import { ArrowRight, Check, Server, LayoutDashboard, ChevronDown } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

const platformFeatures = [
  "Dashboard & monitoring UI",
  "Lead-worker orchestration",
  "Task lifecycle & scheduling",
  "Slack & GitHub integrations",
  "MCP tool ecosystem",
  "Persistent memory & identity",
];

const workerFeatures = [
  "Docker-isolated environment",
  "Full workspace & git access",
  "Any LLM provider (BYO key)",
  "Session continuity & resume",
  "Auto-scaling ready",
  "Managed infrastructure",
];

const examples = [
  { workers: 1, total: 38 },
  { workers: 3, total: 96 },
  { workers: 6, total: 183 },
];

const faqs = [
  {
    question: "What's included in the platform fee?",
    answer:
      "The platform fee covers the API server, dashboard UI, lead agent orchestration, task scheduling, persistent memory, Slack and GitHub integrations, and the full MCP tool ecosystem. It's the base infrastructure that coordinates your entire swarm.",
  },
  {
    question: "How do workers scale?",
    answer:
      "Each worker runs in its own Docker container with full workspace isolation. Add workers on demand -- each one costs a flat \u20AC29/mo. Workers can use any LLM provider with your own API keys, so you control both capacity and cost.",
  },
  {
    question: "Is there a free trial?",
    answer:
      "Yes. Every new account gets a 7-day free trial with full access to all features, including one worker. No credit card required to start.",
  },
  {
    question: "What happens after the trial?",
    answer:
      "After your trial ends, you can subscribe to continue. If you don't, your swarm pauses -- no data is deleted. You can reactivate at any time and pick up right where you left off.",
  },
  {
    question: "Can I self-host instead?",
    answer:
      "Absolutely. Agent Swarm is fully open source under the MIT license. You can self-host on any infrastructure -- your own servers, air-gapped environments, or any cloud provider. Cloud is for teams that want managed infrastructure without the ops overhead.",
  },
  {
    question: "What LLMs are supported?",
    answer:
      "Agent Swarm is LLM-agnostic. Workers support Claude (via Anthropic or AWS Bedrock), OpenAI, Gemini, and any OpenRouter-compatible model. Bring your own API keys -- there's no vendor lock-in.",
  },
];

function FAQItem({ question, answer }: { question: string; answer: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="border-b border-zinc-100 last:border-b-0">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center justify-between w-full py-5 text-left group"
      >
        <span className="text-sm font-semibold text-zinc-900 group-hover:text-amber-700 transition-colors">
          {question}
        </span>
        <ChevronDown
          className={`w-4 h-4 text-zinc-400 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>
      <div
        className={`overflow-hidden transition-all duration-200 ${open ? "max-h-48 pb-5" : "max-h-0"}`}
      >
        <p className="text-sm text-zinc-500 leading-relaxed">{answer}</p>
      </div>
    </div>
  );
}

export function PricingSection({ compact }: { compact?: boolean }) {
  return (
    <section id="pricing" className="relative py-32 overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-b from-white via-amber-50/30 to-white" />

      <div className="relative mx-auto max-w-6xl px-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6 }}
          className="text-center mb-16"
        >
          <span className="inline-block text-sm font-semibold text-amber-700 tracking-wider uppercase mb-4">
            Pricing
          </span>
          <h2 className="text-4xl sm:text-5xl font-bold tracking-tight mb-6">
            Simple, predictable pricing
          </h2>
          <p className="text-lg text-zinc-500 max-w-2xl mx-auto">
            One platform fee, plus a flat rate per worker. No usage surprises, no hidden costs.
          </p>
        </motion.div>

        {/* Pricing cards */}
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-50px" }}
          transition={{ duration: 0.5, delay: 0.1 }}
          className="grid sm:grid-cols-2 gap-6 max-w-4xl mx-auto mb-12"
        >
          {/* Platform card */}
          <div className="group relative rounded-2xl bg-white border border-zinc-200 p-6 hover:border-zinc-300 hover:shadow-xl hover:shadow-zinc-100/50 hover:scale-[1.02] transition-all duration-300">
            <div className="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-br from-amber-500 to-orange-500 mb-4 shadow-lg">
              <LayoutDashboard className="w-5 h-5 text-white" />
            </div>
            <h3 className="text-lg font-bold text-zinc-900 mb-1">Platform</h3>
            <div className="flex items-baseline gap-1 mb-1">
              <span className="text-3xl font-bold text-zinc-900">&euro;9</span>
              <span className="text-sm text-zinc-500">/mo</span>
            </div>
            <p className="text-xs text-zinc-400 mb-4">Base infrastructure</p>
            <span className="inline-block text-xs font-semibold text-amber-700 bg-amber-50 rounded-full px-3 py-1 mb-5">
              7-day free trial
            </span>
            <ul className="space-y-2.5">
              {platformFeatures.map((f) => (
                <li key={f} className="flex items-start gap-2 text-sm text-zinc-600">
                  <Check className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
                  {f}
                </li>
              ))}
            </ul>
          </div>

          {/* Worker card */}
          <div className="group relative rounded-2xl bg-white border border-zinc-200 p-6 hover:border-zinc-300 hover:shadow-xl hover:shadow-zinc-100/50 hover:scale-[1.02] transition-all duration-300">
            <div className="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-cyan-500 mb-4 shadow-lg">
              <Server className="w-5 h-5 text-white" />
            </div>
            <h3 className="text-lg font-bold text-zinc-900 mb-1">Worker Compute</h3>
            <div className="flex items-baseline gap-1 mb-1">
              <span className="text-3xl font-bold text-zinc-900">&euro;29</span>
              <span className="text-sm text-zinc-500">/mo per worker</span>
            </div>
            <p className="text-xs text-zinc-400 mb-4">Docker-isolated agent</p>
            <span className="inline-block text-xs font-semibold text-amber-700 bg-amber-50 rounded-full px-3 py-1 mb-5">
              7-day free trial
            </span>
            <ul className="space-y-2.5">
              {workerFeatures.map((f) => (
                <li key={f} className="flex items-start gap-2 text-sm text-zinc-600">
                  <Check className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
                  {f}
                </li>
              ))}
            </ul>
          </div>
        </motion.div>

        {/* Example calculations */}
        {!compact && (
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.4, delay: 0.2 }}
            className="flex flex-wrap justify-center gap-4 mb-12"
          >
            {examples.map((ex) => (
              <div
                key={ex.workers}
                className="rounded-xl bg-zinc-50 border border-zinc-100 px-5 py-3 text-center"
              >
                <div className="text-xs text-zinc-400 mb-0.5">
                  {ex.workers} worker{ex.workers > 1 ? "s" : ""}
                </div>
                <div className="text-lg font-bold text-zinc-900">
                  &euro;{ex.total}
                  <span className="text-sm font-normal text-zinc-500">/mo</span>
                </div>
              </div>
            ))}
          </motion.div>
        )}

        {/* CTA */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="text-center"
        >
          <a
            href="https://cloud.agent-swarm.dev"
            className="group inline-flex items-center gap-2 rounded-xl bg-amber-600 px-8 py-4 text-sm font-semibold text-white hover:bg-amber-500 transition-all shadow-xl shadow-amber-600/20"
          >
            Start Free Trial
            <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" />
          </a>
          <p className="mt-4 text-sm text-zinc-400">
            Prefer self-hosting? It&apos;s{" "}
            <a
              href="https://docs.agent-swarm.dev/docs/getting-started"
              className="text-amber-600 hover:text-amber-700 underline underline-offset-2 transition-colors"
            >
              free and MIT-licensed
            </a>
            .
          </p>
          {compact && (
            <Link
              href="/pricing"
              className="inline-flex items-center gap-1 mt-3 text-sm font-medium text-amber-700 hover:text-amber-600 transition-colors"
            >
              See full pricing
              <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          )}
        </motion.div>

        {/* FAQ (full mode only) */}
        {!compact && (
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-50px" }}
            transition={{ duration: 0.5 }}
            className="mt-24 max-w-2xl mx-auto"
          >
            <h3 className="text-2xl font-bold text-zinc-900 text-center mb-8">
              Frequently asked questions
            </h3>
            <div className="rounded-2xl bg-white border border-zinc-200 px-6">
              {faqs.map((faq) => (
                <FAQItem key={faq.question} question={faq.question} answer={faq.answer} />
              ))}
            </div>
          </motion.div>
        )}
      </div>
    </section>
  );
}
