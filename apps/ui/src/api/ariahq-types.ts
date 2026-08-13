export type AriaEngineDraftStatus = "queued" | "running" | "ready" | "failed";

export interface AriaEngineContract {
  engineKey: string;
  name: string;
  objective: string;
  caseType: string;
  triggers: string[];
  stages: Array<{
    id: string;
    name: string;
    kind: "agent" | "approval";
    objective: string;
    requiredEvidence: string[];
    tools: string[];
    next?: string;
    approverRoles?: string[];
  }>;
  knowledgePolicy: {
    allowedSources: string[];
    requiredEvidence: string[];
    conflictPolicy: "escalate" | "abstain";
  };
  actions: Array<{
    key: string;
    description: string;
    externalWrite: boolean;
    authority: string[];
  }>;
  completionCriteria: string[];
  openQuestions: string[];
}

export interface AriaEngineDraft {
  id: string;
  organizationId: string;
  name: string;
  brief: string;
  status: AriaEngineDraftStatus;
  swarmTaskId?: string;
  proposedContract?: AriaEngineContract;
  errorMessage?: string;
  createdByUserId: string;
  createdAt: string;
  lastUpdatedAt: string;
}

export interface AriaEngineVersion {
  id: string;
  organizationId: string;
  draftId: string;
  engineKey: string;
  name: string;
  version: number;
  status: "published" | "retired";
  contract: AriaEngineContract;
  workflowId: string;
  publishedByUserId: string;
  publishedAt: string;
  createdAt: string;
  lastUpdatedAt: string;
}

export interface AriaEvidenceItem {
  recordId: string;
  kind: "source_evidence" | "canonical_fact" | "derived_insight";
  content: string;
  verificationStatus: "raw" | "verified" | "conflicted" | "superseded";
  effectiveAt: string;
  citation: string;
}

export interface AriaKnowledgeAnswer {
  status: "dispatched" | "abstained";
  bundle: {
    question: string;
    audience: "internal" | "client";
    evidence: AriaEvidenceItem[];
    hasConflict: boolean;
  };
  taskId?: string;
  message?: string;
}

export interface AriaClientIntake {
  id: string;
  organizationId: string;
  workItemId: string;
  clientStatus: string;
  publicSummary: string;
  createdAt: string;
}

export interface AriaKnowledgeSource {
  id: string;
  organizationId: string;
  key: string;
  name: string;
  sourceKind: "slack" | "google_drive" | "call_recording" | "crm" | "github" | "manual" | "ariahq";
  audience: "internal" | "client";
  clientKey?: string;
  adapter: "openapi" | "webhook";
  connectionSlug?: string;
  runAsAgentId: string;
  syncConfig: Record<string, unknown>;
  cursor?: string;
  scheduleId?: string;
  enabled: boolean;
  lastSyncStatus?: "running" | "completed" | "failed";
  lastSyncAt?: string;
  lastErrorMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
}

export interface AriaSlackSurface {
  id: string;
  organizationId: string;
  name: string;
  workspaceId: string;
  channelId: string;
  audience: "internal" | "client";
  clientKey?: string;
  captureMode: "mention_only" | "designated_channel";
  pmOwnerId: string;
  isActive: boolean;
  verificationStatus: "pending" | "verified" | "failed";
  verifiedAt?: string;
  verificationError?: string;
  createdAt: string;
  lastUpdatedAt: string;
}
