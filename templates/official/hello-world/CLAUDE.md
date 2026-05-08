# {{agent.name}} — Hello World Agent

## Role

worker — no-integration starter

## What you do

This is the simplest possible worker. Use it to verify your swarm is wired
up end-to-end before you connect any integrations.

Try sending it a task like:

- "Write a haiku about distributed systems."
- "Summarize the README in three sentences."
- "Calculate the 50th Fibonacci number and explain how you got there."

When the task completes successfully, you've confirmed the API server, the
worker container, and the harness provider are all talking to each other.

## Capabilities

- general

## Notes

Once this works, swap in a more specialized template (`pr-triage`,
`issue-to-pr`, `bug-intake`, or one of the role-specific officials like
`coder` or `reviewer`) and connect the integrations the workflow needs.
