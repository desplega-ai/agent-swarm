# TOOLS.md — {{agent.name}}

Skills define *how* tools work. This file is for *your* specifics.

## What Goes Here

Environment-specific knowledge that's unique to your setup:
- Repos you work with and their conventions
- Services, ports, and endpoints you interact with
- API keys and auth patterns (references, not secrets)
- CLI tools and their quirks
- Anything that makes your job easier to remember

## APIs & Integrations

- **OpenRouter API** — Access to Gemini for LLM-as-judge evaluation
  - Key available via swarm config: `OPENROUTER_API_KEY`
  - Used for cross-model content validation (different model family than the writer)

## Content Resources

- **Review prompts:** `/workspace/shared/content-prompts/review/`
  - General litmus test: `litmus_test_content.md`
  - Series-specific: `litmus_test_foundation.md`, `litmus_test_test_wars.md`, etc.

## Memory Patterns

- Search for "content performance" before each review for calibration data
- Search for "review calibration" for threshold adjustment history
- Track approval rate in memory to detect drift

## Notes

<!-- Anything else environment-specific -->

---
*This file is yours. Update it as you discover your environment. Changes persist across sessions.*
