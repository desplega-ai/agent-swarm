import { ArrowRight, Github } from "lucide-react";

export function CTA() {
  return (
    <section className="relative py-28 overflow-hidden bg-zinc-950">
      <div
        className="absolute inset-1/2 w-[680px] h-[680px] -translate-x-1/2 -translate-y-1/2 rounded-full pointer-events-none"
        style={{
          background:
            "radial-gradient(circle, oklch(0.769 0.188 70.08 / 0.18), transparent 60%)",
          filter: "blur(40px)",
        }}
      />
      <div
        className="absolute inset-0 opacity-[0.07] pointer-events-none"
        style={{
          backgroundImage:
            "linear-gradient(rgba(255,255,255,.5) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.5) 1px, transparent 1px)",
          backgroundSize: "60px 60px",
        }}
      />

      <div className="relative max-w-3xl mx-auto px-6 sm:px-7 text-center">
        <div className="font-mono text-[11px] tracking-[0.14em] uppercase text-amber-400 mb-5">
          / get started
        </div>
        <h2 className="text-[40px] sm:text-[56px] leading-[1.02] font-semibold tracking-[-0.025em] text-white">
          Build your swarm tonight.
        </h2>
        <p className="mt-5 text-[17px] text-zinc-400 leading-[1.55] max-w-xl mx-auto">
          A 7-day free trial on Cloud, or fork it on GitHub. Either way, your agents start
          compounding today.
        </p>
        <div className="mt-9 flex flex-wrap justify-center gap-3">
          <a
            href="https://cloud.agent-swarm.dev"
            className="inline-flex items-center gap-1.5 bg-amber-500 hover:bg-amber-400 text-zinc-950 text-[14px] font-semibold px-6 h-11 rounded-xl transition"
          >
            Start free trial <ArrowRight className="w-[15px] h-[15px]" />
          </a>
          <a
            href="https://github.com/desplega-ai/agent-swarm"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 bg-white/[0.06] hover:bg-white/[0.1] backdrop-blur-sm text-white text-[14px] font-semibold px-6 h-11 rounded-xl border border-white/[0.08] transition"
          >
            <Github className="w-[15px] h-[15px]" /> Self-host
          </a>
        </div>
      </div>
    </section>
  );
}
