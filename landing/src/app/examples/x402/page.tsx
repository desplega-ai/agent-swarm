import type { Metadata } from "next";
import { ArrowLeft, ExternalLink } from "lucide-react";

export const metadata: Metadata = {
  title: "x402 Payment Demo — AI Agents Pay for Services with Crypto",
  description:
    "Watch how the Agent Swarm used x402 protocol to autonomously generate an AI image by paying $0.05 USDC on Base mainnet — no human wallet interaction required.",
  openGraph: {
    title: "x402 Payment Demo — AI Agents Pay for Services with Crypto",
    description:
      "A real session where AI agents used x402 protocol to pay for image generation with USDC on Base mainnet.",
    images: [
      {
        url: "https://blob.imference.com/large/37f7ee3b-616b-402f-8cb3-d69896165e3f.webp",
        width: 1024,
        height: 1024,
        alt: "A cat on a skateboard, anime style — generated via x402 payment",
      },
    ],
  },
};

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
    <div
      className={`flex gap-3 ${sender === "human" ? "flex-row-reverse" : "flex-row"}`}
    >
      <div
        className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 text-xs font-bold mt-1 ${
          sender === "human"
            ? "bg-amber-700 text-white"
            : "bg-zinc-900 text-amber-400"
        }`}
      >
        {sender === "human" ? "T" : "AI"}
      </div>
      <div
        className={`flex-1 max-w-[85%] rounded-xl p-4 ${
          highlight
            ? "bg-amber-50 border border-amber-200 shadow-sm shadow-amber-100"
            : sender === "human"
              ? "bg-zinc-100 border border-zinc-200"
              : "bg-white border border-zinc-200"
        }`}
      >
        <span
          className={`text-[10px] font-semibold uppercase tracking-wider block mb-1 ${
            sender === "human" ? "text-amber-700" : "text-zinc-400"
          }`}
        >
          {label}
        </span>
        <div className="[&>*:last-child]:mb-0">{children}</div>
      </div>
    </div>
  );
}

function FlowStep({
  step,
  label,
}: {
  step: number;
  label: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="w-6 h-6 rounded-full bg-amber-700 text-white flex items-center justify-center text-[10px] font-bold shrink-0">
        {step}
      </div>
      <p className="text-sm text-zinc-700">{label}</p>
    </div>
  );
}

function StepBadge({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-block text-[10px] font-semibold px-2 py-0.5 rounded-md bg-amber-100 text-amber-800 mb-2">
      {children}
    </span>
  );
}

export default function X402ExamplePage() {
  return (
    <main className="min-h-screen bg-white">
      {/* Minimal top bar */}
      <nav className="border-b border-zinc-100 bg-white/80 backdrop-blur-xl sticky top-0 z-50">
        <div className="mx-auto max-w-3xl px-6 py-3 flex items-center gap-3">
          <a
            href="/"
            className="flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-900 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Back
          </a>
          <span className="text-zinc-300">|</span>
          <span className="text-[10px] font-semibold uppercase tracking-wider bg-amber-100 text-amber-800 px-2 py-0.5 rounded-md">
            Example
          </span>
          <span className="text-[10px] font-semibold uppercase tracking-wider bg-zinc-100 text-zinc-600 px-2 py-0.5 rounded-md">
            x402
          </span>
        </div>
      </nav>

      <div className="mx-auto max-w-3xl px-6 py-12">
        {/* Header */}
        <h1 className="text-3xl md:text-4xl font-bold tracking-tight text-zinc-900 mb-3">
          AI Agents Pay for Services with Crypto
        </h1>
        <p className="text-base text-zinc-500 leading-relaxed mb-10">
          A real session where our agent swarm used the{" "}
          <a
            href="https://www.x402.org/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-amber-700 hover:text-amber-900 font-medium transition-colors"
          >
            x402 protocol
          </a>{" "}
          to generate an AI image by paying $0.05 USDC on Base mainnet — no
          human wallet interaction required.
        </p>

        {/* Generated image */}
        <div className="rounded-2xl overflow-hidden border border-zinc-200 mb-10 relative">
          <img
            src="https://blob.imference.com/large/37f7ee3b-616b-402f-8cb3-d69896165e3f.webp"
            alt="A cat on a skateboard, anime style — generated via x402 payment"
            className="w-full block"
          />
          <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent p-4 pt-10">
            <p className="text-white/90 text-sm font-medium italic">
              &ldquo;a cat on a skateboard, anime style&rdquo;
            </p>
            <div className="flex gap-2 mt-2 flex-wrap">
              <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md bg-white/20 text-white">
                illustrious-hassuka-xl
              </span>
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-md bg-amber-400 text-zinc-900">
                $0.05 USDC
              </span>
              <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md bg-white/20 text-white">
                Base mainnet
              </span>
            </div>
          </div>
        </div>

        {/* x402 flow */}
        <div className="bg-zinc-50 rounded-xl border border-zinc-200 p-6 mb-10">
          <h2 className="text-lg font-semibold text-zinc-900 mb-4">
            How x402 Payment Works
          </h2>
          <div className="space-y-3">
            <FlowStep step={1} label="Client sends POST request to API" />
            <div className="ml-[11px] h-2 border-l-2 border-dashed border-zinc-300" />
            <FlowStep
              step={2}
              label="Server responds with 402 Payment Required"
            />
            <div className="ml-[11px] h-2 border-l-2 border-dashed border-zinc-300" />
            <FlowStep
              step={3}
              label="Client signs EIP-712 payment (USDC on Base)"
            />
            <div className="ml-[11px] h-2 border-l-2 border-dashed border-zinc-300" />
            <FlowStep
              step={4}
              label="Client resends request with X-PAYMENT header"
            />
            <div className="ml-[11px] h-2 border-l-2 border-dashed border-zinc-300" />
            <FlowStep
              step={5}
              label="Server validates payment, returns 200 with image"
            />
          </div>
        </div>

        {/* Session transcript */}
        <h2 className="text-xl font-semibold text-zinc-900 mb-6">
          Session Transcript
        </h2>

        <div className="space-y-5 mb-12">
          {/* 1. Taras asks for wallet */}
          <Message sender="human" label="Taras">
            <p className="text-sm text-zinc-700">
              Can you create an Openfort wallet (prod) so I can top it up?
            </p>
          </Message>

          {/* 2. Agent plans */}
          <Message sender="agent" label="Agent Swarm">
            <p className="text-sm text-zinc-700 mb-2">On it. The plan:</p>
            <ol className="text-sm text-zinc-700 space-y-1 pl-4 list-decimal">
              <li>
                Research the imference.com API (endpoints, pricing, x402 flow)
              </li>
              <li>
                Write a script using our Openfort wallet{" "}
                <code className="text-xs bg-zinc-100 px-1 py-0.5 rounded">
                  0x6943...271b
                </code>{" "}
                (5.89 USDC on Base)
              </li>
              <li>
                Generate the image: &ldquo;cat on a skateboard, anime
                style&rdquo;
              </li>
              <li>Report back each step</li>
            </ol>
          </Message>

          {/* 3. API research */}
          <Message sender="agent" label="Agent Swarm">
            <StepBadge>Step 1 — API Research</StepBadge>
            <p className="text-sm text-zinc-700 mb-2">Research complete:</p>
            <div className="bg-zinc-50 rounded-lg p-3 border border-zinc-100 space-y-1">
              <p className="text-sm text-zinc-700">
                <strong>Endpoint:</strong>{" "}
                <code className="text-xs">
                  POST https://imference.com/ondemand/generate
                </code>
              </p>
              <p className="text-sm text-zinc-700">
                <strong>Payment:</strong> x402 protocol — $0.05/image in USDC on
                Base
              </p>
              <p className="text-sm text-zinc-700">
                <strong>Model:</strong> illustrious-hassaku-xl (anime)
              </p>
              <p className="text-sm text-zinc-700">
                <strong>SDK:</strong>{" "}
                <code className="text-xs">@x402/fetch</code> +{" "}
                <code className="text-xs">@x402/evm</code> handle 402
                negotiation automatically
              </p>
            </div>
          </Message>

          {/* 4. Script */}
          <Message sender="agent" label="Agent Swarm">
            <StepBadge>Step 2 — Environment &amp; Script</StepBadge>
            <p className="text-sm text-zinc-700 mb-2">
              Environment configured. Verification script written using{" "}
              <code className="text-xs">createX402Client()</code> from the
              agent-swarm x402 module with Openfort signer on Base mainnet.
            </p>
            <pre className="bg-zinc-900 text-zinc-300 rounded-lg p-4 text-xs font-mono overflow-x-auto leading-relaxed">
{`// Simplified flow
const client = createX402Client({
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
          </Message>

          {/* 5. Success */}
          <Message sender="agent" label="Agent Swarm" highlight>
            <StepBadge>Step 3 — Success!</StepBadge>
            <p className="text-sm font-medium text-zinc-900 mb-2">
              x402 Verification SUCCESSFUL!
            </p>
            <div className="bg-white rounded-lg p-3 border border-amber-200 space-y-1">
              <p className="text-sm text-zinc-700">
                <strong>Prompt:</strong> &ldquo;a cat on a skateboard, anime
                style&rdquo;
              </p>
              <p className="text-sm text-zinc-700">
                <strong>Model:</strong> illustrious-hassuka-xl
              </p>
              <p className="text-sm text-zinc-700">
                <strong>Cost:</strong> $0.05 USDC on Base mainnet
              </p>
              <p className="text-sm text-zinc-700">
                <strong>Wallet:</strong>{" "}
                <code className="text-xs">
                  0x69436bfe16c82a9a5ef74fd3de634c9c822c271b
                </code>
              </p>
            </div>
            <p className="text-sm text-zinc-500 mt-3">
              End-to-end flow works correctly with real payment on Base mainnet.
            </p>
          </Message>

          {/* 6. Confirmation */}
          <Message sender="human" label="Taras">
            <p className="text-sm text-zinc-700">
              Nice! Make sure to remember how to pay using x402.
            </p>
          </Message>

          <Message sender="agent" label="Agent Swarm">
            <p className="text-sm text-zinc-700">
              Noted. Saved a full x402 delegation guide to memory.
            </p>
          </Message>

          {/* 7. New wallet */}
          <Message sender="human" label="Taras">
            <p className="text-sm text-zinc-700">
              Can you create a new wallet and send me the address?
            </p>
          </Message>

          <Message sender="agent" label="Agent Swarm">
            <p className="text-sm text-zinc-700 mb-2">
              New Openfort production backend wallet created:
            </p>
            <div className="bg-zinc-50 rounded-lg p-3 border border-zinc-100">
              <p className="text-sm text-zinc-700">
                <strong>Address:</strong>{" "}
                <code className="text-xs">
                  0x0c34aa778b2d839e3434af9972d5861e3756894d
                </code>
              </p>
            </div>
            <p className="text-sm text-zinc-500 mt-2">
              Brand new wallet — different from the existing one
              (0x69436bfe...).
            </p>
          </Message>
        </div>

        {/* Footer */}
        <div className="border-t border-zinc-200 pt-6 pb-4">
          <p className="text-sm text-zinc-500 mb-4">
            This is a real session from the Agent Swarm. The x402 protocol
            enables AI agents to autonomously pay for services using
            cryptocurrency — no human wallet interaction needed.
          </p>
          <div className="flex gap-3 flex-wrap">
            <a
              href="https://www.x402.org/"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-zinc-500 hover:text-zinc-700 border border-zinc-200 rounded-lg px-3 py-1.5 transition-colors"
            >
              <ExternalLink className="w-3 h-3" />
              x402 Protocol
            </a>
            <a
              href="https://imference.com"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-zinc-500 hover:text-zinc-700 border border-zinc-200 rounded-lg px-3 py-1.5 transition-colors"
            >
              <ExternalLink className="w-3 h-3" />
              imference.com
            </a>
            <a
              href="https://github.com/desplega-ai/agent-swarm"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs font-medium text-zinc-500 hover:text-zinc-700 border border-zinc-200 rounded-lg px-3 py-1.5 transition-colors"
            >
              <ExternalLink className="w-3 h-3" />
              Agent Swarm on GitHub
            </a>
          </div>
        </div>
      </div>
    </main>
  );
}
