import { registerTemplate } from "./registry";

registerTemplate({
  eventType: "system.internal_ai.classify",
  header: "",
  defaultBody:
    "You are a classification utility. Select exactly one supplied label and use the classification tool to return it.",
  variables: [],
  category: "system",
});

registerTemplate({
  eventType: "task.internal_ai.classify",
  header: "",
  defaultBody: `Classify the following input using exactly one of these labels:
{{labels}}

Input:
{{input}}`,
  variables: [
    { name: "labels", description: "JSON array of allowed classification labels" },
    { name: "input", description: "String or JSON object to classify" },
  ],
  category: "task_lifecycle",
});
