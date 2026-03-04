import type { Metadata } from "next";
import { ArrowRight, Calendar, Clock } from "lucide-react";
import { Navbar } from "@/components/navbar";
import { Footer } from "@/components/footer";

export const metadata: Metadata = {
  title: "Blog — Agent Swarm",
  description:
    "Updates, technical deep dives, and stories from the Agent Swarm team.",
  openGraph: {
    title: "Blog — Agent Swarm",
    description:
      "Updates, technical deep dives, and stories from the Agent Swarm team.",
    url: "https://agent-swarm.dev/blog",
    siteName: "Agent Swarm",
    type: "website",
    images: [
      {
        url: "https://agent-swarm.dev/og-image.png",
        width: 1200,
        height: 630,
        alt: "Agent Swarm — Multi-Agent Orchestration for AI Coding Assistants",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Blog — Agent Swarm",
    description:
      "Updates, technical deep dives, and stories from the Agent Swarm team.",
    images: ["https://agent-swarm.dev/og-image.png"],
  },
  alternates: {
    canonical: "/blog",
  },
};

interface BlogPost {
  slug: string;
  title: string;
  description: string;
  date: string;
  readTime: string;
  tags: string[];
}

const posts: BlogPost[] = [
  {
    slug: "swarm-metrics",
    title: "Agent Swarm by the Numbers: 67 Days, 177 PRs, 6 Agents",
    description:
      "In 67 days, our swarm of 6 AI agents autonomously created 177 pull requests across 4 repositories, completed 4 epics, and built its own UI, marketing campaign, and CLI tools.",
    date: "February 28, 2026",
    readTime: "6 min read",
    tags: ["metrics", "AI agents", "automation", "open source"],
  },
  {
    slug: "openfort-hackathon",
    title: "Openfort Hackathon: Teaching Agents to Pay",
    description:
      "We shipped x402 payment capability into Agent Swarm — our AI agents can now autonomously pay for API services using crypto. Here's how we built it in a day.",
    date: "February 28, 2026",
    readTime: "8 min read",
    tags: ["x402", "Openfort", "crypto", "hackathon"],
  },
];

export default function BlogIndex() {
  return (
    <main className="min-h-screen bg-white">
      <Navbar />

      <div className="mx-auto max-w-3xl px-6 pt-32 pb-20">
        <header className="mb-16">
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight text-zinc-900">
            Blog
          </h1>
          <p className="mt-4 text-lg text-zinc-500 max-w-xl">
            Updates, technical deep dives, and stories from the Agent Swarm
            team.
          </p>
        </header>

        <div className="space-y-0 divide-y divide-zinc-100">
          {posts.map((post) => (
            <article key={post.slug} className="group py-8 first:pt-0">
              <a href={`/blog/${post.slug}`} className="block">
                <div className="flex items-center gap-3 mb-3">
                  <span className="flex items-center gap-1.5 text-[13px] text-zinc-400">
                    <Calendar className="w-3.5 h-3.5" />
                    {post.date}
                  </span>
                  <span className="text-zinc-300">&middot;</span>
                  <span className="flex items-center gap-1.5 text-[13px] text-zinc-400">
                    <Clock className="w-3.5 h-3.5" />
                    {post.readTime}
                  </span>
                </div>

                <h2 className="text-xl sm:text-2xl font-semibold text-zinc-900 group-hover:text-amber-700 transition-colors mb-2">
                  {post.title}
                </h2>

                <p className="text-[15px] text-zinc-500 leading-relaxed mb-4">
                  {post.description}
                </p>

                <div className="flex items-center justify-between">
                  <div className="flex gap-2 flex-wrap">
                    {post.tags.map((tag) => (
                      <span
                        key={tag}
                        className="text-[11px] font-medium px-2.5 py-1 rounded-full bg-zinc-100 text-zinc-500"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>

                  <span className="flex items-center gap-1.5 text-sm font-medium text-amber-700 opacity-0 group-hover:opacity-100 transition-opacity">
                    Read
                    <ArrowRight className="w-4 h-4" />
                  </span>
                </div>
              </a>
            </article>
          ))}
        </div>
      </div>

      <Footer />
    </main>
  );
}
