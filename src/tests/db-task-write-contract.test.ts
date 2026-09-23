import { expect, test } from "bun:test";
import ts from "typescript";
import * as db from "../be/db";
import * as write from "../be/db/tasks/write";
import { CHILD_PROCESS_TEST_BUDGET_MS, expectChildOk, runChild } from "./test-proc";

function manifest(source: string): string[] {
  const file = ts.createSourceFile("module.ts", source, ts.ScriptTarget.Latest, true);
  const names = new Set<string>();
  for (const node of file.statements) {
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const binding of node.exportClause.elements) {
        names.add(
          `${node.isTypeOnly || binding.isTypeOnly ? "type" : "value"}:${binding.name.text}`,
        );
      }
    } else if (
      ts.canHaveModifiers(node) &&
      ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      if (ts.isVariableStatement(node)) {
        for (const declaration of node.declarationList.declarations)
          names.add(`value:${declaration.name.getText(file)}`);
      } else if (
        (ts.isFunctionDeclaration(node) ||
          ts.isClassDeclaration(node) ||
          ts.isTypeAliasDeclaration(node) ||
          ts.isInterfaceDeclaration(node)) &&
        node.name
      ) {
        names.add(
          `${ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node) ? "type" : "value"}:${node.name.text}`,
        );
      }
    }
  }
  return [...names].sort();
}

// Complete public facade and selected range manifests captured from merged base 8ac7b4a7.
const baseFacade = `type:AgentMailInboxMapping
type:ApiKeyStatus
type:AppVersion
type:ApprovalRequest
type:AssetSummaryFilters
type:AttributionByPersonRow
type:CascadeFailResult
type:ChannelActivityCursor
type:ConcurrentContext
type:ContextSummary
type:CreateContextSnapshotInput
type:CreateInboxMessageOptions
type:CreateScheduledTaskData
type:CreateServiceOptions
type:CreateSessionCostInput
type:CreateSteeringMessageArgs
type:CreateTaskOptions
type:CreateWaitStateInput
type:DashboardCostSummary
type:DeleteMcpServerResult
type:ExistingTrackerContextWork
type:ExistingTrackerContextWorkReason
type:InboxSummary
type:InsertPricingRowInput
type:InsertTaskAttachmentInput
type:KeyCostSummary
type:McpServerFilters
type:McpServerInsert
type:MentionPreview
type:PageListOptions
type:RecordBudgetRefusalNotificationInput
type:ScheduledTaskFilters
type:ScriptRunPatch
type:ServiceFilters
type:SessionCostByAgentRow
type:SessionCostByUserRow
type:SessionCostDailyRow
type:SessionCostSummaryTotals
type:SessionListItem
type:SessionListItemSummary
type:SkillFileInput
type:SkillFileManifestEntry
type:SkillFilters
type:SkillInsert
type:SlackConclusionKind
type:SlackMessageKind
type:SlackMessageRecord
type:StuckApprovalRun
type:StuckWaitRun
type:StuckWorkflowRun
type:SwarmMetrics
type:TaskFilters
type:UpdateScheduledTaskData
type:UpsertAssetKeyMappingInput
type:WorkflowFilters
type:WorkflowRunListOptions
type:WorkflowRunPage
value:EXTENSION_AGENT_ROLE
value:ExtensionAgentAssignmentError
value:KvTypeCollisionError
value:MAX_EMPTY_POLLS
value:NOT_EXTENSION_AGENT_SQL
value:ReservedAgentRoleError
value:SKILL_FILE_LIMITS
value:UNATTRIBUTED_USER_ID
value:__resetSqliteVecExtensionPathCacheForTests
value:acceptTask
value:assignUnassignedTaskPending
value:autoEncryptLegacyPlaintextSecrets
value:backfillSupersedeTaskResumeTaskId
value:bindSlackMessageTimestamp
value:buildRoutingAffinityFromAgent
value:cancelPendingApprovalRequestsForRun
value:cancelPendingSteeringForTask
value:cancelTask
value:cascadeFailDependents
value:checkDependencies
value:checkoutPromptTemplate
value:claimApprovalCancellationNotification
value:claimInboxMessages
value:claimKv
value:claimMentions
value:claimOfferedTask
value:claimTask
value:cleanupAgentSessions
value:cleanupStaleSessions
value:clearKeyRateLimit
value:closeDb
value:completeApprovalCancellationNotificationClaim
value:completeTask
value:computeContentHash
value:countActiveScriptRuns
value:countAllMetrics
value:countAllPages
value:countKv
value:countMetricsByAgent
value:countPagesByAgent
value:countScriptRunJournalAgentTaskSteps
value:countScriptRunJournalSteps
value:countScriptRuns
value:countSessions
value:countWorkflowRuns
value:createAgent
value:createAgentMailInboxMapping
value:createAppVersion
value:createApprovalRequest
value:createChannel
value:createContextSnapshot
value:createContextVersion
value:createInboxMessage
value:createLogEntry
value:createMcpServer
value:createMetric
value:createMetricVersion
value:createPage
value:createPageVersion
value:createScheduledTask
value:createScriptRun
value:createService
value:createSessionCost
value:createSessionLogs
value:createSkill
value:createSteeringMessage
value:createSwarmRepo
value:createTask
value:createTaskExtended
value:createUser
value:createWaitState
value:createWorkflow
value:createWorkflowRun
value:createWorkflowRunStep
value:createWorkflowVersion
value:deleteActiveSession
value:deleteActiveSessionById
value:deleteAgent
value:deleteAgentMailInboxMapping
value:deleteBudget
value:deleteChannel
value:deleteKv
value:deleteMcpServer
value:deleteMetric
value:deletePage
value:deletePricingRow
value:deletePromptTemplate
value:deleteScheduledTask
value:deleteService
value:deleteServicesByAgentId
value:deleteSkill
value:deleteSkillFile
value:deleteSlackMessageRecord
value:deleteSwarmConfig
value:deleteSwarmConfigByKey
value:deleteSwarmRepo
value:deleteTask
value:deleteTaskAttachment
value:deleteUser
value:deleteWorkflow
value:detachTaskFromWorkflowRunStep
value:emitBuiltInIntegrationConnectedOnce
value:emitMcpServerConnectedTelemetry
value:ensureSlackDelegationActivation
value:ensureSlackRenderV2Activation
value:extensionAgentAssignmentError
value:failPendingResumeIfUnclaimed
value:failTask
value:findCompletedTaskInThread
value:findExistingLinearTrackerContextWork
value:findRecentCancelledTaskInThread
value:findRecentSimilarTasks
value:findTaskByAgentMailThread
value:findTaskByGitHub
value:findTaskByVcs
value:generateDefaultClaudeMd
value:generateDefaultIdentityMd
value:generateDefaultSoulMd
value:generateDefaultToolsMd
value:getActivePricingRow
value:getActiveSessionForTask
value:getActiveSessions
value:getActiveTaskCount
value:getAgentById
value:getAgentCurrentTask
value:getAgentHarnessProviders
value:getAgentMailInboxMapping
value:getAgentMailInboxMappingsByAgent
value:getAgentMcpServers
value:getAgentSkills
value:getAgentWithTasks
value:getAgentWorkingOnThread
value:getAllAgentMailInboxMappings
value:getAllAgents
value:getAllAgentsWithTasks
value:getAllChannelActivityCursors
value:getAllChannels
value:getAllLogs
value:getAllPricingRows
value:getAllServices
value:getAllSessionCosts
value:getAllTasks
value:getAllUsers
value:getAppVersion
value:getAppVersions
value:getApprovalRequestById
value:getApprovalRequestByStepId
value:getAssetKeyMapping
value:getAssetKeyMappingByProvider
value:getAttributionByPerson
value:getAvailableKeyIndices
value:getBudget
value:getBudgetRefusalNotification
value:getBudgets
value:getChannelActivityCursor
value:getChannelById
value:getChannelByName
value:getChannelMessages
value:getChildTasks
value:getCompletedSlackTasks
value:getCompletedStepNodeIds
value:getConcurrentContext
value:getContextSnapshotsBySessionId
value:getContextSnapshotsByTaskId
value:getContextSummaryByTaskId
value:getContextVersion
value:getContextVersionHistory
value:getDailySpendForAgent
value:getDailySpendForUser
value:getDailySpendGlobal
value:getDashboardCostSummary
value:getDb
value:getDbClient
value:getDependentTasks
value:getDueScheduledTasks
value:getDueWaitStates
value:getExpiredPendingApprovals
value:getFavoriteItemIdSet
value:getIdleWorkersWithCapacity
value:getInProgressSlackTasks
value:getInProgressTasksByContextKey
value:getInboxMessageById
value:getInboxSummary
value:getInjectableGlobalConfigs
value:getInstanceActivity
value:getKeyCostSummary
value:getKeyStatuses
value:getKv
value:getLastReadAt
value:getLastRunStart
value:getLastSuccessfulRun
value:getLatestActiveTaskInThread
value:getLatestContextVersion
value:getLatestLeadTaskInThread
value:getLatestPageBySlug
value:getLatestScriptRunStepTaskByContextKey
value:getLatestStepForNode
value:getLatestTaskByContextKey
value:getLeadAgent
value:getLiveAgentCounts
value:getLogsByAgentId
value:getLogsByEventType
value:getLogsByTaskId
value:getLogsByTaskIdChronological
value:getMcpServerById
value:getMcpServerByName
value:getMentionsForAgent
value:getMessageById
value:getMetric
value:getMetricBySlug
value:getMetricVersion
value:getMetricVersions
value:getMostRecentTaskInThread
value:getOfferedTasksForAgent
value:getOrphanedInProgressTasksForAgent
value:getPage
value:getPageBySlug
value:getPageVersion
value:getPageVersions
value:getPausedTasksForAgent
value:getPendingEventWaitNames
value:getPendingSlackRelayTasks
value:getPendingSteeringForAgent
value:getPendingSteeringForTask
value:getPendingTaskForAgent
value:getPendingWaitsByEvent
value:getPricingRows
value:getPromptTemplateById
value:getPromptTemplateHistory
value:getPromptTemplates
value:getRecentBudgetRefusalNotifications
value:getRecentCompletedCount
value:getRecentFailedCount
value:getRecentFailedTasks
value:getRecentlyCancelledTasksForAgent
value:getRecentlyFinishedWorkerTasks
value:getRemainingCapacity
value:getResolvedConfig
value:getRetryableSteps
value:getRootTaskChain
value:getRunningScriptRuns
value:getScheduledTaskById
value:getScheduledTaskByName
value:getScheduledTasks
value:getScriptRun
value:getScriptRunByIdempotencyKey
value:getScriptRunJournalStep
value:getServiceByAgentAndName
value:getServiceById
value:getServicesByAgentId
value:getSessionCostSummary
value:getSessionCostsByAgentId
value:getSessionCostsByTaskId
value:getSessionCostsFiltered
value:getSessionLogsBySession
value:getSessionLogsByTaskId
value:getSkillById
value:getSkillByName
value:getSkillFile
value:getSkillFiles
value:getSlackDelegationActivatedAt
value:getSlackMessageByChannelTs
value:getSlackOutcomeMessage
value:getSlackRenderV2ActivatedAt
value:getSlackTasksInThread
value:getSlackTasksMissingTree
value:getSlackTreeMessage
value:getSlackTreeMessageByThread
value:getSlackTreeMessages
value:getStalePinnedResumes
value:getStaleUnassignedAffinityTasks
value:getStalledInProgressTasks
value:getSteeringMessageById
value:getSteeringMessagesForTask
value:getStepByIdempotencyKey
value:getStepCountForNode
value:getStuckApprovalRuns
value:getStuckWaitRuns
value:getStuckWorkflowRuns
value:getSwarmConfigById
value:getSwarmConfigLookupById
value:getSwarmConfigs
value:getSwarmMetrics
value:getSwarmRepoById
value:getSwarmRepoByName
value:getSwarmRepoByUrl
value:getSwarmRepos
value:getSystemDefaultSkills
value:getTaskAttachments
value:getTaskById
value:getTaskByWorkflowRunStepId
value:getTaskStats
value:getTasksByAgentId
value:getTasksByStatus
value:getTasksCount
value:getUnassignedPoolTasks
value:getUnassignedTaskIds
value:getUnassignedTaskIdsForAgent
value:getUnassignedTasksCount
value:getUnreadInboxMessages
value:getUnreadMessages
value:getUserById
value:getWaitStateById
value:getWaitStateByStepId
value:getWorkflow
value:getWorkflowRun
value:getWorkflowRunStep
value:getWorkflowRunStepsByRunId
value:getWorkflowVersion
value:getWorkflowVersions
value:getWorkflowsByScheduleId
value:hasBudgetRefusalNotificationToday
value:hasCapacity
value:hasFirstCompletedTask
value:hasNonTerminalRerouteDecisionChild
value:hasNonTerminalResumeChild
value:hasPendingSteering
value:heartbeatActiveSession
value:incrKv
value:incrementEmptyPollCount
value:incrementPageViewCount
value:initDb
value:insertActiveSession
value:insertPricingRow
value:insertTaskAttachment
value:installMcpServer
value:installSkill
value:installSystemDefaultSkillsForAgent
value:isAgentEligibleForTask
value:isExtensionAgent
value:isPendingSlackMessage
value:isPoolAffinityEnforcementEnabled
value:isSqliteVecAvailable
value:listAgentsWithCredStatusByProvider
value:listAllMetrics
value:listAllPages
value:listApprovalRequests
value:listAssetSummaries
value:listCancelledApprovalRequestsForRun
value:listCancelledApprovalRequestsForStep
value:listFavorites
value:listInboxState
value:listKv
value:listMcpServers
value:listMetricsByAgent
value:listPagesByAgent
value:listRecentSessions
value:listScriptRunJournalSteps
value:listScriptRuns
value:listSkillFileManifest
value:listSkills
value:listTaskTemplates
value:listUserFavorites
value:listWorkflowRuns
value:listWorkflowRunsPage
value:listWorkflows
value:markFinalizedSlackRelaysDelivered
value:markInboxMessageDelegated
value:markInboxMessageRead
value:markInboxMessageResponded
value:markKeyRateLimited
value:markSlackRelayAttempted
value:markSlackRelayDelivered
value:markSlackTreeRendered
value:markSteeringDelivered
value:markSteeringHandled
value:markSteeringPromoted
value:markTaskSlackReplySent
value:markTasksNotified
value:maskSecrets
value:moveAssetKey
value:moveTaskFromBacklog
value:moveTaskToBacklog
value:normalizeSkillFilePath
value:overwriteTerminalTaskResultText
value:pauseTask
value:postMessage
value:promoteAbandonedDraftTasks
value:promoteDraftTask
value:reassociateSessionLogs
value:recordBudgetRefusalNotification
value:recordInlineScriptRun
value:recordKeyRateLimitWindows
value:recordKeyUsage
value:recordSlackMessage
value:recordTaskPullRequestAttachments
value:refreshDraftTaskLease
value:rejectTask
value:releaseApprovalCancellationNotificationClaim
value:releaseMentionProcessing
value:releaseStaleMentionProcessing
value:releaseStaleOfferedTasksForOfflineAgents
value:releaseStaleProcessingInbox
value:releaseStaleReviewingTasks
value:releaseTask
value:replaceTaskAttachment
value:reserveSlackMessage
value:reservedRoleViolation
value:resetEmptyPollCount
value:resetOrphanedInProgressTasksForAgent
value:resetPromptTemplateToDefault
value:resetTasksNotified
value:resolveApprovalRequest
value:resolvePromptTemplate
value:resolveSqliteVecExtensionPath
value:resolveWaitState
value:resumeTask
value:searchSkills
value:setAgentHarnessProvider
value:setApiKeyName
value:setBudgetRefusalFollowUpTaskId
value:setFavorite
value:setSlackMessageTracking
value:setUserFavorite
value:shouldBlockPolling
value:startTask
value:supersedeTask
value:sweepExpiredKv
value:sweepExpiredKvPrefix
value:toggleAgentSkill
value:uninstallMcpServer
value:uninstallSkill
value:updateActiveSessionProviderSessionId
value:updateAgentActivity
value:updateAgentCredStatus
value:updateAgentCredentialMissing
value:updateAgentCredentialState
value:updateAgentMaxTasks
value:updateAgentName
value:updateAgentProfile
value:updateAgentProvider
value:updateAgentStatus
value:updateAgentStatusFromCapacity
value:updateApprovalRequestNotifications
value:updateMcpServer
value:updateMetric
value:updatePage
value:updateReadState
value:updateScheduledTask
value:updateScriptRun
value:updateScriptRunIfNotTerminal
value:updateScriptRunIfRunning
value:updateServiceStatus
value:updateSkill
value:updateSlackMessageRecord
value:updateSwarmRepo
value:updateTaskClaudeSessionId
value:updateTaskProgress
value:updateTaskTitle
value:updateTaskVcs
value:updateUser
value:updateWorkflow
value:updateWorkflowRun
value:updateWorkflowRunStep
value:upsertAssetKeyMapping
value:upsertBudget
value:upsertChannelActivityCursor
value:upsertInboxState
value:upsertKv
value:upsertPromptTemplate
value:upsertScriptRunJournalStep
value:upsertService
value:upsertSkillFile
value:upsertSkillFiles
value:upsertSwarmConfig
value:withFavoriteFlags`.split("\n");
const selected = `value:assignUnassignedTaskPending
value:backfillSupersedeTaskResumeTaskId
value:cancelTask
value:completeTask
value:createTask
value:deleteTask
value:failTask
value:getOrphanedInProgressTasksForAgent
value:getPausedTasksForAgent
value:getPendingTaskForAgent
value:getRecentlyCancelledTasksForAgent
value:overwriteTerminalTaskResultText
value:pauseTask
value:resetOrphanedInProgressTasksForAgent
value:resumeTask
value:startTask
value:supersedeTask
value:updateTaskClaudeSessionId
value:updateTaskProgress
value:updateTaskTitle`.split("\n");
const internal = ["value:configureTaskWriteDependencies"];

test("complete facade, selected public bindings and internal-only manifest remain exact", async () => {
  const facade = await Bun.file(new URL("../be/db.ts", import.meta.url)).text();
  const target = await Bun.file(new URL("../be/db/tasks/write.ts", import.meta.url)).text();
  expect(manifest(facade)).toEqual(baseFacade);
  expect(manifest(target).filter((name) => !internal.includes(name))).toEqual(selected);
  expect(manifest(target).filter((name) => internal.includes(name))).toEqual(internal);
  for (const binding of selected) {
    const [kind, name] = binding.split(":") as [string, string];
    if (kind === "value")
      expect((db as Record<string, unknown>)[name]).toBe((write as Record<string, unknown>)[name]);
  }
  for (const binding of internal) expect(binding.split(":")[1]! in db).toBe(false);
  const parsed = ts.createSourceFile("facade.ts", facade, ts.ScriptTarget.Latest, true);
  for (const node of parsed.statements) {
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isInterfaceDeclaration(node)) &&
      node.name
    ) {
      expect(selected.some((name) => name.endsWith(`:${node.name?.text}`))).toBe(false);
    }
  }
  expect(target).not.toMatch(/from ["'][^"']*(?:be\/db|\.\.\/\.\.\/db)["']/);
  expect(target).not.toContain("bun:sqlite");
  expect(facade.split("\n").length).toBeLessThanOrEqual(14133);
});

test(
  "fresh facade import registers deferred task-write dependencies and preserves their effects",
  async () => {
    const source = `
    import { expect } from "bun:test";
    import * as db from "./src/be/db";
    import { telemetry } from "./src/telemetry";
    const events = [];
    telemetry.taskEvent = (event, props) => events.push({ event, props });
    db.initDb(":memory:");
    const agentId = "bbbb0000-0000-4000-8000-000000000004";
    await db.createAgent({ id: agentId, name: "Fresh process", isLead: false, status: "idle" });
    const parent = await db.createTask(agentId, "parent");
    const child = await db.createTaskExtended("dependent", { agentId, dependsOn: [parent.id] });
    await db.getDbClient().run("UPDATE agent_tasks SET priority = 100 WHERE id = ?", [child.id]);
    expect((await db.getPendingTaskForAgent(agentId)).id).toBe(parent.id);
    await db.updateTaskClaudeSessionId(parent.id, "fresh-session", "codex", {}, undefined, "codex", { version: 3 });
    const steer = await db.createSteeringMessage({ taskId: parent.id, body: "continue afterwards", mode: "queue", source: "mcp", createdByKind: "agent", createdByAgentId: agentId });
    await db.completeTask(parent.id, "https://github.com/desplega-ai/agent-swarm/pull/1455");
    expect((await db.getTaskAttachments(parent.id)).some(a => a.url === "https://github.com/desplega-ai/agent-swarm/pull/1455")).toBe(true);
    expect((await db.getSteeringMessageById(steer.id)).promotedTaskId).toBeTruthy();
    expect((await db.getLogsByTaskId(parent.id)).some(l => l.newValue === "completed")).toBe(true);
    const failed = await db.createTask(agentId, "will fail");
    const blocked = await db.createTaskExtended("cascade", { agentId, dependsOn: [failed.id] });
    await db.failTask(failed.id, "failure");
    expect((await db.getTaskById(blocked.id)).status).toBe("failed");
    for (let i = 0; i < 5; i++) await Bun.sleep(0);
    const completedEvents = events.filter(e => e.event === "completed" && e.props.taskId === parent.id);
    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0].props.provider).toBe("codex");
    expect(completedEvents[0].props.harnessVersion).toBe("3");
    db.closeDb();
    console.log("task-write-initialization-ok");
  `;
    const child = await runChild([process.execPath, "--eval", source], {
      cwd: new URL("../../", import.meta.url).pathname,
      env: {
        ...process.env,
        SECRETS_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        AGENT_SWARM_TELEMETRY_DISABLED: "1",
      },
    });
    expectChildOk(child, "fresh task-write facade initialization");
    expect(child.stdout).toContain("task-write-initialization-ok");
  },
  CHILD_PROCESS_TEST_BUDGET_MS,
);
