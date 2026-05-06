import Image from "next/image";
import Link from "next/link";

type FooterLink = { label: string; href: string; external?: boolean };

const COLUMNS: { title: string; links: FooterLink[] }[] = [
  {
    title: "Product",
    links: [
      { label: "Features", href: "/#features" },
      { label: "Pricing", href: "/pricing" },
      { label: "Cloud", href: "https://cloud.agent-swarm.dev", external: true },
      { label: "Templates", href: "https://templates.agent-swarm.dev", external: true },
      { label: "Changelog", href: "https://github.com/desplega-ai/agent-swarm/releases", external: true },
    ],
  },
  {
    title: "Resources",
    links: [
      { label: "Docs", href: "https://docs.agent-swarm.dev", external: true },
      { label: "GitHub", href: "https://github.com/desplega-ai/agent-swarm", external: true },
      { label: "Blog", href: "/blog" },
      { label: "MCP servers", href: "https://docs.agent-swarm.dev/docs/mcp", external: true },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "desplega.sh", href: "https://desplega.sh", external: true },
      { label: "Privacy", href: "/privacy" },
      { label: "Terms", href: "/terms" },
      { label: "Contact", href: "mailto:hello@desplega.sh" },
    ],
  },
];

function FooterCol({ title, links }: { title: string; links: FooterLink[] }) {
  return (
    <div>
      <div className="text-[11px] font-semibold text-zinc-950 uppercase tracking-[0.12em] mb-4">
        {title}
      </div>
      <ul className="space-y-2.5">
        {links.map((l) => (
          <li key={l.label}>
            {l.external || l.href.startsWith("mailto:") ? (
              <a
                href={l.href}
                target={l.external ? "_blank" : undefined}
                rel={l.external ? "noopener noreferrer" : undefined}
                className="text-[13.5px] text-zinc-500 hover:text-zinc-950 transition-colors"
              >
                {l.label}
              </a>
            ) : (
              <Link
                href={l.href}
                className="text-[13.5px] text-zinc-500 hover:text-zinc-950 transition-colors"
              >
                {l.label}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Footer() {
  return (
    <footer className="border-t border-zinc-100 py-14 bg-white">
      <div className="max-w-[1180px] mx-auto px-6 sm:px-7 grid md:grid-cols-[1.6fr_1fr_1fr_1fr] gap-10">
        <div>
          <div className="flex items-center gap-2.5">
            <Image
              src="/logo.png"
              alt="Agent Swarm"
              width={28}
              height={28}
              className="rounded-md"
              style={{ boxShadow: "0 4px 14px -2px oklch(0.769 0.188 70.08 / 0.35)" }}
            />
            <span className="font-semibold text-zinc-950 tracking-[-0.01em]">Agent Swarm</span>
          </div>
          <p className="mt-4 text-[14px] text-zinc-500 leading-[1.6] max-w-xs">
            Intelligence that compounds. Your agent company OS — open source, MCP-powered.
          </p>
          <p className="mt-5 text-[12px] text-zinc-400 font-mono tracking-[0.04em]">
            Built by{" "}
            <a
              href="https://desplega.sh"
              target="_blank"
              rel="noopener noreferrer"
              className="text-amber-700 hover:text-amber-600 transition-colors"
            >
              desplega.sh
            </a>
            <br />
            by builders, for builders.
          </p>
        </div>
        {COLUMNS.map((c) => (
          <FooterCol key={c.title} title={c.title} links={c.links} />
        ))}
      </div>
    </footer>
  );
}
