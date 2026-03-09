import Image from "next/image";
import Link from "next/link";
import { Github } from "lucide-react";

export function Header() {
  return (
    <header className="border-b border-border bg-card">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4">
        <Link href="/" className="flex items-center gap-3">
          <Image src="/logo.png" alt="Agent Swarm" width={32} height={32} />
          <span className="text-lg font-semibold">Agent Swarm Templates</span>
        </Link>
        <nav className="flex items-center gap-4">
          <Link
            href="/builder"
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            Builder
          </Link>
          <a
            href="https://agent-swarm.dev"
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
