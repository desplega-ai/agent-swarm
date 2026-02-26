"use client";

import { motion } from "framer-motion";

const steps = [
  {
    number: "01",
    title: "Deploy the Swarm",
    description:
      "Spin up the MCP server and connect it to Claude Code. Register your lead agent and workers — each with their own identity, capabilities, and workspace.",
    visual: (
      <div className="font-mono text-xs leading-relaxed text-zinc-600">
        <div className="text-zinc-400"># Start the swarm server</div>
        <div>
          <span className="text-amber-600">$</span> bun run dev:http
        </div>
        <div className="mt-2 text-zinc-400"># Connect via MCP</div>
        <div>
          <span className="text-amber-600">$</span> claude --mcp agent-swarm
        </div>
        <div className="mt-2 text-emerald-600">
          ✓ Lead agent &ldquo;Orchestrator&rdquo; registered
        </div>
        <div className="text-emerald-600">
          ✓ Worker &ldquo;Picateclas&rdquo; online
        </div>
        <div className="text-emerald-600">
          ✓ Worker &ldquo;Codebot&rdquo; online
        </div>
      </div>
    ),
  },
  {
    number: "02",
    title: "Delegate Tasks",
    description:
      "The lead agent breaks down work and assigns tasks to specialized workers. Tasks can be sent directly, offered for acceptance, or pooled for anyone to claim.",
    visual: (
      <div className="space-y-2">
        {[
          { task: "Implement auth flow", agent: "Picateclas", status: "in_progress", color: "bg-blue-100 text-blue-700" },
          { task: "Write API tests", agent: "Codebot", status: "pending", color: "bg-amber-100 text-amber-700" },
          { task: "Update docs", agent: "Pool", status: "unassigned", color: "bg-zinc-100 text-zinc-600" },
        ].map((t) => (
          <div
            key={t.task}
            className="flex items-center justify-between rounded-lg border border-zinc-100 bg-white px-3 py-2"
          >
            <div>
              <div className="text-xs font-medium text-zinc-800">{t.task}</div>
              <div className="text-xs text-zinc-400">{t.agent}</div>
            </div>
            <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${t.color}`}>
              {t.status}
            </span>
          </div>
        ))}
      </div>
    ),
  },
  {
    number: "03",
    title: "Knowledge Compounds",
    description:
      "Every completed task generates memories. Every session enriches the agent's identity. The swarm doesn't just work — it learns. Each session builds on all that came before.",
    visual: (
      <div className="space-y-3">
        <div className="flex items-start gap-2">
          <div className="mt-1 w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />
          <div className="text-xs text-zinc-600">
            <span className="font-medium text-zinc-800">Memory saved:</span>{" "}
            &ldquo;The API requires Bearer prefix on all auth headers&rdquo;
          </div>
        </div>
        <div className="flex items-start gap-2">
          <div className="mt-1 w-1.5 h-1.5 rounded-full bg-violet-500 shrink-0" />
          <div className="text-xs text-zinc-600">
            <span className="font-medium text-zinc-800">Identity evolved:</span>{" "}
            Added &ldquo;auth specialist&rdquo; to capabilities
          </div>
        </div>
        <div className="flex items-start gap-2">
          <div className="mt-1 w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
          <div className="text-xs text-zinc-600">
            <span className="font-medium text-zinc-800">Pattern learned:</span>{" "}
            Session continuity via parentTaskId
          </div>
        </div>
        <div className="mt-3 rounded-lg bg-gradient-to-r from-amber-50 to-amber-100/50 border border-amber-200/50 px-3 py-2">
          <div className="text-xs font-medium text-amber-800">
            Session 47 — 3x faster than session 1
          </div>
          <div className="mt-1 w-full bg-amber-200/50 rounded-full h-1.5">
            <div className="bg-gradient-to-r from-amber-500 to-amber-600 h-1.5 rounded-full" style={{ width: "78%" }} />
          </div>
        </div>
      </div>
    ),
  },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" className="relative py-32">
      <div className="mx-auto max-w-6xl px-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6 }}
          className="text-center mb-20"
        >
          <span className="inline-block text-sm font-semibold text-amber-700 tracking-wider uppercase mb-4">
            How It Works
          </span>
          <h2 className="text-4xl sm:text-5xl font-bold tracking-tight mb-6">
            From setup to compounding
          </h2>
          <p className="text-lg text-zinc-500 max-w-2xl mx-auto">
            Three steps to a swarm that gets smarter every day.
          </p>
        </motion.div>

        <div className="space-y-24">
          {steps.map((step, i) => (
            <motion.div
              key={step.number}
              initial={{ opacity: 0, y: 40 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-80px" }}
              transition={{ duration: 0.6 }}
              className={`grid lg:grid-cols-2 gap-12 items-center ${
                i % 2 === 1 ? "lg:direction-rtl" : ""
              }`}
            >
              <div className={i % 2 === 1 ? "lg:order-2" : ""}>
                <div className="flex items-center gap-4 mb-4">
                  <span className="text-5xl font-bold text-amber-200/80 font-mono">
                    {step.number}
                  </span>
                  <div className="h-px flex-1 bg-gradient-to-r from-amber-200 to-transparent" />
                </div>
                <h3 className="text-2xl sm:text-3xl font-bold text-zinc-900 mb-4">
                  {step.title}
                </h3>
                <p className="text-base text-zinc-500 leading-relaxed">
                  {step.description}
                </p>
              </div>

              <div className={`${i % 2 === 1 ? "lg:order-1" : ""}`}>
                <div className="rounded-2xl bg-zinc-50 border border-zinc-100 p-6">
                  {step.visual}
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
