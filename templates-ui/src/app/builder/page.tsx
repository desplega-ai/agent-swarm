import type { Metadata } from "next";
import { Header } from "@/components/header";
import { Footer } from "@/components/footer";
import { ComposeBuilder } from "@/components/compose-builder";
import { getAllTemplates } from "@/lib/templates";

export const metadata: Metadata = {
  title: "Docker Compose Builder",
  description:
    "Configure your agent swarm and generate docker-compose.yml and .env files. Select templates, set integrations, and deploy.",
  openGraph: {
    title: "Docker Compose Builder | Agent Swarm Templates",
    description: "Configure your agent swarm and generate docker-compose.yml and .env files.",
  },
};

export default function BuilderPage() {
  const templates = getAllTemplates();

  return (
    <div className="flex min-h-screen flex-col lg:h-screen lg:overflow-hidden">
      <Header />
      <div className="mx-auto w-full max-w-6xl px-4 py-4">
        <h1 className="text-xl sm:text-2xl font-bold tracking-tight">Docker Compose Builder</h1>
        <p className="mt-1 text-xs sm:text-sm text-muted-foreground">
          Configure your swarm and generate docker-compose + .env files
        </p>
      </div>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-6 lg:overflow-hidden">
        <ComposeBuilder templates={templates} />
      </main>
    </div>
  );
}
