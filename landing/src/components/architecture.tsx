"use client";

import { motion } from "framer-motion";

export function Architecture() {
  return (
    <section id="architecture" className="relative py-32 overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-b from-white via-zinc-50/50 to-white" />

      <div className="relative mx-auto max-w-6xl px-6">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.6 }}
          className="text-center mb-20"
        >
          <span className="inline-block text-sm font-semibold text-amber-700 tracking-wider uppercase mb-4">
            Architecture
          </span>
          <h2 className="text-4xl sm:text-5xl font-bold tracking-tight mb-6">
            Built for compounding
          </h2>
          <p className="text-lg text-zinc-500 max-w-2xl mx-auto">
            Every layer is designed so the swarm gets better the longer it runs.
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-50px" }}
          transition={{ duration: 0.7 }}
          className="relative max-w-4xl mx-auto"
        >
          {/* Architecture diagram */}
          <div className="rounded-2xl bg-white border border-zinc-200 overflow-hidden shadow-xl shadow-zinc-100/50">
            {/* Header */}
            <div className="bg-zinc-900 px-6 py-4 flex items-center gap-3">
              <div className="flex gap-1.5">
                <div className="w-3 h-3 rounded-full bg-red-400" />
                <div className="w-3 h-3 rounded-full bg-yellow-400" />
                <div className="w-3 h-3 rounded-full bg-green-400" />
              </div>
              <span className="text-xs font-mono text-zinc-400">agent-swarm architecture</span>
            </div>

            <div className="p-8">
              {/* Slack / CLI layer */}
              <div className="mb-6">
                <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">
                  Interface Layer
                </div>
                <div className="flex gap-3">
                  <div className="flex-1 rounded-xl border border-zinc-200 bg-zinc-50 p-4 text-center">
                    <div className="text-sm font-semibold text-zinc-700">Slack</div>
                    <div className="text-xs text-zinc-400 mt-1">Mentions &amp; threads</div>
                  </div>
                  <div className="flex-1 rounded-xl border border-zinc-200 bg-zinc-50 p-4 text-center">
                    <div className="text-sm font-semibold text-zinc-700">Claude Code</div>
                    <div className="text-xs text-zinc-400 mt-1">CLI sessions</div>
                  </div>
                  <div className="flex-1 rounded-xl border border-zinc-200 bg-zinc-50 p-4 text-center">
                    <div className="text-sm font-semibold text-zinc-700">Dashboard</div>
                    <div className="text-xs text-zinc-400 mt-1">Web UI</div>
                  </div>
                </div>
              </div>

              {/* Arrow */}
              <div className="flex justify-center my-4">
                <div className="w-px h-8 bg-gradient-to-b from-zinc-300 to-amber-300" />
              </div>

              {/* MCP Server */}
              <div className="mb-6">
                <div className="rounded-xl border-2 border-amber-200 bg-amber-50/50 p-5">
                  <div className="text-center">
                    <div className="text-sm font-bold text-amber-800">MCP Server</div>
                    <div className="text-xs text-amber-600 mt-1">
                      50+ tools: tasks, messaging, memory, services, scheduling, epics
                    </div>
                  </div>
                  <div className="mt-4 flex flex-wrap justify-center gap-2">
                    {["send-task", "store-progress", "memory-search", "post-message", "register-service", "create-epic"].map((tool) => (
                      <span
                        key={tool}
                        className="inline-flex items-center rounded-md bg-amber-100 border border-amber-200/50 px-2 py-0.5 text-xs font-mono text-amber-700"
                      >
                        {tool}
                      </span>
                    ))}
                  </div>
                </div>
              </div>

              {/* Arrow */}
              <div className="flex justify-center my-4">
                <div className="w-px h-8 bg-gradient-to-b from-amber-300 to-zinc-300" />
              </div>

              {/* Agent Grid */}
              <div className="mb-6">
                <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">
                  Agent Layer
                </div>
                <div className="grid grid-cols-4 gap-3">
                  <div className="col-span-4 sm:col-span-1 rounded-xl border-2 border-amber-500/30 bg-amber-50 p-4 text-center">
                    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-amber-500 to-amber-700 mx-auto mb-2 flex items-center justify-center">
                      <span className="text-white text-xs font-bold">L</span>
                    </div>
                    <div className="text-xs font-semibold text-zinc-700">Lead</div>
                    <div className="text-xs text-zinc-400 mt-0.5">Orchestrator</div>
                  </div>
                  {["Worker 1", "Worker 2", "Worker 3"].map((w) => (
                    <div
                      key={w}
                      className="rounded-xl border border-zinc-200 bg-white p-4 text-center"
                    >
                      <div className="w-8 h-8 rounded-full bg-zinc-100 border border-zinc-200 mx-auto mb-2 flex items-center justify-center">
                        <span className="text-zinc-500 text-xs font-bold">W</span>
                      </div>
                      <div className="text-xs font-semibold text-zinc-700">{w}</div>
                      <div className="text-xs text-zinc-400 mt-0.5">Specialist</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Arrow */}
              <div className="flex justify-center my-4">
                <div className="w-px h-8 bg-gradient-to-b from-zinc-300 to-violet-300" />
              </div>

              {/* Persistence layer */}
              <div>
                <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">
                  Persistence Layer
                </div>
                <div className="flex gap-3">
                  <div className="flex-1 rounded-xl border border-violet-200 bg-violet-50/50 p-4 text-center">
                    <div className="text-sm font-semibold text-violet-700">SQLite + Embeddings</div>
                    <div className="text-xs text-violet-500 mt-1">Searchable memory</div>
                  </div>
                  <div className="flex-1 rounded-xl border border-blue-200 bg-blue-50/50 p-4 text-center">
                    <div className="text-sm font-semibold text-blue-700">SOUL.md / IDENTITY.md</div>
                    <div className="text-xs text-blue-500 mt-1">Agent personality</div>
                  </div>
                  <div className="flex-1 rounded-xl border border-emerald-200 bg-emerald-50/50 p-4 text-center">
                    <div className="text-sm font-semibold text-emerald-700">Git Worktrees</div>
                    <div className="text-xs text-emerald-500 mt-1">Isolated workspaces</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
