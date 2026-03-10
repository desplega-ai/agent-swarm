import type { Metadata } from "next";
import { Header } from "@/components/header";
import { Footer } from "@/components/footer";
import { TemplateGallery } from "@/components/template-gallery";
import { getAllTemplates } from "@/lib/templates";

export const metadata: Metadata = {
  title: "Browse Templates",
  description:
    "Browse pre-configured agent templates for your swarm. Lead agents, coders, researchers, reviewers, and testers — ready to deploy.",
  openGraph: {
    title: "Browse Agent Swarm Templates",
    description:
      "Browse pre-configured agent templates for your swarm. Lead agents, coders, researchers, reviewers, and testers — ready to deploy.",
  },
};

export default function Home() {
  const templates = getAllTemplates();

  return (
    <div className="flex min-h-screen flex-col">
      <Header />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-12">
        <div className="mb-10 text-center">
          <h1 className="text-4xl font-bold tracking-tight">
            Agent Swarm Templates
          </h1>
          <p className="mt-4 text-lg text-muted-foreground">
            Pre-configured worker templates for your swarm
          </p>
        </div>
        <TemplateGallery templates={templates} />
      </main>
      <Footer />
    </div>
  );
}
