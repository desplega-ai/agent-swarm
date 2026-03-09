"use client";

import { motion } from "framer-motion";
import {
  ArrowRight,
  BookOpen,
  Clock,
  Users,
  Presentation,
  Rocket,
  Zap,
  ExternalLink,
  Wrench,
  BarChart3,
} from "lucide-react";

const workshopTimeline = [
  {
    time: "30 min",
    title: "Fundamentals of Agentic Coding",
    description:
      "Key concepts for high-performance local setup. Example simple SDLC for Claude Code.",
    icon: BookOpen,
  },
  {
    time: "45 min",
    title: "The Agent Swarm Experience",
    description:
      "Deep dive into agent-swarm.dev setup & day-to-day usage. Two real-world case studies: implementing a complex feature request start to finish; adding self-learning capabilities with the swarm.",
    icon: Wrench,
  },
  {
    time: "30 min",
    title: "Your Own Swarm",
    description:
      "Split sessions — ICs & Managers get hands-on with a live swarm on your own stack. Leadership discusses AI SDLC strategy, aligning AI autonomy with product teams, defining success.",
    icon: Users,
  },
  {
    time: "15 min",
    title: "Beast Mode",
    description:
      "Path to giving business agency to your agents.",
    icon: Rocket,
  },
];

const briefingTopics = [
  {
    time: "20 min",
    title: "The 4 Leaps of Agentic Coding",
    description: "Where your team stands, key concepts, and the roadmap ahead.",
  },
  {
    time: "20 min",
    title: "CLI SDLCs & Alternatives",
    description: "Showcase CLI SDLCs, pros/cons, alternatives, creating your own.",
  },
  {
    time: "20 min",
    title: "Agent Swarm in Action",
    description: "Overview, example PR, UX principles for agentic development.",
  },
];

const references = [
  {
    label: "Agentic Coding 101",
    href: "https://github.com/desplega-ai/ai-toolbox/tree/main/cc-plugin/base#agentic-coding-101-with-claude-code",
  },
  {
    label: "Agent Swarm",
    href: "https://github.com/desplega-ai/agent-swarm",
  },
  {
    label: "4 Leaps of Agentic Coding",
    href: "https://www.pleasedontdeploy.com/p/4-leaps-of-agentic-coding-where-do",
  },
  {
    label: "Semantic Distance",
    href: "https://www.tarasyarema.com/blog/2026-02-18-introducing-semantic-distance",
  },
  {
    label: "SDLC Explained",
    href: "https://www.pleasedontdeploy.com/p/how-we-stopped-drowning-in-ai-slop",
  },
  {
    label: "Validation vs Verification",
    href: "https://www.pleasedontdeploy.com/p/validation-not-verification-3-strategies",
  },
];

const container = {
  hidden: {},
  show: {
    transition: { staggerChildren: 0.1 },
  },
};

const item = {
  hidden: { opacity: 0, y: 20 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.45, ease: "easeOut" as const },
  },
};

export function Workshops() {
  return (
    <section id="workshops" className="relative py-32 overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-b from-white via-amber-50/20 to-white" />

      <div className="relative mx-auto max-w-6xl px-6">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6 }}
          className="text-center mb-6"
        >
          <span className="inline-block text-sm font-semibold text-amber-700 tracking-wider uppercase mb-4">
            Workshops
          </span>
          <h2 className="text-4xl sm:text-5xl font-bold tracking-tight mb-6">
            Free Agentic SDLC Workshop
          </h2>
        </motion.div>

        <motion.p
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.5, delay: 0.1 }}
          className="text-center text-lg text-zinc-500 max-w-3xl mx-auto mb-4"
        >
          By the end of this workshop, your team will have a swarm of agents in the
          cloud, capable of producing code constantly — removing the need for your
          team to write code.
        </motion.p>

        {/* Two options grid */}
        <div className="grid lg:grid-cols-2 gap-8 mb-16">
          {/* Option 1: Hands-on Workshop */}
          <motion.div
            initial={{ opacity: 0, x: -20 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: "-50px" }}
            transition={{ duration: 0.5 }}
            className="relative rounded-2xl border-2 border-amber-200 bg-white p-8 shadow-xl shadow-amber-100/40"
          >
            {/* Recommended badge */}
            <div className="absolute -top-3.5 left-8">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-600 px-4 py-1.5 text-xs font-semibold text-white shadow-lg shadow-amber-600/20">
                <Zap className="w-3.5 h-3.5" />
                Recommended
              </span>
            </div>

            <div className="flex items-center gap-3 mb-2 mt-2">
              <div className="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-br from-amber-500 to-orange-500 shadow-lg">
                <Presentation className="w-5 h-5 text-white" />
              </div>
              <div>
                <h3 className="text-xl font-bold text-zinc-900">
                  Hands-on Workshop
                </h3>
                <div className="flex items-center gap-1.5 text-sm text-zinc-500">
                  <Clock className="w-3.5 h-3.5" />
                  <span>2 Hours</span>
                </div>
              </div>
            </div>

            <p className="text-sm text-zinc-500 mb-6">
              Best for technical teams familiar with CLIs or IDEs with background
              agents, aiming to move to agentic coding.
            </p>

            {/* Timeline */}
            <motion.div
              variants={container}
              initial="hidden"
              whileInView="show"
              viewport={{ once: true }}
              className="space-y-4"
            >
              {workshopTimeline.map((step) => (
                <motion.div
                  key={step.title}
                  variants={item}
                  className="flex gap-4"
                >
                  <div className="flex flex-col items-center">
                    <div className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-amber-50 border border-amber-200">
                      <step.icon className="w-4 h-4 text-amber-700" />
                    </div>
                    <div className="w-px flex-1 bg-amber-200/50 mt-2" />
                  </div>
                  <div className="pb-4">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-mono font-semibold text-amber-700 bg-amber-50 px-2 py-0.5 rounded">
                        {step.time}
                      </span>
                      <h4 className="text-sm font-semibold text-zinc-900">
                        {step.title}
                      </h4>
                    </div>
                    <p className="text-sm text-zinc-500 leading-relaxed">
                      {step.description}
                    </p>
                  </div>
                </motion.div>
              ))}
            </motion.div>

            <div className="mt-4 p-4 rounded-xl bg-zinc-50 border border-zinc-100">
              <p className="text-xs text-zinc-500">
                <span className="font-semibold text-zinc-700">
                  Pre-Workshop Setup:
                </span>{" "}
                We can spin up dedicated, temporary servers for your team that can
                be wiped after the session.
              </p>
            </div>
          </motion.div>

          {/* Option 2: Strategy Briefing */}
          <motion.div
            initial={{ opacity: 0, x: 20 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: "-50px" }}
            transition={{ duration: 0.5 }}
            className="relative rounded-2xl border border-zinc-200 bg-white p-8 hover:border-zinc-300 transition-colors"
          >
            <div className="flex items-center gap-3 mb-2">
              <div className="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-br from-zinc-600 to-zinc-800 shadow-lg">
                <BarChart3 className="w-5 h-5 text-white" />
              </div>
              <div>
                <h3 className="text-xl font-bold text-zinc-900">
                  Agentic Strategy Briefing
                </h3>
                <div className="flex items-center gap-1.5 text-sm text-zinc-500">
                  <Clock className="w-3.5 h-3.5" />
                  <span>1 Hour</span>
                </div>
              </div>
            </div>

            <p className="text-sm text-zinc-500 mb-6">
              Best for teams looking for a high-level conceptual roadmap to
              understand the agentic coding landscape.
            </p>

            <motion.div
              variants={container}
              initial="hidden"
              whileInView="show"
              viewport={{ once: true }}
              className="space-y-4"
            >
              {briefingTopics.map((topic) => (
                <motion.div
                  key={topic.title}
                  variants={item}
                  className="p-4 rounded-xl bg-zinc-50 border border-zinc-100"
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-mono font-semibold text-zinc-600 bg-zinc-100 px-2 py-0.5 rounded">
                      {topic.time}
                    </span>
                    <h4 className="text-sm font-semibold text-zinc-900">
                      {topic.title}
                    </h4>
                  </div>
                  <p className="text-sm text-zinc-500 leading-relaxed">
                    {topic.description}
                  </p>
                </motion.div>
              ))}
            </motion.div>
          </motion.div>
        </div>

        {/* CTA */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="text-center mb-12"
        >
          <a
            href="mailto:contact@desplega.sh?subject=Agentic%20SDLC%20Workshop%20Inquiry"
            className="group inline-flex items-center gap-2 rounded-xl bg-amber-600 px-8 py-4 text-sm font-semibold text-white hover:bg-amber-500 transition-all shadow-xl shadow-amber-600/20"
          >
            Book a Free Workshop
            <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" />
          </a>
        </motion.div>

        {/* References */}
        <motion.div
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5, delay: 0.2 }}
          className="flex flex-wrap justify-center gap-x-6 gap-y-2"
        >
          {references.map((ref) => (
            <a
              key={ref.label}
              href={ref.href}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-amber-700 transition-colors"
            >
              <ExternalLink className="w-3 h-3" />
              {ref.label}
            </a>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
