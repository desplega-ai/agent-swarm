import { useState } from "react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  convertDuration,
  DURATION_UNITS,
  type DurationUnit,
  preferredDurationUnit,
} from "@/lib/configuration-values";

export function DurationInput({
  id,
  value,
  nativeUnit,
  defaultValue,
  disabled,
  onChange,
}: {
  id: string;
  value: string;
  nativeUnit: DurationUnit;
  defaultValue?: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const [unit, setUnit] = useState(() => preferredDurationUnit(value || defaultValue, nativeUnit));
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      <Input
        id={id}
        type="number"
        step="any"
        value={convertDuration(value, nativeUnit, unit)}
        placeholder={
          defaultValue && Number.isFinite(Number(defaultValue))
            ? convertDuration(defaultValue, nativeUnit, unit)
            : undefined
        }
        disabled={disabled}
        onChange={(event) => onChange(convertDuration(event.target.value, unit, nativeUnit))}
        className="min-w-0 font-mono text-xs"
      />
      <Select
        value={unit}
        onValueChange={(next) => setUnit(next as DurationUnit)}
        disabled={disabled}
      >
        <SelectTrigger aria-label="Duration unit" className="w-20 shrink-0">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {DURATION_UNITS.map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
