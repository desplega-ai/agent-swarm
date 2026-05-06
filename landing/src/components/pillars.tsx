const PILLARS = [
  {
    id: "compounds",
    title: "Yesterday’s work makes tomorrow easier",
    body:
      "Most agents start every task from zero. Ours read what they shipped last week before they begin.",
    accent: "oklch(0.879 0.169 91.605)",
  },
  {
    id: "peer",
    title: "A peer, not a tab",
    body:
      "No new dashboard to live in. @mention the bot where you already work: Slack, GitHub, Linear, email, you name it.",
    accent: "oklch(0.769 0.188 70.08)",
  },
  {
    id: "ip",
    title: "Your IP stays yours",
    body:
      "Memory and identity files sit in your DB and filesystem. Audit, fork, walk away with the lot.",
    accent: "oklch(0.555 0.163 48.998)",
  },
  {
    id: "no-lockin",
    title: "No model, no platform lock-in",
    body:
      "BYOK. BYOM. Swap Claude Code for Codex on Tuesday. The memory layer is yours either way.",
    accent: "oklch(0.473 0.137 46.201)",
  },
  {
    id: "self-hosted",
    title: "Self-host first, cloud optional",
    body:
      "MIT. One docker-compose or a k8s Helm chart. Air-gapped if you need it. The cloud version exists for convenience, never as a hostage.",
    accent: "oklch(0.555 0.163 48.998)",
  },
  {
    id: "velocity",
    title: "You stop being the bottleneck",
    body:
      "A lead plans, workers run in parallel in isolated containers. The swarm ships while you sleep.",
    accent: "oklch(0.769 0.188 70.08)",
  },
];

export function Pillars() {
  return (
    <section
      id="pillars"
      className="relative py-32 bg-white"
      style={{
        background:
          "linear-gradient(180deg, #fff, oklch(0.987 0.022 95.277 / 0.35) 60%, #fff)",
      }}
    >
      <div className="max-w-[1180px] mx-auto px-6 sm:px-7">
        <div className="mb-14 grid lg:grid-cols-[1.1fr_1fr] gap-10 items-end">
          <div>
            <div className="font-mono text-[11px] tracking-[0.14em] uppercase text-amber-700 mb-4">
              / why agent swarm
            </div>
            <h2
              className="text-[40px] sm:text-[56px] leading-[1.0] font-semibold tracking-[-0.03em] text-zinc-950"
              style={{ textWrap: "balance" }}
            >
              Built for the boring
              <br />
              <span className="italic gradient-text">two-year horizon.</span>
            </h2>
          </div>
          <p className="text-[16px] text-zinc-500 leading-[1.6] max-w-md">
            Most agent frameworks optimize for the demo.{" "}
            <br />
            <span className="text-zinc-800">
              We optimize for compounding, ownership, and the right to switch.
            </span>
          </p>
        </div>

        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-px bg-zinc-100 rounded-2xl overflow-hidden border border-zinc-100">
          {PILLARS.map((p, i) => (
            <div
              key={p.id}
              className="bg-white p-7 lg:p-8 relative group hover:bg-amber-50/40 transition-colors"
            >
              <div
                className="absolute top-0 left-7 right-7 h-px"
                style={{
                  background: `linear-gradient(90deg, ${p.accent}, transparent 60%)`,
                  opacity: 0.7,
                }}
              />
              <div className="flex items-center justify-between mb-5">
                <div className="font-mono text-[10.5px] tracking-[0.14em] uppercase text-zinc-400">
                  {String(i + 1).padStart(2, "0")} / 06
                </div>
                <div
                  className="w-1.5 h-1.5 rounded-full"
                  style={{ background: p.accent }}
                />
              </div>
              <h3
                className="text-[22px] font-semibold text-zinc-950 tracking-[-0.015em] mb-3 leading-[1.15]"
                style={{ textWrap: "balance" }}
              >
                {p.title}
              </h3>
              <p
                className="text-[14.5px] text-zinc-500 leading-[1.6]"
                style={{ textWrap: "pretty" }}
              >
                {p.body}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
