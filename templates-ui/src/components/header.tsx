import Image from "next/image";
import Link from "next/link";
import { Github } from "lucide-react";

export function Header() {
  return (
    <header className="border-b border-border bg-card">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4">
        <Link href="/" className="flex items-center gap-2 sm:gap-3 min-w-0">
          <Image
            src="/logo.png"
            alt="Agent Swarm"
            width={32}
            height={32}
            className="shrink-0"
            priority
          />
          <span className="text-lg font-semibold truncate hidden sm:inline">
            Agent Swarm Templates
          </span>
          <span className="text-lg font-semibold sm:hidden">Templates</span>
        </Link>
        <nav className="flex items-center gap-2 sm:gap-4 shrink-0">
          <Link
            href="/builder"
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            Builder
          </Link>
          <a
            href="https://docs.agent-swarm.dev"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            Docs
          </a>
          <a
            href="https://github.com/desplega-ai/agent-swarm"
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <Github className="h-5 w-5" />
          </a>
        </nav>
      </div>
    </header>
  );
}
