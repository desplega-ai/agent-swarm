import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Header } from "@/components/header";
import { Footer } from "@/components/footer";
import { TemplateDetail } from "@/components/template-detail";
import { getAllTemplates, getTemplate, getTemplateConfig } from "@/lib/templates";

interface PageProps {
  params: Promise<{ category: string; name: string }>;
}

export async function generateStaticParams() {
  const templates = getAllTemplates();
  return templates.map((t) => ({
    category: t.category,
    name: t.name,
  }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { category, name } = await params;

  try {
    const config = getTemplateConfig(category, name);
    const title = config.displayName;
    const description = config.description;
    const capabilities = config.agentDefaults.capabilities.join(", ");

    return {
      title,
      description,
      openGraph: {
        title: `${title} — Agent Swarm Template`,
        description: `${description} Capabilities: ${capabilities}.`,
        url: `https://templates.agent-swarm.dev/${category}/${name}`,
      },
      twitter: {
        card: "summary",
        title: `${title} — Agent Swarm Template`,
        description,
      },
    };
  } catch {
    return { title: "Template Not Found" };
  }
}

export default async function TemplateDetailPage({ params }: PageProps) {
  const { category, name } = await params;

  let template;
  try {
    template = getTemplate(category, name);
  } catch {
    notFound();
  }

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: template.config.displayName,
    description: template.config.description,
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Docker",
    softwareVersion: template.config.version,
    author: {
      "@type": "Organization",
      name: "Desplega AI",
    },
  };

  return (
    <div className="flex min-h-screen flex-col">
      <Header />
      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-12">
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
        <TemplateDetail template={template} category={category} />
      </main>
      <Footer />
    </div>
  );
}
