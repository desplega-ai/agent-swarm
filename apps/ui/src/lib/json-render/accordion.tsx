/**
 * `Accordion`: grouped collapsible sections on the Radix Accordion. Children
 * are positional like Tabs (`children[i]` is the body of `items[i]`), and the
 * open keys live at `/ui/<id>/open` as an array in both modes, so a `$state`
 * read never has to care about `type`.
 */

import { getByPath } from "@json-render/core";
import { useStateStore } from "@json-render/react";
import { ChevronDown } from "lucide-react";
import { Accordion as AccordionPrimitive } from "radix-ui";
import { Children, type ReactNode, useEffect } from "react";
import { cn } from "@/lib/utils";
import type { AccordionItem } from "./catalog";
import { CatalogIcon } from "./icons";

export interface AccordionProps {
  id: string;
  type?: "single" | "multiple";
  items: AccordionItem[];
  defaultOpen?: string[];
}

/** The open keys to render: stored keys that still exist, else `defaultOpen`. */
export function openAccordionKeys(
  stored: unknown,
  items: AccordionItem[],
  type: "single" | "multiple",
  defaultOpen: string[] | undefined,
): string[] {
  const known = new Set(items.map((item) => item.key));
  const source = Array.isArray(stored) ? stored : (defaultOpen ?? []);
  const keys = source.filter(
    (key, index): key is string =>
      typeof key === "string" && known.has(key) && source.indexOf(key) === index,
  );
  return type === "single" ? keys.slice(0, 1) : keys;
}

export function AccordionComponent({
  props,
  children,
}: {
  props: AccordionProps;
  children: ReactNode;
}) {
  const { state, set } = useStateStore();
  const items = props.items ?? [];
  const type = props.type ?? "single";
  const path = `/ui/${props.id}/open`;
  const stored = getByPath(state, path);
  const open = openAccordionKeys(stored, items, type, props.defaultOpen);
  const openSignature = JSON.stringify(open);

  // Seed `/ui/<id>/open` on mount (so `$state` reads resolve at once) and drop
  // keys an app edit removed.
  useEffect(() => {
    if (JSON.stringify(stored ?? null) !== openSignature) set(path, JSON.parse(openSignature));
  }, [stored, openSignature, path, set]);

  if (items.length === 0) return null;
  const bodies = Array.isArray(children) ? (children as ReactNode[]) : Children.toArray(children);

  const itemNodes = items.map((item, index) => (
    <AccordionPrimitive.Item
      key={item.key}
      value={item.key}
      className="border-b border-border last:border-b-0"
      data-testid={`json-render-accordion-item-${item.key}`}
    >
      <AccordionPrimitive.Header className="flex">
        <AccordionPrimitive.Trigger
          className={cn(
            "group flex flex-1 items-center gap-2 py-3 text-left text-sm font-medium outline-none",
            "hover:underline focus-visible:ring-2 focus-visible:ring-ring rounded-sm",
          )}
        >
          <CatalogIcon name={item.icon} size="sm" />
          <span className="min-w-0 flex-1">
            <span className="block truncate">{item.title}</span>
            {item.description ? (
              <span className="block text-xs font-normal text-muted-foreground">
                {item.description}
              </span>
            ) : null}
          </span>
          <ChevronDown
            aria-hidden
            className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180"
          />
        </AccordionPrimitive.Trigger>
      </AccordionPrimitive.Header>
      <AccordionPrimitive.Content className="flex min-w-0 flex-col gap-4 pb-4">
        {/* Extra children past the item count join the last body, like Tabs. */}
        {index === items.length - 1 ? bodies.slice(index) : (bodies[index] ?? null)}
      </AccordionPrimitive.Content>
    </AccordionPrimitive.Item>
  ));

  const className = "flex min-w-0 flex-col";
  if (type === "multiple") {
    return (
      <AccordionPrimitive.Root
        type="multiple"
        value={open}
        onValueChange={(next) => set(path, next)}
        className={className}
        data-testid="json-render-accordion"
      >
        {itemNodes}
      </AccordionPrimitive.Root>
    );
  }
  return (
    <AccordionPrimitive.Root
      type="single"
      collapsible
      value={open[0] ?? ""}
      onValueChange={(next) => set(path, next ? [next] : [])}
      className={className}
      data-testid="json-render-accordion"
    >
      {itemNodes}
    </AccordionPrimitive.Root>
  );
}
