import { z } from "zod";
import {
  DevFlowBlastRadiusSchema,
  DevFlowEffortBandSchema,
  DevFlowNfrStatusSchema,
  DevFlowPrioritySchema,
} from "./types";

export const IntakeEvidenceSchema = z.strictObject({
  classification: z.enum(["feature", "bug", "idea", "task", "architecture", "ops", "noise"]),
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
