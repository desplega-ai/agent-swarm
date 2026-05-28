import type { Metadata } from "next";
import { Header } from "@/components/header";
import { Footer } from "@/components/footer";
import { UnifiedGallery } from "@/components/unified-gallery";
import { getAllTemplates, getAllAssets } from "@/lib/templates";

export const metadata: Metadata = {
  title: "Browse Templates",
  description:
    "Browse pre-configured agent templates, skills, schedules, and workflows for your swarm. Ready to deploy.",
  openGraph: {
    title: "Browse Agent Swarm Templates",
    description:
      "Browse pre-configured agent templates, skills, schedules, and workflows for your swarm. Ready to deploy.",
  },
};

export default function Home() {
  const templates = getAllTemplates();
  const assets = getAllAssets();

  return (
    <div className="flex min-h-screen flex-col">
      <Header />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-12">
        <UnifiedGallery templates={templates} assets={assets} />
      </main>
      <Footer />
    </div>
  );
}
