import { Github, BookOpen, ExternalLink } from "lucide-react";

export function Footer() {
  return (
    <footer className="border-t border-zinc-100 bg-white">
      <div className="mx-auto max-w-6xl px-6 py-12">
        <div className="flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-3">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-amber-500 to-amber-700 flex items-center justify-center">
              <svg
                viewBox="0 0 24 24"
                className="w-4 h-4 text-white"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <circle cx="12" cy="12" r="3" />
                <circle cx="5" cy="6" r="2" />
                <circle cx="19" cy="6" r="2" />
                <circle cx="5" cy="18" r="2" />
                <circle cx="19" cy="18" r="2" />
                <line x1="9.5" y1="10.5" x2="6.5" y2="7.5" />
                <line x1="14.5" y1="10.5" x2="17.5" y2="7.5" />
                <line x1="9.5" y1="13.5" x2="6.5" y2="16.5" />
                <line x1="14.5" y1="13.5" x2="17.5" y2="16.5" />
              </svg>
            </div>
            <div>
              <div className="text-sm font-semibold text-zinc-900">
                Agent Swarm
              </div>
              <div className="text-xs text-zinc-400">
                Built by{" "}
                <a
                  href="https://desplega.sh"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-amber-600 hover:text-amber-700 transition-colors inline-flex items-center gap-0.5"
                >
                  desplega.sh
                  <ExternalLink className="w-3 h-3" />
                </a>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-6">
            <a
              href="https://github.com/desplega-ai/agent-swarm"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-700 transition-colors"
            >
              <Github className="w-4 h-4" />
              GitHub
            </a>
            <a
              href="https://docs.agent-swarm.dev"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-700 transition-colors"
            >
              <BookOpen className="w-4 h-4" />
              Docs
            </a>
            <a
              href="https://desplega.sh"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-700 transition-colors"
            >
              <ExternalLink className="w-4 h-4" />
              desplega.sh
            </a>
          </div>
        </div>

        <div className="mt-8 pt-6 border-t border-zinc-100 text-center">
          <p className="text-xs text-zinc-400">
            MIT License &middot; Open source multi-agent orchestration for Claude Code
          </p>
        </div>
      </div>
    </footer>
  );
}
