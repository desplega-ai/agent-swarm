import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  assignTaskToEpic,
  closeDb,
  createAgent,
  createEpic,
  createTaskExtended,
  deleteEpic,
  getChannelById,
  getEpicById,
  getEpicByName,
  getEpics,
  getEpicTaskStats,
  getEpicWithProgress,
  getTasksByEpicId,
  initDb,
  unassignTaskFromEpic,
  updateEpic,
} from "../be/db";

const TEST_DB_PATH = "./test-epics.sqlite";

describe("Epics Integration", () => {
  let testAgent: { id: string; name: string };
  let leadAgent: { id: string; name: string };

  beforeAll(async () => {
    // Clean up any existing test database
    try {
      await unlink(TEST_DB_PATH);
    } catch {
      // File doesn't exist, that's fine
    }

    // Initialize test database
    initDb(TEST_DB_PATH);

    // Create test agents
    testAgent = createAgent({
      name: "Test Epic Agent",
      isLead: false,
      status: "idle",
    });

    leadAgent = createAgent({
      name: "Lead Agent",
      isLead: true,
      status: "idle",
    });
  });

  afterAll(async () => {
    // Close database
    closeDb();

    // Clean up test database file
    try {
      await unlink(TEST_DB_PATH);
      await unlink(`${TEST_DB_PATH}-wal`);
      await unlink(`${TEST_DB_PATH}-shm`);
    } catch {
      // Files may not exist
    }
  });

  describe("Epic CRUD Operations", () => {
    test("should create an epic with required fields only", () => {
      const epic = createEpic({
        name: "test-epic-basic",
        goal: "Test the basic epic creation",
      });

      expect(epic.id).toBeDefined();
      expect(epic.name).toBe("test-epic-basic");
      expect(epic.goal).toBe("Test the basic epic creation");
      expect(epic.status).toBe("draft");
      expect(epic.priority).toBe(50);
      expect(epic.tags).toEqual([]);
    });

    test("should create an epic with all fields", () => {
      const epic = createEpic({
        name: "test-epic-full",
        goal: "Test full epic creation",
        description: "A comprehensive test epic",
        prd: "## Product Requirements\n- Feature A\n- Feature B",
        plan: "## Implementation Plan\n1. Step 1\n2. Step 2",
        priority: 80,
        tags: ["feature", "q1"],
        createdByAgentId: testAgent.id,
        leadAgentId: leadAgent.id,
        researchDocPath: "/thoughts/research/test.md",
        planDocPath: "/thoughts/plans/test.md",
        githubRepo: "desplega-ai/agent-swarm",
        githubMilestone: "v1.0",
      });

      expect(epic.id).toBeDefined();
      expect(epic.name).toBe("test-epic-full");
      expect(epic.goal).toBe("Test full epic creation");
      expect(epic.description).toBe("A comprehensive test epic");
      expect(epic.prd).toContain("Product Requirements");
      expect(epic.plan).toContain("Implementation Plan");
      expect(epic.priority).toBe(80);
      expect(epic.tags).toEqual(["feature", "q1"]);
      expect(epic.createdByAgentId).toBe(testAgent.id);
      expect(epic.leadAgentId).toBe(leadAgent.id);
      expect(epic.researchDocPath).toBe("/thoughts/research/test.md");
      expect(epic.githubRepo).toBe("desplega-ai/agent-swarm");
    });

    test("should auto-create a channel when creating an epic", () => {
      // Create epic - channel should be auto-created
      const epic = createEpic({
        name: "test-epic-auto-channel",
        goal: "Test epic with auto-created channel",
        createdByAgentId: testAgent.id,
      });

      expect(epic.id).toBeDefined();
      expect(epic.channelId).toBeDefined();

      // Verify the auto-created channel exists
      const channel = getChannelById(epic.channelId!);
      expect(channel).not.toBeNull();
      expect(channel?.name).toBe("epic-test-epic-auto-channel");
      expect(channel?.description).toBe("Channel for epic: test-epic-auto-channel");

      // Verify epic can be retrieved with channelId
      const retrieved = getEpicById(epic.id);
      expect(retrieved?.channelId).toBe(epic.channelId);
    });

    test("should retrieve epic by ID", () => {
      const created = createEpic({
        name: "test-get-by-id",
        goal: "Test retrieval by ID",
      });

      const retrieved = getEpicById(created.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(created.id);
      expect(retrieved?.name).toBe("test-get-by-id");
    });

    test("should retrieve epic by name", () => {
      const created = createEpic({
        name: "test-get-by-name",
        goal: "Test retrieval by name",
      });

      const retrieved = getEpicByName("test-get-by-name");
      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(created.id);
    });

    test("should list epics with filters", () => {
      // Create epics with different statuses
      const draft = createEpic({
        name: "filter-draft",
        goal: "Draft epic",
      });

      const active = createEpic({
        name: "filter-active",
        goal: "Active epic",
      });
      updateEpic(active.id, { status: "active" });

      // List all
      const all = getEpics();
      expect(all.length).toBeGreaterThan(0);

      // Filter by status
      const drafts = getEpics({ status: "draft" });
      expect(drafts.some((e) => e.id === draft.id)).toBe(true);

      const actives = getEpics({ status: "active" });
      expect(actives.some((e) => e.id === active.id)).toBe(true);

      // Search
      const searched = getEpics({ search: "filter" });
      expect(searched.length).toBeGreaterThanOrEqual(2);
    });

    test("should update epic", () => {
      const epic = createEpic({
        name: "test-update",
        goal: "Original goal",
      });

      const updated = updateEpic(epic.id, {
        goal: "Updated goal",
        description: "Added description",
        status: "active",
        priority: 90,
        tags: ["updated", "test"],
      });

      expect(updated).not.toBeNull();
      expect(updated?.goal).toBe("Updated goal");
      expect(updated?.description).toBe("Added description");
      expect(updated?.status).toBe("active");
      expect(updated?.priority).toBe(90);
      expect(updated?.tags).toEqual(["updated", "test"]);
      expect(updated?.startedAt).toBeDefined(); // Should be set when status becomes active
    });

    test("should set completedAt when completing epic", () => {
      const epic = createEpic({
        name: "test-complete",
        goal: "Test completion",
      });

      updateEpic(epic.id, { status: "active" });
      const completed = updateEpic(epic.id, { status: "completed" });

      expect(completed?.completedAt).toBeDefined();
    });

    test("should delete epic and unassign tasks", () => {
      const epic = createEpic({
        name: "test-delete",
        goal: "Test deletion",
      });

      // Create a task associated with the epic
      const task = createTaskExtended("Task for deletion test", {
        epicId: epic.id,
      });

      expect(task.epicId).toBe(epic.id);

      // Delete the epic
      const deleted = deleteEpic(epic.id);
      expect(deleted).toBe(true);

      // Epic should be gone
      expect(getEpicById(epic.id)).toBeNull();

      // Task should still exist but without epicId
      const taskAfter = getTasksByEpicId(epic.id);
      expect(taskAfter.length).toBe(0);
    });
  });

  describe("Epic Task Association", () => {
    test("should create task with epicId", () => {
      const epic = createEpic({
        name: "test-task-epic",
        goal: "Test task association",
      });

      const task = createTaskExtended("Task within epic", {
        epicId: epic.id,
        tags: ["test"],
      });

      expect(task.epicId).toBe(epic.id);

      const tasks = getTasksByEpicId(epic.id);
      expect(tasks.length).toBe(1);
      expect(tasks[0].id).toBe(task.id);
    });

    test("should assign existing task to epic", () => {
      const epic = createEpic({
        name: "test-assign-task",
        goal: "Test task assignment",
      });

      // Create task without epic
      const task = createTaskExtended("Standalone task", {});
      expect(task.epicId).toBeUndefined();

      // Assign to epic
      const assigned = assignTaskToEpic(task.id, epic.id);
      expect(assigned).not.toBeNull();
      expect(assigned?.epicId).toBe(epic.id);

      // Verify
      const tasks = getTasksByEpicId(epic.id);
      expect(tasks.length).toBe(1);
    });

    test("should unassign task from epic", () => {
      const epic = createEpic({
        name: "test-unassign-task",
        goal: "Test task unassignment",
      });

      const task = createTaskExtended("Task to unassign", {
        epicId: epic.id,
      });

      const unassigned = unassignTaskFromEpic(task.id);
      expect(unassigned).not.toBeNull();
      expect(unassigned?.epicId).toBeUndefined();

      const tasks = getTasksByEpicId(epic.id);
      expect(tasks.length).toBe(0);
    });
  });

  describe("Epic Progress Tracking", () => {
    test("should calculate task stats correctly", () => {
      const epic = createEpic({
        name: "test-progress-stats",
        goal: "Test progress calculation",
      });

      // Create tasks with different statuses
      // Task without agentId starts as "unassigned"
      createTaskExtended("Unassigned task", { epicId: epic.id });
      // Task with agentId starts as "pending"
      const inProgress = createTaskExtended("In progress task", {
        epicId: epic.id,
        agentId: testAgent.id,
      });
      const completed = createTaskExtended("Completed task", {
        epicId: epic.id,
        agentId: testAgent.id,
      });

      // Update statuses
      const db = require("../be/db");
      db.startTask(inProgress.id);
      db.startTask(completed.id);
      db.completeTask(completed.id, "Done!");

      const stats = getEpicTaskStats(epic.id);
      expect(stats.total).toBe(3);
      expect(stats.completed).toBe(1);
      expect(stats.inProgress).toBe(1);
      expect(stats.unassigned).toBe(1);
    });

    test("should calculate progress percentage", () => {
      const epic = createEpic({
        name: "test-progress-percentage",
        goal: "Test progress percentage",
      });

      // Create tasks
      const t1 = createTaskExtended("Task 1", { epicId: epic.id, agentId: testAgent.id });
      const _t2 = createTaskExtended("Task 2", { epicId: epic.id, agentId: testAgent.id });

      // Complete one task
      const db = require("../be/db");
      db.startTask(t1.id);
      db.completeTask(t1.id, "Done!");

      const epicWithProgress = getEpicWithProgress(epic.id);
      expect(epicWithProgress).not.toBeNull();
      expect(epicWithProgress?.progress).toBe(50); // 1/2 = 50%
    });

    test("should return 0 progress for epic with no tasks", () => {
      const epic = createEpic({
        name: "test-empty-progress",
        goal: "Test empty epic progress",
      });

      const epicWithProgress = getEpicWithProgress(epic.id);
      expect(epicWithProgress?.progress).toBe(0);
      expect(epicWithProgress?.taskStats.total).toBe(0);
    });
  });
});
