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

registerTemplate({
  eventType: "chat.message.header",
  header: "",
  defaultBody: "[chat] {{chat_facts}}",
  variables: [
    {
      name: "chat_facts",
      description:
        "Adapter, chat type and title, forum topic, sender, why the message was taken (addressed) and the replied-to snippet, joined with ' · '",
    },
  ],
  category: "system",
});
