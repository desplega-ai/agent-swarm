"use client";

import { motion } from "framer-motion";
import {
  Brain,
  Network,
  Layers,
  Clock,
  Database,
  Workflow,
  Users,
  Zap,
} from "lucide-react";

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
    title: "Persistent Memory",
    description:
      "Agents remember across sessions. Solutions, patterns, and mistakes are stored and searchable — knowledge truly compounds over time.",
    color: "from-violet-500 to-purple-500",
  },
  {
    icon: Layers,
    title: "Identity & Soul",
    description:
      "Each agent has personality files — SOUL.md and IDENTITY.md — that define who they are and evolve as they work. They become someone.",
    color: "from-blue-500 to-cyan-500",
  },
  {
    icon: Workflow,
    title: "Task Lifecycle",
    description:
      "Tasks flow through a rich lifecycle: unassigned, offered, claimed, in-progress, reviewing, completed. Full traceability at every step.",
    color: "from-emerald-500 to-teal-500",
  },
  {
    icon: Clock,
    title: "Session Continuity",
    description:
      "Follow-up tasks resume the same Claude Code session. No cold starts, no lost context. Workers pick up exactly where they left off.",
    color: "from-rose-500 to-pink-500",
  },
  {
    icon: Database,
    title: "Epics & Scheduling",
    description:
      "Organize work into epics with progress tracking. Schedule recurring tasks with cron expressions. The swarm runs while you sleep.",
    color: "from-amber-600 to-yellow-500",
  },
  {
    icon: Users,
    title: "Slack Integration",
    description:
      "Talk to the swarm from Slack. Mention the bot, get progress updates in threads, delegate work — all from your existing workflow.",
    color: "from-indigo-500 to-blue-500",
  },
  {
    icon: Zap,
    title: "MCP-Native",
    description:
      "Built on the Model Context Protocol. Every capability is a tool. Agents discover and invoke each other's services seamlessly.",
    color: "from-orange-500 to-red-500",
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
            From task delegation to persistent memory, Agent Swarm provides the
            full infrastructure for autonomous multi-agent coordination.
          </p>
        </motion.div>

        <motion.div
          variants={container}
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, margin: "-50px" }}
          className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6"
        >
          {features.map((feature) => (
            <motion.div
              key={feature.title}
              variants={item}
              className="group relative rounded-2xl bg-white border border-zinc-100 p-6 hover:border-zinc-200 hover:shadow-xl hover:shadow-zinc-100/50 transition-all duration-300"
            >
              <div
                className={`inline-flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-br ${feature.color} mb-4 shadow-lg`}
              >
                <feature.icon className="w-5 h-5 text-white" />
              </div>
              <h3 className="text-base font-semibold text-zinc-900 mb-2">
                {feature.title}
              </h3>
              <p className="text-sm text-zinc-500 leading-relaxed">
                {feature.description}
              </p>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
