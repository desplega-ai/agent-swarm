import type { App } from "@slack/bolt";
import { getAllAgents, getAllTasks } from "../be/db";

export function registerCommandHandler(app: App): void {
  app.command("/agent-swarm-status", async ({ ack, respond }) => {
    await ack();

    const agents = getAllAgents();
    const tasks = getAllTasks({ status: "in_progress" });

    const statusEmoji: Record<string, string> = {
      idle: ":white_circle:",
      busy: ":large_blue_circle:",
      offline: ":black_circle:",
    };

    const agentLines = agents.map((agent) => {
      const emoji = statusEmoji[agent.status] || ":question:";
      const role = agent.isLead ? " (Lead)" : "";
      const activeTask = tasks.find((t) => t.agentId === agent.id);
      const taskInfo = activeTask ? ` - Working on: ${activeTask.task.slice(0, 50)}...` : "";
      return `${emoji} *${agent.name}*${role}: ${agent.status}${taskInfo}`;
    });

    const summary = {
      total: agents.length,
      idle: agents.filter((a) => a.status === "idle").length,
      busy: agents.filter((a) => a.status === "busy").length,
      offline: agents.filter((a) => a.status === "offline").length,
    };

    await respond({
      response_type: "ephemeral",
      blocks: [
        {
          type: "header",
          text: { type: "plain_text", text: "Agent Swarm Status" },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Summary:* ${summary.total} agents (${summary.idle} idle, ${summary.busy} busy, ${summary.offline} offline)`,
          },
        },
        {
          type: "divider",
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: agentLines.join("\n") || "_No agents registered_",
          },
        },
      ],
    });
  });

  app.command("/agent-swarm-help", async ({ ack, respond }) => {
    await ack();

    await respond({
      response_type: "ephemeral",
      blocks: [
        {
          type: "header",
          text: { type: "plain_text", text: "Agent Swarm Help" },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*How to assign tasks:*
• Mention an agent by name: \`Hey Alpha, can you review this code?\`
• Use explicit ID: \`swarm#<uuid> please analyze the logs\`
• Broadcast to all: \`swarm#all status report please\`
• Mention the bot: \`@agent-swarm help me\` (routes to lead agent)

*Commands:*
• \`/agent-swarm-status\` - Show all agents and their current status
• \`/agent-swarm-help\` - Show this help message`,
          },
        },
      ],
    });
  });
}
