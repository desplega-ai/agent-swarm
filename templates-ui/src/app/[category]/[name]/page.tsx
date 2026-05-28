import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Header } from "@/components/header";
import { Footer } from "@/components/footer";
import { TemplateDetail } from "@/components/template-detail";
import { AssetDetail } from "@/components/asset-detail";
import {
  getAllTemplates,
  getAllAssets,
  getTemplate,
  getTemplateConfig,
  getAsset,
  getAssetConfig,
  isAssetCategory,
} from "@/lib/templates";

interface PageProps {
  params: Promise<{ category: string; name: string }>;
}

export async function generateStaticParams() {
  const agentParams = getAllTemplates().map((t) => ({
    category: t.category,
    name: t.name,
  }));

  const assetParams = getAllAssets().map((a) => ({
    category: a.category,
    name: a.name,
  }));

  return [...agentParams, ...assetParams];
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { category, name } = await params;

  try {
    if (isAssetCategory(category)) {
      const config = getAssetConfig(category, name);
      return {
        title: config.displayName,
        description: config.description,
        openGraph: {
          title: `${config.displayName} — Agent Swarm Template`,
          description: config.description,
          url: `https://templates.agent-swarm.dev/${category}/${name}`,
        },
        twitter: {
          card: "summary",
          title: `${config.displayName} — Agent Swarm Template`,
          description: config.description,
        },
      };
    }

    const config = getTemplateConfig(category, name);
    const capabilities = config.agentDefaults.capabilities.join(", ");

    return {
      title: config.displayName,
      description: config.description,
      openGraph: {
        title: `${config.displayName} — Agent Swarm Template`,
        description: `${config.description} Capabilities: ${capabilities}.`,
        url: `https://templates.agent-swarm.dev/${category}/${name}`,
      },
      twitter: {
        card: "summary",
        title: `${config.displayName} — Agent Swarm Template`,
        description: config.description,
      },
    };
  } catch {
    return { title: "Template Not Found" };
  }
}

export default async function TemplateDetailPage({ params }: PageProps) {
  const { category, name } = await params;

  if (isAssetCategory(category)) {
    let asset;
    try {
      asset = getAsset(category, name);
    } catch {
      notFound();
    }

    return (
      <div className="flex min-h-screen flex-col">
        <Header />
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-12">
          <AssetDetail asset={asset} category={category} name={name} />
        </main>
        <Footer />
      </div>
    );
  }

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
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-12">
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
