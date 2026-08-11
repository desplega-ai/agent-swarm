export type DevFlowRole =
  | "admin"
  | "pm_director"
  | "pm"
  | "engineering_lead"
  | "architect"
  | "senior_developer"
  | "execution_lead"
  | "qa"
  | "viewer";

export type DevFlowState =
  | "captured"
  | "triaged"
  | "scoped"
  | "specced"
  | "sized"
  | "planned"
  | "building"
  | "in_review"
  | "deployed"
  | "monitoring"
  | "done"
  | "blocked"
  | "archived";

export type DevFlowWorkItemType = "idea" | "feature" | "bug" | "task" | "architecture" | "ops";
export type DevFlowPriority = "p1" | "p2" | "p3";
export type DevFlowAgentMode = "intake" | "scope" | "spec";

export interface DevFlowOrganization {
  id: string;
  name: string;
  slug: string;
  settings: Record<string, unknown>;
  isActive: boolean;
  createdAt: string;
  lastUpdatedAt: string;
}

export interface DevFlowMembership {
  organizationId: string;
  userId: string;
  role: DevFlowRole;
  isActive: boolean;
  createdAt: string;
  lastUpdatedAt: string;
}

export interface DevFlowWorkItem {
  id: string;
  organizationId: string;
  type: DevFlowWorkItemType;
  state: DevFlowState;
  previousState?: DevFlowState;
  blockerReason?: string;
  archiveReason?: string;
  title: string;
  description: string;
  priority?: DevFlowPriority;
  blastRadius?: "low" | "medium" | "high";
  isSecuritySensitive: boolean;
  duplicateOf?: string;
  duplicateConfidence?: number;
  classificationRationale?: string;
  pmOwnerId: string;
  engineeringOwnerId?: string;
  assignedToUserId?: string;
  createdVia: "manual" | "slack" | "fathom" | "github" | "email" | "api";
  sourceMetadata: Record<string, unknown>;
  capturedAt: string;
  createdAt: string;
  lastUpdatedAt: string;
}

export interface DevFlowScope {
  id: string;
  organizationId: string;
  workItemId: string;
  problemStatement: string;
  targetUsers: string[];
  successCriteria: string[];
  effortBand: "xs" | "s" | "m" | "l" | "xl";
  openQuestions: string[];
  confidence: number;
  rationale: string;
  agentRunId?: string;
  pmSignedOffAt?: string;
  createdAt: string;
  lastUpdatedAt: string;
}

export interface DevFlowAcceptanceCriterion {
  id: string;
  organizationId: string;
  specId: string;
  given: string;
  when: string;
  then: string;
  isTestable: boolean;
  testHint: string;
  testStatus: "unverified" | "passing" | "failing" | "skipped";
  linkedTestId?: string;
}

export interface DevFlowNfrDeclaration {
  id: string;
  organizationId: string;
  specId: string;
  category: string;
  status: "addressed" | "not_applicable" | "pending";
  statement: string;
  reviewedAt?: string;
}

export interface DevFlowSpec {
  id: string;
  organizationId: string;
  workItemId: string;
  version: number;
  status: "draft" | "approved";
  problemStatement: string;
  userStories: string;
  outOfScope: string;
  uxBehavior: string;
  dataModelChanges: string;
  integrationPoints: string;
  threatModel?: string;
  rollbackPlan?: string;
  dependencyMap: string[];
  openQuestions: string[];
  draftedByAgentRunId?: string;
  approvedAt?: string;
  acceptanceCriteria: DevFlowAcceptanceCriterion[];
  nfrDeclarations: DevFlowNfrDeclaration[];
  createdAt: string;
  lastUpdatedAt: string;
}

export interface DevFlowAgentRun {
  id: string;
  organizationId: string;
  workItemId: string;
  mode: DevFlowAgentMode;
  status: "queued" | "running" | "succeeded" | "failed" | "timed_out";
  swarmTaskId?: string;
  contractVersion: string;
  promptVersion: string;
  evidence?: unknown;
  evidenceAppliedAt?: string;
  errorMessage?: string;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
  lastUpdatedAt: string;
}

export interface DevFlowAuditEvent {
  id: string;
  organizationId: string;
  workItemId?: string;
  actorKind: "user" | "agent" | "system";
  actorId?: string;
  action: string;
  beforeState?: DevFlowState;
  afterState?: DevFlowState;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface DevFlowWorkItemDetail {
  item: DevFlowWorkItem;
  scope: DevFlowScope | null;
  spec: DevFlowSpec | null;
  agentRuns: DevFlowAgentRun[];
  audit: DevFlowAuditEvent[];
}

export interface DevFlowWorkItemPage {
  items: DevFlowWorkItem[];
  total: number;
  nextOffset?: number;
}

export interface DevFlowRepositoryTarget {
  id: string;
  organizationId: string;
  name: string;
  repositoryFullName: string;
  defaultBranch: string;
  executionProfile: "command_center_factory";
  isActive: boolean;
  createdAt: string;
  lastUpdatedAt: string;
}

export interface DevFlowImplementationIntent {
  id: string;
  organizationId: string;
  workItemId: string;
  specId: string;
  specVersion: number;
  specDigest: string;
  repositoryTargetId: string;
  desiredOutcome: string;
  priority: DevFlowPriority;
  riskSummary: string;
  intentSnapshot: Record<string, unknown>;
  createdByUserId: string;
  createdAt: string;
  lastUpdatedAt: string;
}

export type DevFlowFactoryExecutionStatus =
  | "queued"
  | "factory_intake"
  | "signoff_pending"
  | "ready"
  | "implementing"
  | "pr_open"
  | "finalizer_admitted"
  | "merged"
  | "failed"
  | "cancelled";

export interface DevFlowFactoryExecution {
  id: string;
  organizationId: string;
  implementationIntentId: string;
  status: DevFlowFactoryExecutionStatus;
  swarmTaskId?: string;
  headSha?: string;
  queueItemId?: string;
  queueItemRevision?: string;
  contractId?: string;
  canonicalContractPath?: string;
  factoryStatus?: string;
  surfaces: string[];
  impactedSurfaces: string[];
  architectureUnits: Record<string, unknown>;
  signoffs: unknown[];
  artifacts: unknown;
  finalizerReceipt?: Record<string, unknown>;
  mergedCommitSha?: string;
  lastObservedAt?: string;
  failureCode?: string;
  failureDetail?: string;
  createdAt: string;
  lastUpdatedAt: string;
}

export interface DevFlowImplementationIntentsResponse {
  intents: DevFlowImplementationIntent[];
  executions: DevFlowFactoryExecution[];
}

export interface DevFlowScopeInput {
  problemStatement: string;
  targetUsers: string[];
  successCriteria: string[];
  effortBand: DevFlowScope["effortBand"];
  openQuestions: string[];
  confidence: number;
  rationale: string;
}

export interface DevFlowSpecInput {
  problemStatement: string;
  outOfScope: string;
  uxBehavior: string;
  dataModelChanges: string;
  integrationPoints: string;
  threatModel?: string;
  rollbackPlan?: string;
  dependencyMap: string[];
  openQuestions: string[];
  acceptanceCriteria: Array<{
    given: string;
    when: string;
    then: string;
    isTestable: boolean;
    testHint: string;
  }>;
  nfrDeclarations: Array<{
    category: string;
    status: "addressed" | "not_applicable" | "pending";
    statement: string;
  }>;
  blastRadius: "low" | "medium" | "high";
}

export class DevFlowApiError extends Error {
  readonly status: number;
  readonly errorCode: string;
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    status: number,
    errorCode: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "DevFlowApiError";
    this.status = status;
    this.errorCode = errorCode;
    this.details = details;
  }
}
