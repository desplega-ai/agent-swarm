import { useEffect, useRef } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function parameterText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return JSON.stringify(value);
}

function parseParameterText(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // Keep incomplete JSON editable rather than preventing a correction.
    }
  }
  return value;
}

/**
 * Editable automation parameters shared by schedule and workflow setup surfaces.
 * A `focusParam` deep link is intentionally focused after a frame: Radix dialogs
 * mount their children after their open state changes, so synchronous focus races
 * the input's DOM insertion.
 */
export function AutomationParamsFields({
  requiredParams,
  params,
  focusParam,
  onChange,
}: {
  requiredParams?: string[];
  params?: Record<string, unknown>;
  focusParam?: string;
  onChange: (params: Record<string, unknown>) => void;
}) {
  const inputRefs = useRef(new Map<string, HTMLInputElement>());
  useEffect(() => {
    if (!focusParam || !requiredParams?.includes(focusParam)) return;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const frame = requestAnimationFrame(() => {
      const focus = () => {
        const input = inputRefs.current.get(focusParam);
        input?.focus();
        input?.scrollIntoView({ block: "center", behavior: "auto" });
      };
      focus();
      timeout = setTimeout(focus, 0);
    });
    return () => {
      cancelAnimationFrame(frame);
      if (timeout) clearTimeout(timeout);
    };
  }, [focusParam, requiredParams]);

  if (!requiredParams?.length) return null;

  return (
    <section className="space-y-3" aria-label="Automation parameters">
      <div className="space-y-1">
        <h2 className="text-sm font-medium">Required parameters</h2>
        <p className="text-xs text-muted-foreground">
          Set these values before this automation can run.
        </p>
      </div>
      <div className="space-y-3">
        {requiredParams.map((param) => (
          <div key={param} className="space-y-1.5">
            <Label htmlFor={`automation-param-${param}`} className="font-mono text-xs">
              {param}
            </Label>
            <Input
              ref={(input) => {
                if (input) inputRefs.current.set(param, input);
                else inputRefs.current.delete(param);
              }}
              id={`automation-param-${param}`}
              data-automation-param={param}
              value={parameterText(params?.[param])}
              onChange={(event) =>
                onChange({ ...params, [param]: parseParameterText(event.target.value) })
              }
            />
          </div>
        ))}
      </div>
    </section>
  );
}
