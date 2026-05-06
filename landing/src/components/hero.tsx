import { ArrowRight, Github } from "lucide-react";
import { HiveScroll } from "@/components/hive-scroll";
import { StarCount } from "@/components/star-count";
import { getLatestRelease, getStarCount } from "@/lib/stars";

export async function Hero() {
  const [stars, version] = await Promise.all([getStarCount(), getLatestRelease()]);

  return (
    <section
      className="relative min-h-screen flex items-center overflow-hidden bg-zinc-950 text-white"
      style={{ clipPath: "inset(0)" }}
    >
      <div
        className="absolute inset-0 opacity-[0.06] pointer-events-none"
        style={{
          backgroundImage:
            "linear-gradient(rgba(255,255,255,.5) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.5) 1px, transparent 1px)",
          backgroundSize: "60px 60px",
        }}
      />
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: [
            "radial-gradient(ellipse 60% 45% at 50% 0%, oklch(0.555 0.163 48.998 / 0.28), transparent 65%)",
            "radial-gradient(ellipse 38% 28% at 50% 50%, oklch(0.141 0.005 285.823 / 0.78), transparent 75%)",
            "linear-gradient(180deg, transparent 65%, oklch(0.141 0.005 285.823) 100%)",
          ].join(", "),
        }}
      />

      <HiveScroll />

      <div className="relative w-full max-w-[980px] mx-auto px-7 text-center py-24">
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/[0.06] border border-white/[0.12] text-zinc-400 text-[12px] mb-9 backdrop-blur-sm">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
          <span className="font-mono tracking-[0.04em] text-[11px]">
            <span className="text-amber-300">{version}</span> · MIT · <StarCount count={stars} /> stars
          </span>
        </div>

        <h1
          className="text-[clamp(48px,7vw,104px)] font-semibold tracking-[-0.04em] leading-[0.96] max-w-[18ch] mx-auto"
          style={{ textWrap: "balance" }}
        >
          <span className="text-white">Intelligence that compounds.</span>
          <br />
          <span className="italic text-white">Every single day</span>
          <span className="text-white">.</span>
        </h1>

        <p
          className="mt-8 text-[18.5px] text-zinc-400 leading-[1.55] max-w-[52ch] mx-auto"
          style={{ textWrap: "pretty" }}
        >
          A lead delegates. Workers ship in Docker.{" "}
          <span className="text-white">Memory persists across every task</span> so tomorrow&apos;s
          swarm is sharper than today&apos;s.
        </p>

        <div className="mt-11 flex flex-row gap-2.5 sm:gap-3 justify-center">
          <a
            href="https://cloud.agent-swarm.dev"
            className="inline-flex items-center justify-center gap-2 bg-amber-500 hover:bg-amber-400 text-zinc-950 text-[13px] sm:text-[14px] font-semibold px-4 sm:px-5 h-11 rounded-xl transition whitespace-nowrap"
            style={{ boxShadow: "0 14px 40px -8px oklch(0.769 0.188 70.08 / 0.55)" }}
          >
            Start free trial <ArrowRight className="w-[15px] h-[15px]" />
          </a>
          <a
            href="https://github.com/desplega-ai/agent-swarm"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center gap-2 bg-white/[0.06] hover:bg-white/[0.1] backdrop-blur-sm text-white text-[13px] sm:text-[14px] font-semibold px-4 sm:px-5 h-11 rounded-xl border border-white/[0.12] transition whitespace-nowrap"
          >
            <Github className="w-[15px] h-[15px]" />
            <StarCount count={stars} format="star" />
            <span className="hidden sm:inline"> · Star on GitHub</span>
          </a>
        </div>

        <div className="mt-14 flex flex-col items-center gap-3">
          <div className="flex flex-wrap items-baseline justify-center gap-x-3">
            <span className="font-mono text-[10.5px] tracking-[0.18em] text-zinc-500 uppercase">
              Models
            </span>
            <span className="font-mono text-[12px] tracking-[0.04em] text-zinc-300">
              <span className="text-white">Claude Code</span> · Codex · Devin
              <span className="hidden sm:inline"> · OpenCode</span> ·{" "}
              <span className="text-zinc-500">+ more</span>
            </span>
          </div>
          <div className="flex flex-wrap items-baseline justify-center gap-x-3">
            <span className="font-mono text-[10.5px] tracking-[0.18em] text-zinc-500 uppercase">
              Lives in
            </span>
            <span className="font-mono text-[12px] tracking-[0.04em] text-zinc-300">
              Slack · GitHub · GitLab
              <span className="hidden sm:inline"> · Linear · Jira · Email · API</span> ·{" "}
              <span className="text-zinc-500">+ more</span>
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
