import type { Database } from "bun:sqlite";
import {
  type DevFlowAcceptanceCriterion,
  DevFlowAcceptanceCriterionSchema,
  type DevFlowAgentMode,
  type DevFlowAgentRun,
  DevFlowAgentRunSchema,
  type DevFlowAgentRunStatusSchema,
  type DevFlowBlastRadius,
  type DevFlowContext,
  type DevFlowCreatedVia,
  type DevFlowEffortBandSchema,
  type DevFlowMembership,
  DevFlowMembershipSchema,
  type DevFlowNfrCategory,
  type DevFlowNfrDeclaration,
  DevFlowNfrDeclarationSchema,
  type DevFlowNfrStatusSchema,
  type DevFlowOrganization,
  DevFlowOrganizationSchema,
  type DevFlowPriority,
  type DevFlowRole,
  type DevFlowScope,
  DevFlowScopeSchema,
  type DevFlowSpec,
  DevFlowSpecSchema,
  type DevFlowState,
  type DevFlowWorkItem,
  DevFlowWorkItemSchema,
  type DevFlowWorkItemType,
} from "./domain/types";

type AgentRunStatus = typeof DevFlowAgentRunStatusSchema._output;
type EffortBand = typeof DevFlowEffortBandSchema._output;
type NfrStatus = typeof DevFlowNfrStatusSchema._output;

export interface CreateOrganizationInput {
  id?: string;
  name: string;
  slug: string;
  settings?: Record<string, unknown>;
}

export interface CreateMembershipInput {
  organizationId: string;
  userId: string;
  role: DevFlowRole;
}

export interface CreateWorkItemInput {
  id?: string;
  organizationId: string;
  type?: DevFlowWorkItemType;
  title: string;
  description: string;
  priority?: DevFlowPriority;
  pmOwnerId: string;
  engineeringOwnerId?: string;
  assignedToUserId?: string;
  createdVia: DevFlowCreatedVia;
  sourceMetadata?: Record<string, unknown>;
}

export interface WorkItemFilters {
  state?: DevFlowState;
  type?: DevFlowWorkItemType;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface WorkItemPage {
  items: DevFlowWorkItem[];
  total: number;
  nextOffset?: number;
}

export interface UpsertScopeInput {
  problemStatement: string;
  targetUsers: string[];
  successCriteria: string[];
  effortBand: EffortBand;
  openQuestions: string[];
  confidence: number;
  rationale: string;
  agentRunId?: string;
}

export interface AcceptanceCriterionInput {
  id?: string;
  given: string;
  when: string;
  then: string;
  isTestable: boolean;
  testHint?: string;
  testStatus?: DevFlowAcceptanceCriterion["testStatus"];
  linkedTestId?: string;
}

export interface NfrDeclarationInput {
  category: DevFlowNfrCategory;
  status: NfrStatus;
  statement: string;
  reviewedAt?: string;
}

export interface CreateSpecInput {
  problemStatement: string;
  userStories?: string;
  outOfScope: string;
  uxBehavior: string;
  dataModelChanges: string;
  integrationPoints: string;
  threatModel?: string;
  rollbackPlan?: string;
  dependencyMap: string[];
  openQuestions: string[];
  draftedByAgentRunId?: string;
  acceptanceCriteria: AcceptanceCriterionInput[];
  nfrDeclarations: NfrDeclarationInput[];
}

export interface CreateAgentRunInput {
  id?: string;
  organizationId: string;
  workItemId: string;
  mode: DevFlowAgentMode;
  status?: AgentRunStatus;
  swarmTaskId?: string;
  workflowRunId?: string;
  contractVersion: string;
  promptVersion: string;
}

export interface GateDecisionInput {
  organizationId: string;
  workItemId: string;
  gate: number;
  decision: "approved" | "rejected" | "timeout";
  actorUserId: string;
  actorRole: DevFlowRole;
  rationale: string;
  preconditionSnapshot: Record<string, unknown>;
  approvalRequestId?: string;
}

export interface AuditEventInput {
  context: DevFlowContext;
  workItemId?: string;
  action: string;
  beforeState?: DevFlowState;
  afterState?: DevFlowState;
  metadata?: Record<string, unknown>;
}

export interface DevFlowAuditEvent {
  id: string;
  organizationId: string;
  workItemId?: string;
  actorKind: DevFlowContext["actorKind"];
  actorId?: string;
  action: string;
  beforeState?: DevFlowState;
  afterState?: DevFlowState;
  metadata: Record<string, unknown>;
  correlationId?: string;
  createdAt: string;
}

export interface DevFlowGateDecision extends Omit<
  GateDecisionInput,
  "preconditionSnapshot"
> {
  id: string;
  preconditionSnapshot: Record<string, unknown>;
  decidedAt: string;
}

export interface DevFlowRepository {
  transaction<T>(fn: () => T): T;
  createOrganization(input: CreateOrganizationInput): DevFlowOrganization;
  getOrganization(id: string): DevFlowOrganization | null;
  getOrganizationBySlug(slug: string): DevFlowOrganization | null;
  addMembership(input: CreateMembershipInput): DevFlowMembership;
  getMembership(
    organizationId: string,
    userId: string,
  ): DevFlowMembership | null;
  findMembershipForUser(userId: string): DevFlowMembership | null;
  createWorkItem(input: CreateWorkItemInput): DevFlowWorkItem;
  getWorkItem(organizationId: string, id: string): DevFlowWorkItem | null;
  listWorkItems(organizationId: string, filters: WorkItemFilters): WorkItemPage;
  updateWorkItem(
    organizationId: string,
    id: string,
    patch: Partial<
      Pick<
        DevFlowWorkItem,
        | "type"
        | "state"
        | "previousState"
        | "blockerReason"
        | "archiveReason"
        | "title"
        | "description"
        | "priority"
        | "blastRadius"
        | "isSecuritySensitive"
        | "duplicateOf"
        | "duplicateConfidence"
        | "classificationRationale"
      >
    >,
  ): DevFlowWorkItem;
  getScope(organizationId: string, workItemId: string): DevFlowScope | null;
  upsertScope(
    organizationId: string,
    workItemId: string,
    input: UpsertScopeInput,
  ): DevFlowScope;
  signOffScope(
    organizationId: string,
    workItemId: string,
    at: string,
  ): DevFlowScope;
  getCurrentSpec(
    organizationId: string,
    workItemId: string,
  ): DevFlowSpec | null;
  createSpecVersion(
    organizationId: string,
    workItemId: string,
    input: CreateSpecInput,
  ): DevFlowSpec;
  approveCurrentSpec(
    organizationId: string,
    workItemId: string,
    at: string,
  ): DevFlowSpec;
  createGateDecision(input: GateDecisionInput): DevFlowGateDecision;
  listGateDecisions(
    organizationId: string,
    workItemId: string,
  ): DevFlowGateDecision[];
  createAgentRun(input: CreateAgentRunInput): DevFlowAgentRun;
  getAgentRun(organizationId: string, id: string): DevFlowAgentRun | null;
  listAgentRuns(organizationId: string, workItemId: string): DevFlowAgentRun[];
  updateAgentRun(
    organizationId: string,
    id: string,
    patch: Partial<
      Pick<
        DevFlowAgentRun,
        | "status"
        | "swarmTaskId"
        | "workflowRunId"
        | "evidence"
        | "evidenceAppliedAt"
        | "latencyMs"
        | "costUsd"
        | "errorMessage"
        | "startedAt"
        | "finishedAt"
      >
    >,
  ): DevFlowAgentRun;
  appendAuditEvent(input: AuditEventInput): DevFlowAuditEvent;
  listAuditEvents(
    organizationId: string,
    workItemId?: string,
  ): DevFlowAuditEvent[];
}

function now(): string {
  return new Date().toISOString();
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (value == null || value === "") return fallback;
  return JSON.parse(value) as T;
}

function optionalString(value: string | null): string | undefined {
  return value ?? undefined;
}

function sqlBinding(value: unknown): string | number | null {
  if (value == null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string" || typeof value === "number") return value;
  return JSON.stringify(value);
}

type OrganizationRow = {
  id: string;
  name: string;
  slug: string;
  settingsJson: string;
  isActive: number;
  createdAt: string;
  lastUpdatedAt: string;
};

function organizationFromRow(row: OrganizationRow): DevFlowOrganization {
  return DevFlowOrganizationSchema.parse({
    ...row,
    settings: parseJson(row.settingsJson, {}),
    isActive: row.isActive === 1,
  });
}

type MembershipRow = {
  organizationId: string;
  userId: string;
  role: string;
  isActive: number;
  createdAt: string;
  lastUpdatedAt: string;
};

function membershipFromRow(row: MembershipRow): DevFlowMembership {
  return DevFlowMembershipSchema.parse({
    ...row,
    isActive: row.isActive === 1,
  });
}

type WorkItemRow = {
  id: string;
  organizationId: string;
  type: string;
  state: string;
  previousState: string | null;
  blockerReason: string | null;
  archiveReason: string | null;
  title: string;
  description: string;
  priority: string | null;
  storyPoints: number | null;
  sprintId: string | null;
  sprintProbability: number | null;
  blastRadius: string | null;
  isSecuritySensitive: number;
  duplicateOf: string | null;
  duplicateConfidence: number | null;
  classificationRationale: string | null;
  pmOwnerId: string;
  engineeringOwnerId: string | null;
  assignedToUserId: string | null;
  createdVia: string;
  sourceMetadataJson: string;
  capturedAt: string;
  createdAt: string;
  lastUpdatedAt: string;
};

function workItemFromRow(row: WorkItemRow): DevFlowWorkItem {
  return DevFlowWorkItemSchema.parse({
    ...row,
    previousState: optionalString(row.previousState),
    blockerReason: optionalString(row.blockerReason),
    archiveReason: optionalString(row.archiveReason),
    priority: optionalString(row.priority),
    storyPoints: row.storyPoints ?? undefined,
    sprintId: optionalString(row.sprintId),
    sprintProbability: row.sprintProbability ?? undefined,
    blastRadius: optionalString(row.blastRadius),
    isSecuritySensitive: row.isSecuritySensitive === 1,
    duplicateOf: optionalString(row.duplicateOf),
    duplicateConfidence: row.duplicateConfidence ?? undefined,
    classificationRationale: optionalString(row.classificationRationale),
    engineeringOwnerId: optionalString(row.engineeringOwnerId),
    assignedToUserId: optionalString(row.assignedToUserId),
    sourceMetadata: parseJson(row.sourceMetadataJson, {}),
  });
}

type ScopeRow = {
  id: string;
  organizationId: string;
  workItemId: string;
  problemStatement: string;
  targetUsersJson: string;
  successCriteriaJson: string;
  effortBand: string;
  openQuestionsJson: string;
  confidence: number;
  rationale: string;
  agentRunId: string | null;
  pmSignedOffAt: string | null;
  createdAt: string;
  lastUpdatedAt: string;
};

function scopeFromRow(row: ScopeRow): DevFlowScope {
  return DevFlowScopeSchema.parse({
    ...row,
    targetUsers: parseJson(row.targetUsersJson, []),
    successCriteria: parseJson(row.successCriteriaJson, []),
    openQuestions: parseJson(row.openQuestionsJson, []),
    agentRunId: optionalString(row.agentRunId),
    pmSignedOffAt: optionalString(row.pmSignedOffAt),
  });
}

type AgentRunRow = {
  id: string;
  organizationId: string;
  workItemId: string;
  mode: string;
  status: string;
  swarmTaskId: string | null;
  workflowRunId: string | null;
  contractVersion: string;
  promptVersion: string;
  evidenceJson: string | null;
  evidenceAppliedAt: string | null;
  latencyMs: number | null;
  costUsd: number | null;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  lastUpdatedAt: string;
};

function agentRunFromRow(row: AgentRunRow): DevFlowAgentRun {
  return DevFlowAgentRunSchema.parse({
    ...row,
    swarmTaskId: optionalString(row.swarmTaskId),
    workflowRunId: optionalString(row.workflowRunId),
    evidence: row.evidenceJson
      ? parseJson(row.evidenceJson, undefined)
      : undefined,
    evidenceAppliedAt: optionalString(row.evidenceAppliedAt),
    latencyMs: row.latencyMs ?? undefined,
    costUsd: row.costUsd ?? undefined,
    errorMessage: optionalString(row.errorMessage),
    startedAt: optionalString(row.startedAt),
    finishedAt: optionalString(row.finishedAt),
  });
}

export function createDevFlowRepository(db: Database): DevFlowRepository {
  function getWorkItem(
    organizationId: string,
    id: string,
  ): DevFlowWorkItem | null {
    const row = db
      .prepare<WorkItemRow, [string, string]>(
        "SELECT * FROM devflow_work_items WHERE organizationId = ? AND id = ?",
      )
      .get(organizationId, id);
    return row ? workItemFromRow(row) : null;
  }

  function getAgentRun(
    organizationId: string,
    id: string,
  ): DevFlowAgentRun | null {
    const row = db
      .prepare<AgentRunRow, [string, string]>(
        "SELECT * FROM devflow_agent_runs WHERE organizationId = ? AND id = ?",
      )
      .get(organizationId, id);
    return row ? agentRunFromRow(row) : null;
  }

  function getCurrentSpec(
    organizationId: string,
    workItemId: string,
  ): DevFlowSpec | null {
    const row = db
      .prepare<Record<string, unknown>, [string, string]>(
        `SELECT * FROM devflow_specs
         WHERE organizationId = ? AND workItemId = ?
         ORDER BY version DESC LIMIT 1`,
      )
      .get(organizationId, workItemId) as {
      id: string;
      organizationId: string;
      workItemId: string;
      version: number;
      status: string;
      problemStatement: string;
      userStories: string;
      outOfScope: string;
      uxBehavior: string;
      dataModelChanges: string;
      integrationPoints: string;
      threatModel: string | null;
      rollbackPlan: string | null;
      dependencyMapJson: string;
      openQuestionsJson: string;
      draftedByAgentRunId: string | null;
      approvedAt: string | null;
      createdAt: string;
      lastUpdatedAt: string;
    } | null;
    if (!row) return null;
    const acceptanceCriteria = db
      .prepare<Record<string, unknown>, [string, string]>(
        `SELECT id, organizationId, specId, givenText, whenText, thenText, isTestable,
                testHint, testStatus, linkedTestId
         FROM devflow_acceptance_criteria WHERE organizationId = ? AND specId = ? ORDER BY createdAt`,
      )
      .all(organizationId, row.id)
      .map((entry) => {
        const criterion = entry as Record<string, unknown>;
        return DevFlowAcceptanceCriterionSchema.parse({
          id: criterion.id,
          organizationId: criterion.organizationId,
          specId: criterion.specId,
          given: criterion.givenText,
          when: criterion.whenText,
          then: criterion.thenText,
          isTestable: criterion.isTestable === 1,
          testHint: criterion.testHint,
          testStatus: criterion.testStatus,
          linkedTestId: criterion.linkedTestId ?? undefined,
        });
      });
    const nfrDeclarations = db
      .prepare<Record<string, unknown>, [string, string]>(
        `SELECT id, organizationId, specId, category, status, statement, reviewedAt
         FROM devflow_nfr_declarations WHERE organizationId = ? AND specId = ? ORDER BY category`,
      )
      .all(organizationId, row.id)
      .map((entry) =>
        DevFlowNfrDeclarationSchema.parse({
          ...entry,
          reviewedAt:
            (entry as { reviewedAt?: string | null }).reviewedAt ?? undefined,
        }),
      );
    return DevFlowSpecSchema.parse({
      ...row,
      threatModel: optionalString(row.threatModel),
      rollbackPlan: optionalString(row.rollbackPlan),
      dependencyMap: parseJson(row.dependencyMapJson, []),
      openQuestions: parseJson(row.openQuestionsJson, []),
      draftedByAgentRunId: optionalString(row.draftedByAgentRunId),
      approvedAt: optionalString(row.approvedAt),
      acceptanceCriteria,
      nfrDeclarations,
    });
  }

  return {
    transaction<T>(fn: () => T): T {
      return db.transaction(fn)();
    },

    createOrganization(input) {
      const timestamp = now();
      const id = input.id ?? crypto.randomUUID();
      const row = db
        .prepare<
          OrganizationRow,
          [string, string, string, string, string, string]
        >(
          `INSERT INTO devflow_organizations
           (id, name, slug, settingsJson, createdAt, lastUpdatedAt)
           VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
        )
        .get(
          id,
          input.name,
          input.slug,
          JSON.stringify(input.settings ?? {}),
          timestamp,
          timestamp,
        );
      if (!row) throw new Error("Failed to create DevFlow organization");
      return organizationFromRow(row);
    },

    getOrganization(id) {
      const row = db
        .prepare<OrganizationRow, [string]>(
          "SELECT * FROM devflow_organizations WHERE id = ?",
        )
        .get(id);
      return row ? organizationFromRow(row) : null;
    },

    getOrganizationBySlug(slug) {
      const row = db
        .prepare<OrganizationRow, [string]>(
          "SELECT * FROM devflow_organizations WHERE slug = ?",
        )
        .get(slug);
      return row ? organizationFromRow(row) : null;
    },

    addMembership(input) {
      const timestamp = now();
      const row = db
        .prepare<MembershipRow, [string, string, string, string, string]>(
          `INSERT INTO devflow_organization_memberships
           (organizationId, userId, role, createdAt, lastUpdatedAt)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (organizationId, userId) DO UPDATE SET
             role = excluded.role, isActive = 1, lastUpdatedAt = excluded.lastUpdatedAt
           RETURNING *`,
        )
        .get(
          input.organizationId,
          input.userId,
          input.role,
          timestamp,
          timestamp,
        );
      if (!row) throw new Error("Failed to create DevFlow membership");
      return membershipFromRow(row);
    },

    getMembership(organizationId, userId) {
      const row = db
        .prepare<MembershipRow, [string, string]>(
          `SELECT * FROM devflow_organization_memberships
           WHERE organizationId = ? AND userId = ? AND isActive = 1`,
        )
        .get(organizationId, userId);
      return row ? membershipFromRow(row) : null;
    },

    findMembershipForUser(userId) {
      const row = db
        .prepare<MembershipRow, [string]>(
          `SELECT * FROM devflow_organization_memberships
           WHERE userId = ? AND isActive = 1 ORDER BY createdAt ASC LIMIT 1`,
        )
        .get(userId);
      return row ? membershipFromRow(row) : null;
    },

    createWorkItem(input) {
      const membership = this.getMembership(
        input.organizationId,
        input.pmOwnerId,
      );
      if (!membership)
        throw new Error(
          "PM owner must be an active member of the organization",
        );
      const timestamp = now();
      const id = input.id ?? crypto.randomUUID();
      const row = db
        .prepare<WorkItemRow, (string | number | null)[]>(
          `INSERT INTO devflow_work_items
           (id, organizationId, type, title, description, priority, pmOwnerId,
            engineeringOwnerId, assignedToUserId, createdVia, sourceMetadataJson,
            capturedAt, createdAt, lastUpdatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        )
        .get(
          id,
          input.organizationId,
          input.type ?? "idea",
          input.title,
          input.description,
          input.priority ?? null,
          input.pmOwnerId,
          input.engineeringOwnerId ?? null,
          input.assignedToUserId ?? null,
          input.createdVia,
          JSON.stringify(input.sourceMetadata ?? {}),
          timestamp,
          timestamp,
          timestamp,
        );
      if (!row) throw new Error("Failed to create DevFlow work item");
      return workItemFromRow(row);
    },

    getWorkItem,

    listWorkItems(organizationId, filters) {
      const conditions = ["organizationId = ?"];
      const values: (string | number)[] = [organizationId];
      if (filters.state) {
        conditions.push("state = ?");
        values.push(filters.state);
      }
      if (filters.type) {
        conditions.push("type = ?");
        values.push(filters.type);
      }
      if (filters.search) {
        conditions.push("(title LIKE ? OR description LIKE ?)");
        values.push(`%${filters.search}%`, `%${filters.search}%`);
      }
      const count = db
        .prepare<{ count: number }, (string | number)[]>(
          `SELECT COUNT(*) AS count FROM devflow_work_items WHERE ${conditions.join(" AND ")}`,
        )
        .get(...values)?.count;
      const limit = Math.min(Math.max(filters.limit ?? 50, 1), 100);
      const offset = Math.max(filters.offset ?? 0, 0);
      const rows = db
        .prepare<WorkItemRow, (string | number)[]>(
          `SELECT * FROM devflow_work_items WHERE ${conditions.join(" AND ")}
           ORDER BY createdAt DESC LIMIT ? OFFSET ?`,
        )
        .all(...values, limit, offset);
      const total = count ?? 0;
      return {
        items: rows.map(workItemFromRow),
        total,
        nextOffset:
          offset + rows.length < total ? offset + rows.length : undefined,
      };
    },

    updateWorkItem(organizationId, id, patch) {
      const columnByKey: Record<string, string> = {
        type: "type",
        state: "state",
        previousState: "previousState",
        blockerReason: "blockerReason",
        archiveReason: "archiveReason",
        title: "title",
        description: "description",
        priority: "priority",
        blastRadius: "blastRadius",
        isSecuritySensitive: "isSecuritySensitive",
        duplicateOf: "duplicateOf",
        duplicateConfidence: "duplicateConfidence",
        classificationRationale: "classificationRationale",
      };
      const entries = Object.entries(patch).filter(
        ([key]) => key in columnByKey,
      );
      if (entries.length === 0) {
        const current = getWorkItem(organizationId, id);
        if (!current) throw new Error("DevFlow work item not found");
        return current;
      }
      const assignments = entries.map(([key]) => `${columnByKey[key]} = ?`);
      const values = entries.map(([, value]) => sqlBinding(value));
      const timestamp = now();
      const row = db
        .prepare<WorkItemRow, (string | number | null)[]>(
          `UPDATE devflow_work_items SET ${assignments.join(", ")}, lastUpdatedAt = ?
           WHERE organizationId = ? AND id = ? RETURNING *`,
        )
        .get(...values, timestamp, organizationId, id);
      if (!row) throw new Error("DevFlow work item not found");
      return workItemFromRow(row);
    },

    getScope(organizationId, workItemId) {
      const row = db
        .prepare<ScopeRow, [string, string]>(
          "SELECT * FROM devflow_scopes WHERE organizationId = ? AND workItemId = ?",
        )
        .get(organizationId, workItemId);
      return row ? scopeFromRow(row) : null;
    },

    upsertScope(organizationId, workItemId, input) {
      if (!getWorkItem(organizationId, workItemId))
        throw new Error("DevFlow work item not found");
      const timestamp = now();
      const row = db
        .prepare<ScopeRow, (string | number | null)[]>(
          `INSERT INTO devflow_scopes
           (id, organizationId, workItemId, problemStatement, targetUsersJson,
            successCriteriaJson, effortBand, openQuestionsJson, confidence, rationale,
            agentRunId, createdAt, lastUpdatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (organizationId, workItemId) DO UPDATE SET
             problemStatement = excluded.problemStatement,
             targetUsersJson = excluded.targetUsersJson,
             successCriteriaJson = excluded.successCriteriaJson,
             effortBand = excluded.effortBand,
             openQuestionsJson = excluded.openQuestionsJson,
             confidence = excluded.confidence,
             rationale = excluded.rationale,
             agentRunId = excluded.agentRunId,
             lastUpdatedAt = excluded.lastUpdatedAt
           RETURNING *`,
        )
        .get(
          crypto.randomUUID(),
          organizationId,
          workItemId,
          input.problemStatement,
          JSON.stringify(input.targetUsers),
          JSON.stringify(input.successCriteria),
          input.effortBand,
          JSON.stringify(input.openQuestions),
          input.confidence,
          input.rationale,
          input.agentRunId ?? null,
          timestamp,
          timestamp,
        );
      if (!row) throw new Error("Failed to save DevFlow scope");
      return scopeFromRow(row);
    },

    signOffScope(organizationId, workItemId, at) {
      const row = db
        .prepare<ScopeRow, [string, string, string, string]>(
          `UPDATE devflow_scopes SET pmSignedOffAt = ?, lastUpdatedAt = ?
           WHERE organizationId = ? AND workItemId = ? RETURNING *`,
        )
        .get(at, at, organizationId, workItemId);
      if (!row) throw new Error("DevFlow scope not found");
      return scopeFromRow(row);
    },

    getCurrentSpec,

    createSpecVersion(organizationId, workItemId, input) {
      if (!getWorkItem(organizationId, workItemId))
        throw new Error("DevFlow work item not found");
      const current = getCurrentSpec(organizationId, workItemId);
      const version = (current?.version ?? 0) + 1;
      const specId = crypto.randomUUID();
      const timestamp = now();
      db.transaction(() => {
        db.run(
          `INSERT INTO devflow_specs
           (id, organizationId, workItemId, version, problemStatement, userStories,
            outOfScope, uxBehavior, dataModelChanges, integrationPoints, threatModel,
            rollbackPlan, dependencyMapJson, openQuestionsJson, draftedByAgentRunId,
            createdAt, lastUpdatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            specId,
            organizationId,
            workItemId,
            version,
            input.problemStatement,
            input.userStories ?? "",
            input.outOfScope,
            input.uxBehavior,
            input.dataModelChanges,
            input.integrationPoints,
            input.threatModel ?? null,
            input.rollbackPlan ?? null,
            JSON.stringify(input.dependencyMap),
            JSON.stringify(input.openQuestions),
            input.draftedByAgentRunId ?? null,
            timestamp,
            timestamp,
          ],
        );
        for (const criterion of input.acceptanceCriteria) {
          db.run(
            `INSERT INTO devflow_acceptance_criteria
             (id, organizationId, specId, givenText, whenText, thenText, isTestable,
              testHint, testStatus, linkedTestId, createdAt, lastUpdatedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              criterion.id ?? crypto.randomUUID(),
              organizationId,
              specId,
              criterion.given,
              criterion.when,
              criterion.then,
              criterion.isTestable ? 1 : 0,
              criterion.testHint ?? "",
              criterion.testStatus ?? "unverified",
              criterion.linkedTestId ?? null,
              timestamp,
              timestamp,
            ],
          );
        }
        for (const nfr of input.nfrDeclarations) {
          db.run(
            `INSERT INTO devflow_nfr_declarations
             (id, organizationId, specId, category, status, statement, reviewedAt,
              createdAt, lastUpdatedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              crypto.randomUUID(),
              organizationId,
              specId,
              nfr.category,
              nfr.status,
              nfr.statement,
              nfr.reviewedAt ?? null,
              timestamp,
              timestamp,
            ],
          );
        }
      })();
      const spec = getCurrentSpec(organizationId, workItemId);
      if (!spec) throw new Error("Failed to create DevFlow spec");
      return spec;
    },

    approveCurrentSpec(organizationId, workItemId, at) {
      const current = getCurrentSpec(organizationId, workItemId);
      if (!current) throw new Error("DevFlow spec not found");
      db.run(
        `UPDATE devflow_specs SET status = 'approved', approvedAt = ?, lastUpdatedAt = ?
         WHERE organizationId = ? AND id = ?`,
        [at, at, organizationId, current.id],
      );
      return getCurrentSpec(organizationId, workItemId)!;
    },

    createGateDecision(input) {
      const timestamp = now();
      const id = crypto.randomUUID();
      db.run(
        `INSERT INTO devflow_gate_decisions
         (id, organizationId, workItemId, gate, decision, actorUserId, actorRole,
          rationale, preconditionSnapshotJson, approvalRequestId, decidedAt, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.organizationId,
          input.workItemId,
          input.gate,
          input.decision,
          input.actorUserId,
          input.actorRole,
          input.rationale,
          JSON.stringify(input.preconditionSnapshot),
          input.approvalRequestId ?? null,
          timestamp,
          timestamp,
        ],
      );
      return { ...input, id, decidedAt: timestamp };
    },

    listGateDecisions(organizationId, workItemId) {
      return db
        .prepare<Record<string, unknown>, [string, string]>(
          `SELECT * FROM devflow_gate_decisions
           WHERE organizationId = ? AND workItemId = ? ORDER BY decidedAt DESC`,
        )
        .all(organizationId, workItemId)
        .map((row) => ({
          id: String(row.id),
          organizationId: String(row.organizationId),
          workItemId: String(row.workItemId),
          gate: Number(row.gate),
          decision: row.decision as DevFlowGateDecision["decision"],
          actorUserId: String(row.actorUserId),
          actorRole: row.actorRole as DevFlowRole,
          rationale: String(row.rationale),
          preconditionSnapshot: parseJson(
            String(row.preconditionSnapshotJson),
            {},
          ),
          approvalRequestId: row.approvalRequestId
            ? String(row.approvalRequestId)
            : undefined,
          decidedAt: String(row.decidedAt),
        }));
    },

    createAgentRun(input) {
      const timestamp = now();
      const id = input.id ?? crypto.randomUUID();
      const row = db
        .prepare<AgentRunRow, (string | null)[]>(
          `INSERT INTO devflow_agent_runs
           (id, organizationId, workItemId, mode, status, swarmTaskId, workflowRunId,
            contractVersion, promptVersion, createdAt, lastUpdatedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        )
        .get(
          id,
          input.organizationId,
          input.workItemId,
          input.mode,
          input.status ?? "queued",
          input.swarmTaskId ?? null,
          input.workflowRunId ?? null,
          input.contractVersion,
          input.promptVersion,
          timestamp,
          timestamp,
        );
      if (!row) throw new Error("Failed to create DevFlow agent run");
      return agentRunFromRow(row);
    },

    getAgentRun,

    listAgentRuns(organizationId, workItemId) {
      return db
        .prepare<AgentRunRow, [string, string]>(
          `SELECT * FROM devflow_agent_runs
           WHERE organizationId = ? AND workItemId = ? ORDER BY createdAt DESC`,
        )
        .all(organizationId, workItemId)
        .map(agentRunFromRow);
    },

    updateAgentRun(organizationId, id, patch) {
      const columnByKey: Record<string, string> = {
        status: "status",
        swarmTaskId: "swarmTaskId",
        workflowRunId: "workflowRunId",
        evidence: "evidenceJson",
        evidenceAppliedAt: "evidenceAppliedAt",
        latencyMs: "latencyMs",
        costUsd: "costUsd",
        errorMessage: "errorMessage",
        startedAt: "startedAt",
        finishedAt: "finishedAt",
      };
      const entries = Object.entries(patch).filter(
        ([key]) => key in columnByKey,
      );
      if (entries.length === 0) {
        const current = getAgentRun(organizationId, id);
        if (!current) throw new Error("DevFlow agent run not found");
        return current;
      }
      const assignments = entries.map(([key]) => `${columnByKey[key]} = ?`);
      const values = entries.map(([, value]) => sqlBinding(value));
      const row = db
        .prepare<AgentRunRow, (string | number | null)[]>(
          `UPDATE devflow_agent_runs SET ${assignments.join(", ")}, lastUpdatedAt = ?
           WHERE organizationId = ? AND id = ? RETURNING *`,
        )
        .get(...values, now(), organizationId, id);
      if (!row) throw new Error("DevFlow agent run not found");
      return agentRunFromRow(row);
    },

    appendAuditEvent(input) {
      const timestamp = now();
      const event: DevFlowAuditEvent = {
        id: crypto.randomUUID(),
        organizationId: input.context.organizationId,
        workItemId: input.workItemId,
        actorKind: input.context.actorKind,
        actorId: input.context.actorId,
        action: input.action,
        beforeState: input.beforeState,
        afterState: input.afterState,
        metadata: input.metadata ?? {},
        correlationId: input.context.correlationId,
        createdAt: timestamp,
      };
      db.run(
        `INSERT INTO devflow_audit_events
         (id, organizationId, workItemId, actorKind, actorId, action, beforeState,
          afterState, metadataJson, correlationId, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          event.id,
          event.organizationId,
          event.workItemId ?? null,
          event.actorKind,
          event.actorId ?? null,
          event.action,
          event.beforeState ?? null,
          event.afterState ?? null,
          JSON.stringify(event.metadata),
          event.correlationId ?? null,
          timestamp,
        ],
      );
      return event;
    },

    listAuditEvents(organizationId, workItemId) {
      const rows = workItemId
        ? db
            .prepare<Record<string, unknown>, [string, string]>(
              `SELECT * FROM devflow_audit_events
               WHERE organizationId = ? AND workItemId = ? ORDER BY createdAt DESC`,
            )
            .all(organizationId, workItemId)
        : db
            .prepare<Record<string, unknown>, [string]>(
              `SELECT * FROM devflow_audit_events
               WHERE organizationId = ? ORDER BY createdAt DESC`,
            )
            .all(organizationId);
      return rows.map((row) => ({
        id: String(row.id),
        organizationId: String(row.organizationId),
        workItemId: row.workItemId ? String(row.workItemId) : undefined,
        actorKind: row.actorKind as DevFlowContext["actorKind"],
        actorId: row.actorId ? String(row.actorId) : undefined,
        action: String(row.action),
        beforeState: row.beforeState
          ? (row.beforeState as DevFlowState)
          : undefined,
        afterState: row.afterState
          ? (row.afterState as DevFlowState)
          : undefined,
        metadata: parseJson(String(row.metadataJson), {}),
        correlationId: row.correlationId
          ? String(row.correlationId)
          : undefined,
        createdAt: String(row.createdAt),
      }));
    },
  };
}
