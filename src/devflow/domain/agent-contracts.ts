import { z } from "zod";
import {
  DevFlowBlastRadiusSchema,
  DevFlowEffortBandSchema,
  DevFlowNfrStatusSchema,
  DevFlowPrioritySchema,
} from "./types";

export const IntakeEvidenceSchema = z.strictObject({
  classification: z.enum([
    "feature",
    "bug",
    "idea",
    "task",
    "architecture",
    "ops",
    "noise",
  ]),
  title: z.string().min(1).max(120),
  description: z.string().min(1),
  suggestedPriority: DevFlowPrioritySchema.nullable(),
  duplicateOf: z.string().nullable(),
  duplicateConfidence: z.number().min(0).max(1),
  okrLinks: z.array(z.string()),
  isSecuritySensitiveSignal: z.boolean(),
  customerSignalPresent: z.boolean(),
  rationale: z.string().min(1),
});
export type IntakeEvidence = z.infer<typeof IntakeEvidenceSchema>;

export const ScopeEvidenceSchema = z.strictObject({
  problemStatement: z.string().min(1),
  targetUsers: z.array(z.string().min(1)).min(1),
  successCriteria: z.array(z.string().min(1)).min(1),
  effortBand: DevFlowEffortBandSchema,
  openQuestions: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1),
});
export type ScopeEvidence = z.infer<typeof ScopeEvidenceSchema>;

const NfrEvidenceSchema = z.strictObject({
  status: DevFlowNfrStatusSchema,
  statement: z.string().min(1),
});

export const SpecEvidenceSchema = z.strictObject({
  acClauses: z
    .array(
      z.strictObject({
        given: z.string().min(1),
        when: z.string().min(1),
        then: z.string().min(1),
        isTestable: z.boolean(),
        testHint: z.string(),
      }),
    )
    .min(1),
  nfrDeclarations: z.strictObject({
    supportability: NfrEvidenceSchema,
    testability: NfrEvidenceSchema,
    security: NfrEvidenceSchema,
    scalability: NfrEvidenceSchema,
    usability: NfrEvidenceSchema,
    maintainability: NfrEvidenceSchema,
    reliability: NfrEvidenceSchema,
    observability: NfrEvidenceSchema,
    performance: NfrEvidenceSchema,
  }),
  uxBehavior: z.string().min(1),
  dataModelChanges: z.string().min(1),
  integrationPoints: z.string().min(1),
  outOfScope: z.string(),
  openQuestions: z.array(z.string()),
  blastRadius: DevFlowBlastRadiusSchema,
  threatModel: z.string().min(1).nullable(),
  confidence: z.number().min(0).max(1),
});
export type SpecEvidence = z.infer<typeof SpecEvidenceSchema>;

export const DEVFLOW_AGENT_CONTRACT_VERSION = "1.0.0";

const nullableString = {
  anyOf: [{ type: "string" }, { type: "null" }],
} as const;
const nullablePriority = {
  anyOf: [{ type: "string", enum: ["p1", "p2", "p3"] }, { type: "null" }],
} as const;

const nfrJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: {
      type: "string",
      enum: ["addressed", "not_applicable", "pending"],
    },
    statement: { type: "string", minLength: 1 },
  },
  required: ["status", "statement"],
} as const;

export const DEVFLOW_AGENT_OUTPUT_SCHEMAS: Record<
  "intake" | "scope" | "spec",
  Record<string, unknown>
> = {
  intake: {
    type: "object",
    additionalProperties: false,
    properties: {
      classification: {
        type: "string",
        enum: [
          "feature",
          "bug",
          "idea",
          "task",
          "architecture",
          "ops",
          "noise",
        ],
      },
      title: { type: "string", minLength: 1, maxLength: 120 },
      description: { type: "string", minLength: 1 },
      suggestedPriority: nullablePriority,
      duplicateOf: nullableString,
      duplicateConfidence: { type: "number", minimum: 0, maximum: 1 },
      okrLinks: { type: "array", items: { type: "string" } },
      isSecuritySensitiveSignal: { type: "boolean" },
      customerSignalPresent: { type: "boolean" },
      rationale: { type: "string", minLength: 1 },
    },
    required: [
      "classification",
      "title",
      "description",
      "suggestedPriority",
      "duplicateOf",
      "duplicateConfidence",
      "okrLinks",
      "isSecuritySensitiveSignal",
      "customerSignalPresent",
      "rationale",
    ],
  },
  scope: {
    type: "object",
    additionalProperties: false,
    properties: {
      problemStatement: { type: "string", minLength: 1 },
      targetUsers: {
        type: "array",
        minItems: 1,
        items: { type: "string", minLength: 1 },
      },
      successCriteria: {
        type: "array",
        minItems: 1,
        items: { type: "string", minLength: 1 },
      },
      effortBand: { type: "string", enum: ["xs", "s", "m", "l", "xl"] },
      openQuestions: { type: "array", items: { type: "string" } },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      rationale: { type: "string", minLength: 1 },
    },
    required: [
      "problemStatement",
      "targetUsers",
      "successCriteria",
      "effortBand",
      "openQuestions",
      "confidence",
      "rationale",
    ],
  },
  spec: {
    type: "object",
    additionalProperties: false,
    properties: {
      acClauses: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            given: { type: "string", minLength: 1 },
            when: { type: "string", minLength: 1 },
            then: { type: "string", minLength: 1 },
            isTestable: { type: "boolean" },
            testHint: { type: "string" },
          },
          required: ["given", "when", "then", "isTestable", "testHint"],
        },
      },
      nfrDeclarations: {
        type: "object",
        additionalProperties: false,
        properties: Object.fromEntries(
          [
            "supportability",
            "testability",
            "security",
            "scalability",
            "usability",
            "maintainability",
            "reliability",
            "observability",
            "performance",
          ].map((category) => [category, nfrJsonSchema]),
        ),
        required: [
          "supportability",
          "testability",
          "security",
          "scalability",
          "usability",
          "maintainability",
          "reliability",
          "observability",
          "performance",
        ],
      },
      uxBehavior: { type: "string", minLength: 1 },
      dataModelChanges: { type: "string", minLength: 1 },
      integrationPoints: { type: "string", minLength: 1 },
      outOfScope: { type: "string" },
      openQuestions: { type: "array", items: { type: "string" } },
      blastRadius: { type: "string", enum: ["low", "medium", "high"] },
      threatModel: nullableString,
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
    required: [
      "acClauses",
      "nfrDeclarations",
      "uxBehavior",
      "dataModelChanges",
      "integrationPoints",
      "outOfScope",
      "openQuestions",
      "blastRadius",
      "threatModel",
      "confidence",
    ],
  },
};
