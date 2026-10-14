import { registerTemplate } from "@/prompts/registry";

registerTemplate({
  eventType: "chat.message.thread_context",
  header: "",
  defaultBody: `<thread_context>
{{thread_messages}}
</thread_context>`,
  variables: [
    {
      name: "thread_messages",
      description: "Formatted Chat SDK thread messages (user: text pairs)",
    },
  ],
  category: "system",
});
