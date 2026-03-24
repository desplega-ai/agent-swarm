"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { Mail, ArrowRight, Check, Loader2 } from "lucide-react";
import { joinWaitlist } from "@/app/actions/waitlist";

type Status = "idle" | "loading" | "success" | "error";

export function Waitlist() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || status === "loading") return;

    setStatus("loading");
    setErrorMsg("");

    const result = await joinWaitlist(email.trim());

    if (result.success) {
      setStatus("success");
      setEmail("");
    } else {
      setStatus("error");
      setErrorMsg(result.error);
    }
  }

  return (
    <section className="relative py-24 overflow-hidden bg-zinc-50">
      <div className="absolute inset-0 grid-bg opacity-20" />

      <div className="relative mx-auto max-w-2xl px-6 text-center">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
        >
          <div className="inline-flex items-center gap-2 rounded-full bg-amber-50 border border-amber-200/60 px-4 py-1.5 mb-6">
            <Mail className="w-4 h-4 text-amber-600" />
            <span className="text-sm font-medium text-amber-800">Coming Soon</span>
          </div>

          <h2 className="text-3xl sm:text-4xl font-bold tracking-tight text-zinc-900 mb-4">
            Interested in a hosted version?
          </h2>
          <p className="text-lg text-zinc-500 max-w-lg mx-auto mb-10">
            Skip the self-hosting. Join the waitlist for managed Agent Swarm — we&apos;ll handle the
            infrastructure so you can focus on your agents.
          </p>

          {status === "success" ? (
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="inline-flex items-center gap-2 rounded-xl bg-emerald-50 border border-emerald-200 px-6 py-3.5 text-sm font-semibold text-emerald-700"
            >
              <Check className="w-4 h-4" />
              You&apos;re on the list!
            </motion.div>
          ) : (
            <form onSubmit={handleSubmit} className="flex flex-col items-center gap-3">
              <div className="flex w-full max-w-md gap-3">
                <input
                  type="email"
                  placeholder="you@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={status === "loading"}
                  className="flex-1 rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-amber-500/40 focus:border-amber-400 disabled:opacity-60 transition-all"
                />
                <button
                  type="submit"
                  disabled={status === "loading" || !email.trim()}
                  className="group inline-flex items-center gap-2 rounded-xl bg-zinc-900 px-6 py-3 text-sm font-semibold text-white hover:bg-zinc-800 disabled:opacity-60 disabled:cursor-not-allowed transition-all shadow-lg shadow-zinc-900/10"
                >
                  {status === "loading" ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <>
                      Join
                      <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" />
                    </>
                  )}
                </button>
              </div>

              {status === "error" && (
                <motion.p
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="text-sm text-red-500"
                >
                  {errorMsg}
                </motion.p>
              )}
            </form>
          )}
        </motion.div>
      </div>
    </section>
  );
}
