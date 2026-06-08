# LLM-Safe Release Context

Use this pattern for release-note, changelog, and report workflows where one node gathers a large source artifact and later LLM nodes plan or write from it.

The key rule: keep the full artifact for audit/debugging, but pass a compact projection to every LLM prompt.

```json
{
  "name": "LLM-safe release context",
  "description": "Build full release context and a slim prompt-safe projection before downstream LLM nodes run.",
  "nodes": [
    {
      "id": "context-builder",
      "type": "agent-task",
      "config": {
        "template": "Build release context for {{REPO_URL}}. Write the full audit artifact to agent-fs at release-runs/{DATE}/context.json. Also write release-runs/{DATE}/context-slim.json with at most 150 commit objects containing only hash, shortHash, author, date, message, and changed file paths. Do not include patch bodies, diff hunks, raw git log --stat output, downloaded HTML, or other bulk text in context-slim.json. Return contextPath and contextSlimPath.",
        "outputSchema": {
          "type": "object",
          "properties": {
            "skip": { "type": "boolean" },
            "reason": { "type": "string" },
            "contextPath": { "type": "string" },
            "contextSlimPath": { "type": "string" },
            "itemCount": { "type": "number" }
          },
          "required": ["skip"]
        }
      },
      "next": "plan-release"
    },
    {
      "id": "plan-release",
      "type": "agent-task",
      "inputs": { "context": "context-builder" },
      "config": {
        "template": "Read the slim context only:\nagent-fs --org {{ORG_ID}} cat {{context.taskOutput.contextSlimPath}}\n\nDo not read {{context.taskOutput.contextPath}} unless a human explicitly asks for the full audit artifact. Plan the release from the slim context and return JSON.",
        "outputSchema": {
          "type": "object",
          "properties": {
            "planPath": { "type": "string" },
            "heroChange": { "type": "string" },
            "themes": { "type": "array", "items": { "type": "string" } }
          },
          "required": ["planPath", "heroChange"]
        }
      },
      "next": "write-release"
    },
    {
      "id": "write-release",
      "type": "agent-task",
      "inputs": { "context": "context-builder", "plan": "plan-release" },
      "config": {
        "template": "Read the approved plan and slim context only:\nagent-fs --org {{ORG_ID}} cat {{plan.taskOutput.planPath}}\nagent-fs --org {{ORG_ID}} cat {{context.taskOutput.contextSlimPath}}\n\nDo not read {{context.taskOutput.contextPath}}. Write the release artifact and return JSON.",
        "outputSchema": {
          "type": "object",
          "properties": {
            "contentPath": { "type": "string" },
            "title": { "type": "string" }
          },
          "required": ["contentPath", "title"]
        }
      }
    }
  ]
}
```

This avoids the common failure mode where a large `context.json` fills the model window and the workflow fails as "structured output required" before the agent has enough context left to call `store-progress`.
