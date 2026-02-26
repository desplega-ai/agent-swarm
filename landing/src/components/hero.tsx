"use client";

import { motion } from "framer-motion";
import { ArrowRight, Github, Sparkles } from "lucide-react";

function SwarmVisualization() {
  const nodes = [
    { x: 50, y: 50, label: "Lead", size: 18, delay: 0 },
    { x: 20, y: 25, label: "W1", size: 12, delay: 0.2 },
    { x: 80, y: 20, label: "W2", size: 12, delay: 0.4 },
    { x: 15, y: 70, label: "W3", size: 12, delay: 0.6 },
    { x: 85, y: 75, label: "W4", size: 12, delay: 0.8 },
    { x: 50, y: 85, label: "W5", size: 12, delay: 1.0 },
  ];

  const connections = [
    [0, 1], [0, 2], [0, 3], [0, 4], [0, 5],
    [1, 2], [3, 4], [4, 5],
  ];

  return (
    <div className="relative w-full aspect-square max-w-lg mx-auto">
      <div className="absolute inset-0 rounded-full bg-gradient-to-br from-amber-100/50 to-amber-50/20 blur-3xl" />

      <svg viewBox="0 0 100 100" className="relative w-full h-full">
        {connections.map(([from, to], i) => (
          <motion.line
            key={i}
            x1={nodes[from].x}
            y1={nodes[from].y}
            x2={nodes[to].x}
            y2={nodes[to].y}
            stroke="url(#lineGrad)"
            strokeWidth="0.3"
            initial={{ pathLength: 0, opacity: 0 }}
            animate={{ pathLength: 1, opacity: 0.4 }}
            transition={{ duration: 1.5, delay: 0.5 + i * 0.1, ease: "easeOut" }}
          />
        ))}

        {/* Animated data particles along connections */}
        {connections.slice(0, 5).map(([from, to], i) => (
          <motion.circle
            key={`particle-${i}`}
            r="0.8"
            fill="oklch(0.769 0.188 70.08)"
            initial={{ opacity: 0 }}
            animate={{
              cx: [nodes[from].x, nodes[to].x],
              cy: [nodes[from].y, nodes[to].y],
              opacity: [0, 1, 1, 0],
            }}
            transition={{
              duration: 2,
              delay: 1.5 + i * 0.6,
              repeat: Infinity,
              repeatDelay: 2,
              ease: "easeInOut",
            }}
          />
        ))}

        {nodes.map((node, i) => (
          <motion.g
            key={i}
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 0.5, delay: node.delay, type: "spring", stiffness: 200 }}
          >
            <motion.circle
              cx={node.x}
              cy={node.y}
              r={node.size * 0.8}
              fill="none"
              stroke="oklch(0.555 0.163 48.998)"
              strokeWidth="0.15"
              animate={{ r: [node.size * 0.8, node.size * 1.2, node.size * 0.8] }}
              transition={{ duration: 3, repeat: Infinity, delay: node.delay }}
              opacity={0.2}
            />
            <circle
              cx={node.x}
              cy={node.y}
              r={node.size * 0.5}
              fill={i === 0 ? "oklch(0.555 0.163 48.998)" : "oklch(0.967 0.001 286.375)"}
              stroke={i === 0 ? "oklch(0.473 0.137 46.201)" : "oklch(0.92 0.004 286.32)"}
              strokeWidth="0.5"
            />
            <text
              x={node.x}
              y={node.y + 1.2}
              textAnchor="middle"
              fontSize="3"
              fontWeight={i === 0 ? "700" : "500"}
              fill={i === 0 ? "white" : "oklch(0.552 0.016 285.938)"}
              fontFamily="Space Grotesk, sans-serif"
            >
              {node.label}
            </text>
          </motion.g>
        ))}

        <defs>
          <linearGradient id="lineGrad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="oklch(0.555 0.163 48.998)" />
            <stop offset="100%" stopColor="oklch(0.769 0.188 70.08)" />
          </linearGradient>
        </defs>
      </svg>
    </div>
  );
}

export function Hero() {
  return (
    <section className="relative min-h-screen flex items-center overflow-hidden">
      {/* Background grid */}
      <div className="absolute inset-0 grid-bg opacity-40" />

      {/* Gradient orbs */}
      <div className="absolute top-20 -left-40 w-96 h-96 rounded-full bg-amber-200/20 blur-[100px] animate-pulse-glow" />
      <div className="absolute bottom-20 -right-40 w-96 h-96 rounded-full bg-amber-300/15 blur-[100px] animate-pulse-glow" style={{ animationDelay: "1.5s" }} />

      <div className="relative mx-auto max-w-6xl px-6 pt-32 pb-20 w-full">
        <div className="grid lg:grid-cols-2 gap-16 items-center">
          <div>
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6 }}
              className="inline-flex items-center gap-2 rounded-full bg-amber-50 border border-amber-200/60 px-4 py-1.5 mb-8"
            >
              <Sparkles className="w-4 h-4 text-amber-600" />
              <span className="text-sm font-medium text-amber-800">
                Open Source &middot; MCP-Powered
              </span>
            </motion.div>

            <motion.h1
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.1 }}
              className="text-5xl sm:text-6xl lg:text-7xl font-bold tracking-tight leading-[1.05] mb-6"
            >
              Intelligence that{" "}
              <span className="gradient-text">compounds</span>
            </motion.h1>

            <motion.p
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.2 }}
              className="text-lg sm:text-xl text-zinc-500 leading-relaxed mb-10 max-w-xl"
            >
              Orchestrate autonomous AI agents that learn, remember, and get
              smarter with every session. A lead coordinates workers. Memory
              persists. Knowledge compounds.
            </motion.p>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.3 }}
              className="flex flex-wrap gap-4"
            >
              <a
                href="https://github.com/desplega-ai/agent-swarm"
                target="_blank"
                rel="noopener noreferrer"
                className="group inline-flex items-center gap-2 rounded-xl bg-zinc-900 px-6 py-3 text-sm font-semibold text-white hover:bg-zinc-800 transition-all shadow-xl shadow-zinc-900/20 hover:shadow-zinc-900/30"
              >
                <Github className="w-4 h-4" />
                Get Started
                <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" />
              </a>
              <a
                href="https://github.com/desplega-ai/agent-swarm#readme"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-xl bg-white px-6 py-3 text-sm font-semibold text-zinc-700 border border-zinc-200 hover:border-zinc-300 hover:bg-zinc-50 transition-all shadow-sm"
              >
                Read the Docs
              </a>
            </motion.div>

            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.6, delay: 0.5 }}
              className="mt-10 flex items-center gap-6 text-sm text-zinc-400"
            >
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                TypeScript
              </div>
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" style={{ animationDelay: "0.5s" }} />
                MCP Protocol
              </div>
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" style={{ animationDelay: "1s" }} />
                Claude Code
              </div>
            </motion.div>
          </div>

          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.8, delay: 0.3 }}
            className="hidden lg:block"
          >
            <SwarmVisualization />
          </motion.div>
        </div>
      </div>
    </section>
  );
}
