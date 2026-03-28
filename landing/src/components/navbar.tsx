"use client";

import { useState, useEffect } from "react";
import Image from "next/image";
import Link from "next/link";
import { Github, BookOpen, Menu, X, Blocks, ArrowRight, DollarSign } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

export function Navbar({ animate = true }: { animate?: boolean }) {
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener("scroll", onScroll);
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <motion.nav
      initial={animate ? { y: -100 } : false}
      animate={animate ? { y: 0 } : undefined}
      transition={animate ? { duration: 0.6, ease: "easeOut" } : undefined}
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
        scrolled
          ? "bg-white/80 backdrop-blur-xl border-b border-zinc-200/60 shadow-sm"
          : "bg-transparent"
      }`}
    >
      <div className="mx-auto max-w-6xl px-6 py-4 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-3 group">
          <Image
            src="/logo.png"
            alt="Agent Swarm"
            width={32}
            height={32}
            className="rounded-lg shadow-lg shadow-amber-500/20 group-hover:shadow-amber-500/40 transition-shadow"
            priority
          />
          <span className="text-lg font-bold tracking-tight text-zinc-900">Agent Swarm</span>
        </Link>

        <div className="hidden md:flex items-center gap-6">
          <a
            href="https://docs.agent-swarm.dev"
            className="flex items-center gap-1.5 text-sm font-medium text-zinc-600 hover:text-zinc-900 transition-colors"
          >
            <BookOpen className="w-4 h-4" />
            Docs
          </a>
          <Link
            href="/pricing"
            className="flex items-center gap-1.5 text-sm font-medium text-zinc-600 hover:text-zinc-900 transition-colors"
          >
            <DollarSign className="w-4 h-4" />
            Pricing
          </Link>
          <Link
            href="/blog"
            className="text-sm font-medium text-zinc-600 hover:text-zinc-900 transition-colors"
          >
            Blog
          </Link>
          <a
            href="https://templates.agent-swarm.dev"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-sm font-medium text-zinc-600 hover:text-zinc-900 transition-colors"
          >
            <Blocks className="w-4 h-4" />
            Templates
          </a>
          <a
            href="https://github.com/desplega-ai/agent-swarm"
            target="_blank"
            rel="noopener noreferrer"
            className="text-zinc-600 hover:text-zinc-900 transition-colors"
            aria-label="GitHub"
          >
            <Github className="w-5 h-5" />
          </a>
          <a
            href="https://cloud.agent-swarm.dev"
            className="inline-flex items-center gap-2 rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-500 transition-colors shadow-lg shadow-amber-600/20"
          >
            Start Free Trial
            <ArrowRight className="w-4 h-4" />
          </a>
        </div>

        <button onClick={() => setMobileOpen(!mobileOpen)} className="md:hidden p-2 text-zinc-600">
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
              <a
                href="https://docs.agent-swarm.dev"
                onClick={() => setMobileOpen(false)}
                className="flex items-center gap-2 text-sm font-medium text-zinc-600 py-2"
              >
                <BookOpen className="w-4 h-4" /> Docs
              </a>
              <Link
                href="/pricing"
                onClick={() => setMobileOpen(false)}
                className="flex items-center gap-2 text-sm font-medium text-zinc-600 py-2"
              >
                <DollarSign className="w-4 h-4" /> Pricing
              </Link>
              <Link
                href="/blog"
                onClick={() => setMobileOpen(false)}
                className="text-sm font-medium text-zinc-600 py-2"
              >
                Blog
              </Link>
              <a
                href="https://templates.agent-swarm.dev"
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setMobileOpen(false)}
                className="flex items-center gap-2 text-sm font-medium text-zinc-600 py-2"
              >
                <Blocks className="w-4 h-4" /> Templates
              </a>
              <a
                href="https://github.com/desplega-ai/agent-swarm"
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setMobileOpen(false)}
                className="flex items-center gap-2 text-sm font-medium text-zinc-600 py-2"
              >
                <Github className="w-4 h-4" /> GitHub
              </a>
              <div className="h-px bg-zinc-200" />
              <a
                href="https://cloud.agent-swarm.dev"
                onClick={() => setMobileOpen(false)}
                className="flex items-center gap-2 justify-center rounded-lg bg-amber-600 px-4 py-2.5 text-sm font-semibold text-white"
              >
                Start Free Trial
                <ArrowRight className="w-4 h-4" />
              </a>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.nav>
  );
}
