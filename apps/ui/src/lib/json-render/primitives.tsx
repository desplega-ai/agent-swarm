/**
 * Low-level primitives: a state-bound `Input` with key-filtered event chains,
 * and an `Svg` with Rect / Line / Path / Circle / SvgText children.
 */

import type { InferComponentProps } from "@json-render/core";
import { useActions, useRepeatScope, useStateStore } from "@json-render/react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { resolveScopedParams } from "./action-params";
import {
  type ActionChain,
  INPUT_KEYS,
  type InputKey,
  SVG_PATH_DATA,
  type swarmCatalog,
} from "./catalog";
import { isChainHalt } from "./chain-halt";
import { COLOR_VARS } from "./chart-model";
import { createFocusRegistry, type FocusRegistry } from "./ui-actions";

// A surface without its own registry (the JSON pages renderer) shares this one.
const FocusRegistryContext = createContext<FocusRegistry>(createFocusRegistry());
export const FocusRegistryProvider = FocusRegistryContext.Provider;

type InputProps = InferComponentProps<typeof swarmCatalog, "Input">;

const INPUT_KEY_SET = new Set<string>(INPUT_KEYS);

export function InputComponent({
  props,
  bindings,
}: {
  props: InputProps;
  bindings?: Record<string, string>;
}) {
  const { set, getSnapshot } = useStateStore();
  const { execute } = useActions();
  const repeat = useRepeatScope();
  const focus = useContext(FocusRegistryContext);
  const boundPath = bindings?.value;
  const [localValue, setLocalValue] = useState(props.value ?? "");
  const value = boundPath ? String(props.value ?? "") : localValue;
  const inputRef = useRef<HTMLInputElement>(null);

  const index = repeat?.index;
  useEffect(() => {
    if (!props.id || !inputRef.current) return;
    return focus.register(props.id, index, inputRef.current);
  }, [focus, props.id, index]);

  const executeRef = useRef(execute);
  executeRef.current = execute;
  // Chains run like Form/Table chains: `$chain` reads the event, `$state` the live store.
  const runChain = useCallback(
    (chain: ActionChain | undefined, scope: Record<string, unknown>) => {
      if (!chain) return;
      const chainScope = { value: null, text: null, key: null, ...scope };
      void (async () => {
        for (const binding of chain) {
          await executeRef.current({
            ...binding,
            params: resolveScopedParams(binding.params, {
              state: getSnapshot(),
              chain: chainScope,
            }),
          });
        }
      })().catch((error: unknown) => {
        // A halted step (`ui.when`, a failed write) already reported itself.
        if (!isChainHalt(error)) throw error;
      });
    },
    [getSnapshot],
  );

  const inputId = props.id
    ? `input-${props.id}${index === undefined ? "" : `-${index}`}`
    : undefined;
  const cell = props.size === "cell";
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", cell && "w-auto")}>
      {props.label ? <Label htmlFor={inputId}>{props.label}</Label> : null}
      <Input
        ref={inputRef}
        id={inputId}
        type={props.type ?? "text"}
        inputMode={props.inputMode}
        autoComplete={props.autoComplete}
        maxLength={props.maxLength}
        placeholder={props.placeholder}
        disabled={props.disabled}
        aria-label={
          props.label ?? props.placeholder ?? (index === undefined ? "Text" : `Cell ${index + 1}`)
        }
        className={cn(cell && "size-11 px-0 text-center font-mono text-lg")}
        value={value}
        onFocus={(event) => {
          if (props.selectOnFocus) event.currentTarget.select();
        }}
        onChange={(event) => {
          const next = event.target.value;
          if (boundPath) set(boundPath, next);
          else setLocalValue(next);
          runChain(props.onInput, { value: next });
        }}
        onPaste={(event) => {
          if (!props.onPaste) return;
          event.preventDefault();
          runChain(props.onPaste, { value, text: event.clipboardData.getData("text") });
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || !INPUT_KEY_SET.has(event.key)) return;
          const chain = props[`onKeyDown:${event.key as InputKey}`];
          if (!chain) return;
          event.preventDefault();
          runChain(chain, { value, key: event.key });
        }}
      />
    </div>
  );
}

// ─── Svg ────────────────────────────────────────────────────────────────────

type Paint = NonNullable<InferComponentProps<typeof swarmCatalog, "Rect">["fill"]>;
const SURFACE_PAINT: Record<string, string> = {
  foreground: "var(--color-foreground)",
  background: "var(--color-background)",
  border: "var(--color-border)",
  none: "none",
};

function paint(token: Paint | undefined, fallback: string): string {
  if (!token) return fallback;
  return (COLOR_VARS as Record<string, string>)[token] ?? SURFACE_PAINT[token] ?? fallback;
}

/** A bound attribute that did not resolve to a finite number draws nothing. */
function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

const SvgDepth = createContext(0);

export function SvgComponent({
  props,
  children,
}: {
  props: InferComponentProps<typeof swarmCatalog, "Svg">;
  children?: ReactNode;
}) {
  const depth = useContext(SvgDepth);
  const width = num(props.width);
  const height = num(props.height);
  if (depth > 0) {
    // A nested Svg is a group offset by x/y, e.g. the repeated row of a Gantt.
    return (
      <SvgDepth.Provider value={depth + 1}>
        <g transform={`translate(${num(props.x) ?? 0} ${num(props.y) ?? 0})`}>{children}</g>
      </SvgDepth.Provider>
    );
  }
  if (width === undefined || height === undefined) return null;
  return (
    <SvgDepth.Provider value={1}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        style={{ maxWidth: width }}
        className="h-auto text-foreground"
        role={props.label ? "img" : undefined}
        aria-label={props.label}
        aria-hidden={props.label ? undefined : true}
      >
        {children}
      </svg>
    </SvgDepth.Provider>
  );
}

export function RectComponent({
  props,
}: {
  props: InferComponentProps<typeof swarmCatalog, "Rect">;
}) {
  const width = num(props.width);
  const height = num(props.height);
  if (width === undefined || height === undefined || width < 0 || height < 0) return null;
  return (
    <rect
      x={num(props.x)}
      y={num(props.y)}
      width={width}
      height={height}
      rx={num(props.rx)}
      fill={paint(props.fill, "var(--color-primary)")}
      stroke={paint(props.stroke, "none")}
      strokeWidth={num(props.strokeWidth)}
      opacity={num(props.opacity)}
    >
      {props.title ? <title>{props.title}</title> : null}
    </rect>
  );
}

export function LineComponent({
  props,
}: {
  props: InferComponentProps<typeof swarmCatalog, "Line">;
}) {
  return (
    <line
      x1={num(props.x1)}
      y1={num(props.y1)}
      x2={num(props.x2)}
      y2={num(props.y2)}
      stroke={paint(props.stroke, "var(--color-border)")}
      strokeWidth={num(props.strokeWidth) ?? 1}
      strokeDasharray={props.dashed ? "4 4" : undefined}
      opacity={num(props.opacity)}
    />
  );
}

export function PathComponent({
  props,
}: {
  props: InferComponentProps<typeof swarmCatalog, "Path">;
}) {
  // A bound `d` is only known at render time, so the grammar check runs here too.
  if (typeof props.d !== "string" || !SVG_PATH_DATA.test(props.d)) return null;
  return (
    <path
      d={props.d}
      fill={paint(props.fill, "none")}
      stroke={paint(props.stroke, "var(--color-foreground)")}
      strokeWidth={num(props.strokeWidth) ?? 1}
      opacity={num(props.opacity)}
    />
  );
}

export function CircleComponent({
  props,
}: {
  props: InferComponentProps<typeof swarmCatalog, "Circle">;
}) {
  const r = num(props.r);
  if (r === undefined || r < 0) return null;
  return (
    <circle
      cx={num(props.cx)}
      cy={num(props.cy)}
      r={r}
      fill={paint(props.fill, "var(--color-primary)")}
      stroke={paint(props.stroke, "none")}
      strokeWidth={num(props.strokeWidth)}
      opacity={num(props.opacity)}
    >
      {props.title ? <title>{props.title}</title> : null}
    </circle>
  );
}

export function SvgTextComponent({
  props,
}: {
  props: InferComponentProps<typeof swarmCatalog, "SvgText">;
}) {
  return (
    <text
      x={num(props.x)}
      y={num(props.y)}
      textAnchor={props.anchor ?? "start"}
      dominantBaseline="middle"
      fontSize={num(props.size) ?? 12}
      fontWeight={props.weight === "bold" ? 600 : undefined}
      fill={paint(props.fill, "var(--color-foreground)")}
    >
      {props.text == null ? "" : String(props.text)}
    </text>
  );
}
