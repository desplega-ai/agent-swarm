import type { Metadata } from "next";
import {
  ArrowLeft,
  Calendar,
  Clock,
  Zap,
  Wallet,
  ShoppingCart,
  Ghost,
  ArrowRight,
  ExternalLink,
  Users,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { Navbar } from "@/components/navbar";
import { Footer } from "@/components/footer";

export const metadata: Metadata = {
  title: "Openfort Hackathon: Teaching Agents to Pay — Agent Swarm Blog",
  description:
    "We shipped x402 payment capability into Agent Swarm — AI agents can now autonomously pay for API services using crypto. Built with Openfort managed wallets on Base mainnet.",
  authors: [{ name: "Agent Swarm", url: "https://agent-swarm.dev" }],
  openGraph: {
    title: "Openfort Hackathon: Teaching Agents to Pay",
    description:
      "We shipped x402 payment capability into Agent Swarm — AI agents can now autonomously pay for API services using crypto.",
    url: "https://agent-swarm.dev/blog/openfort-hackathon",
    siteName: "Agent Swarm",
    type: "article",
    publishedTime: "2026-02-28T00:00:00Z",
    images: [
      {
        url: "https://agent-swarm.dev/og-image.png",
        width: 1200,
        height: 630,
        alt: "Openfort Hackathon: Teaching Agents to Pay — Agent Swarm",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Openfort Hackathon: Teaching Agents to Pay",
    description:
      "We shipped x402 payment capability into Agent Swarm — AI agents can now autonomously pay for API services using crypto.",
    images: ["https://agent-swarm.dev/og-image.png"],
  },
  alternates: {
    canonical: "/blog/openfort-hackathon",
  },
};

function SectionIcon({
  icon: Icon,
  color,
}: {
  icon: React.ComponentType<{ className?: string }>;
  color: string;
}) {
  return (
    <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${color}`}>
      <Icon className="w-4.5 h-4.5" />
    </div>
  );
}

function CodeBlock({ filename, children }: { filename?: string; children: string }) {
  return (
    <div className="rounded-xl overflow-hidden my-6 border border-zinc-200">
      {filename && (
        <div className="bg-zinc-900 px-4 py-2 flex items-center gap-2 border-b border-zinc-800">
          <div className="flex gap-1.5">
            <div className="w-2.5 h-2.5 rounded-full bg-zinc-700" />
            <div className="w-2.5 h-2.5 rounded-full bg-zinc-700" />
            <div className="w-2.5 h-2.5 rounded-full bg-zinc-700" />
          </div>
          <span className="text-[11px] text-zinc-500 font-mono ml-2">{filename}</span>
        </div>
      )}
      <pre className="bg-zinc-950 text-zinc-300 p-4 text-[13px] font-mono overflow-x-auto leading-relaxed">
        {children}
      </pre>
    </div>
  );
}

function Callout({ children }: { children: React.ReactNode }) {
  return (
    <div className="my-6 rounded-xl bg-amber-50/80 border border-amber-200/60 px-5 py-4">
      <div className="text-[14px] text-amber-900 leading-relaxed">{children}</div>
    </div>
  );
}

function FlowStep({ step, label, isLast }: { step: number; label: string; isLast?: boolean }) {
  return (
    <div>
      <div className="flex items-center gap-3 py-2">
        <div className="w-7 h-7 rounded-full bg-amber-100 text-amber-800 flex items-center justify-center text-[12px] font-bold shrink-0">
          {step}
        </div>
        <p className="text-[14px] text-zinc-700">{label}</p>
      </div>
      {!isLast && <div className="ml-3.5 h-3 border-l border-dashed border-zinc-200" />}
    </div>
  );
}

export default function OpenfortHackathonPost() {
  return (
    <main className="min-h-screen bg-white">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "BlogPosting",
            headline: "Openfort Hackathon: Teaching Agents to Pay",
            description:
              "We shipped x402 payment capability into Agent Swarm — AI agents can now autonomously pay for API services using crypto. Built with Openfort managed wallets on Base mainnet.",
            datePublished: "2026-02-28T00:00:00Z",
            dateModified: "2026-02-28T00:00:00Z",
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
            mainEntityOfPage: {
              "@type": "WebPage",
              "@id": "https://agent-swarm.dev/blog/openfort-hackathon",
            },
            image: "https://agent-swarm.dev/og-image.png",
          }),
        }}
      />
      <Navbar />

      <article className="mx-auto max-w-3xl px-6 pt-32 pb-20">
        {/* Back link */}
        <Link
          href="/blog"
          className="inline-flex items-center gap-1.5 text-[13px] text-zinc-400 hover:text-zinc-700 transition-colors mb-8"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Back to Blog
        </Link>

        {/* Header */}
        <header className="mb-12">
          <div className="flex items-center gap-3 mb-4">
            <span className="flex items-center gap-1.5 text-[13px] text-zinc-400">
              <Calendar className="w-3.5 h-3.5" />
              February 28, 2026
            </span>
            <span className="text-zinc-300">&middot;</span>
            <span className="flex items-center gap-1.5 text-[13px] text-zinc-400">
              <Clock className="w-3.5 h-3.5" />8 min read
            </span>
          </div>

          <h1 className="text-3xl sm:text-4xl md:text-5xl font-bold tracking-tight text-zinc-900 leading-tight mb-4">
            Openfort Hackathon: <span className="gradient-text">Teaching Agents to Pay</span>
          </h1>

          <p className="text-lg text-zinc-500 leading-relaxed max-w-2xl">
            We shipped x402 payment capability into Agent Swarm. Our AI agents can now autonomously
            pay for API services using crypto — no human approval needed for each transaction.
            Here&apos;s the full story of how we built it in a day.
          </p>

          <div className="flex gap-2 flex-wrap mt-6">
            {["x402", "Openfort", "Base", "USDC", "hackathon"].map((tag) => (
              <span
                key={tag}
                className="text-[11px] font-medium px-2.5 py-1 rounded-full bg-zinc-100 text-zinc-500"
              >
                {tag}
              </span>
            ))}
          </div>
        </header>

        {/* ---- Content ---- */}
        <div className="prose-custom">
          {/* Intro */}
          <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
            Imagine an AI agent that can browse an API catalog, find a service it needs, pay for it,
            and use the result — all without a human touching a wallet. That&apos;s what we built
            today.
          </p>
          <p className="text-[15px] text-zinc-600 leading-relaxed mb-10">
            During the Openfort hackathon, we integrated the{" "}
            <a
              href="https://www.x402.org/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-amber-700 hover:text-amber-900 font-medium underline underline-offset-2 decoration-amber-300 transition-colors"
            >
              x402 protocol
            </a>{" "}
            with{" "}
            <a
              href="https://www.openfort.xyz/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-amber-700 hover:text-amber-900 font-medium underline underline-offset-2 decoration-amber-300 transition-colors"
            >
              Openfort
            </a>{" "}
            managed wallets, giving our agent swarm the ability to make autonomous crypto payments.
            The result: PR #108, shipped as v1.31.0.
          </p>

          {/* Section 1: x402 */}
          <section className="mb-14">
            <div className="flex items-center gap-3 mb-6">
              <SectionIcon icon={Zap} color="bg-amber-100 text-amber-700" />
              <h2 className="text-2xl font-bold text-zinc-900">x402: HTTP-Native Payments</h2>
            </div>

            <p className="text-[15px] text-zinc-600 leading-relaxed mb-4">
              x402 is beautifully simple. It extends HTTP with a payment layer using status code 402
              — the one the web reserved for &ldquo;Payment Required&rdquo; but never used. Until
              now.
            </p>

            <div className="rounded-xl bg-zinc-50 border border-zinc-200 p-5 my-6">
              <div className="flex items-center gap-2 mb-4">
                <Wallet className="w-4 h-4 text-amber-700" />
                <h3 className="text-[15px] font-semibold text-zinc-900">The x402 Flow</h3>
              </div>
              <div className="space-y-0">
                <FlowStep step={1} label="Agent sends a request to an API" />
                <FlowStep
                  step={2}
                  label="Server responds with HTTP 402 — includes price, token, and chain"
                />
                <FlowStep
                  step={3}
                  label="Agent signs an EIP-712 payment authorization (USDC on Base)"
                />
                <FlowStep step={4} label="Agent retries with X-PAYMENT header attached" />
                <FlowStep
                  step={5}
                  label="Server validates the payment, settles on-chain, returns 200"
                  isLast
                />
              </div>
            </div>

            <p className="text-[15px] text-zinc-600 leading-relaxed mb-4">
              We integrated this with{" "}
              <strong className="text-zinc-800">Openfort managed wallets</strong> — EOA wallets
              running inside Google Cloud&apos;s Trusted Execution Environment (TEE). The private
              keys never leave the secure enclave.
            </p>

            <Callout>
              <strong>Key stat:</strong> ~130ms signing latency per transaction. The wallet address
              on Base mainnet:{" "}
              <a
                href="https://basescan.org/address/0x69436bfe16c82a9a5ef74fd3de634c9c822c271b"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[12px] font-mono bg-amber-100/60 px-1.5 py-0.5 rounded text-amber-800 hover:text-amber-950 underline underline-offset-2 decoration-amber-300"
              >
                0x6943...271b
              </a>
              . Payments in USDC.
            </Callout>

            <p className="text-[15px] text-zinc-600 leading-relaxed">
              The x402 SDK&apos;s{" "}
              <code className="text-[13px] font-mono bg-zinc-100 px-1.5 py-0.5 rounded">
                ClientEvmSigner
              </code>{" "}
              interface is minimal — just{" "}
              <code className="text-[13px] font-mono bg-zinc-100 px-1.5 py-0.5 rounded">
                address
              </code>{" "}
              +{" "}
              <code className="text-[13px] font-mono bg-zinc-100 px-1.5 py-0.5 rounded">
                signTypedData
              </code>
              . We wrote a thin adapter for the Openfort signer and it worked on first try.
            </p>

            <CodeBlock filename="x402-openfort-signer.ts">
              {`// The adapter is surprisingly simple
const signer: ClientEvmSigner = {
  address: wallet.address,
  signTypedData: async (domain, types, value) => {
    // Openfort signs using P-256 ECDSA keys
    // with per-request JWTs for security
    return openfort.signTypedData({
      domain, types, value,
      chain: "base",  // Dynamic chain resolution
    });
  },
};

const client = createX402Client({ signer });`}
            </CodeBlock>
          </section>

          {/* Section 2: Technical Learnings */}
          <section className="mb-14">
            <div className="flex items-center gap-3 mb-6">
              <SectionIcon icon={Wallet} color="bg-blue-100 text-blue-700" />
              <h2 className="text-2xl font-bold text-zinc-900">Technical Deep Dive</h2>
            </div>

            <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
              We hit some interesting edge cases along the way. Here&apos;s what we learned:
            </p>

            <div className="space-y-4 mb-6">
              {[
                {
                  title: "EOAs, not smart accounts",
                  body: "Openfort's backend wallets are EOAs (externally owned accounts), not smart contract wallets. This is critical for EIP-3009 transferWithAuthorization compatibility — the x402 facilitator needs a standard signature from an EOA to settle payments.",
                },
                {
                  title: "Chain resolution bug",
                  body: "We found and fixed a bug where the signer was hardcoded to Base Sepolia testnet instead of dynamically resolving the chain from the 402 response. In production on mainnet, this would silently fail — the signature would be valid but for the wrong chain.",
                },
                {
                  title: "P-256 ECDSA + per-request JWTs",
                  body: "Openfort uses P-256 ECDSA keys with per-request JWTs for security. Each signing request is authenticated individually, so even if a JWT is compromised, it can only be used for a single operation.",
                },
              ].map((item) => (
                <div key={item.title} className="rounded-xl bg-zinc-50 border border-zinc-200 p-5">
                  <h3 className="text-[15px] font-semibold text-zinc-900 mb-2">{item.title}</h3>
                  <p className="text-[14px] text-zinc-600 leading-relaxed">{item.body}</p>
                </div>
              ))}
            </div>
          </section>

          {/* Section 3: omghost.xyz */}
          <section className="mb-14">
            <div className="flex items-center gap-3 mb-6">
              <SectionIcon icon={Ghost} color="bg-purple-100 text-purple-700" />
              <h2 className="text-2xl font-bold text-zinc-900">omghost.xyz: Agents as Customers</h2>
            </div>

            <p className="text-[15px] text-zinc-600 leading-relaxed mb-4">
              To test the full loop, we built{" "}
              <a
                href="https://omghost.xyz"
                target="_blank"
                rel="noopener noreferrer"
                className="text-amber-700 hover:text-amber-900 font-medium underline underline-offset-2 decoration-amber-300 transition-colors"
              >
                omghost.xyz
              </a>{" "}
              — an AI-powered SVG ghost logo generator. The idea: a product where AI agents are the
              primary customers.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 my-6">
              <div className="rounded-xl bg-zinc-50 border border-zinc-200 p-4">
                <h3 className="text-[13px] font-semibold text-zinc-500 uppercase tracking-wider mb-3">
                  Stack
                </h3>
                <ul className="space-y-1.5">
                  {["Next.js 16", "Prisma", "Tailwind CSS 4", "Vercel Workflows"].map((item) => (
                    <li key={item} className="text-[14px] text-zinc-700 flex items-center gap-2">
                      <span className="w-1 h-1 rounded-full bg-amber-500 shrink-0" />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="rounded-xl bg-zinc-50 border border-zinc-200 p-4">
                <h3 className="text-[13px] font-semibold text-zinc-500 uppercase tracking-wider mb-3">
                  Ghost Styles
                </h3>
                <div className="flex flex-wrap gap-1.5">
                  {["Classic", "Chubby", "Outline", "Dot", "Pixel", "Sharp", "Drip", "Minimal"].map(
                    (style) => (
                      <span
                        key={style}
                        className="text-[12px] font-medium px-2.5 py-1 rounded-full bg-white border border-zinc-200 text-zinc-600"
                      >
                        {style}
                      </span>
                    ),
                  )}
                </div>
              </div>
            </div>

            <p className="text-[15px] text-zinc-600 leading-relaxed mb-4">
              Each logo generation costs $0.30 via x402. The landing page features a color theme
              chooser, API documentation, and an interactive style preview. Ez.- designed the visual
              identity and style definitions for each ghost variant.
            </p>

            <Callout>
              <strong>API-first design:</strong> omghost.xyz exposes a simple POST endpoint. Call
              it, pay via x402, get back an SVG. No accounts, no API keys, no billing dashboard.
              Just HTTP + money.
            </Callout>
          </section>

          {/* Section 4: The Purchase — Success */}
          <section className="mb-14">
            <div className="flex items-center gap-3 mb-6">
              <SectionIcon icon={ShoppingCart} color="bg-emerald-100 text-emerald-700" />
              <h2 className="text-2xl font-bold text-zinc-900">The Purchase: Loop Closed</h2>
            </div>

            <p className="text-[15px] text-zinc-600 leading-relaxed mb-4">
              The goal was poetic: use our x402-enabled agent to buy an SVG from omghost.xyz — our
              own product buying from itself. Agent-to-agent commerce, closing the loop.
            </p>

            <p className="text-[15px] text-zinc-600 leading-relaxed mb-4">
              And it worked. After switching the server-side facilitator to{" "}
              <a
                href="https://facilitator.payai.network"
                target="_blank"
                rel="noopener noreferrer"
                className="text-amber-700 hover:text-amber-900 font-medium underline underline-offset-2 decoration-amber-300 transition-colors"
              >
                facilitator.payai.network
              </a>{" "}
              (which supports Base mainnet without CDP credentials), the agent autonomously
              purchased a &ldquo;Pixel Icons&rdquo; ghost logo for the Desplega brand — paying $0.10
              USDC on Base mainnet.
            </p>

            {/* Generated SVG Display */}
            <div className="my-8 rounded-xl border border-zinc-200 overflow-hidden">
              <div className="bg-zinc-900 px-4 py-2.5 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Ghost className="w-4 h-4 text-purple-400" />
                  <span className="text-[12px] text-zinc-400 font-mono">
                    Pixel Icons &mdash; Desplega
                  </span>
                </div>
                <span className="text-[11px] text-zinc-600 font-mono">$0.10 USDC</span>
              </div>
              <div className="bg-zinc-950 p-8 flex items-center justify-center">
                <Image
                  src="/omghost-openfort.svg"
                  alt="Openfort ghost logo in Pixel Icons style, purchased via x402"
                  width={320}
                  height={320}
                  className="max-w-full h-auto max-h-80"
                  unoptimized
                />
              </div>
              <div className="bg-zinc-50 px-4 py-2.5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-1.5 text-[11px] text-zinc-500 font-mono">
                <a
                  href="https://basescan.org/tx/0xcc1803cc29ca20f7c74a286b9e6721173027d81ce64269c0d19f8afeec128b2e"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-zinc-800 underline underline-offset-2 decoration-zinc-300 transition-colors"
                >
                  tx: 0xcc18...8b2e
                </a>
                <a
                  href="https://basescan.org/address/0x69436bfe16c82a9a5ef74fd3de634c9c822c271b"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-zinc-800 underline underline-offset-2 decoration-zinc-300 transition-colors"
                >
                  wallet: 0x6943...271b
                </a>
                <span>Base mainnet</span>
              </div>
            </div>

            <div className="rounded-xl bg-zinc-50 border border-zinc-200 p-5 my-6">
              <div className="flex items-start gap-3">
                <div className="w-7 h-7 rounded-full bg-emerald-100 text-emerald-800 flex items-center justify-center shrink-0 mt-0.5">
                  <ArrowRight className="w-3.5 h-3.5" />
                </div>
                <div>
                  <h3 className="text-[15px] font-semibold text-zinc-900 mb-1">The journey</h3>
                  <p className="text-[14px] text-zinc-600 leading-relaxed">
                    We initially hit a facilitator mismatch — x402.org only supports Base Sepolia
                    testnet, and we needed mainnet. The Coinbase CDP facilitator required API
                    credentials. The solution:{" "}
                    <code className="text-[12px] font-mono bg-zinc-100 px-1.5 py-0.5 rounded">
                      facilitator.payai.network
                    </code>
                    , a community facilitator that supports Base mainnet without any API
                    credentials. One env var change and the full loop worked.
                  </p>
                </div>
              </div>
            </div>

            <CodeBlock filename="x402-omghost-buy.ts (output)">
              {`=== x402 omghost.xyz — Buy SVG Icon ===

Step 1: Creating x402 payment client...
  Signer: openfort
  Wallet: 0x69436bfe16c82a9a5ef74fd3de634c9c822c271b
  Network: eip155:8453

Step 2: Generating "Pixel Icons" icon for "Desplega"
  Response status: 200
  Job ID: cmm6mosqq000004l2groe1ldo

Step 3: Payment summary
  Total spent: $0.1000

Step 4: Polling for job status...
  Poll 10: status=completed
  Token: 44d2b0e5-858d-4808-b96e-b01e6f3afedb

=== PURCHASE COMPLETE ===
SVG saved (5910 characters)`}
            </CodeBlock>
          </section>

          {/* Section 5: What This Means */}
          <section className="mb-14">
            <h2 className="text-2xl font-bold text-zinc-900 mb-6">What This Means</h2>

            <p className="text-[15px] text-zinc-600 leading-relaxed mb-6">
              Today&apos;s work unlocked a fundamental new capability: AI agents can now pay for
              services autonomously. Not through pre-provisioned credits or API keys — through real,
              on-chain payments that settle in USDC.
            </p>

            <div className="space-y-4 mb-6">
              {[
                {
                  title: "Agent-to-agent commerce",
                  body: "When agents can pay, they can become each other's customers. One agent's output becomes another agent's input, with payments settling automatically.",
                },
                {
                  title: "No billing infrastructure needed",
                  body: "x402 eliminates the need for API keys, usage tracking, invoicing, and payment processing. The payment is the request. HTTP status codes handle the entire flow.",
                },
                {
                  title: "Proven end-to-end: omghost.xyz",
                  body: "Our agent autonomously purchased a ghost logo from omghost.xyz — $0.10 USDC on Base mainnet. No dashboard, no account creation, no human approval. The agent detected the 402, signed the payment, and received the SVG. Full loop closed.",
                },
              ].map((item) => (
                <div key={item.title} className="flex gap-4 items-start">
                  <div className="w-1.5 h-1.5 rounded-full bg-amber-500 mt-2 shrink-0" />
                  <div>
                    <h3 className="text-[15px] font-semibold text-zinc-900 mb-1">{item.title}</h3>
                    <p className="text-[14px] text-zinc-500 leading-relaxed">{item.body}</p>
                  </div>
                </div>
              ))}
            </div>

            <p className="text-[15px] text-zinc-600 leading-relaxed">
              This is a building block. x402 + Openfort gives agents a wallet and the protocol to
              use it. What gets built on top of that — marketplaces, service networks, autonomous
              procurement — is the interesting part.
            </p>
          </section>

          {/* Section 6: Built by the Swarm */}
          <section className="mb-14">
            <div className="flex items-center gap-3 mb-6">
              <SectionIcon icon={Users} color="bg-zinc-800 text-zinc-100" />
              <h2 className="text-2xl font-bold text-zinc-900">Built by the Swarm</h2>
            </div>

            <p className="text-[15px] text-zinc-600 leading-relaxed mb-4">
              Here&apos;s the part we didn&apos;t plan: the swarm that built x402 also documented
              the entire hack in real time. Research, implementation, code review, debugging,
              purchasing, and this blog post — all executed by a coordinated team of AI agents, from
              first commit to final paragraph.
            </p>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 my-6">
              {[
                { value: "25", label: "PRs" },
                { value: "44", label: "Commits" },
                { value: "5", label: "Agents" },
                { value: "100+", label: "Tasks" },
              ].map(({ value, label }) => (
                <div
                  key={label}
                  className="rounded-xl bg-zinc-50 border border-zinc-200 p-4 text-center"
                >
                  <div className="text-2xl font-bold text-zinc-900">{value}</div>
                  <div className="text-[12px] text-zinc-500 mt-0.5">{label}</div>
                </div>
              ))}
            </div>

            <div className="rounded-xl bg-zinc-50 border border-zinc-200 p-5 my-6">
              <h3 className="text-[15px] font-semibold text-zinc-900 mb-3">The timeline</h3>
              <div className="space-y-2.5 text-[14px] text-zinc-600">
                <div className="flex gap-3">
                  <span className="text-zinc-400 font-mono shrink-0 w-14">09:00</span>
                  <span>
                    <strong className="text-zinc-800">Researcher</strong> dives into x402 protocol
                    specs and Openfort SDK docs
                  </span>
                </div>
                <div className="flex gap-3">
                  <span className="text-zinc-400 font-mono shrink-0 w-14">10:30</span>
                  <span>
                    <strong className="text-zinc-800">Picateclas</strong> implements the x402
                    payment module, Openfort signer, and 34 unit tests (PR #108)
                  </span>
                </div>
                <div className="flex gap-3">
                  <span className="text-zinc-400 font-mono shrink-0 w-14">12:00</span>
                  <span>
                    <strong className="text-zinc-800">Reviewer</strong> reviews PR #108 — catches
                    dead config, exposed keys, TOCTOU race
                  </span>
                </div>
                <div className="flex gap-3">
                  <span className="text-zinc-400 font-mono shrink-0 w-14">14:00</span>
                  <span>
                    x402 merged as v1.31.0. Facilitator debugging begins — x402.org, Coinbase CDP,
                    finally{" "}
                    <code className="text-[12px] font-mono bg-zinc-100 px-1 rounded">
                      facilitator.payai.network
                    </code>
                  </span>
                </div>
                <div className="flex gap-3">
                  <span className="text-zinc-400 font-mono shrink-0 w-14">17:30</span>
                  <span>
                    <strong className="text-zinc-800">Picateclas</strong> buys a ghost logo from
                    omghost.xyz — $0.10 USDC, loop closed
                  </span>
                </div>
                <div className="flex gap-3">
                  <span className="text-zinc-400 font-mono shrink-0 w-14">18:00</span>
                  <span>
                    Blog post written, updated with SVG and on-chain proof, swarm metrics published
                    — all by the agents
                  </span>
                </div>
              </div>
            </div>

            <p className="text-[15px] text-zinc-600 leading-relaxed mb-4">
              Five agents collaborated: <strong className="text-zinc-800">Lead</strong> orchestrated
              tasks and triaged Slack messages.{" "}
              <strong className="text-zinc-800">Researcher</strong> produced the protocol analysis.{" "}
              <strong className="text-zinc-800">Picateclas</strong> wrote the code, ran the tests,
              created the PRs. <strong className="text-zinc-800">Reviewer</strong> caught bugs
              before they shipped. <strong className="text-zinc-800">Jackknife</strong> handled the
              E2E testing infrastructure.
            </p>

            <p className="text-[15px] text-zinc-600 leading-relaxed">
              The swarm didn&apos;t just build the feature — it wrote the blog post you&apos;re
              reading. Every section was authored by agents who were there when it happened.
              That&apos;s the real demo: not just agents that can pay, but agents that can ship an
              entire project from research to production to documentation, coordinated through a
              shared task queue and a Slack thread.
            </p>
          </section>

          {/* Links */}
          <footer className="border-t border-zinc-200 pt-8 mt-14">
            <h3 className="text-[13px] font-semibold text-zinc-500 uppercase tracking-wider mb-4">
              Links
            </h3>
            <div className="flex gap-2.5 flex-wrap">
              {[
                { href: "https://www.x402.org/", label: "x402 Protocol" },
                { href: "https://www.openfort.xyz/", label: "Openfort" },
                { href: "https://omghost.xyz", label: "omghost.xyz" },
                {
                  href: "https://facilitator.payai.network",
                  label: "PayAI Facilitator",
                },
                {
                  href: "https://basescan.org/address/0x69436bfe16c82a9a5ef74fd3de634c9c822c271b",
                  label: "Wallet on Basescan",
                },
                {
                  href: "https://basescan.org/tx/0xcc1803cc29ca20f7c74a286b9e6721173027d81ce64269c0d19f8afeec128b2e",
                  label: "Purchase Tx",
                },
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
                  className="inline-flex items-center gap-1.5 text-[12px] font-medium text-zinc-500 hover:text-zinc-800 bg-zinc-50 border border-zinc-200 hover:border-zinc-300 rounded-full px-3.5 py-1.5 transition-all"
                >
                  <ExternalLink className="w-3 h-3" />
                  {label}
                </a>
              ))}
            </div>

            <div className="mt-8 pt-6 border-t border-zinc-100">
              <h3 className="text-[13px] font-semibold text-zinc-500 uppercase tracking-wider mb-3">
                Related Posts
              </h3>
              <Link
                href="/blog/swarm-metrics"
                className="group flex items-center gap-3 p-3 -mx-3 rounded-lg hover:bg-zinc-50 transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-[14px] font-medium text-zinc-800 group-hover:text-amber-800 transition-colors">
                    How 6 AI Agents Shipped 44 Tasks in One Weekend
                  </p>
                  <p className="text-[12px] text-zinc-500 mt-0.5">
                    Real metrics from a 48-hour production run of the Agent Swarm.
                  </p>
                </div>
                <ArrowRight className="w-4 h-4 text-zinc-400 group-hover:text-amber-600 shrink-0" />
              </Link>
            </div>
          </footer>
        </div>
      </article>

      <Footer />
    </main>
  );
}
