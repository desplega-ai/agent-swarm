# Lead Kickoff Prompt

Copy this into your agent-swarm Lead to set up the Linear Delivery Loop.

```text
Set up the Linear Delivery Loop from templates/community/linear-delivery-loop in the
desplega-ai/agent-swarm repo (main branch). Follow its PLAYBOOK.md "Setup" section.

Ask me first for anything below that is missing:
- Linear team key, and whether my team uses other names for any of the loop's states
  (map them in config.linear.states).
- GitHub repos (owner/name) the issues' pull requests live in, and the login of any
  review bot whose threads the coder should answer (github.botLogins).
- Optional: the GitHub logins whose reviews count as the owner's (github.ownerLogins).
  Empty means the repo's owners, members and collaborators.
- Agent ids for coders, reviewers and researchers.
- Slack ids: the owner-ping channel, the escalation target (a user id DMs that user),
  the team-review channel and the error channel.
- Whether the Linear and GitHub tokens are already stored as swarm secrets.

Then, as the Lead:
1. Create the `linear` and `github` GraphQL script connections bound to api.linear.app and
   api.github.com. Never put a token in a script, a task or a message.
2. Upsert linear-delivery-tick and linear-delivery-setup at global scope from the template.
3. Run linear-delivery-setup with dryRun true and show me `wouldCreate`. Run it with
   dryRun false only after I say yes.
4. Store the config in KV namespace linear-delivery-loop, key config.
5. Run linear-delivery-tick with dryRun true on one project I name. Show me controls, budget
   and the planned action per issue. Stop if controls.ok is false and tell me why.
6. Create the schedule from schedule.json (it starts in dry run).

Stop before switching the schedule to dryRun false. I will read a few scheduled dry runs and
give an explicit yes first. Enrolling a project (the delivery-loop label) stays my call.
```
