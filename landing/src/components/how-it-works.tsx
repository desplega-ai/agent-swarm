type CodeLine = { p: string; t: string; ok?: boolean };

type Step = {
  n: string;
  eyebrow: string;
  title: string;
  desc: string;
  code?: CodeLine[];
  chips?: string[];
};

const STEPS: Step[] = [
  {
    n: "01",
    eyebrow: "install",
    title: "docker compose up",
    desc:
      "Clone, set CLAUDE_CODE_OAUTH_TOKEN in .env, bring it up. The API server, lead, and workers come online in their own containers — no DAG, no agent definition language.",
    code: [
      { p: "$", t: "git clone github.com/desplega-ai/agent-swarm" },
      { p: "$", t: "cp .env.docker.example .env" },
      { p: "$", t: "docker compose up -d" },
      { p: "✓", t: "API on :3013   ✓ Lead online   ✓ 2 workers ready", ok: true },
    ],
  },
  {
    n: "02",
    eyebrow: "connect",
    title: "Wire it into where you work",
    desc:
      "Install the GitHub App, drop the bot in Slack, OAuth Linear, point AgentMail at an inbox. From now on, mentions and assignments become tasks the lead routes.",
    chips: ["Slack", "GitHub", "GitLab", "Linear", "AgentMail", "Sentry", "DataDog", "..."],
  },
  {
    n: "03",
    eyebrow: "compound",
    title: "It gets sharper while you sleep",
    desc:
      "Workers ship. Each task summary is embedded into shared memory. SOUL.md and IDENTITY.md evolve. Tomorrow’s swarm reads what last week’s shipped before it touches a keystroke.",
    chips: ["SOUL.md", "IDENTITY.md", "TOOLS.md", "embeddings", "..."],
  },
];

function StepCard({ step, i }: { step: Step; i: number }) {
  return (
    <div className="relative bg-white rounded-2xl border border-zinc-100 p-7 hover:border-zinc-200 hover:shadow-xl hover:shadow-zinc-200/40 transition-all flex flex-col">
      <div className="flex items-center gap-3 mb-5">
        <div className="w-8 h-8 rounded-full border border-amber-700 bg-white flex items-center justify-center font-mono text-[11px] font-bold text-amber-700 relative z-10">
          {step.n}
        </div>
        <div className="font-mono text-[10.5px] tracking-[0.14em] text-zinc-400 uppercase">
          step {i + 1} · {step.eyebrow}
        </div>
      </div>
      <h3
        className="text-[20px] font-semibold text-zinc-950 mb-2.5 tracking-[-0.01em]"
        style={{ textWrap: "balance" }}
      >
        {step.title}
      </h3>
      <p
        className="text-[14.5px] text-zinc-500 leading-[1.6] mb-5"
        style={{ textWrap: "pretty" }}
      >
        {step.desc}
      </p>

      {step.code && (
        <div className="mt-auto rounded-lg bg-zinc-950 text-zinc-300 font-mono text-[11.5px] leading-[1.7] p-4 overflow-hidden">
          {step.code.map((line, j) => (
            <div key={j} className="whitespace-nowrap overflow-hidden text-ellipsis">
              <span className={line.ok ? "text-emerald-400" : "text-zinc-500"}>{line.p}</span>{" "}
              <span className={line.ok ? "text-zinc-300" : "text-zinc-100"}>{line.t}</span>
            </div>
          ))}
        </div>
      )}

      {step.chips && (
        <div className="mt-auto flex flex-wrap gap-1.5">
          {step.chips.map((c) => (
            <span
              key={c}
              className="font-mono text-[11px] tracking-[0.02em] text-zinc-700 bg-zinc-50 border border-zinc-100 rounded-md px-2 py-1"
            >
              {c}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function HowItWorks() {
  return (
    <section
      id="how"
      className="relative py-32"
      style={{
        background:
          "linear-gradient(180deg, #fff, oklch(0.987 0.022 95.277 / 0.5) 50%, #fff)",
      }}
    >
      <div className="max-w-[1180px] mx-auto px-6 sm:px-7">
        <div className="mb-16 grid lg:grid-cols-[1fr_auto] gap-6 items-end">
          <div>
            <div className="font-mono text-[11px] tracking-[0.14em] uppercase text-amber-700 mb-4">
              / how it works
            </div>
            <h2
              className="text-[40px] sm:text-[52px] leading-[1.02] font-semibold tracking-[-0.025em] text-zinc-950 max-w-2xl"
              style={{ textWrap: "balance" }}
            >
              From zero to compounding
              <br />
              <span className="italic gradient-text">in an afternoon.</span>
            </h2>
          </div>
          <p className="text-[15px] text-zinc-500 max-w-xs leading-[1.6]">
            No DAGs. No definition language.{" "}
            <br />
            Run <span className="font-mono text-zinc-800">docker compose up</span>, then talk to it
            where you already work.
          </p>
        </div>
        <div className="grid md:grid-cols-3 gap-5 lg:gap-6 relative">
          <div
            className="hidden md:block absolute top-[55px] left-[8%] right-[8%] h-px pointer-events-none"
            style={{
              background:
                "linear-gradient(90deg, transparent, oklch(0.879 0.169 91.605 / 0.5), oklch(0.879 0.169 91.605 / 0.5), transparent)",
            }}
          />
          {STEPS.map((s, i) => (
            <StepCard key={s.n} step={s} i={i} />
          ))}
        </div>
      </div>
    </section>
  );
}
