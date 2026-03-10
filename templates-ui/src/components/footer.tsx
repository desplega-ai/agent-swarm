export function Footer() {
  return (
    <footer className="border-t border-border bg-card mt-auto">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
        <a
          href="https://agent-swarm.dev"
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          Agent Swarm {new Date().getFullYear()}
        </a>
        <nav className="flex items-center gap-4">
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
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            GitHub
          </a>
          <a
            href="mailto:contact@agent-swarm.dev"
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            Contact
          </a>
        </nav>
      </div>
    </footer>
  );
}
