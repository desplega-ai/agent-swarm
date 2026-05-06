"use client";

import { useState, useEffect } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Github, Menu, X, ArrowRight } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";

type Props = {
  /** When true, the navbar starts dark over a full-bleed dark hero and inverts to light past the fold. */
  darkAboveFold?: boolean;
};

export function Navbar({ darkAboveFold = false }: Props) {
  const [scrolled, setScrolled] = useState(false);
  const [pastHero, setPastHero] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY;
      setScrolled(y > 12);
      setPastHero(y > window.innerHeight - 80);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const dark = darkAboveFold && !pastHero;
  const pathname = usePathname() ?? "/";

  const isActive = (href: string) => {
    if (href === "/") return pathname === "/";
    if (href.startsWith("http")) return false;
    return pathname === href || pathname.startsWith(`${href}/`);
  };

  const activeCls = dark
    ? "text-amber-300 font-semibold"
    : "text-amber-700 font-semibold";

  const baseBar = dark
    ? scrolled
      ? "bg-zinc-950/80 backdrop-blur-xl border-b border-white/[0.06]"
      : "bg-transparent"
    : scrolled
      ? "bg-white/85 backdrop-blur-xl border-b border-zinc-100"
      : "bg-transparent";

  const linkCls = dark ? "text-zinc-300 hover:text-white" : "text-zinc-600 hover:text-zinc-950";
  const ghCls = dark
    ? "text-zinc-200 hover:text-white hover:bg-white/[0.06]"
    : "text-zinc-700 hover:text-zinc-950 hover:bg-zinc-50";
  const wordCls = dark ? "text-white" : "text-zinc-950";

  return (
    <nav className={`fixed top-0 inset-x-0 z-50 transition-colors duration-300 ${baseBar}`}>
      <div className="mx-auto max-w-[1180px] px-6 sm:px-7 h-[68px] flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2.5">
          <Image
            src="/logo.png"
            alt="Agent Swarm"
            width={28}
            height={28}
            className="rounded-md"
            style={{ boxShadow: "0 4px 14px -2px oklch(0.769 0.188 70.08 / 0.35)" }}
            priority
          />
          <span className={`font-semibold tracking-[-0.01em] transition-colors ${wordCls}`}>
            Agent Swarm
          </span>
        </Link>

        <div
          className={`hidden md:flex items-center gap-9 text-[14px] transition-colors ${
            dark ? "text-zinc-300" : "text-zinc-600"
          }`}
        >
          <a href="/#features" className={`transition-colors ${linkCls}`}>
            Features
          </a>
          <a href="/#how" className={`transition-colors ${linkCls}`}>
            How it works
          </a>
          <Link
            href="/pricing"
            className={`transition-colors ${isActive("/pricing") ? activeCls : linkCls}`}
          >
            Pricing
          </Link>
          <Link
            href="/blog"
            className={`transition-colors ${isActive("/blog") ? activeCls : linkCls}`}
          >
            Blog
          </Link>
          <a href="https://docs.agent-swarm.dev" className={`transition-colors ${linkCls}`}>
            Docs
          </a>
        </div>

        <div className="flex items-center gap-1.5">
          <a
            className={`hidden sm:inline-flex items-center gap-1.5 text-[13.5px] font-medium px-3 h-9 rounded-md transition-colors ${ghCls}`}
            href="https://github.com/desplega-ai/agent-swarm"
            target="_blank"
            rel="noopener noreferrer"
          >
            <Github className="w-[15px] h-[15px]" /> GitHub
          </a>
          <a
            className="hidden sm:inline-flex items-center gap-1.5 text-[13.5px] font-semibold text-white bg-amber-700 hover:bg-amber-600 px-4 h-9 rounded-md transition-colors"
            style={{
              boxShadow:
                "0 1px 0 0 oklch(0.473 0.137 46.201) inset, 0 8px 20px -8px oklch(0.555 0.163 48.998 / 0.55)",
            }}
            href="https://cloud.agent-swarm.dev"
          >
            Start free trial
          </a>
          <button
            type="button"
            onClick={() => setMobileOpen((s) => !s)}
            className={`md:hidden p-2 transition-colors ${dark ? "text-zinc-200" : "text-zinc-700"}`}
            aria-label="Toggle menu"
          >
            {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>
      </div>

      <AnimatePresence>
        {mobileOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className={`md:hidden overflow-hidden border-b ${
              dark
                ? "bg-zinc-950/95 border-white/[0.06]"
                : "bg-white/95 backdrop-blur-xl border-zinc-100"
            }`}
          >
            <div className="px-6 py-4 flex flex-col gap-3">
              <a
                href="/#features"
                onClick={() => setMobileOpen(false)}
                className={`text-sm font-medium py-2 ${linkCls}`}
              >
                Features
              </a>
              <a
                href="/#how"
                onClick={() => setMobileOpen(false)}
                className={`text-sm font-medium py-2 ${linkCls}`}
              >
                How it works
              </a>
              <Link
                href="/pricing"
                onClick={() => setMobileOpen(false)}
                className={`text-sm font-medium py-2 ${isActive("/pricing") ? activeCls : linkCls}`}
              >
                Pricing
              </Link>
              <Link
                href="/blog"
                onClick={() => setMobileOpen(false)}
                className={`text-sm font-medium py-2 ${isActive("/blog") ? activeCls : linkCls}`}
              >
                Blog
              </Link>
              <a
                href="https://docs.agent-swarm.dev"
                onClick={() => setMobileOpen(false)}
                className={`text-sm font-medium py-2 ${linkCls}`}
              >
                Docs
              </a>
              <a
                href="https://github.com/desplega-ai/agent-swarm"
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setMobileOpen(false)}
                className={`flex items-center gap-2 text-sm font-medium py-2 ${linkCls}`}
              >
                <Github className="w-4 h-4" /> GitHub
              </a>
              <div className="h-px bg-zinc-200/40" />
              <a
                href="https://cloud.agent-swarm.dev"
                onClick={() => setMobileOpen(false)}
                className="inline-flex items-center justify-center gap-1.5 rounded-md bg-amber-700 px-4 h-10 text-sm font-semibold text-white"
              >
                Start free trial <ArrowRight className="w-4 h-4" />
              </a>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </nav>
  );
}
