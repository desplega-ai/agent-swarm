import { cn } from "@/lib/utils";
import { formatCompactNumber } from "@/lib/utils";

interface HexStatProps {
  label: string;
  value: number | string;
  color?: string;
  active?: boolean;
  onClick?: () => void;
}

function HexStat({ label, value, color = "text-amber-400", active, onClick }: HexStatProps) {
  const hexClip = "polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)";

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={cn(
        "group relative flex-shrink-0 cursor-default transition-transform hover:scale-105",
        onClick && "cursor-pointer",
      )}
    >
      {/* Border layer */}
      <div
        className="absolute inset-0 bg-amber-500/20"
        style={{ clipPath: hexClip }}
      />
      {/* Background layer */}
      <div
        className={cn(
          "absolute inset-[1.5px] bg-card",
          active && "animate-[breathe_3s_ease-in-out_infinite]",
        )}
        style={{ clipPath: hexClip }}
      />
      {/* Content layer */}
      <div
        className="relative flex flex-col items-center justify-center w-[100px] h-[110px] md:w-[120px] md:h-[130px]"
        style={{ clipPath: hexClip }}
      >
        <span className={cn("text-xl md:text-2xl font-bold font-mono tabular-nums", color)}>
          {typeof value === "number" ? formatCompactNumber(value) : value}
        </span>
        <span className="text-[9px] md:text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mt-0.5">
          {label}
        </span>
      </div>
    </button>
  );
}

interface StatsBarProps {
  agents?: { total: number; idle: number; busy: number; offline: number };
  tasks?: { total: number; pending: number; in_progress: number; completed: number; failed: number };
  epics?: { active: number };
  healthy?: boolean;
}

export function StatsBar({ agents, tasks, epics, healthy }: StatsBarProps) {
  return (
    <div className="w-full overflow-x-auto pb-2">
      {/* Top row */}
      <div className="flex items-center justify-center gap-1 md:gap-2">
        <HexStat
          label="Agents"
          value={agents?.total ?? 0}
          color="text-amber-400"
        />
        <HexStat
          label="Busy"
          value={agents?.busy ?? 0}
          color="text-amber-300"
          active={(agents?.busy ?? 0) > 0}
        />
        <HexStat
          label="Idle"
          value={agents?.idle ?? 0}
          color="text-emerald-400"
        />
        <HexStat
          label="Epics"
          value={epics?.active ?? 0}
          color="text-blue-400"
        />
        <HexStat
          label="Health"
          value={healthy ? "OK" : "ERR"}
          color={healthy ? "text-emerald-400" : "text-red-400"}
        />
      </div>
      {/* Bottom row — offset for honeycomb */}
      <div className="flex items-center justify-center gap-1 md:gap-2 -mt-[28px] md:-mt-[32px] ml-[52px] md:ml-[62px]">
        <HexStat
          label="Pending"
          value={tasks?.pending ?? 0}
          color="text-yellow-400"
        />
        <HexStat
          label="Running"
          value={tasks?.in_progress ?? 0}
          color="text-amber-400"
          active={(tasks?.in_progress ?? 0) > 0}
        />
        <HexStat
          label="Done"
          value={tasks?.completed ?? 0}
          color="text-emerald-400"
        />
        <HexStat
          label="Failed"
          value={tasks?.failed ?? 0}
          color={(tasks?.failed ?? 0) > 0 ? "text-red-400" : "text-zinc-500"}
        />
      </div>
    </div>
  );
}
