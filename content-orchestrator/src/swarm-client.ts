import { CONFIG } from "./config.js";
import type { TaskResponse } from "./types.js";

export class SwarmClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(
    baseUrl: string = CONFIG.SWARM_API_URL,
    apiKey: string = CONFIG.API_KEY,
  ) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
  }

  /** Create a task and return the task ID */
  async createTask(opts: {
    task: string;
    agentId?: string;
    taskType?: string;
    tags?: string[];
    priority?: number;
  }): Promise<string> {
    const resp = await fetch(`${this.baseUrl}/api/tasks`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        task: opts.task,
        agentId: opts.agentId,
        source: "api",
        taskType: opts.taskType ?? "implementation",
        tags: opts.tags ?? [],
        priority: opts.priority ?? 50,
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Failed to create task: ${resp.status} ${text}`);
    }

    const data = (await resp.json()) as { task: { id: string } };
    return data.task.id;
  }

  /** Get task details by ID */
  async getTaskDetails(taskId: string): Promise<TaskResponse> {
    const resp = await fetch(`${this.baseUrl}/api/tasks/${taskId}`, {
      headers: this.headers(),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Failed to get task ${taskId}: ${resp.status} ${text}`);
    }

    const data = (await resp.json()) as { task: TaskResponse };
    return data.task;
  }

  /**
   * Create a task and poll until completion or timeout.
   * Uses exponential backoff for polling.
   */
  async sendTaskAndWait(
    agentId: string,
    taskDescription: string,
    opts: {
      timeoutMs?: number;
      tags?: string[];
      taskType?: string;
    } = {},
  ): Promise<TaskResponse> {
    const timeoutMs = opts.timeoutMs ?? CONFIG.LLM_TASK_TIMEOUT_MS;

    if (CONFIG.DRY_RUN) {
      console.log(`[dry-run] Would send task to agent ${agentId}`);
      console.log(`[dry-run] Task: ${taskDescription.slice(0, 200)}...`);
      return {
        id: "dry-run-task-id",
        agentId,
        task: taskDescription,
        status: "completed",
        output: getDryRunOutput(taskDescription),
      };
    }

    const taskId = await this.createTask({
      task: taskDescription,
      agentId,
      taskType: opts.taskType,
      tags: opts.tags,
    });

    console.log(`[swarm] Created task ${taskId} for agent ${agentId}`);

    const deadline = Date.now() + timeoutMs;
    let pollInterval: number = CONFIG.POLL_INITIAL_MS;

    while (Date.now() < deadline) {
      await sleep(pollInterval);

      const task = await this.getTaskDetails(taskId);

      if (task.status === "completed") {
        console.log(`[swarm] Task ${taskId} completed`);
        return task;
      }

      if (task.status === "failed") {
        console.log(
          `[swarm] Task ${taskId} failed: ${task.failureReason ?? "unknown"}`,
        );
        return task;
      }

      // Exponential backoff
      pollInterval = Math.min(
        pollInterval * CONFIG.POLL_BACKOFF_FACTOR,
        CONFIG.POLL_MAX_MS,
      );
    }

    // Timeout: try to cancel and return failure
    console.log(`[swarm] Task ${taskId} timed out after ${timeoutMs}ms`);
    try {
      await fetch(`${this.baseUrl}/api/tasks/${taskId}/cancel`, {
        method: "POST",
        headers: this.headers(),
      });
    } catch {
      // Best-effort cancel
    }

    return {
      id: taskId,
      agentId,
      task: taskDescription,
      status: "failed",
      failureReason: `Timed out after ${timeoutMs}ms`,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Generate context-aware mock output for dry-run mode */
function getDryRunOutput(taskDescription: string): string {
  const lower = taskDescription.toLowerCase();

  // Writer task (has "write a blog post")
  if (lower.includes("write a blog post")) {
    const slug = `dry-run-test-${Date.now().toString(36)}`;
    return `import BlogArticle from "@/components/BlogArticle";
import { Metadata } from "next";

export const metadata: Metadata = {
  title: "Dry Run Test: Automated Testing Patterns",
  description: "A test blog post generated in dry-run mode",
  keywords: "testing, automation, dry-run",
};

export default function Page() {
  return (
    <BlogArticle
      title="Dry Run Test: Automated Testing Patterns"
      series="Foundation"
      date="2026-03-16"
    >
      <h2>Introduction</h2>
      <p>This is a dry-run test post.</p>
    </BlogArticle>
  );
}
METADATA: {"slug": "${slug}", "image_filename": "${slug}"}`;
  }

  // Image prompt extraction
  if (lower.includes("extract a meme") || lower.includes("image prompt")) {
    return JSON.stringify({
      template: "drake",
      text0: "Writing tests manually",
      text1: "Automated testing with CI/CD",
      text2: "",
      text3: "",
    });
  }

  // Litmus test / review
  if (lower.includes("litmus test") || lower.includes("review the following")) {
    return JSON.stringify({
      approved: true,
      scores: {
        depth: 8,
        relevance: 8,
        specificity: 7,
        actionability: 7,
        uniqueness: 8,
      },
      totalScore: 38,
      rejection_reasons: [],
      improvement_suggestions: [],
    });
  }

  // Default: research/topic task
  return JSON.stringify({
    topic_title: "Dry Run Test Topic: Automated Testing Patterns",
    description: "A placeholder topic for dry-run testing of the orchestrator pipeline",
    target_audience: "QA Engineers",
    key_takeaways: ["Testing patterns", "CI/CD automation", "Quality gates"],
    series: "Foundation",
  });
}
