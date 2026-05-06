type DiagramKind = "network" | "docker" | "plug" | "mcp" | "schedule";

const FEATURES: {
  num: string;
  tag: string;
  title: string;
  desc: string;
  diagram: DiagramKind;
}[] = [
  {
    num: "01",
    tag: "orchestration",
    title: "A lead that decides what to ship next",
    desc:
      "The lead reads the task, breaks it down, and routes work to workers — directly assigned, offered for acceptance, or pulled from a pool. You hand off the goal; the lead owns the plan.",
    diagram: "network",
  },
  {
    num: "02",
    tag: "isolation",
    title: "Every worker free to do its own job",
    desc:
      "Each worker runs in its own Docker container with a persistent /workspace. They install what they need, branch off main, and ship without stepping on each other or your repo.",
    diagram: "docker",
  },
  {
    num: "03",
    tag: "integrations",
    title: "Talks human, talks API",
    desc:
      "Mention the bot in Slack, assign a Linear issue, send an email — that’s the task. Built on Model Context Protocol with a full OpenAPI 3.1 spec at :3013, so anything that speaks HTTP — your CI, your monitoring, your custom dashboards — can drive the swarm or be driven by it.",
    diagram: "plug",
  },
  {
    num: "04",
    tag: "lifecycle",
    title: "Wake up to work already done",
    desc:
      "Cron-scheduled recurring jobs, multi-step workflows, role templates for Coder / Researcher / PM. Hand the night-shift work to scheduled tasks, find the results in your Slack the next morning.",
    diagram: "schedule",
  },
];

function Diagram({ kind }: { kind: DiagramKind }) {
  const amber = "oklch(0.555 0.163 48.998)";
  const amberSoft = "oklch(0.555 0.163 48.998 / 0.4)";
  const amberFill = "oklch(0.555 0.163 48.998 / 0.08)";
  const zinc = "oklch(0.92 0.004 286.32)";
  const muted = "oklch(0.552 0.016 285.938)";

  if (kind === "network") {
    return (
      <svg viewBox="0 0 200 84" className="w-full h-full" aria-hidden="true">
        <line x1="100" y1="42" x2="40" y2="22" stroke={amberSoft} strokeWidth="1.2" strokeDasharray="3 3" />
        <line x1="100" y1="42" x2="160" y2="22" stroke={amberSoft} strokeWidth="1.2" strokeDasharray="3 3" />
        <line x1="100" y1="42" x2="40" y2="62" stroke={amberSoft} strokeWidth="1.2" strokeDasharray="3 3" />
        <line x1="100" y1="42" x2="160" y2="62" stroke={amberSoft} strokeWidth="1.2" strokeDasharray="3 3" />
        <circle cx="100" cy="42" r="11" fill={amber} />
        <text x="100" y="45" textAnchor="middle" fontFamily="Space Mono" fontSize="8" fontWeight="700" fill="#fff">
          L
        </text>
        {[
          [40, 22],
          [160, 22],
          [40, 62],
          [160, 62],
        ].map(([x, y]) => (
          <circle key={`${x}-${y}`} cx={x} cy={y} r="6" fill="#fff" stroke={zinc} />
        ))}
      </svg>
    );
  }

  if (kind === "docker") {
    return (
      <svg viewBox="0 0 200 84" className="w-full h-full" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <g key={i} transform={`translate(${28 + i * 50}, 18)`}>
            <rect
              width="44"
              height="48"
              rx="4"
              fill={i === 1 ? amberFill : "#fff"}
              stroke={i === 1 ? amber : zinc}
              strokeWidth={i === 1 ? 1.4 : 1}
            />
            <rect x="6" y="6" width="32" height="3" rx="1" fill={zinc} />
            <rect x="6" y="12" width="22" height="3" rx="1" fill={zinc} />
            <circle cx="22" cy="32" r="6" fill="none" stroke={i === 1 ? amber : muted} strokeWidth="1.2" />
            <text
              x="22"
              y="35"
              textAnchor="middle"
              fontFamily="Space Mono"
              fontSize="6"
              fill={i === 1 ? amber : muted}
              fontWeight="700"
            >
              w{i + 1}
            </text>
          </g>
        ))}
      </svg>
    );
  }

  if (kind === "plug") {
    const apps = ["Slack", "GitHub", "GitLab", "Linear"];
    return (
      <svg viewBox="0 0 200 84" className="w-full h-full" aria-hidden="true">
        {apps.map((label, i) => (
          <g key={label} transform={`translate(${15 + i * 45}, 28)`}>
            <rect width="34" height="22" rx="4" fill="#fff" stroke={zinc} />
            <text x="17" y="14" textAnchor="middle" fontFamily="Space Mono" fontSize="8" fill={muted}>
              {label}
            </text>
            <line x1="17" y1="22" x2="17" y2="34" stroke={amberSoft} strokeWidth="1.2" strokeDasharray="2 2" />
            <circle cx="17" cy="38" r="2.5" fill={amber} />
          </g>
        ))}
      </svg>
    );
  }

  if (kind === "mcp") {
    return (
      <svg viewBox="0 0 200 84" className="w-full h-full" aria-hidden="true">
        <rect x="60" y="22" width="80" height="40" rx="6" fill={amberFill} stroke={amber} strokeWidth="1.4" />
        <text x="100" y="42" textAnchor="middle" fontFamily="Space Mono" fontSize="10" fontWeight="700" fill={amber}>
          MCP
        </text>
        <text x="100" y="54" textAnchor="middle" fontFamily="Space Mono" fontSize="7" fill={muted}>
          :3013
        </text>
        <line x1="20" y1="42" x2="58" y2="42" stroke={zinc} strokeWidth="1" />
        <line x1="142" y1="42" x2="180" y2="42" stroke={zinc} strokeWidth="1" />
        <circle cx="20" cy="42" r="3" fill={muted} />
        <circle cx="180" cy="42" r="3" fill={muted} />
      </svg>
    );
  }

  if (kind === "schedule") {
    return (
      <svg viewBox="0 0 200 84" className="w-full h-full" aria-hidden="true">
        <line x1="20" y1="42" x2="180" y2="42" stroke={zinc} strokeWidth="1" />
        {[40, 80, 120].map((x) => (
          <circle key={x} cx={x} cy="42" r="4" fill={amber} />
        ))}
        <circle cx="160" cy="42" r="4" fill="#fff" stroke={amber} strokeWidth="1.5" />
        {["09:00", "12:00", "15:00"].map((t, i) => (
          <text
            key={t}
            x={40 + i * 40}
            y="64"
            textAnchor="middle"
            fontFamily="Space Mono"
            fontSize="8"
            fill={muted}
          >
            {t}
          </text>
        ))}
        <text x="160" y="64" textAnchor="middle" fontFamily="Space Mono" fontSize="8" fill={amber} fontWeight="700">
          next
        </text>
      </svg>
    );
  }

  return null;
}

export function Features() {
  return (
    <section id="features" className="relative py-32 bg-white">
      <div className="max-w-[1180px] mx-auto px-6 sm:px-7">
        <div className="mb-14 max-w-2xl">
          <div className="font-mono text-[11px] tracking-[0.14em] uppercase text-amber-700 mb-4">
            / what&apos;s in the box
          </div>
          <h2
            className="text-[40px] sm:text-[52px] leading-[1.02] font-semibold tracking-[-0.025em] text-zinc-950"
            style={{ textWrap: "balance" }}
          >
            Day one: a team that
            <br />
            <span className="italic gradient-text">already ships.</span>
          </h2>
        </div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-5">
          {FEATURES.map((f) => (
            <div
              key={f.title}
              className="group bg-white border border-zinc-100 rounded-2xl p-6 hover:border-zinc-200 hover:shadow-xl hover:shadow-zinc-200/30 transition-all"
            >
              <div
                className="h-[88px] -mx-1 mb-5 rounded-xl border border-zinc-100/70 overflow-hidden"
                style={{ background: "linear-gradient(180deg, #fafaf9, #fff)" }}
              >
                <Diagram kind={f.diagram} />
              </div>
              <div className="flex items-center justify-between font-mono text-[10.5px] tracking-[0.1em] text-amber-700 mb-2">
                <span>{f.num} / 04</span>
                <span className="text-zinc-400">{f.tag}</span>
              </div>
              <h3
                className="text-[16px] font-semibold text-zinc-950 mb-1.5 tracking-[-0.005em]"
                style={{ textWrap: "balance" }}
              >
                {f.title}
              </h3>
              <p className="text-[14px] text-zinc-500 leading-[1.55]">{f.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
