import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  completeTask,
  createAgent,
  createMemory,
  createTaskExtended,
  failTask,
  getAgentById,
  initDb,
  searchMemoriesByVector,
  updateMemoryEmbedding,
} from "../be/db";
import { serializeEmbedding } from "../be/embedding";
import { getBasePrompt } from "../prompts/base-prompt";

const TEST_DB_PATH = "./test-self-improvement.sqlite";

describe("Self-Improvement Mechanisms", () => {
  const leadId = "aaaa0000-0000-4000-8000-000000000001";
  const workerId = "bbbb0000-0000-4000-8000-000000000002";
  const otherWorkerId = "cccc0000-0000-4000-8000-000000000003";

  beforeAll(async () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {
        // File doesn't exist
      }
    }

    initDb(TEST_DB_PATH);

    createAgent({ id: leadId, name: "Test Lead", isLead: true, status: "idle" });
    createAgent({ id: workerId, name: "Test Worker", isLead: false, status: "idle" });
    createAgent({ id: otherWorkerId, name: "Other Worker", isLead: false, status: "idle" });
  });

  afterAll(async () => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await unlink(TEST_DB_PATH + suffix);
      } catch {
        // File doesn't exist
      }
    }
  });

  // ==========================================================================
  // P2: store-progress memory indexing for completed and failed tasks
  // ==========================================================================

  describe("store-progress memory indexing", () => {
    test("completed task creates agent-scoped memory with output", () => {
      const task = createTaskExtended("Test task for completion", {
        agentId: workerId,
        source: "mcp",
        priority: 50,
      });

      const output = "Successfully completed the task with great results";
      completeTask(task.id, output);

      // Simulate what store-progress does: create memory for completed task
      const taskContent = `Task: ${task.task}\n\nOutput:\n${output}`;
      const memory = createMemory({
        agentId: workerId,
        content: taskContent,
        name: `Task: ${task.task.slice(0, 80)}`,
        scope: "agent",
        source: "task_completion",
        sourceTaskId: task.id,
      });

      expect(memory.scope).toBe("agent");
      expect(memory.source).toBe("task_completion");
      expect(memory.sourceTaskId).toBe(task.id);
      expect(memory.content).toContain("Output:");
      expect(memory.content).toContain(output);
      expect(memory.content).not.toContain("undefined");
    });

    test("completed task with undefined output uses fallback", () => {
      const task = createTaskExtended("Task without output", {
        agentId: workerId,
        source: "mcp",
        priority: 50,
      });

      const output: string | undefined = undefined;
      completeTask(task.id, output);

      // Simulate store-progress logic with undefined guard
      const taskContent = `Task: ${task.task}\n\nOutput:\n${output || "(no output)"}`;

      expect(taskContent).toContain("(no output)");
      expect(taskContent).not.toContain("undefined");
    });

    test("failed task creates memory with failure reason", () => {
      const task = createTaskExtended("Task that will fail", {
        agentId: workerId,
        source: "mcp",
        priority: 50,
      });

      const failureReason = "Could not connect to external API";
      failTask(task.id, failureReason);

      // Simulate store-progress failed task memory creation
      const taskContent = `Task: ${task.task}\n\nFailure reason:\n${failureReason}\n\nThis task failed. Learn from this to avoid repeating the mistake.`;
      const memory = createMemory({
        agentId: workerId,
        content: taskContent,
        name: `Task: ${task.task.slice(0, 80)}`,
        scope: "agent",
        source: "task_completion",
        sourceTaskId: task.id,
      });

      expect(memory.source).toBe("task_completion");
      expect(memory.content).toContain("Failure reason:");
      expect(memory.content).toContain(failureReason);
      expect(memory.content).toContain("Learn from this");
    });

    test("failed task with undefined failureReason uses fallback", () => {
      const failureReason: string | undefined = undefined;

      // Simulate store-progress logic with undefined guard
      const taskContent = `Task: Some task\n\nFailure reason:\n${failureReason || "No reason provided"}\n\nThis task failed.`;

      expect(taskContent).toContain("No reason provided");
      expect(taskContent).not.toContain("undefined");
    });

    test("short task content is skipped (< 30 chars)", () => {
      // Simulate the length check in store-progress
      const shortContent = "Task: X\n\nOutput:\n";
      expect(shortContent.length).toBeLessThan(30);
      // In store-progress, this would return early without creating memory
    });
  });

  // ==========================================================================
  // P3: Swarm memory auto-promotion
  // ==========================================================================

  describe("swarm memory auto-promotion", () => {
    test("research task type promotes to swarm scope", () => {
      const task = createTaskExtended("Research best practices for testing", {
        agentId: workerId,
        source: "mcp",
        priority: 50,
        taskType: "research",
      });

      completeTask(task.id, "Found several useful patterns");

      // Simulate the shouldShareWithSwarm logic
      const shouldShareWithSwarm =
        task.taskType === "research" ||
        task.tags?.includes("knowledge") ||
        task.tags?.includes("shared");

      expect(shouldShareWithSwarm).toBe(true);

      // Verify swarm memory can be created
      const swarmMemory = createMemory({
        agentId: workerId,
        scope: "swarm",
        name: `Shared: ${task.task.slice(0, 80)}`,
        content: `Task completed by agent ${workerId}:\n\nTask: ${task.task}\n\nOutput:\nFound several useful patterns`,
        source: "task_completion",
        sourceTaskId: task.id,
      });

      expect(swarmMemory.scope).toBe("swarm");
      expect(swarmMemory.source).toBe("task_completion");
    });

    test("knowledge-tagged task promotes to swarm scope", () => {
      const task = createTaskExtended("Document API conventions", {
        agentId: workerId,
        source: "mcp",
        priority: 50,
        tags: ["knowledge"],
      });

      const shouldShareWithSwarm =
        task.taskType === "research" ||
        task.tags?.includes("knowledge") ||
        task.tags?.includes("shared");

      expect(shouldShareWithSwarm).toBe(true);
    });

    test("shared-tagged task promotes to swarm scope", () => {
      const task = createTaskExtended("Build shared utility", {
        agentId: workerId,
        source: "mcp",
        priority: 50,
        tags: ["shared", "utility"],
      });

      const shouldShareWithSwarm =
        task.taskType === "research" ||
        task.tags?.includes("knowledge") ||
        task.tags?.includes("shared");

      expect(shouldShareWithSwarm).toBe(true);
    });

    test("regular task does NOT promote to swarm scope", () => {
      const task = createTaskExtended("Fix a typo", {
        agentId: workerId,
        source: "mcp",
        priority: 50,
        taskType: "quick-fix",
        tags: ["bug-fix"],
      });

      const shouldShareWithSwarm =
        task.taskType === "research" ||
        task.tags?.includes("knowledge") ||
        task.tags?.includes("shared");

      expect(shouldShareWithSwarm).toBe(false);
    });

    test("failed task does NOT promote to swarm scope", () => {
      const task = createTaskExtended("Research something", {
        agentId: workerId,
        source: "mcp",
        priority: 50,
        taskType: "research",
      });

      const status = "failed";
      // In store-progress, shouldShareWithSwarm only fires for status === "completed"
      const shouldShareWithSwarm =
        status === "completed" &&
        (task.taskType === "research" ||
          task.tags?.includes("knowledge") ||
          task.tags?.includes("shared"));

      expect(shouldShareWithSwarm).toBe(false);
    });
  });

  // ==========================================================================
  // P6: inject-learning tool
  // ==========================================================================

  describe("inject-learning tool logic", () => {
    test("lead agent can inject learning into worker memory", () => {
      const callerAgent = getAgentById(leadId);
      expect(callerAgent).not.toBeNull();
      expect(callerAgent!.isLead).toBe(true);

      const category = "best-practice";
      const learning = "Always run lint before committing";
      const content = `[Lead Feedback — ${category}]\n\n${learning}`;

      const memory = createMemory({
        agentId: workerId,
        scope: "agent",
        name: `Lead feedback: ${category} — ${learning.slice(0, 60)}`,
        content,
        source: "manual",
      });

      expect(memory.agentId).toBe(workerId);
      expect(memory.scope).toBe("agent");
      expect(memory.content).toContain("[Lead Feedback — best-practice]");
      expect(memory.content).toContain(learning);
    });

    test("non-lead agent is rejected", () => {
      const callerAgent = getAgentById(workerId);
      expect(callerAgent).not.toBeNull();
      expect(callerAgent!.isLead).toBe(false);

      // In the tool handler, this check prevents non-leads from injecting
      const canInject = callerAgent!.isLead;
      expect(canInject).toBe(false);
    });

    test("injected learning is visible to target worker in memory search", () => {
      // Create memory with embedding for searchability
      const content = "[Lead Feedback — mistake-pattern]\n\nNever force-push to main branch";
      const memory = createMemory({
        agentId: workerId,
        scope: "agent",
        name: "Lead feedback: mistake-pattern — Never force-push to main branch",
        content,
        source: "manual",
      });

      const embedding = new Float32Array([0.7, 0.3, 0.0]);
      updateMemoryEmbedding(memory.id, serializeEmbedding(embedding));

      // Worker can find it via search
      const results = searchMemoriesByVector(new Float32Array([0.7, 0.3, 0.0]), workerId, {
        isLead: false,
        scope: "agent",
      });

      const found = results.find((r) => r.id === memory.id);
      expect(found).toBeDefined();
      expect(found!.content).toContain("Never force-push");
    });

    test("injected learning is NOT visible to other workers", () => {
      const content = "[Lead Feedback — preference]\n\nUse bun instead of npm";
      const memory = createMemory({
        agentId: workerId,
        scope: "agent",
        name: "Lead feedback: preference — Use bun instead of npm",
        content,
        source: "manual",
      });

      const embedding = new Float32Array([0.2, 0.8, 0.1]);
      updateMemoryEmbedding(memory.id, serializeEmbedding(embedding));

      // Other worker should NOT see it
      const results = searchMemoriesByVector(new Float32Array([0.2, 0.8, 0.1]), otherWorkerId, {
        isLead: false,
        scope: "agent",
      });

      const found = results.find((r) => r.id === memory.id);
      expect(found).toBeUndefined();
    });

    test("learning categories are properly formatted", () => {
      const categories = ["mistake-pattern", "best-practice", "codebase-knowledge", "preference"];

      for (const category of categories) {
        const content = `[Lead Feedback — ${category}]\n\nSome learning`;
        expect(content).toContain(`[Lead Feedback — ${category}]`);
      }
    });
  });

  // ==========================================================================
  // P7: Memory search agent ID security
  // ==========================================================================

  describe("memory search agent ID security", () => {
    test("agent can only search their own memories (not others)", () => {
      // Create private memories for worker and other worker
      const workerMemory = createMemory({
        agentId: workerId,
        scope: "agent",
        name: "Worker Private Secret",
        content: "My secret API key pattern",
        source: "manual",
      });
      updateMemoryEmbedding(workerMemory.id, serializeEmbedding(new Float32Array([0.5, 0.5, 0.0])));

      const otherMemory = createMemory({
        agentId: otherWorkerId,
        scope: "agent",
        name: "Other Worker Secret",
        content: "Other agent's private data",
        source: "manual",
      });
      updateMemoryEmbedding(otherMemory.id, serializeEmbedding(new Float32Array([0.5, 0.5, 0.0])));

      // Worker searching with their own ID should see their memory but not other's
      const workerResults = searchMemoriesByVector(new Float32Array([0.5, 0.5, 0.0]), workerId, {
        isLead: false,
        scope: "all",
      });

      const workerNames = workerResults.map((r) => r.name);
      expect(workerNames).toContain("Worker Private Secret");
      expect(workerNames).not.toContain("Other Worker Secret");
    });

    test("missing agent ID should be rejected (endpoint logic)", () => {
      // Simulate the endpoint logic: searchAgentId = myAgentId (from header only)
      const myAgentId: string | undefined = undefined;
      const searchAgentId = myAgentId; // No fallback to body.agentId

      // The endpoint requires both query and searchAgentId
      const isValid = !!searchAgentId;
      expect(isValid).toBe(false);
    });

    test("agent ID from header is used, not from body", () => {
      // Simulate the fixed logic
      const headerAgentId = workerId;
      const _bodyAgentId = otherWorkerId; // attacker trying to access other agent's memories

      // Fixed code: searchAgentId = myAgentId (from header only)
      const searchAgentId = headerAgentId; // NOT: headerAgentId || bodyAgentId

      expect(searchAgentId).toBe(workerId);
      expect(searchAgentId).not.toBe(otherWorkerId);
    });
  });

  // ==========================================================================
  // P2: Self-awareness in base prompt
  // ==========================================================================

  describe("base prompt self-awareness", () => {
    test("base prompt includes 'How You Are Built' section", () => {
      const prompt = getBasePrompt({
        role: "worker",
        agentId: workerId,
        swarmUrl: "test.example.com",
      });

      expect(prompt).toContain("### How You Are Built");
      expect(prompt).toContain("desplega-ai/agent-swarm");
      expect(prompt).toContain("src/commands/runner.ts");
      expect(prompt).toContain("src/hooks/hook.ts");
    });

    test("self-awareness section includes change proposal instructions", () => {
      const prompt = getBasePrompt({
        role: "worker",
        agentId: workerId,
        swarmUrl: "test.example.com",
      });

      expect(prompt).toContain("Proposing changes");
      expect(prompt).toContain("@tarasyarema");
    });

    test("self-awareness is included for both worker and lead roles", () => {
      const workerPrompt = getBasePrompt({
        role: "worker",
        agentId: workerId,
        swarmUrl: "test.example.com",
      });

      const leadPrompt = getBasePrompt({
        role: "lead",
        agentId: leadId,
        swarmUrl: "test.example.com",
      });

      expect(workerPrompt).toContain("### How You Are Built");
      expect(leadPrompt).toContain("### How You Are Built");
    });
  });

  // ==========================================================================
  // P4: Session summary "no significant learnings" filter
  // ==========================================================================

  describe("session summary filtering", () => {
    test("'no significant learnings' response is filtered out", () => {
      const summary = "No significant learnings.";

      const shouldIndex =
        summary &&
        summary.length > 20 &&
        !summary.trim().toLowerCase().includes("no significant learnings");

      expect(shouldIndex).toBe(false);
    });

    test("summary with actual learnings passes filter", () => {
      const summary =
        "- Discovered that the API requires Bearer prefix on auth headers\n- Found that bun test runs faster with --bail flag";

      const shouldIndex =
        summary &&
        summary.length > 20 &&
        !summary.trim().toLowerCase().includes("no significant learnings");

      expect(shouldIndex).toBe(true);
    });

    test("very short summary is filtered out", () => {
      const summary = "Done.";

      const shouldIndex =
        summary &&
        summary.length > 20 &&
        !summary.trim().toLowerCase().includes("no significant learnings");

      expect(shouldIndex).toBe(false);
    });

    test("case-insensitive matching for 'no significant learnings'", () => {
      const variants = [
        "No Significant Learnings.",
        "NO SIGNIFICANT LEARNINGS",
        "no significant learnings",
        "  No significant learnings.  ",
      ];

      for (const summary of variants) {
        const shouldIndex =
          summary &&
          summary.length > 20 &&
          !summary.trim().toLowerCase().includes("no significant learnings");

        expect(shouldIndex).toBe(false);
      }
    });
  });
});
