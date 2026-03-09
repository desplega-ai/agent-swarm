"use client";

import { motion } from "framer-motion";
import {
  Shield,
  Code2,
  Brain,
  Server,
  Shuffle,
} from "lucide-react";

const pillars = [
  {
    icon: Code2,
    title: "Free & Open Source",
    color: "from-emerald-500 to-teal-500",
    points: [
      "Full visibility and control, no third party in the loop",
      "Community-driven improvements, without giving up your edge",
      "Your team ships faster — they focus on the work that matters",
    ],
  },
  {
    icon: Brain,
    title: "Built to Be Yours",
    color: "from-violet-500 to-purple-500",
    points: [
      "Agents learn as you use them. Define their tools, skills, and boundaries",
      "Compounding self-learnings make them improve over time",
      "They live where your team already works: Slack, Linear, GitHub, Jira, email — they build their own integrations",
    ],
  },
  {
    icon: Shuffle,
    title: "Not Locked to Any LLM",
    color: "from-blue-500 to-cyan-500",
    points: [
      "Switch between OpenAI, Anthropic, Qwen, Google, or OpenRouter",
      "Per task, per agent, per cost target — you choose",
      "No vendor lock-in, ever",
    ],
  },
  {
    icon: Server,
    title: "Dockerized from Day One",
    color: "from-orange-500 to-red-500",
    points: [
      "Runs on whatever infrastructure your team trusts",
      "Self-hosted, air-gapped, or cloud — your call",
      "Full control over data residency and compliance",
    ],
  },
];

const container = {
  hidden: {},
  show: {
    transition: { staggerChildren: 0.12 },
  },
};

const item = {
  hidden: { opacity: 0, y: 24 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.5, ease: "easeOut" as const },
  },
};

export function WhyChoose() {
  return (
    <section id="why-choose" className="relative py-32 overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-br from-zinc-900 via-zinc-900 to-zinc-800" />
      <div className="absolute inset-0 grid-bg opacity-5" />

      {/* Subtle amber glow */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[400px] rounded-full bg-amber-500/5 blur-[120px]" />

      <div className="relative mx-auto max-w-6xl px-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6 }}
          className="text-center mb-6"
        >
          <span className="inline-block text-sm font-semibold text-amber-500 tracking-wider uppercase mb-4">
            Why Agent Swarm
          </span>
          <h2 className="text-4xl sm:text-5xl font-bold tracking-tight text-white mb-6">
            Your agents are your IP.
            <br />
            <span className="text-amber-500">Keep them that way.</span>
          </h2>
        </motion.div>

        <motion.p
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.5, delay: 0.15 }}
          className="text-center text-lg text-zinc-400 max-w-3xl mx-auto mb-16"
        >
          Platforms that run agents{" "}
          <span className="text-zinc-200 font-medium">for</span> you learn from
          your workflows — your logic becomes their training data. Agent Swarm is
          different.
        </motion.p>

        <motion.div
          variants={container}
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, margin: "-50px" }}
          className="grid sm:grid-cols-2 gap-6"
        >
          {pillars.map((pillar) => (
            <motion.div
              key={pillar.title}
              variants={item}
              className="group relative rounded-2xl bg-white/5 border border-white/10 p-8 hover:border-amber-500/30 hover:bg-white/[0.07] transition-all duration-300"
            >
              <div
                className={`inline-flex items-center justify-center w-11 h-11 rounded-xl bg-gradient-to-br ${pillar.color} mb-5 shadow-lg`}
              >
                <pillar.icon className="w-5 h-5 text-white" />
              </div>
              <h3 className="text-lg font-semibold text-white mb-4">
                {pillar.title}
              </h3>
              <ul className="space-y-3">
                {pillar.points.map((point, i) => (
                  <li
                    key={i}
                    className="flex items-start gap-3 text-sm text-zinc-400 leading-relaxed"
                  >
                    <Shield className="w-4 h-4 text-amber-500/70 mt-0.5 shrink-0" />
                    <span>{point}</span>
                  </li>
                ))}
              </ul>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
