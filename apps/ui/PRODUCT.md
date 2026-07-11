# Product

## Register

product

## Platform

web

## Users

People running an agent swarm — and they are not only developers. The primary user is an operator (a dev, a lead, or a less technical teammate) who has delegated real work to a fleet of coding agents and comes to the dashboard to steer it: assign and review tasks, manage workflows, schedules, and approvals, and check on agents while doing other work. They may be self-hosting or on cloud.agent-swarm.dev, and they interact with the swarm the way they would with remote colleagues.

## Product Purpose

The dashboard is the control center for an agent swarm. It is the primary surface for creating and steering work — tasks, workflows, schedules, approvals — across every harness (Claude Code, Codex, Gemini CLI, Devin), with monitoring, session logs, costs, and memory in the same pane. A successful session is one where the operator confidently directed the swarm's work: created or redirected tasks, approved what needed approving, and understood what their agents did and what it cost.

## Positioning

The control center for an AI agent swarm that compounds daily — a lead coordinates, workers ship in isolated containers, memory compounds with every run, and this is where you steer all of it.

## Brand Personality

Calm, capable, transparent. The operator is trusting autonomous agents with real work; the interface answers with steady mission-control composure — nothing hidden, nothing theatrical. A busy swarm should never produce a busy screen.

## Anti-references

- Enterprise admin sprawl (Salesforce/Jira-style nested config mazes, ten clicks to anything).
- AI-startup gradient slop (purple gradients, sparkles, glassmorphism, "magic" theater around what agents do).

Positive references for the right feel: Linear (crisp, fast, restrained color, density without clutter) and the Vercel dashboard (quiet monochrome plus one accent, excellent detail pages).

## Design Principles

1. **Steering over spectating.** This is a control center, not a read-only monitor — every screen should surface the next action (create, approve, redirect, retry), not just data.
2. **Transparency builds trust.** Show what agents actually did: full session logs, costs, context, memory. Never dress agent work up as magic.
3. **Earned familiarity.** Linear/Vercel-grade conventions — consistent primitives, restrained color, standard affordances. The tool disappears into the task.
4. **Legible beyond developers.** Operators may not be engineers. Plain language, clear statuses, and explanations win over jargon and raw payloads.
5. **Calm under load.** Dozens of agents and tasks in flight must still read as an ordered fleet — hierarchy and status semantics absorb the volume.

## Accessibility & Inclusion

WCAG 2.1 AA: ≥4.5:1 body-text contrast in both light and dark themes, full keyboard navigability, and `prefers-reduced-motion` respected across the app.
