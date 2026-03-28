"use client";

import { motion } from "framer-motion";
import { Brain, Network, Workflow, Zap, Blocks, Server } from "lucide-react";

const features = [
  {
    icon: Network,
    title: "Lead-Worker Orchestration",
    description:
      "A lead agent coordinates specialized workers. Tasks are delegated, tracked, and completed autonomously — like a team that never sleeps.",
    color: "from-amber-500 to-orange-500",
  },
  {
    icon: Brain,
    title: "Persistent Memory & Identity",
    description:
      "Agents remember across sessions. Each develops a unique identity with SOUL.md and IDENTITY.md — knowledge truly compounds over time.",
    color: "from-violet-500 to-purple-500",
  },
  {
    icon: Workflow,
    title: "Tasks, Workflows & Scheduling",
    description:
      "Tasks flow through a rich lifecycle with full traceability. Orchestrate multi-step workflows, schedule recurring tasks with cron — the swarm runs while you sleep.",
    color: "from-emerald-500 to-teal-500",
  },
  {
    icon: Blocks,
    title: "Agent Templates",
    description:
      "Start from pre-built templates — Lead, Coder, Researcher, Reviewer, Tester, and more. Or create your own and share them with the community.",
    color: "from-rose-500 to-pink-500",
    link: "https://templates.agent-swarm.dev",
  },
  {
    icon: Zap,
    title: "MCP-Native",
    description:
      "Built on the Model Context Protocol. Every capability is a tool. Agents discover and invoke each other's services seamlessly.",
    color: "from-orange-500 to-red-500",
  },
  {
    icon: Server,
    title: "Docker-Isolated Workers",
    description:
      "Each worker runs in its own Docker container with full workspace isolation. Self-host on any infrastructure, air-gapped or cloud — your call.",
    color: "from-blue-500 to-cyan-500",
  },
];

const container = {
  hidden: {},
  show: {
    transition: { staggerChildren: 0.08 },
  },
};

const item = {
  hidden: { opacity: 0, y: 24 },
  show: { opacity: 1, y: 0, transition: { duration: 0.5, ease: "easeOut" as const } },
};

export function Features() {
  return (
    <section id="features" className="relative py-32 overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-b from-white via-amber-50/30 to-white" />

      <div className="relative mx-auto max-w-6xl px-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6 }}
          className="text-center mb-20"
        >
          <span className="inline-block text-sm font-semibold text-amber-700 tracking-wider uppercase mb-4">
            Capabilities
          </span>
          <h2 className="text-4xl sm:text-5xl font-bold tracking-tight mb-6">
            Everything a swarm needs
          </h2>
          <p className="text-lg text-zinc-500 max-w-2xl mx-auto">
            From task delegation to persistent memory, Agent Swarm provides the full infrastructure
            for autonomous multi-agent coordination.
          </p>
        </motion.div>

        <motion.div
          variants={container}
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, margin: "-50px" }}
          className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6"
        >
          {features.map((feature) => {
            const Wrapper = feature.link ? "a" : "div";
            const linkProps = feature.link
              ? { href: feature.link, target: "_blank" as const, rel: "noopener noreferrer" }
              : {};
            return (
              <motion.div key={feature.title} variants={item}>
                <Wrapper
                  {...linkProps}
                  className="group relative block rounded-2xl bg-white border border-zinc-100 p-6 hover:border-zinc-200 hover:shadow-xl hover:shadow-zinc-100/50 transition-all duration-300 h-full"
                >
                  <div
                    className={`inline-flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-br ${feature.color} mb-4 shadow-lg`}
                  >
                    <feature.icon className="w-5 h-5 text-white" />
                  </div>
                  <h3 className="text-base font-semibold text-zinc-900 mb-2">{feature.title}</h3>
                  <p className="text-sm text-zinc-500 leading-relaxed">{feature.description}</p>
                </Wrapper>
              </motion.div>
            );
          })}
        </motion.div>
      </div>
    </section>
  );
}
