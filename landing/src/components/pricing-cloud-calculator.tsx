"use client";

import { useId, useState } from "react";
import { ArrowRight, Check, Minus, Plus } from "lucide-react";

const PLATFORM_FEE_EUR = 9;
const WORKER_FEE_EUR = 29;
const MIN_WORKERS = 1;
const MAX_WORKERS = 30;
const DEFAULT_WORKERS = 2;
const ANNUAL_DISCOUNT = 0.25;

const FEATURES = [
  "Hosted lead + dashboard",
  "Coordination intelligence built in — memory persists across sessions",
  "Slack, GitHub, GitLab, Linear, AgentMail, Sentry",
  "Bring your own model keys (BYOK)",
  "7-day free trial · no card required",
];

type BillingPeriod = "monthly" | "annual";

function formatEuro(amount: number): string {
  // Drop the .00 on whole numbers; keep two decimals when needed.
  if (Number.isInteger(amount)) return `€${amount}`;
  return `€${amount.toFixed(2)}`;
}

export function PricingCloudCalculator() {
  const [workers, setWorkers] = useState<number>(DEFAULT_WORKERS);
  const [period, setPeriod] = useState<BillingPeriod>("monthly");
  const stepperLabelId = useId();

  const monthlyTotal = PLATFORM_FEE_EUR + workers * WORKER_FEE_EUR;
  const annualTotal = monthlyTotal * 12 * (1 - ANNUAL_DISCOUNT);
  const annualSavings = monthlyTotal * 12 * ANNUAL_DISCOUNT;
  const annualEffectiveMonthly = annualTotal / 12;

  const decrement = () => setWorkers((w) => Math.max(MIN_WORKERS, w - 1));
  const increment = () => setWorkers((w) => Math.min(MAX_WORKERS, w + 1));

  return (
    <div className="flex flex-col h-full">
      <div className="text-[13px] font-semibold tracking-tight text-amber-400">Cloud</div>
      <div className="mt-1 text-[12.5px] text-zinc-400">Hosted swarm, pick your size</div>

      <div className="mt-5 flex items-baseline gap-1.5">
        <span className="text-[44px] font-bold tracking-[-0.03em] leading-none text-white">
          {period === "monthly" ? formatEuro(monthlyTotal) : formatEuro(Math.round(annualTotal))}
        </span>
        <span className="text-[13px] text-zinc-400">{period === "monthly" ? "/ mo" : "/ yr"}</span>
      </div>
      {period === "annual" && (
        <div className="mt-1 font-mono text-[11.5px] tracking-[0.02em] text-zinc-500">
          ≈ {formatEuro(Math.round(annualEffectiveMonthly))} / mo paid annually
        </div>
      )}

      <div className="mt-3 font-mono text-[11.5px] tracking-[0.02em] text-amber-300">
        {formatEuro(PLATFORM_FEE_EUR)} platform + {workers} × {formatEuro(WORKER_FEE_EUR)} worker ={" "}
        {formatEuro(monthlyTotal)} / mo
      </div>

      {period === "annual" && (
        <div className="mt-1.5 font-mono text-[11px] tracking-[0.02em] text-zinc-500">
          Saves {formatEuro(Math.round(annualSavings))}/yr vs monthly billing
        </div>
      )}

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
            disabled={workers <= MIN_WORKERS}
            aria-label="Decrease worker count"
            className="w-9 h-9 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] disabled:opacity-30 disabled:cursor-not-allowed border border-white/[0.12] text-white flex items-center justify-center transition"
          >
            <Minus className="w-[14px] h-[14px]" />
          </button>
          <input
            type="number"
            inputMode="numeric"
            min={MIN_WORKERS}
            max={MAX_WORKERS}
            value={workers}
            aria-labelledby={stepperLabelId}
            onChange={(e) => {
              const raw = Number.parseInt(e.target.value, 10);
              if (Number.isNaN(raw)) return;
              setWorkers(Math.min(MAX_WORKERS, Math.max(MIN_WORKERS, raw)));
            }}
            className="w-16 h-9 rounded-lg bg-white/[0.04] border border-white/[0.12] text-white text-center text-[15px] font-semibold tracking-tight focus:outline-none focus:border-amber-400 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          />
          <button
            type="button"
            onClick={increment}
            disabled={workers >= MAX_WORKERS}
            aria-label="Increase worker count"
            className="w-9 h-9 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] disabled:opacity-30 disabled:cursor-not-allowed border border-white/[0.12] text-white flex items-center justify-center transition"
          >
            <Plus className="w-[14px] h-[14px]" />
          </button>
          <span className="ml-2 font-mono text-[11px] tracking-[0.04em] text-zinc-500">
            {MIN_WORKERS}–{MAX_WORKERS}
          </span>
        </div>
      </div>

      <div
        className="mt-4 inline-flex items-center self-start rounded-lg bg-white/[0.04] border border-white/[0.12] p-0.5"
        role="group"
        aria-label="Billing period"
      >
        <button
          type="button"
          onClick={() => setPeriod("monthly")}
          aria-pressed={period === "monthly"}
          className={`px-3 h-8 rounded-md text-[12px] font-semibold tracking-tight transition ${
            period === "monthly"
              ? "bg-white/[0.12] text-white"
              : "text-zinc-400 hover:text-white"
          }`}
        >
          Monthly
        </button>
        <button
          type="button"
          onClick={() => setPeriod("annual")}
          aria-pressed={period === "annual"}
          className={`px-3 h-8 rounded-md text-[12px] font-semibold tracking-tight transition flex items-center gap-1.5 ${
            period === "annual"
              ? "bg-white/[0.12] text-white"
              : "text-zinc-400 hover:text-white"
          }`}
        >
          Annual
          <span className="font-mono text-[10px] tracking-[0.04em] text-amber-300">save 25%</span>
        </button>
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
