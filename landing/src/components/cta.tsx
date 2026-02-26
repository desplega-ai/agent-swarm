"use client";

import { motion } from "framer-motion";
import { ArrowRight, Github } from "lucide-react";

export function CTA() {
  return (
    <section className="relative py-32 overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-br from-zinc-900 via-zinc-900 to-zinc-800" />
      <div className="absolute inset-0 grid-bg opacity-5" />

      {/* Amber glow */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] rounded-full bg-amber-500/5 blur-[120px]" />

      <div className="relative mx-auto max-w-4xl px-6 text-center">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
        >
          <h2 className="text-4xl sm:text-5xl font-bold tracking-tight text-white mb-6">
            Ready to build your swarm?
          </h2>
          <p className="text-lg text-zinc-400 max-w-xl mx-auto mb-10">
            Agent Swarm is open source and ready to deploy. Start with one lead
            and one worker — scale as your ambitions grow.
          </p>

          <div className="flex flex-wrap justify-center gap-4">
            <a
              href="https://docs.agent-swarm.dev/docs/getting-started"
              className="group inline-flex items-center gap-2 rounded-xl bg-amber-600 px-7 py-3.5 text-sm font-semibold text-white hover:bg-amber-500 transition-all shadow-xl shadow-amber-600/20"
            >
              Get Started
              <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" />
            </a>
            <a
              href="https://github.com/desplega-ai/agent-swarm"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-xl bg-white/10 backdrop-blur-sm px-7 py-3.5 text-sm font-semibold text-white border border-white/10 hover:bg-white/15 transition-all"
            >
              <Github className="w-4 h-4" />
              Star on GitHub
            </a>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
