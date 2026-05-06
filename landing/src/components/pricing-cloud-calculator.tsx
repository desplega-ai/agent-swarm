"use client";

import { useId, useState } from "react";
import { ArrowRight, Check, Minus, Plus } from "lucide-react";

type Tier = { workers: number; eurPerMonth: number };

const TIERS: Tier[] = [
  { workers: 4, eurPerMonth: 30 },
  { workers: 6, eurPerMonth: 45 },
  { workers: 10, eurPerMonth: 70 },
  { workers: 12, eurPerMonth: 80 },
  { workers: 14, eurPerMonth: 90 },
  { workers: 16, eurPerMonth: 100 },
];
const DEFAULT_TIER_INDEX = 0;

const FEATURES = [
  "Hosted lead + dashboard",
  "Coordination intelligence built in — memory persists across sessions",
  "Slack, GitHub, GitLab, Linear, AgentMail, Sentry",
  "Bring your own model keys (BYOK)",
  "7-day free trial · no card required",
];

function formatEuro(amount: number): string {
  if (Number.isInteger(amount)) return `€${amount}`;
  return `€${amount.toFixed(2)}`;
}

export function PricingCloudCalculator() {
  const [tierIndex, setTierIndex] = useState<number>(DEFAULT_TIER_INDEX);
  const stepperLabelId = useId();

  const tier = TIERS[tierIndex];
  const minIndex = 0;
  const maxIndex = TIERS.length - 1;

  const decrement = () => setTierIndex((i) => Math.max(minIndex, i - 1));
  const increment = () => setTierIndex((i) => Math.min(maxIndex, i + 1));

  return (
    <div className="flex flex-col h-full">
      <div className="text-[13px] font-semibold tracking-tight text-amber-400">Cloud</div>
      <div className="mt-1 text-[12.5px] text-zinc-400">Hosted swarm, pick your size</div>

      <div className="mt-5 flex items-baseline gap-1.5">
        <span className="text-[44px] font-bold tracking-[-0.03em] leading-none text-white">
          {formatEuro(tier.eurPerMonth)}
        </span>
        <span className="text-[13px] text-zinc-400">/ mo</span>
      </div>

      <div className="mt-3 font-mono text-[11.5px] tracking-[0.02em] text-amber-300">
        {tier.workers} workers · billed monthly
      </div>

      <div className="mt-5">
        <div
          id={stepperLabelId}
          className="font-mono text-[10.5px] tracking-[0.14em] uppercase text-zinc-400 mb-2"
        >
          Workers
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={decrement}
            disabled={tierIndex <= minIndex}
            aria-label="Decrease worker count"
            className="w-9 h-9 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] disabled:opacity-30 disabled:cursor-not-allowed border border-white/[0.12] text-white flex items-center justify-center transition"
          >
            <Minus className="w-[14px] h-[14px]" />
          </button>
          <div
            aria-labelledby={stepperLabelId}
            aria-live="polite"
            className="w-16 h-9 rounded-lg bg-white/[0.04] border border-white/[0.12] text-white text-center text-[15px] font-semibold tracking-tight flex items-center justify-center"
          >
            {tier.workers}
          </div>
          <button
            type="button"
            onClick={increment}
            disabled={tierIndex >= maxIndex}
            aria-label="Increase worker count"
            className="w-9 h-9 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] disabled:opacity-30 disabled:cursor-not-allowed border border-white/[0.12] text-white flex items-center justify-center transition"
          >
            <Plus className="w-[14px] h-[14px]" />
          </button>
          <span className="ml-2 font-mono text-[11px] tracking-[0.04em] text-zinc-500">
            {TIERS[minIndex].workers}–{TIERS[maxIndex].workers}
          </span>
        </div>
      </div>

      <div className="mt-5 h-px bg-white/[0.08]" />

      <ul className="mt-5 space-y-2.5 text-[14px] text-zinc-300 flex-1">
        {FEATURES.map((f) => (
          <li key={f} className="flex items-start gap-2.5">
            <span className="mt-0.5 flex-shrink-0 text-amber-400">
              <Check className="w-[15px] h-[15px]" />
            </span>
            <span>{f}</span>
          </li>
        ))}
      </ul>

      <a
        href="https://cloud.agent-swarm.dev"
        className="mt-7 inline-flex w-full justify-center items-center gap-1.5 px-4 h-11 rounded-xl text-[14px] font-semibold transition bg-amber-500 hover:bg-amber-400 text-zinc-950"
      >
        Start your 7-day free trial <ArrowRight className="w-[14px] h-[14px]" />
      </a>
    </div>
  );
}
