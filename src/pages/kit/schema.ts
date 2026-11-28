/**
 * The page kit: a slot spec (`{ template, slots }`) that the server renders to
 * design system v2 HTML. Agents fill slots instead of writing layout, so a kit
 * page cannot ship layout slop, and a renderer fix restyles every kit page.
 *
 * Component names follow the chat-card catalog (`Section`, `Text`, `Fields`,
 * `Table`, `Chart`, `Callout`) plus the page-only `Header`, `Metrics`, `Slide`
 * and `Details`. Nodes are nested `{ type, props, children }`: the template
 * slots already give the page its structure.
 */
import * as z from "zod";

const MAX_TEXT = 20_000;
const MAX_SHORT = 500;

/** Inline markdown: `code`, **bold**, *italic* and [links](https://…). */
const inlineText = (max = MAX_SHORT) => z.string().min(1).max(max);

/** The status tones of the `swarm-*` primitives (`data-tone`). */
export const KitToneSchema = z.enum([
  "neutral",
  "primary",
  "success",
  "warning",
  "error",
  "info",
  "pending",
  "paused",
  "active",
]);

const LabelValueSchema = z.strictObject({ label: inlineText(80), value: inlineText(200) });

export const HeaderNodeSchema = z.strictObject({
  type: z.literal("Header"),
  props: z.strictObject({
    eyebrow: inlineText(120).optional(),
    title: inlineText(200),
    lede: inlineText(600).optional(),
    meta: z.array(LabelValueSchema).max(6).optional(),
  }),
});

export const MetricsNodeSchema = z.strictObject({
  type: z.literal("Metrics"),
  props: z.strictObject({
    items: z
      .array(
        z.strictObject({
          label: inlineText(60),
          value: z.string().min(1).max(24),
          unit: z.string().min(1).max(12).optional(),
          delta: z.string().min(1).max(24).optional(),
          tone: KitToneSchema.optional(),
          compare: inlineText(120).describe(
            "What the value is compared with, for example 'vs 2.2 s on 4.11' or 'target 50%'. Required: a number with no comparison cannot be read.",
          ),
        }),
      )
      .min(1)
      .max(6),
  }),
});

export const TextNodeSchema = z.strictObject({
  type: z.literal("Text"),
  props: z.strictObject({
    content: z
      .string()
      .min(1)
      .max(MAX_TEXT)
      .describe(
        "Markdown: paragraphs, '- ' lists, '1. ' lists, '> ' quotes and '### ' subheads, with inline code, bold, italic and https links.",
      ),
    style: z.enum(["muted"]).optional(),
  }),
});

export const CalloutNodeSchema = z.strictObject({
  type: z.literal("Callout"),
  props: z.strictObject({
    tone: KitToneSchema.optional(),
    title: inlineText(160).optional(),
    content: z.string().min(1).max(4000),
  }),
});

const CellSchema = z.union([
  z.string().max(400),
  z.number(),
  z.strictObject({ badge: z.string().min(1).max(40), tone: KitToneSchema.optional() }),
  z.strictObject({ text: z.string().min(1).max(400), tone: KitToneSchema.optional() }),
]);
export type KitCell = z.infer<typeof CellSchema>;

export const TableNodeSchema = z
  .strictObject({
    type: z.literal("Table"),
    props: z.strictObject({
      title: inlineText(160).optional(),
      caption: z.string().max(200).optional(),
      headers: z.array(z.string().max(80)).min(1).max(12),
      align: z
        .array(z.enum(["left", "right"]))
        .max(12)
        .optional(),
      rows: z.array(z.array(CellSchema)).max(200),
      footer: z.array(CellSchema).optional(),
    }),
  })
  .superRefine((node, ctx) => {
    const width = node.props.headers.length;
    node.props.rows.forEach((row, i) => {
      if (row.length !== width)
        ctx.addIssue({
          code: "custom",
          path: ["props", "rows", i],
          message: `Row has ${row.length} cells; the table has ${width} headers.`,
        });
    });
    if (node.props.footer && node.props.footer.length !== width)
      ctx.addIssue({
        code: "custom",
        path: ["props", "footer"],
        message: `Footer has ${node.props.footer.length} cells; the table has ${width} headers.`,
      });
  });

export const FieldsNodeSchema = z.strictObject({
  type: z.literal("Fields"),
  props: z.strictObject({ title: inlineText(80).optional() }).optional(),
  children: z
    .array(z.strictObject({ type: z.literal("Field"), props: LabelValueSchema }))
    .min(1)
    .max(30),
});

export const ChartSpecSchema = z
  .strictObject({
    type: z.enum(["bar", "line", "area"]),
    categories: z.array(z.string().max(40)).min(1).max(60),
    series: z
      .array(
        z.strictObject({
          name: z.string().min(1).max(80),
          values: z.array(z.number().finite()),
          role: z
            .literal("baseline")
            .optional()
            .describe("Draws the series grey (dashed for lines): a comparison costs no color."),
        }),
      )
      .min(1)
      .max(6),
    unit: z.string().max(12).optional(),
    xLabel: z.string().max(80).optional(),
    yLabel: z.string().max(120).optional(),
    horizontal: z.boolean().optional(),
    stacked: z.boolean().optional(),
    yMin: z.number().finite().optional(),
    reference: z
      .strictObject({ value: z.number().finite(), label: z.string().min(1).max(60) })
      .optional(),
  })
  .superRefine((chart, ctx) => {
    chart.series.forEach((series, i) => {
      if (series.values.length !== chart.categories.length)
        ctx.addIssue({
          code: "custom",
          path: ["series", i, "values"],
          message: `Series "${series.name}" has ${series.values.length} values for ${chart.categories.length} categories.`,
        });
    });
    if (chart.horizontal && chart.type !== "bar")
      ctx.addIssue({
        code: "custom",
        path: ["horizontal"],
        message: "Only bar charts can be horizontal.",
      });
  });
export type KitChartSpec = z.infer<typeof ChartSpecSchema>;

export const ChartNodeSchema = z.strictObject({
  type: z.literal("Chart"),
  props: z.strictObject({
    title: inlineText(200).describe("Say what the chart shows, with the unit."),
    chart: ChartSpecSchema,
    note: inlineText(400).optional(),
  }),
});

export const DetailsNodeSchema = z.strictObject({
  type: z.literal("Details"),
  props: z
    .strictObject({
      summary: inlineText(200),
      content: z.string().max(MAX_TEXT).optional(),
      code: z
        .unknown()
        .optional()
        .describe("Raw data shown as pretty-printed JSON, or a string shown as is."),
    })
    .refine((p) => p.content !== undefined || p.code !== undefined, {
      message: "Details needs content or code.",
    }),
});

/** Blocks that go inside a Section, a slide or a rail. */
export const KitBlockSchema = z.discriminatedUnion("type", [
  TextNodeSchema,
  CalloutNodeSchema,
  TableNodeSchema,
  FieldsNodeSchema,
  ChartNodeSchema,
  DetailsNodeSchema,
]);
export type KitBlock = z.infer<typeof KitBlockSchema>;

export const SectionNodeSchema = z
  .strictObject({
    type: z.literal("Section"),
    props: z
      .strictObject({
        title: inlineText(200).optional(),
        layout: z
          .enum(["stack", "split", "aside"])
          .optional()
          .describe("stack (default), split (two equal columns) or aside (2:1)."),
      })
      .optional(),
    children: z.array(KitBlockSchema).min(1).max(30),
  })
  .superRefine((node, ctx) => {
    const layout = node.props?.layout ?? "stack";
    if (layout !== "stack" && node.children.length < 2)
      ctx.addIssue({
        code: "custom",
        path: ["children"],
        message: `A ${layout} section needs at least 2 children: the first one fills the first column.`,
      });
  });
export type KitSection = z.infer<typeof SectionNodeSchema>;

export const SlideNodeSchema = z
  .strictObject({
    type: z.literal("Slide"),
    props: z.strictObject({
      layout: z.enum(["title", "statement", "content", "split", "quote"]).optional(),
      eyebrow: inlineText(120).optional(),
      title: inlineText(240).optional(),
      lede: inlineText(600).optional(),
      meta: z.array(LabelValueSchema).max(6).optional(),
      quote: inlineText(600).optional(),
      attribution: inlineText(200).optional(),
    }),
    children: z.array(KitBlockSchema).max(6).optional(),
  })
  .superRefine((node, ctx) => {
    const layout = node.props.layout ?? "content";
    if (layout === "quote") {
      if (!node.props.quote)
        ctx.addIssue({
          code: "custom",
          path: ["props", "quote"],
          message: "A quote slide needs quote.",
        });
    } else if (!node.props.title) {
      ctx.addIssue({
        code: "custom",
        path: ["props", "title"],
        message: `A ${layout} slide needs a title.`,
      });
    }
    if (layout === "split" && (node.children?.length ?? 0) < 2)
      ctx.addIssue({
        code: "custom",
        path: ["children"],
        message: "A split slide needs at least 2 children.",
      });
  });
export type KitSlide = z.infer<typeof SlideNodeSchema>;

const sections = z.array(SectionNodeSchema).min(1).max(40);
const rail = z.array(KitBlockSchema).min(1).max(12);
const footer = TextNodeSchema.optional();

export const KitDataSlotSchema = z.strictObject({
  key: z
    .string()
    .min(1)
    .max(200)
    .describe(
      "KV key in your own namespace (task:agent:<your agent id>) holding a JSON object with any of notice, metrics, sections and footer. Each view merges it over the spec, so a schedule can refresh the dashboard without a new page version.",
    ),
  refreshSeconds: z
    .number()
    .int()
    .min(30)
    .max(86_400)
    .optional()
    .describe("Reload an open dashboard this often. Omit for no reload."),
});

export const ReportKitSchema = z.strictObject({
  template: z.literal("report"),
  slots: z.strictObject({
    header: HeaderNodeSchema,
    summary: CalloutNodeSchema.optional(),
    metrics: MetricsNodeSchema.optional(),
    sections,
    aside: rail.optional(),
    toc: z.boolean().optional().describe("Puts the contents and the aside in a left rail."),
    appendix: z.array(DetailsNodeSchema).min(1).max(20).optional(),
  }),
});

export const OnePagerKitSchema = z.strictObject({
  template: z.literal("one-pager"),
  slots: z.strictObject({
    header: HeaderNodeSchema,
    facts: FieldsNodeSchema.optional(),
    metrics: MetricsNodeSchema.optional(),
    sections,
    aside: rail.optional(),
    footer,
  }),
});

/** The dashboard slots a `data` KV value may replace. */
export const DashboardDataSchema = z.strictObject({
  notice: CalloutNodeSchema.nullable().optional(),
  metrics: MetricsNodeSchema.nullable().optional(),
  sections: sections.optional(),
  footer: TextNodeSchema.nullable().optional(),
});

export const DashboardKitSchema = z.strictObject({
  template: z.literal("dashboard"),
  slots: z.strictObject({
    header: HeaderNodeSchema,
    notice: CalloutNodeSchema.optional(),
    metrics: MetricsNodeSchema.optional(),
    sections,
    footer,
    data: KitDataSlotSchema.optional(),
  }),
});

export const DeckKitSchema = z.strictObject({
  template: z.literal("deck"),
  slots: z.strictObject({ slides: z.array(SlideNodeSchema).min(1).max(60) }),
});

export const PageKitSchema = z.discriminatedUnion("template", [
  ReportKitSchema,
  OnePagerKitSchema,
  DashboardKitSchema,
  DeckKitSchema,
]);
export type PageKit = z.infer<typeof PageKitSchema>;
export type KitTemplate = PageKit["template"];
export const KIT_TEMPLATES = ["report", "one-pager", "dashboard", "deck"] as const;

/** Readable zod issues for a rejected spec, one line each with its path. */
export function formatKitIssues(error: z.ZodError): string[] {
  return error.issues.slice(0, 12).map((issue) => {
    const path = issue.path.map(String).join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
}
