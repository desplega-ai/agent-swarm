import Link from "next/link";

export default function HomePage() {
  return (
    <main
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
        padding: "2rem",
        textAlign: "center",
      }}
    >
      <h1
        style={{
          fontSize: "3rem",
          fontWeight: 800,
          marginBottom: "1rem",
        }}
      >
        Agent Swarm
      </h1>
      <p
        style={{
          fontSize: "1.25rem",
          maxWidth: "600px",
          marginBottom: "2rem",
          opacity: 0.8,
        }}
      >
        Multi-agent orchestration for Claude Code, Codex, Gemini CLI, and other
        AI coding assistants.
      </p>
      <Link
        href="/docs"
        style={{
          padding: "0.75rem 2rem",
          borderRadius: "0.5rem",
          backgroundColor: "var(--fd-primary)",
          color: "var(--fd-primary-foreground)",
          textDecoration: "none",
          fontWeight: 600,
          fontSize: "1.1rem",
        }}
      >
        Get Started
      </Link>
    </main>
  );
}
