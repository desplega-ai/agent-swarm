import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, ExternalLink, CheckCircle, Wallet, Zap } from "lucide-react";

export const metadata: Metadata = {
  title: "x402 Payment Session — AI Agents Pay for Services with Crypto — Agent Swarm",
  description:
    "Watch a real session where the Agent Swarm used x402 protocol to autonomously pay $0.05 USDC on Base mainnet and generate an AI image — no human wallet interaction.",
  openGraph: {
    title: "x402 Payment Session — AI Agents Pay with Crypto",
    description:
      "A real session: AI agents used x402 protocol to pay for image generation with USDC on Base mainnet.",
    url: "https://agent-swarm.dev/examples/x402",
    siteName: "Agent Swarm",
    type: "article",
    publishedTime: "2026-02-28T00:00:00Z",
    images: [
      {
        url: "https://blob.imference.com/large/37f7ee3b-616b-402f-8cb3-d69896165e3f.webp",
        width: 1024,
        height: 1024,
        alt: "A cat on a skateboard, anime style — generated via x402 payment",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "x402 Payment Session — AI Agents Pay with Crypto",
    description:
      "Real session: AI agents used x402 protocol to pay $0.05 USDC for image generation on Base mainnet.",
    images: ["https://blob.imference.com/large/37f7ee3b-616b-402f-8cb3-d69896165e3f.webp"],
  },
  keywords: [
    "AI agent crypto payments",
    "x402 protocol",
    "AI autonomous payments",
    "agent swarm x402",
    "HTTP 402 payment required",
    "USDC AI agent payments",
    "AI agent micropayments",
    "Openfort AI agents",
    "crypto payment automation",
    "autonomous agent wallet",
  ],
  alternates: {
    canonical: "/examples/x402",
  },
};

function Avatar({ sender }: { sender: "human" | "agent" }) {
  return (
    <div
      className={`w-8 h-8 md:w-9 md:h-9 rounded-full flex items-center justify-center shrink-0 text-[11px] font-bold select-none ${
        sender === "human"
          ? "bg-gradient-to-br from-amber-600 to-amber-800 text-white"
          : "bg-gradient-to-br from-zinc-800 to-zinc-950 text-amber-400"
      }`}
    >
      {sender === "human" ? "T" : "AI"}
    </div>
  );
}

function Message({
  sender,
  label,
  highlight,
  children,
}: {
  sender: "human" | "agent";
  label: string;
  highlight?: boolean;
  children: React.ReactNode;
}) {
  return (
    <article className="group">
      <div className="flex gap-3 items-start">
        <Avatar sender={sender} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1.5">
            <span
              className={`text-[13px] font-semibold ${
                sender === "human" ? "text-amber-800" : "text-zinc-800"
              }`}
            >
              {label}
            </span>
          </div>
          <div
            className={`rounded-2xl px-4 py-3 md:px-5 md:py-4 ${
              highlight
                ? "bg-gradient-to-br from-amber-50 to-orange-50 border border-amber-200/80 shadow-sm"
                : sender === "human"
                  ? "bg-zinc-100/80"
                  : "bg-white border border-zinc-100"
            }`}
          >
            <div className="[&>*:last-child]:mb-0">{children}</div>
          </div>
        </div>
      </div>
    </article>
  );
}

function Badge({
  children,
  variant = "default",
}: {
  children: React.ReactNode;
  variant?: "default" | "success";
}) {
  const styles =
    variant === "success"
      ? "bg-emerald-100 text-emerald-800 border-emerald-200"
      : "bg-zinc-100 text-zinc-600 border-zinc-200";
  return (
    <span
      className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1 rounded-full border ${styles} mb-3`}
    >
      {children}
    </span>
  );
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-start gap-1 sm:gap-0">
      <span className="text-[13px] font-semibold text-zinc-500 sm:w-24 shrink-0">{label}</span>
      <span className="text-[13px] text-zinc-800">{children}</span>
    </div>
  );
}

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "Article",
  headline: "x402 Payment Session — AI Agents Pay for Services with Crypto",
  description:
    "Watch a real session where the Agent Swarm used x402 protocol to autonomously pay $0.05 USDC on Base mainnet and generate an AI image.",
  datePublished: "2026-02-28T00:00:00Z",
  author: {
    "@type": "Organization",
    name: "Agent Swarm",
    url: "https://agent-swarm.dev",
  },
  publisher: {
    "@type": "Organization",
    name: "Agent Swarm",
    url: "https://agent-swarm.dev",
    logo: {
      "@type": "ImageObject",
      url: "https://agent-swarm.dev/logo.png",
    },
  },
  mainEntityOfPage: "https://agent-swarm.dev/examples/x402",
  image: "https://blob.imference.com/large/37f7ee3b-616b-402f-8cb3-d69896165e3f.webp",
};

export default function X402ExamplePage() {
  return (
    <main className="min-h-screen bg-zinc-50/50">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      {/* Top bar */}
      <nav className="border-b border-zinc-200/60 bg-white/90 backdrop-blur-xl sticky top-0 z-50">
        <div className="mx-auto max-w-2xl px-4 sm:px-6 h-12 flex items-center gap-3">
          <Link
            href="/examples"
            className="flex items-center gap-1.5 text-[13px] text-zinc-500 hover:text-zinc-900 transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Examples</span>
          </Link>
          <div className="w-px h-4 bg-zinc-200" />
          <div className="flex items-center gap-1.5">
            <Zap className="w-3.5 h-3.5 text-amber-600" />
            <span className="text-[13px] font-medium text-zinc-700">x402 Payment Session</span>
          </div>
        </div>
      </nav>

      <div className="mx-auto max-w-2xl px-4 sm:px-6">
        {/* Header */}
        <header className="pt-8 pb-6 md:pt-12 md:pb-8">
          <h1 className="text-2xl sm:text-3xl md:text-4xl font-bold tracking-tight text-zinc-900 leading-tight">
            AI Agents Pay for Services
            <br />
            <span className="gradient-text">with Crypto</span>
          </h1>
          <p className="mt-3 text-[15px] text-zinc-500 leading-relaxed max-w-xl">
            A real session where the agent swarm used the{" "}
            <a
              href="https://www.x402.org/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-amber-700 hover:text-amber-900 font-medium underline underline-offset-2 decoration-amber-300 transition-colors"
            >
              x402 protocol
            </a>{" "}
            to pay $0.05 USDC on Base and generate an image — autonomously.
          </p>
        </header>

        {/* Result image */}
        <section className="mb-8 md:mb-10">
          <div className="rounded-2xl overflow-hidden border border-zinc-200 shadow-lg shadow-zinc-200/50 relative group">
            <Image
              src="https://blob.imference.com/large/37f7ee3b-616b-402f-8cb3-d69896165e3f.webp"
              alt="A cat on a skateboard, anime style — generated via x402 payment"
              width={1024}
              height={1024}
              className="w-full block"
              priority
              sizes="(max-width: 768px) 100vw, 672px"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-transparent" />
            <div className="absolute bottom-0 left-0 right-0 p-4 md:p-5">
              <p className="text-white/95 text-sm md:text-base font-medium italic font-[var(--font-sans)]">
                &ldquo;a cat on a skateboard, anime style&rdquo;
              </p>
              <div className="flex gap-2 mt-2.5 flex-wrap">
                <span className="text-[11px] font-medium px-2.5 py-1 rounded-full bg-white/15 text-white/90 backdrop-blur-sm border border-white/10">
                  illustrious-hassuka-xl
                </span>
                <span className="text-[11px] font-bold px-2.5 py-1 rounded-full bg-amber-400/90 text-zinc-900 backdrop-blur-sm">
                  $0.05 USDC
                </span>
                <span className="text-[11px] font-medium px-2.5 py-1 rounded-full bg-white/15 text-white/90 backdrop-blur-sm border border-white/10">
                  Base mainnet
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* x402 flow card */}
        <section className="mb-8 md:mb-10">
          <div className="rounded-2xl bg-white border border-zinc-200 p-5 md:p-6">
            <div className="flex items-center gap-2 mb-4">
              <Wallet className="w-4 h-4 text-amber-700" />
              <h2 className="text-[15px] font-semibold text-zinc-900">How x402 Payment Works</h2>
            </div>
            <div className="space-y-0">
              {[
                "Client sends POST request to API",
                "Server responds with 402 Payment Required",
                "Client signs EIP-712 payment (USDC on Base)",
                "Client resends with X-PAYMENT header",
                "Server validates, returns 200 with image",
              ].map((label, i) => (
                <div key={label}>
                  <div className="flex items-center gap-3 py-2">
                    <div className="w-6 h-6 rounded-full bg-amber-100 text-amber-800 flex items-center justify-center text-[11px] font-bold shrink-0">
                      {i + 1}
                    </div>
                    <p className="text-[13px] text-zinc-700">{label}</p>
                  </div>
                  {i < 4 && <div className="ml-3 h-3 border-l border-dashed border-zinc-200" />}
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Transcript */}
        <section className="pb-10">
          <h2 className="text-lg md:text-xl font-semibold text-zinc-900 mb-6">
            Session Transcript
          </h2>

          <div className="space-y-6">
            {/* 1 */}
            <Message sender="human" label="Taras">
              <p className="text-[14px] text-zinc-700 leading-relaxed">
                Can you create an Openfort wallet (prod) so I can top it up?
              </p>
            </Message>

            {/* 2 */}
            <Message sender="agent" label="Agent Swarm">
              <p className="text-[14px] text-zinc-700 leading-relaxed mb-2">On it. The plan:</p>
              <ol className="text-[14px] text-zinc-700 space-y-1.5 pl-5 list-decimal marker:text-zinc-400">
                <li>Research the imference.com API (endpoints, pricing, x402 flow)</li>
                <li>
                  Write a script using our Openfort wallet{" "}
                  <code className="text-[12px] bg-zinc-100 px-1.5 py-0.5 rounded-md font-mono">
                    0x6943...271b
                  </code>{" "}
                  (5.89 USDC on Base)
                </li>
                <li>Generate the image: &ldquo;cat on a skateboard, anime style&rdquo;</li>
                <li>Report back each step</li>
              </ol>
            </Message>

            {/* 3 */}
            <Message sender="agent" label="Agent Swarm">
              <Badge>Step 1 — API Research</Badge>
              <p className="text-[14px] text-zinc-700 leading-relaxed mb-3">Research complete:</p>
              <div className="bg-zinc-50 rounded-xl p-3.5 space-y-2">
                <InfoRow label="Endpoint">
                  <code className="text-[12px] font-mono break-all">
                    POST https://imference.com/ondemand/generate
                  </code>
                </InfoRow>
                <InfoRow label="Payment">x402 protocol — $0.05/image in USDC on Base</InfoRow>
                <InfoRow label="Model">illustrious-hassaku-xl (anime)</InfoRow>
                <InfoRow label="SDK">
                  <code className="text-[12px] font-mono">@x402/fetch</code> +{" "}
                  <code className="text-[12px] font-mono">@x402/evm</code> handle 402 automatically
                </InfoRow>
              </div>
            </Message>

            {/* 4 */}
            <Message sender="agent" label="Agent Swarm">
              <Badge>Step 2 — Environment &amp; Script</Badge>
              <p className="text-[14px] text-zinc-700 leading-relaxed mb-3">
                Environment configured. Verification script written using{" "}
                <code className="text-[12px] font-mono bg-zinc-100 px-1.5 py-0.5 rounded-md">
                  createX402Client()
                </code>{" "}
                from the agent-swarm x402 module with Openfort signer on Base mainnet.
              </p>
              <div className="rounded-xl overflow-hidden">
                <div className="bg-zinc-900 px-4 py-2 flex items-center gap-2 border-b border-zinc-800">
                  <div className="flex gap-1.5">
                    <div className="w-2.5 h-2.5 rounded-full bg-zinc-700" />
                    <div className="w-2.5 h-2.5 rounded-full bg-zinc-700" />
                    <div className="w-2.5 h-2.5 rounded-full bg-zinc-700" />
                  </div>
                  <span className="text-[11px] text-zinc-500 font-mono ml-2">verify-x402.ts</span>
                </div>
                <pre className="bg-zinc-950 text-zinc-300 p-4 text-[12px] md:text-[13px] font-mono overflow-x-auto leading-relaxed">
                  {`const client = createX402Client({
  signer: openfortSigner,
  chain: "base",
});

const result = await client.fetch(
  "https://imference.com/ondemand/generate",
  {
    method: "POST",
    body: JSON.stringify({
      prompt: "a cat on a skateboard, anime style",
      model: "illustrious-hassuka-xl",
    }),
  }
);
// x402 handles 402 → sign → retry automatically`}
                </pre>
              </div>
            </Message>

            {/* 5 — Success */}
            <Message sender="agent" label="Agent Swarm" highlight>
              <Badge variant="success">
                <CheckCircle className="w-3 h-3" />
                Verification Successful
              </Badge>
              <p className="text-[14px] font-medium text-zinc-900 mb-3">
                x402 payment flow verified end-to-end!
              </p>
              <div className="bg-white/80 rounded-xl p-3.5 border border-amber-200/60 space-y-2">
                <InfoRow label="Prompt">&ldquo;a cat on a skateboard, anime style&rdquo;</InfoRow>
                <InfoRow label="Model">illustrious-hassuka-xl</InfoRow>
                <InfoRow label="Cost">$0.05 USDC on Base mainnet</InfoRow>
                <InfoRow label="Wallet">
                  <code className="text-[11px] font-mono break-all">
                    0x69436bfe16c82a9a5ef74fd3de634c9c822c271b
                  </code>
                </InfoRow>
              </div>
              <p className="text-[13px] text-zinc-500 mt-3">
                Real payment on Base mainnet. The entire flow — from request to image — was
                autonomous.
              </p>
            </Message>

            {/* 6 */}
            <Message sender="human" label="Taras">
              <p className="text-[14px] text-zinc-700 leading-relaxed">
                Nice! Make sure to remember how to pay using x402.
              </p>
            </Message>

            <Message sender="agent" label="Agent Swarm">
              <p className="text-[14px] text-zinc-700 leading-relaxed">
                Noted. Saved a full x402 delegation guide to memory.
              </p>
            </Message>

            {/* 7 */}
            <Message sender="human" label="Taras">
              <p className="text-[14px] text-zinc-700 leading-relaxed">
                Can you create a new wallet and send me the address?
              </p>
            </Message>

            <Message sender="agent" label="Agent Swarm">
              <p className="text-[14px] text-zinc-700 leading-relaxed mb-3">
                New Openfort production wallet created:
              </p>
              <div className="bg-zinc-50 rounded-xl p-3.5">
                <InfoRow label="Address">
                  <code className="text-[11px] font-mono break-all">
                    0x0c34aa778b2d839e3434af9972d5861e3756894d
                  </code>
                </InfoRow>
              </div>
              <p className="text-[13px] text-zinc-500 mt-2">
                Brand new wallet — different from the existing one (0x69436bfe...).
              </p>
            </Message>
          </div>
        </section>

        {/* Footer */}
        <footer className="border-t border-zinc-200 py-8">
          <p className="text-[13px] text-zinc-500 leading-relaxed mb-5">
            This is a real session from the{" "}
            <Link
              href="/"
              className="text-amber-700 hover:text-amber-900 font-medium transition-colors"
            >
              Agent Swarm
            </Link>
            . The x402 protocol enables AI agents to autonomously pay for services using
            cryptocurrency — no human wallet interaction needed.
          </p>
          <div className="flex gap-2.5 flex-wrap">
            {[
              { href: "https://www.x402.org/", label: "x402 Protocol" },
              { href: "https://imference.com", label: "imference.com" },
              {
                href: "https://github.com/desplega-ai/agent-swarm",
                label: "Agent Swarm",
              },
            ].map(({ href, label }) => (
              <a
                key={href}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-[12px] font-medium text-zinc-500 hover:text-zinc-800 bg-white border border-zinc-200 hover:border-zinc-300 rounded-full px-3.5 py-1.5 transition-all"
              >
                <ExternalLink className="w-3 h-3" />
                {label}
              </a>
            ))}
          </div>
        </footer>
      </div>
    </main>
  );
}
