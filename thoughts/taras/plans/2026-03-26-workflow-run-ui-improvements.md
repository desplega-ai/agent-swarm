---
date: 2026-03-26T14:00:00Z
topic: "Workflow & Run Detail Pages — UI Improvements"
type: plan
planner: claude
status: completed
scope: new-ui workflow and run detail pages
research: thoughts/taras/research/2026-03-26-workflow-run-ui-improvements.md
---

# Workflow & Run Detail Pages — UI Improvements Plan

## Overview

Enhance the workflow detail page (`/workflows/:id`) and workflow run detail page (`/workflow-runs/:id`) in the `new-ui/` dashboard to surface data that the backend already returns but the UI ignores, add cross-navigation links between entities, replace raw JSON dumps with smart rendering by step type, and add missing sections (trigger data, step summary, version history, workspace info).

## Current State Analysis

The workflow UI has two detail pages sharing a split layout (graph left, panel right) built on ReactFlow + dagre. Both pages work functionally but under-utilize the data the backend provides:

- **Type drift**: The UI types in `new-ui/src/api/types.ts:400-535` are missing 8+ fields the backend returns (diagnostics, nextPort, dir, vcsRepo, triggerSchema, inputs, inputSchema, outputSchema)
- **Raw JSON everywhere**: Step input/output and node config are rendered as `JsonTree` with no type-aware parsing. For agent-task steps, `taskId` and `taskOutput` are buried in a JSON tree
- **No cross-links**: Steps don't link to tasks or agents; the run header doesn't link to the parent workflow
- **Wrong back navigation**: Run detail back button goes to `/workflows?tab=runs` (global runs) instead of the parent workflow's runs tab
- **Missing sections**: No trigger data display, no step summary bar, no version history tab, no workspace info

### Key Discoveries:
- `StepCard` is defined inline in `new-ui/src/pages/workflow-runs/[id]/page.tsx:235-352` (~120 lines, will grow)
- `step-detail-sheet.tsx` is orphaned — not imported anywhere in the codebase
- `useWorkflowVersions` hook exists at `new-ui/src/api/hooks/use-workflows.ts` but has no UI
- Entity link pattern: `<Link to={...} className="text-primary hover:underline">` with truncated UUIDs in `font-mono`
- Collapsible pattern: Hand-rolled `CollapsibleCard` from `new-ui/src/pages/tasks/[id]/page.tsx:185-222`
- Badge pattern: `variant="outline" className="text-[9px] px-1.5 py-0 h-5 font-medium leading-none items-center uppercase"`
- Back button pattern: `<button>` + `navigate("/path")` with `ArrowLeft` icon

## Desired End State

After all 6 phases:

1. **All backend data surfaced**: UI types match backend schemas; diagnostics, workspace info, trigger schema all displayed
2. **Smart step rendering**: Agent-task steps show task link badge + agent name + collapsible output. HITL steps show approval request links. Script steps show pre-formatted output. Raw JSON is opt-in fallback
3. **Full cross-navigation**: Every entity ID is a clickable link (tasks, agents, workflows, approval requests)
4. **Trigger data visible**: Collapsible section in run header showing what triggered the run
5. **Step summary bar**: Visual status overview (`3/5 completed, 1 running`) with colored dots
6. **Structured node inspector**: Agent-task config parsed into template text, agent link, schema viewer, badges
7. **Workflow header enhanced**: Created-by agent link, workspace info (dir/vcsRepo), version history tab
8. **Clean navigation**: Back button goes to parent workflow's runs tab; workflow name in run header is a link

## Quick Verification Reference

Common commands:
- `cd new-ui && pnpm lint` — Biome lint + format
- `cd new-ui && pnpm exec tsc --noEmit` — TypeScript type check
- `cd new-ui && pnpm run dev` — Start dev server for manual testing

Key files:
- `new-ui/src/api/types.ts` — UI type definitions (lines 400-535)
- `new-ui/src/pages/workflow-runs/[id]/page.tsx` — Run detail page
- `new-ui/src/pages/workflows/[id]/page.tsx` — Workflow detail page
- `new-ui/src/components/workflows/step-card.tsx` — Step card (will be extracted)
- `new-ui/src/components/workflows/step-detail-sheet.tsx` — Orphaned (will be deleted)
- `new-ui/src/api/hooks/use-workflows.ts` — Workflow hooks

## What We're NOT Doing

- **Backend changes**: All data is already available from the API. No backend modifications needed.
- **Graph redesign**: The ReactFlow + dagre graph visualization works well. We're only enhancing the panel content.
- **New API endpoints**: We're surfacing data from existing endpoints, not creating new ones.
- **Workflow creation/editing UI**: Out of scope — this plan is read-only improvements.
- **Performance optimization**: No changes to data fetching patterns or caching strategies.

## Implementation Approach

Six incremental phases, each independently shippable:

1. **Type foundation first** — Align UI types with backend before any visual work
2. **Quick wins on run detail** — Fix navigation and add missing header sections
3. **Extract + enhance StepCard** — Biggest visual change: smart rendering + cross-links
4. **Node inspector** — Structured config display on workflow detail page
5. **Workflow header** — Agent link, workspace info, version history tab
6. **HITL links** — Approval request integration for human-in-the-loop steps

Each phase is a commit. Phases depend on Phase 1 (types) but are otherwise independent.

---

## Phase 1: Type Foundation

### Overview
Add all missing fields to UI types in `new-ui/src/api/types.ts` to align with backend schemas. No visual changes — this unblocks all subsequent phases.

### Changes Required:

#### 1. Workflow Type
**File**: `new-ui/src/api/types.ts`
**Changes**: Add `triggerSchema`, `dir`, `vcsRepo` fields to the `Workflow` interface (around line 456-468).

```typescript
// Add after existing fields:
triggerSchema?: Record<string, unknown>;
dir?: string;
vcsRepo?: string;
```

#### 2. WorkflowNode Type
**File**: `new-ui/src/api/types.ts`
**Changes**: Add `inputs`, `inputSchema`, `outputSchema` to the `WorkflowNode` interface (around line 419-427). Also add the `string[]` variant to `next`.

```typescript
// Update next to include array variant:
next?: string | string[] | Record<string, string>;

// Add new fields:
inputs?: Record<string, string>;
inputSchema?: Record<string, unknown>;
outputSchema?: Record<string, unknown>;
```

#### 3. WorkflowRunStep Type
**File**: `new-ui/src/api/types.ts`
**Changes**: Add `diagnostics` and `nextPort` to the `WorkflowRunStep` interface (around line 492-507).

```typescript
// Add after existing fields:
diagnostics?: string;  // JSON string with unresolvedTokens, etc.
nextPort?: string;
```

#### 4. WorkflowDefinition Type
**File**: `new-ui/src/api/types.ts`
**Changes**: Add `onNodeFailure` to `WorkflowDefinition` (around line 437-441).

```typescript
onNodeFailure?: "fail" | "continue";
```

#### 5. WorkflowVersion Snapshot Type
**File**: `new-ui/src/api/types.ts`
**Changes**: Add `triggerSchema`, `dir`, `vcsRepo` to the version snapshot type (around line 513-528), mirroring the `Workflow` additions.

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `cd new-ui && pnpm exec tsc --noEmit`
- [x] Lint passes: `cd new-ui && pnpm lint`

#### Manual Verification:
- [ ] Existing pages still render correctly (no regressions from type additions — all new fields are optional)

**Implementation Note**: After completing this phase, pause for manual confirmation. Create commit after verification passes.

---

## Phase 2: Run Detail — Quick Wins

### Overview
Fix navigation issues and add missing header sections to the workflow run detail page. Four targeted changes that each improve usability independently.

### Changes Required:

#### 1. Fix Back Button Navigation
**File**: `new-ui/src/pages/workflow-runs/[id]/page.tsx`
**Changes**: Change back button from `navigate("/workflows?tab=runs")` (line ~100) to `navigate(`/workflows/${run.workflowId}?tab=runs`)`. This navigates to the parent workflow's runs tab instead of the global runs list.

#### 2. Make Workflow Name a Link
**File**: `new-ui/src/pages/workflow-runs/[id]/page.tsx`
**Changes**: In the header section (line ~105), wrap the workflow name text in a `<Link to={`/workflows/${run.workflowId}`}>` with `className="text-primary hover:underline"`. Import `Link` from `react-router-dom`.

#### 3. Add Trigger Data Section
**File**: `new-ui/src/pages/workflow-runs/[id]/page.tsx`
**Changes**: After the header and before the split layout, add a collapsible section displaying `run.triggerData` when present. Use the hand-rolled collapsible pattern (ChevronDown/ChevronRight toggle) with `JsonTree` for the content. Keep it collapsed by default.

```tsx
// Pattern to follow (similar to CollapsibleCard from tasks page):
{run.triggerData != null && (
  <div className="rounded-md border border-border/50">
    <button onClick={() => setTriggerExpanded(!triggerExpanded)} className="...">
      {triggerExpanded ? <ChevronDown /> : <ChevronRight />}
      <span className="text-xs text-muted-foreground">Trigger Data</span>
    </button>
    {triggerExpanded && (
      <div className="px-3 pb-2.5">
        <JsonTree data={run.triggerData} defaultExpandDepth={1} maxHeight="200px" />
      </div>
    )}
  </div>
)}
```

#### 4. Add Step Summary Bar
**File**: `new-ui/src/pages/workflow-runs/[id]/page.tsx`
**Changes**: Below the header (after trigger data), add a summary bar showing step status counts. Compute counts from `run.steps` array grouped by status. Display as colored dots (using colors from `node-styles.ts` `statusBorderColor` mapping) with text like "4/5 completed · 1 skipped".

```tsx
// Summary bar component (inline or extracted):
const statusCounts = useMemo(() => {
  const counts: Record<string, number> = {};
  run.steps.forEach(s => { counts[s.status] = (counts[s.status] || 0) + 1; });
  return counts;
}, [run.steps]);

// Render: colored dots + "{completed}/{total} completed · N running · N failed"
```

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `cd new-ui && pnpm exec tsc --noEmit`
- [x] Lint passes: `cd new-ui && pnpm lint`

#### Manual Verification:
- [ ] Back button on a run detail page navigates to the parent workflow's runs tab (not global)
- [ ] Workflow name in run header is clickable and navigates to the workflow detail page
- [ ] Trigger data section appears when a run has `triggerData`, collapsed by default, expands on click
- [ ] Step summary bar shows correct counts with colored status dots
- [ ] Runs without trigger data don't show an empty section

**Implementation Note**: After completing this phase, pause for manual confirmation. Create commit after verification passes.

### QA Spec (optional):

**Approach:** browser-automation
**Test Scenarios:**
- [ ] TC-1: Back button navigation
  - Steps: 1. Navigate to `/workflow-runs/:id` for a known run, 2. Click back button, 3. Verify URL
  - Expected: URL is `/workflows/:workflowId?tab=runs` (parent workflow, runs tab active)
- [ ] TC-2: Workflow name link
  - Steps: 1. Navigate to `/workflow-runs/:id`, 2. Click workflow name in header
  - Expected: Navigates to `/workflows/:workflowId`
- [ ] TC-3: Trigger data visibility
  - Steps: 1. Navigate to run with trigger data, 2. Verify section is collapsed, 3. Click to expand, 4. Verify JSON content appears
  - Expected: Collapsible section shows trigger data when expanded

---

## Phase 3: Extract & Enhance StepCard

### Overview
Extract the inline `StepCard` component to its own file, then add smart output rendering by step type: task links for agent-task steps, collapsible output with byte size, agent info from config, and diagnostics warnings. Delete the orphaned `step-detail-sheet.tsx`.

### Changes Required:

#### 1. Extract StepCard Component
**File**: Create `new-ui/src/components/workflows/step-card.tsx`
**Changes**: Move the `StepCard` component (currently at `new-ui/src/pages/workflow-runs/[id]/page.tsx:235-352`) to its own file. Export it. Update the run detail page to import from the new location. Keep the same props interface.

#### 2. Smart Output for agent-task Steps
**File**: `new-ui/src/components/workflows/step-card.tsx`
**Changes**: When `step.nodeType === "agent-task"` (this is the only executor type that creates tasks — there are no aliases like "create-task" or "delegate-to-agent"), parse the output:

- **Only for completed/failed steps** (when `step.output` is not null — output is NULL while the task is still running/waiting):
  - Extract `taskId` from `step.output.taskId` → render as a clickable link badge: `<Link to={`/tasks/${taskId}`} className="text-primary hover:underline font-mono text-xs">→ {taskId.slice(0, 8)}</Link>` with a status badge if available
  - Extract `taskOutput` from `step.output.taskOutput` → render in a collapsible section (collapsed by default) with byte size in the toggle label: `"Show output (2.4 KB)"`. Use `JSON.stringify(taskOutput).length` for byte size, format with KB/MB.
  - Note: `taskOutput` may be a parsed JSON object or a raw string (the resume handler tries JSON.parse, falls back to string)
- For **waiting** agent-task steps (output is NULL): show "Task in progress" indicator without a task link. The task ID is not available in step data until completion.
- Show agent info: Look up `agentId` from the node config (`workflowNodes` prop). If present, render as `Agent: <Link to={`/agents/${agentId}`}>agentName or truncated ID</Link>`.

#### 3. Smart Output for Other Step Types
**File**: `new-ui/src/components/workflows/step-card.tsx`
**Changes**:
- For `script` / `raw-llm` steps: If output is a string, render as `<pre>` with mono font instead of JsonTree
- For all steps: If output is an object (not parsed above), use existing `JsonTree` but wrapped in a collapsible with byte size label, collapsed by default
- Add "Raw JSON" toggle at the bottom of every step card's expanded section — shows the full `step.output` as `JsonTree` when opened

#### 4. Show Diagnostics Warnings
**File**: `new-ui/src/components/workflows/step-card.tsx`
**Changes**: If `step.diagnostics` is present, parse it (it's a JSON string) and check for `unresolvedTokens`. If any exist, show a warning: `⚠ Diagnostics: N unresolved token(s)` with amber color, listing the token names.

#### 5. Show nextPort
**File**: `new-ui/src/components/workflows/step-card.tsx`
**Changes**: If `step.nextPort` is present and not `"default"`, show it as a badge in the step card metadata: `Port: {nextPort}`.

#### 6. Delete Orphaned Component
**File**: Delete `new-ui/src/components/workflows/step-detail-sheet.tsx`
**Changes**: Remove the file entirely. It's not imported anywhere.

#### 7. Update Run Detail Page
**File**: `new-ui/src/pages/workflow-runs/[id]/page.tsx`
**Changes**: Replace the inline `StepCard` with the imported one. Pass `workflowNodes` (from the workflow definition) as a prop so `StepCard` can look up node config for agent IDs and templates.

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `cd new-ui && pnpm exec tsc --noEmit`
- [x] Lint passes: `cd new-ui && pnpm lint`
- [x] No imports of deleted file: `grep -r "step-detail-sheet" new-ui/src/`
- [x] StepCard is exported from new location: `grep "export" new-ui/src/components/workflows/step-card.tsx`

#### Manual Verification:
- [ ] Completed agent-task step cards show a clickable task link badge (navigates to `/tasks/:id`)
- [ ] Waiting agent-task step cards show "Task in progress" without a link (output is NULL while running)
- [ ] Agent-task step cards show agent name/link when `config.agentId` is present
- [ ] Task output is collapsed by default with byte size label; expands on click
- [ ] Script/raw-llm steps with string output render as pre-formatted text
- [ ] "Raw JSON" toggle works on all step types
- [ ] Diagnostics warnings appear with amber styling when `unresolvedTokens` exist
- [ ] `nextPort` badge shows when port is non-default
- [ ] All existing step card functionality preserved (expand/collapse, click-to-highlight, graph interaction)

**Implementation Note**: After completing this phase, pause for manual confirmation. Create commit after verification passes.

### QA Spec (optional):

**Approach:** browser-automation
**Test Scenarios:**
- [ ] TC-1: Agent-task step with task link
  - Steps: 1. Navigate to a run with agent-task steps, 2. Expand a completed agent-task step, 3. Click the task link
  - Expected: Task link badge visible with truncated ID; clicking navigates to `/tasks/:taskId`
- [ ] TC-2: Collapsible output
  - Steps: 1. Expand an agent-task step, 2. Verify output section is collapsed with size label, 3. Click to expand
  - Expected: Shows "Show output (X.X KB)" toggle; expanding reveals the JSON content
- [ ] TC-3: Raw JSON fallback
  - Steps: 1. Expand any step, 2. Click "Raw JSON" toggle
  - Expected: Full output renders as JsonTree

---

## Phase 4: Structured Node Inspector

### Overview
Enhance the `NodeInspector` on the workflow detail page to show structured config fields by executor type instead of a single JSON dump. Agent-task nodes get a template text block, agent link, schema viewer, and badges. Other types get type-appropriate rendering with raw config as fallback.

### Changes Required:

#### 1. Agent-Task Config Rendering
**File**: `new-ui/src/pages/workflows/[id]/page.tsx` (NodeInspector section, lines 272-328)
**Changes**: When `node.type === "agent-task"` (the only agent-task executor type), parse `node.config` and render structured fields:

- **`config.template`**: Render as a styled text block with `bg-muted rounded-md p-3 font-mono text-xs whitespace-pre-wrap`. Highlight `{{interpolation}}` tokens with amber color.
- **`config.agentId`**: Render as `Agent: <Link to={`/agents/${agentId}`}>truncated ID</Link>`
- **`config.outputSchema`**: Render in a collapsible section with a JsonTree (collapsed by default)
- **`config.tags`**: Render as inline badges
- **`config.priority`**: Badge with value
- **`config.offerMode`**: Badge (`offer: true/false`)
- **`config.dir`**: Show as workspace path
- **`config.vcsRepo`**: Show as repo link text

#### 2. Script Config Rendering
**File**: `new-ui/src/pages/workflows/[id]/page.tsx`
**Changes**: When `node.type` is `"script"`, parse `config.command` as a code block and `config.timeout` as a badge.

#### 3. Raw-LLM Config Rendering
**File**: `new-ui/src/pages/workflows/[id]/page.tsx`
**Changes**: When `node.type` is `"raw-llm"`, render `config.prompt` as a text block and `config.model` as a badge.

#### 4. Node Inputs Display
**File**: `new-ui/src/pages/workflows/[id]/page.tsx`
**Changes**: If `node.inputs` is present (new field from Phase 1), show an "Inputs Mapping" section displaying the key → value mappings.

#### 5. Raw Config Fallback
**File**: `new-ui/src/pages/workflows/[id]/page.tsx`
**Changes**: After type-specific rendering, add a collapsed "Raw Configuration" toggle that shows the full `node.config` as `JsonTree`. For unknown node types, show only this fallback.

#### 6. Connections Section
**File**: `new-ui/src/pages/workflows/[id]/page.tsx`
**Changes**: Replace the plain `JsonTree` for `node.next` with a structured "Connections" section. For string next, show `Next: → {nodeLabel}`. For record next, show `Port "x": → {nodeLabel}` for each entry. Node labels resolved from the definition.

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `cd new-ui && pnpm exec tsc --noEmit`
- [x] Lint passes: `cd new-ui && pnpm lint`

#### Manual Verification:
- [ ] Agent-task node inspector shows template as styled text block (not JSON)
- [ ] `{{interpolation}}` tokens are highlighted in amber
- [ ] Agent ID renders as a clickable link to the agent page
- [ ] Output schema is in a collapsible section
- [ ] Tags and priority render as badges
- [ ] Script nodes show command as code block
- [ ] Unknown node types fall back to raw JSON
- [ ] "Raw Configuration" toggle works for all node types
- [ ] Connections section shows node labels instead of raw IDs

**Implementation Note**: After completing this phase, pause for manual confirmation. Create commit after verification passes.

### QA Spec (optional):

**Approach:** browser-automation
**Test Scenarios:**
- [ ] TC-1: Agent-task node inspector
  - Steps: 1. Navigate to a workflow with agent-task nodes, 2. Click an agent-task node in the graph, 3. Inspect the side panel
  - Expected: Template text block visible, agent link clickable, tags as badges, output schema collapsible
- [ ] TC-2: Raw config fallback
  - Steps: 1. Click any node, 2. Expand "Raw Configuration" section
  - Expected: Full config shown as JsonTree

---

## Phase 5: Workflow Detail Enhancements

### Overview
Add created-by agent link, workspace info, and version history tab to the workflow detail page.

### Changes Required:

#### 1. Created-By Agent Link
**File**: `new-ui/src/pages/workflows/[id]/page.tsx`
**Changes**: In the header section (after the description and before triggers), add a `Created by:` row. If `workflow.createdByAgentId` is present, render as `<Link to={`/agents/${id}`}>` with truncated ID (font-mono, text-primary). This follows the same pattern as `MetaRow` in the tasks detail page.

#### 2. Workspace Info
**File**: `new-ui/src/pages/workflows/[id]/page.tsx`
**Changes**: In the metadata area (near triggers/cooldown), add:
- `Dir: {workflow.dir}` if present — render in `font-mono text-xs`
- `Repo: {workflow.vcsRepo}` if present — render in `font-mono text-xs`

#### 3. Version History Tab
**File**: `new-ui/src/pages/workflows/[id]/page.tsx`
**Changes**: Add a third tab "Versions" alongside "Definition" and "Runs". When active, fetch versions using the existing `useWorkflowVersions` hook. Display as a vertical timeline/list:

- Each version shows: version number, created timestamp, change summary badge (if definition changed vs triggers changed, etc.)
- Version entries are expandable: show a JsonTree of the snapshot diff or the full snapshot
- The hook already exists at `new-ui/src/api/hooks/use-workflows.ts` — just needs UI

#### 4. Trigger Schema Display
**File**: `new-ui/src/pages/workflows/[id]/page.tsx`
**Changes**: In the `WorkflowMeta` section (lines 341-395), if `workflow.triggerSchema` is present, add a collapsible "Trigger Schema" section with a `JsonTree`.

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `cd new-ui && pnpm exec tsc --noEmit`
- [x] Lint passes: `cd new-ui && pnpm lint`

#### Manual Verification:
- [ ] Created-by agent link appears in workflow header; clicking navigates to agent page
- [ ] Workspace info (dir, vcsRepo) displays when present
- [ ] "Versions" tab appears and loads version history
- [ ] Version entries show version number and timestamp
- [ ] Version entries are expandable with snapshot content
- [ ] Trigger schema displays in a collapsible section when present
- [ ] Workflows without these optional fields don't show empty sections

**Implementation Note**: After completing this phase, pause for manual confirmation. Create commit after verification passes.

### QA Spec (optional):

**Approach:** browser-automation
**Test Scenarios:**
- [ ] TC-1: Version history tab
  - Steps: 1. Navigate to a workflow that has been updated, 2. Click "Versions" tab
  - Expected: Version timeline loads showing version entries with timestamps
- [ ] TC-2: Created-by agent
  - Steps: 1. Navigate to a workflow created by an agent, 2. Click the agent link in the header
  - Expected: Navigates to the agent detail page

---

## Phase 6: HITL & Approval Request Links

### Overview
For `human-in-the-loop` steps in workflow runs, show approval status and provide direct links to the approval request page. This requires parsing step output/context for approval request IDs.

### Changes Required:

#### 1. Detect HITL Steps
**File**: `new-ui/src/components/workflows/step-card.tsx`
**Changes**: Identify HITL steps by `step.nodeType === "human-in-the-loop"`. When detected, apply special rendering.

#### 2. Approval Request Link (Completed/Resolved Steps)
**File**: `new-ui/src/components/workflows/step-card.tsx`
**Changes**: For HITL steps where `step.output` is not null (i.e., the approval has been resolved), extract `step.output.requestId` — this is the `approval_requests.id`. Render as:

```tsx
<Link to={`/approval-requests/${requestId}`} className="text-primary hover:underline font-mono text-xs">
  → {requestId.slice(0, 8)}
</Link>
```

Follow the same pattern as task links in agent-task steps (Phase 3).

**Important data shape note**: `step.output` for resolved HITL steps is:
```typescript
{ requestId: string, status: "approved" | "rejected" | "timeout", responses: Record<string, unknown> | null }
```

#### 3. Waiting Steps (Output is NULL)
**File**: `new-ui/src/components/workflows/step-card.tsx`
**Changes**: When a HITL step has `step.status === "waiting"` and `step.output` is null, the approval request ID is NOT available in the step data (it lives only in the `approval_requests` table). For waiting steps:
- Show an amber "Awaiting approval" indicator with a pulsing dot
- Do NOT attempt to show a link to the approval request (we don't have the ID)
- Optionally: consider adding a future API endpoint to look up approval requests by step ID, but this is out of scope for this plan

#### 4. Approval Status Display
**File**: `new-ui/src/components/workflows/step-card.tsx`
**Changes**: For completed HITL steps (where `step.output` exists), show the approval outcome prominently:
- `step.output.status === "approved"` → emerald "Approved" badge
- `step.output.status === "rejected"` → red "Rejected" badge
- `step.output.status === "timeout"` → amber "Timed out" badge
- Also show `step.nextPort` (which is `"approved"`, `"rejected"`, or `"timeout"`) as context for which branch was taken

#### 5. HITL Config Display (Title & Questions)
**File**: `new-ui/src/components/workflows/step-card.tsx`
**Changes**: The HITL node config contains `title` (string) and `questions` (array of `{ id, type, label, description?, ... }`). Look up the node config from `workflowNodes` and display:
- `config.title` as a styled text block (similar to template rendering in Phase 4)
- `config.questions` as a list showing each question's label and type badge (e.g., "approval", "text", "single-select")
- This gives users context about what was asked without opening the approval request page

### Success Criteria:

#### Automated Verification:
- [x] TypeScript compiles: `cd new-ui && pnpm exec tsc --noEmit`
- [x] Lint passes: `cd new-ui && pnpm lint`

#### Manual Verification:
- [ ] Resolved HITL step cards show an approval request link badge (from `step.output.requestId`)
- [ ] Clicking the approval request link navigates to `/approval-requests/:id`
- [ ] Waiting HITL steps (where `step.output` is null) show "Awaiting approval" indicator without a link
- [ ] Completed HITL steps show approved/rejected/timeout badge matching `step.output.status`
- [ ] HITL title and questions from node config are displayed as styled content
- [ ] Non-HITL steps are unaffected

**Implementation Note**: After completing this phase, pause for manual confirmation. Create commit after verification passes.

### QA Spec (optional):

**Approach:** browser-automation
**Test Scenarios:**
- [ ] TC-1: Resolved HITL step with approval link
  - Steps: 1. Navigate to a run with a completed HITL step, 2. Expand the HITL step card, 3. Click approval request link
  - Expected: Link navigates to `/approval-requests/:id`, shows approved/rejected badge
- [ ] TC-2: Waiting HITL step (no output yet)
  - Steps: 1. Navigate to a running workflow with a pending HITL step, 2. Inspect the step card
  - Expected: Shows "Awaiting approval" with amber indicator, no approval request link (ID not available until resolution)
- [ ] TC-3: HITL config display
  - Steps: 1. Expand any HITL step card, 2. Check for title and questions display
  - Expected: Shows the approval title and question labels from node config

---

## Testing Strategy

**Per-phase**: Each phase has automated checks (TypeScript compile + Biome lint) and manual verification steps. The dashboard dev server (`cd new-ui && pnpm run dev`) is needed for manual testing.

**Cross-phase regressions**: After each phase, verify that previous phases' functionality still works:
- Phase 2+: Step cards still expand/collapse, graph interaction works
- Phase 3+: Back button still points to parent workflow
- Phase 4+: Step card smart rendering still works

**End-to-end manual verification after all phases**:
```bash
# Start the API server and UI
cd /Users/taras/Documents/code/agent-swarm
bun run start:http &
cd new-ui && pnpm run dev

# Test with real workflow data:
# 1. Navigate to /workflows — verify list loads
# 2. Click a workflow — verify definition tab, node inspector, metadata
# 3. Click "Versions" tab — verify version history loads
# 4. Click "Runs" tab — click a run — verify run detail page
# 5. Verify back button goes to parent workflow's runs tab
# 6. Verify workflow name is a clickable link
# 7. Verify trigger data section (if run has trigger data)
# 8. Verify step summary bar counts
# 9. Expand agent-task steps — verify task links, agent info, collapsible output
# 10. Check "Raw JSON" toggle on step cards
# 11. Verify diagnostics warnings on steps with unresolved tokens
# 12. Navigate to workflow detail — click an agent-task node — verify structured inspector
# 13. Verify created-by agent link in workflow header
# 14. If HITL steps exist — verify approval request links
```

## Executor Type Reference

All registered executor types (from `src/workflows/executors/registry.ts:61-78`):

| Type | Executor | Mode | Output Shape |
|------|----------|------|-------------|
| `agent-task` | AgentTaskExecutor | async | `{ taskId: string, taskOutput: unknown }` |
| `human-in-the-loop` | HumanInTheLoopExecutor | async | `{ requestId: string, status: "approved"\|"rejected"\|"timeout", responses: Record\|null }` |
| `property-match` | PropertyMatchExecutor | instant | — |
| `code-match` | CodeMatchExecutor | instant | — |
| `notify` | NotifyExecutor | instant | — |
| `raw-llm` | RawLlmExecutor | instant | — |
| `script` | ScriptExecutor | instant | — |
| `vcs` | VcsExecutor | instant | — |
| `validate` | ValidateExecutor | instant | — |

**Important**: Async executors (`agent-task`, `human-in-the-loop`) have `step.output = NULL` while the step is in `"waiting"` status. Output is only populated upon completion/resolution via the resume handler.

## References
- Research: `thoughts/taras/research/2026-03-26-workflow-run-ui-improvements.md`
- UI types: `new-ui/src/api/types.ts:400-535`
- Backend types: `src/types.ts:674-909`
- Backend DB mappers: `src/be/db.ts:5674-5710, 5892-5916, 5992-6029`
- Entity link pattern: `new-ui/src/pages/approval-requests/[id]/page.tsx:207-218`
- CollapsibleCard pattern: `new-ui/src/pages/tasks/[id]/page.tsx:185-222`
- StatusBadge component: `new-ui/src/components/shared/status-badge.tsx`
- Agent-task executor: `src/workflows/executors/agent-task.ts`
- HITL executor: `src/workflows/executors/human-in-the-loop.ts`
- Resume handler (output construction): `src/workflows/resume.ts:106-119`
- Version history hook: `new-ui/src/api/hooks/use-workflows.ts:82-88`

---

## Review Errata

_Reviewed: 2026-03-26 by Claude_

### Resolved
- [x] Phase 3 & 4 listed `"create-task"` and `"delegate-to-agent"` as agent-task executor types — these don't exist. Fixed to only reference `"agent-task"`.
- [x] Phase 6 used `approvalRequestId` — actual field is `step.output.requestId`. Fixed.
- [x] Phase 6 assumed approval request ID is always available — for waiting steps, `step.output` is NULL. Added explicit handling for pending vs resolved states.
- [x] Phase 3 didn't mention that waiting agent-task steps have NULL output. Added "Task in progress" indicator for waiting steps.
- [x] Phase 6 referenced "prompt text" — actual HITL config has `title` (string) and `questions` (array). Fixed to reference correct field names.
- [x] Frontmatter missing `planner` field — added.
- [x] Added Executor Type Reference table with output shapes and async behavior note.
