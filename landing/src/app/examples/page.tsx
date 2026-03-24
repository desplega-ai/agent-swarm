import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, ArrowRight, Zap } from "lucide-react";

export const metadata: Metadata = {
  title: "Examples — Real Agent Swarm Sessions — Agent Swarm",
  description:
    "See what AI agent swarms can do. Real session transcripts showing autonomous task execution, crypto payments, and more.",
  openGraph: {
    title: "Examples — Real Agent Swarm Sessions",
    description: "Real session transcripts showing autonomous AI agent coordination in action.",
    url: "https://agent-swarm.dev/examples",
    siteName: "Agent Swarm",
    type: "website",
    images: [
      {
        url: "https://agent-swarm.dev/og-image.png",
        width: 1200,
        height: 630,
        alt: "Examples — Real Agent Swarm Sessions",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Examples — Real Agent Swarm Sessions",
    description: "Real session transcripts showing autonomous AI agent coordination in action.",
    images: ["https://agent-swarm.dev/og-image.png"],
  },
  alternates: {
    canonical: "/examples",
  },
};

type Example = {
  slug: string;
  title: string;
  description: string;
  tags: string[];
  icon: React.ReactNode;
  image?: string;
};

const examples: Example[] = [
  {
    slug: "x402",
    title: "AI Agents Pay for Services with Crypto",
    description:
      "The agent swarm used x402 protocol to autonomously pay $0.05 USDC on Base mainnet and generate an anime-style image — no human wallet interaction.",
    tags: ["x402", "Crypto Payments", "Base", "Image Gen"],
    icon: <Zap className="w-5 h-5" />,
    image: "https://blob.imference.com/large/37f7ee3b-616b-402f-8cb3-d69896165e3f.webp",
  },
];

function ExampleCard({ example }: { example: Example }) {
  return (
    <Link
      href={`/examples/${example.slug}`}
      className="group block rounded-2xl border border-zinc-200 bg-white hover:border-zinc-300 hover:shadow-lg hover:shadow-zinc-200/50 transition-all overflow-hidden"
    >
      {example.image && (
        <div className="aspect-video overflow-hidden bg-zinc-100 relative">
          <Image
            src={example.image}
            alt={example.title}
            fill
            className="object-cover group-hover:scale-[1.02] transition-transform duration-500"
            sizes="(max-width: 768px) 100vw, 672px"
          />
        </div>
      )}
      <div className="p-5 md:p-6">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-amber-100 text-amber-700 flex items-center justify-center shrink-0">
            {example.icon}
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-[15px] md:text-base font-semibold text-zinc-900 group-hover:text-amber-800 transition-colors leading-snug">
              {example.title}
            </h2>
            <p className="text-[13px] text-zinc-500 mt-1.5 leading-relaxed">
              {example.description}
            </p>
          </div>
        </div>
        <div className="flex items-center justify-between mt-4 pt-3 border-t border-zinc-100">
          <div className="flex gap-1.5 flex-wrap">
            {example.tags.map((tag) => (
              <span
                key={tag}
                className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-zinc-100 text-zinc-500"
              >
                {tag}
              </span>
            ))}
          </div>
          <ArrowRight className="w-4 h-4 text-zinc-400 group-hover:text-amber-600 group-hover:translate-x-0.5 transition-all shrink-0" />
        </div>
      </div>
    </Link>
  );
}

export default function ExamplesPage() {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "Examples — Real Agent Swarm Sessions",
    description:
      "See what AI agent swarms can do. Real session transcripts showing autonomous task execution, crypto payments, and more.",
    url: "https://agent-swarm.dev/examples",
    isPartOf: {
      "@type": "WebSite",
      name: "Agent Swarm",
      url: "https://agent-swarm.dev",
    },
    mainEntity: {
      "@type": "ItemList",
      itemListElement: examples.map((example, index) => ({
        "@type": "ListItem",
        position: index + 1,
        url: `https://agent-swarm.dev/examples/${example.slug}`,
        name: example.title,
      })),
    },
  };

  return (
    <main className="min-h-screen bg-zinc-50/50">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      {/* Top bar */}
      <nav className="border-b border-zinc-200/60 bg-white/90 backdrop-blur-xl sticky top-0 z-50">
        <div className="mx-auto max-w-3xl px-4 sm:px-6 h-12 flex items-center gap-3">
          <Link
            href="/"
            className="flex items-center gap-1.5 text-[13px] text-zinc-500 hover:text-zinc-900 transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Home</span>
          </Link>
          <div className="w-px h-4 bg-zinc-200" />
          <span className="text-[13px] font-medium text-zinc-700">Examples</span>
        </div>
      </nav>

      <div className="mx-auto max-w-3xl px-4 sm:px-6">
        <header className="pt-8 pb-6 md:pt-12 md:pb-8">
          <h1 className="text-2xl sm:text-3xl md:text-4xl font-bold tracking-tight text-zinc-900">
            Examples
          </h1>
          <p className="mt-2 text-[15px] text-zinc-500 leading-relaxed">
            Real sessions from the Agent Swarm — see what autonomous AI agents can do.
          </p>
        </header>

        <div className="grid gap-4 pb-12">
          {examples.map((example) => (
            <ExampleCard key={example.slug} example={example} />
          ))}
        </div>
      </div>
    </main>
  );
}
