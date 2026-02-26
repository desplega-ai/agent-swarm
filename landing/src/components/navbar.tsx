"use client";

import { useState, useEffect } from "react";
import { Github, BookOpen, LayoutDashboard, Menu, X } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

export function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener("scroll", onScroll);
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <motion.nav
      initial={{ y: -100 }}
      animate={{ y: 0 }}
      transition={{ duration: 0.6, ease: "easeOut" }}
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
        scrolled
          ? "bg-white/80 backdrop-blur-xl border-b border-zinc-200/60 shadow-sm"
          : "bg-transparent"
      }`}
    >
      <div className="mx-auto max-w-6xl px-6 py-4 flex items-center justify-between">
        <a href="#" className="flex items-center gap-3 group">
          <img src="/logo.png" alt="Agent Swarm" className="w-8 h-8 rounded-lg shadow-lg shadow-amber-500/20 group-hover:shadow-amber-500/40 transition-shadow" />
          <span className="text-lg font-bold tracking-tight text-zinc-900">
            Agent Swarm
          </span>
        </a>

        <div className="hidden md:flex items-center gap-6">
          <a
            href="#features"
            className="text-sm font-medium text-zinc-600 hover:text-zinc-900 transition-colors"
          >
            Features
          </a>
          <a
            href="#how-it-works"
            className="text-sm font-medium text-zinc-600 hover:text-zinc-900 transition-colors"
          >
            How It Works
          </a>
          <a
            href="#architecture"
            className="text-sm font-medium text-zinc-600 hover:text-zinc-900 transition-colors"
          >
            Architecture
          </a>
          <div className="w-px h-5 bg-zinc-200" />
          <a
            href="https://docs.agent-swarm.dev"
            className="flex items-center gap-1.5 text-sm font-medium text-zinc-600 hover:text-zinc-900 transition-colors"
          >
            <BookOpen className="w-4 h-4" />
            Docs
          </a>
          <a
            href="https://app.agent-swarm.dev"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-sm font-medium text-amber-700 hover:text-amber-900 transition-colors"
          >
            <LayoutDashboard className="w-4 h-4" />
            Dashboard
          </a>
          <a
            href="https://github.com/desplega-ai/agent-swarm"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 transition-colors shadow-lg shadow-zinc-900/10"
          >
            <Github className="w-4 h-4" />
            GitHub
          </a>
        </div>

        <button
          onClick={() => setMobileOpen(!mobileOpen)}
          className="md:hidden p-2 text-zinc-600"
        >
          {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
        </button>
      </div>

      <AnimatePresence>
        {mobileOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="md:hidden overflow-hidden bg-white/95 backdrop-blur-xl border-b border-zinc-200"
          >
            <div className="px-6 py-4 flex flex-col gap-3">
              <a href="#features" onClick={() => setMobileOpen(false)} className="text-sm font-medium text-zinc-600 py-2">Features</a>
              <a href="#how-it-works" onClick={() => setMobileOpen(false)} className="text-sm font-medium text-zinc-600 py-2">How It Works</a>
              <a href="#architecture" onClick={() => setMobileOpen(false)} className="text-sm font-medium text-zinc-600 py-2">Architecture</a>
              <div className="h-px bg-zinc-200" />
              <a href="https://docs.agent-swarm.dev" className="flex items-center gap-2 text-sm font-medium text-zinc-600 py-2">
                <BookOpen className="w-4 h-4" /> Docs
              </a>
              <a href="https://app.agent-swarm.dev" target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 text-sm font-medium text-amber-700 py-2">
                <LayoutDashboard className="w-4 h-4" /> Dashboard
              </a>
              <a href="https://github.com/desplega-ai/agent-swarm" target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 justify-center rounded-lg bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white">
                <Github className="w-4 h-4" /> View on GitHub
              </a>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.nav>
  );
}
