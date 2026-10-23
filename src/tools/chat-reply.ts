import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { getAgentCurrentTask, getTaskById } from "@/be/db";
import { errorMessage } from "@/integrations/chat-sdk/logger";
import {
  ChatAdapterUnavailableError,
  postChatMessage,
  unsentFilesSummary,
} from "@/integrations/chat-sdk/outbound";
import { resolveChatAttachmentRefs } from "@/integrations/chat-sdk/outbound-files";
import { chatThreadOfContextKey } from "@/tasks/context-key";
import { chatAttachmentsSchema } from "@/tools/chat-access";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

export const registerChatReplyTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "chat-reply",
    {
      title: "Reply in the chat thread of this task",
      description:
        "Post a message to the Telegram, Slack, Discord or Teams thread your current task came from. Works only on a task whose contextKey starts with task:chat-sdk:. The task's final output is posted to the thread automatically when the task ends, so use this only for a question to the user, a short progress note on long work, or to send files (attachments). Markdown is supported; long text is split into several messages. When the final output of a task is posted, the files attached to that task go with it.",
      annotations: { openWorldHint: true },
      inputSchema: z.object({
        text: z.string().min(1).max(20_000).describe("Markdown text to post to the thread."),
        attachments: chatAttachmentsSchema,
      }),
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        messageId: z.string().optional(),
        adapter: z.string().optional(),
        threadId: z.string().optional(),
        unsentFiles: z
          .array(z.looseObject({ name: z.string().optional(), reason: z.string().optional() }))
          .optional(),
      }),
    },
    async ({ text, attachments }, requestInfo) => {
      if (!requestInfo.agentId) return toolErr("Agent ID not found.");
      const data = { yourAgentId: requestInfo.agentId };

      // The header names the task this session works on; without it, the
      // agent's current in-progress task.
      const task = requestInfo.sourceTaskId
        ? await getTaskById(requestInfo.sourceTaskId)
        : await getAgentCurrentTask(requestInfo.agentId);
      if (!task) return toolErr("No current task found for chat-reply.", { data });
      // Creator is safe: a non-lead agent can only create a chat-bound task under a parent it owns or created.
      if (task.agentId !== requestInfo.agentId && task.creatorAgentId !== requestInfo.agentId) {
        return toolErr("You don't have context for this task.", { data });
      }
      const thread = chatThreadOfContextKey(task.contextKey);
      if (!thread) {
        return toolErr(
          `Task ${task.id} did not come from a chat thread (no task:chat-sdk contextKey). Use the tool of the channel the task came from.`,
          { data },
        );
      }

      const resolved = await resolveChatAttachmentRefs(
        attachments ?? [],
        task.id,
        requestInfo.agentId,
      );
      if ("error" in resolved) return toolErr(resolved.error, { data });

      try {
        const sent = await postChatMessage({
          adapter: thread.adapter,
          threadId: thread.threadId,
          text,
          taskId: task.id,
          files: resolved.files,
          // Same anchor as the final answer: the message that started this task.
          replyToMessageId: task.mentionMessageId,
        });
        return toolOk(
          `Posted to ${thread.adapter} thread ${sent.threadId}.${unsentFilesSummary(sent.unsentFiles)}`,
          {
            data: {
              ...data,
              messageId: sent.messageIds.at(-1),
              adapter: sent.adapter,
              threadId: sent.threadId,
              unsentFiles: sent.unsentFiles,
            },
          },
        );
      } catch (error) {
        const message = errorMessage(error);
        return toolErr(
          error instanceof ChatAdapterUnavailableError
            ? `${message}. The final task output is still posted when the adapter is back.`
            : `Could not post to the chat thread: ${message}`,
          { data },
        );
      }
    },
  );
};
