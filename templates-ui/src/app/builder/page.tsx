import { Header } from "@/components/header";
import { Footer } from "@/components/footer";
import { ComposeBuilder } from "@/components/compose-builder";
import { getAllTemplates } from "@/lib/templates";

export default function BuilderPage() {
  const templates = getAllTemplates();

  return (
    <div className="flex min-h-screen flex-col">
      <Header />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-12">
        <div className="mb-10">
          <h1 className="text-3xl font-bold tracking-tight">
            Docker Compose Builder
          </h1>
          <p className="mt-2 text-muted-foreground">
            Configure your swarm and generate docker-compose + .env files
          </p>
        </div>
        <ComposeBuilder templates={templates} />
      </main>
      <Footer />
    </div>
  );
}
